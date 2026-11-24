/**
 * Sync protocol shared by the server and the offline client.
 *
 * The client writes locally, records an op in its outbox, and later pushes ops in order.
 * - opId        unique idempotency key: replaying an op never applies it twice.
 * - baseVersion the version the client edited; if the server's version differs, the op is a
 *               CONFLICT and is not applied (no blind last-write-wins).
 * Pull returns every record changed after a cursor (the workspace's monotonic change_seq),
 * including tombstones (deletedAt set).
 */
import { z } from "zod";
import { ACCOUNT_TYPES, TXN_TYPES, type EntityName } from "../domain/types";
import { isISODate } from "../finance/dates";
import { MAX_AMOUNT } from "../finance/money";

const id = z.uuid();
const isoDate = z.string().refine(isISODate, "Invalid date (YYYY-MM-DD)");
const instant = z.string().max(40).refine((s) => !Number.isNaN(new Date(s).getTime()), "Invalid timestamp");
const name = z.string().trim().min(1).max(80);
const text = (max: number) => z.string().max(max).nullable();
const positiveAmount = z.number().int().positive().max(MAX_AMOUNT);
const signedAmount = z.number().int().min(-MAX_AMOUNT).max(MAX_AMOUNT);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable();
const icon = z.string().regex(/^[a-z0-9-]{1,40}$/).nullable();

export const entitySchemas = {
  settings: z.object({
    id,
    currency: z.literal("PHP"),
    timezone: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Unknown timezone"),
    weekStart: z.number().int().min(0).max(6),
  }),
  account: z.object({
    id,
    name,
    type: z.enum(ACCOUNT_TYPES),
    openingBalance: signedAmount,
    openingDate: isoDate,
    color,
    icon,
    description: text(500),
    isActive: z.boolean(),
    countsAsSpendable: z.boolean(),
  }),
  category: z.object({
    id,
    name,
    kind: z.enum(["income", "expense"]),
    icon,
    color,
    isArchived: z.boolean(),
  }),
  tag: z.object({ id, name: z.string().trim().min(1).max(40) }),
  transaction: z.object({
    id,
    type: z.enum(TXN_TYPES),
    amount: positiveAmount,
    accountId: id,
    toAccountId: id.nullable(),
    adjustmentDirection: z.enum(["increase", "decrease"]).nullable(),
    categoryId: id.nullable(),
    occurredAt: instant,
    localDate: isoDate,
    description: text(200),
    notes: text(2000),
    tagIds: z.array(id).max(20),
    refundOfId: id.nullable(),
    allocationId: id.nullable(),
  }),
  template: z.object({
    id,
    name,
    type: z.enum(TXN_TYPES),
    amount: positiveAmount.nullable(),
    accountId: id.nullable(),
    toAccountId: id.nullable(),
    categoryId: id.nullable(),
    description: text(200),
    notes: text(2000),
    tagIds: z.array(id).max(20),
  }),
  budget: z.object({
    id,
    name,
    scope: z.enum(["overall", "category"]),
    categoryId: id.nullable(),
    period: z.enum(["daily", "weekly", "monthly", "custom"]),
    startDate: isoDate,
    endDate: isoDate.nullable(),
    amountRevisions: z
      .array(z.object({ effectiveFrom: isoDate, amount: positiveAmount }))
      .min(1)
      .max(200),
    warnAtPct: z.number().int().min(1).max(100),
    rollover: z.literal(false),
    isActive: z.boolean(),
  }),
  allocation: z.object({
    id,
    kind: z.enum(["reserve", "obligation"]),
    name,
    amount: positiveAmount,
    dueDate: isoDate.nullable(),
    accountId: id.nullable(),
    status: z.enum(["open", "settled", "cancelled"]),
    notes: text(1000),
  }),
  reconciliation: z.object({
    id,
    accountId: id,
    statementDate: isoDate,
    statementBalance: signedAmount,
    computedBalance: signedAmount,
    adjustmentTransactionId: id.nullable(),
    note: text(500),
  }),
  attachment: z.object({
    id,
    transactionId: id,
    filename: z.string().max(200),
    mime: z.string().max(100),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
} satisfies Record<EntityName, z.ZodType>;

export const ENTITY_ENUM = z.enum([
  "settings",
  "account",
  "category",
  "tag",
  "transaction",
  "template",
  "budget",
  "allocation",
  "reconciliation",
  "attachment",
]);

export const OP_KINDS = ["create", "update", "delete", "restore"] as const;
export type OpKind = (typeof OP_KINDS)[number];

export const syncOpSchema = z.object({
  opId: id,
  entity: ENTITY_ENUM,
  entityId: id,
  kind: z.enum(OP_KINDS),
  /** Version the client based this change on; null for creates. */
  baseVersion: z.number().int().positive().nullable(),
  /** Full entity data for create/update; omitted for delete/restore. */
  data: z.record(z.string(), z.unknown()).optional(),
  clientCreatedAt: instant,
});
export type SyncOp = z.infer<typeof syncOpSchema>;

export const MAX_OPS_PER_PUSH = 100;
export const pushRequestSchema = z.object({
  ops: z.array(syncOpSchema).min(1).max(MAX_OPS_PER_PUSH),
});

export interface ServerRecord {
  entity: EntityName;
  id: string;
  version: number;
  changeSeq: number;
  deletedAt: string | null;
  updatedAt: string;
  data: Record<string, unknown>;
}

export type OpStatus =
  | "applied" // done; `record` is the new server state
  | "duplicate" // this opId was applied before; `record` is the state at that time
  | "conflict" // baseVersion mismatch; `record` is the current server state; not applied
  | "rejected" // invalid; will not succeed if retried unchanged
  | "blocked"; // an earlier op for the same entity in this batch conflicted/was rejected

export interface OpResult {
  opId: string;
  entity: EntityName;
  entityId: string;
  status: OpStatus;
  record?: ServerRecord;
  error?: { code: string; message: string };
}

export interface PushResponse {
  results: OpResult[];
}

export interface PullResponse {
  records: ServerRecord[];
  cursor: number;
  hasMore: boolean;
}
