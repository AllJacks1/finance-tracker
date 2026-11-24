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
/** Phase 2 optional link: older clients that omit it still validate. */
const optId = id.nullable().default(null);
const optDate = isoDate.nullable().default(null);
const months = z.union([z.literal(3), z.literal(6), z.literal(9), z.literal(12)]);

export const preferencesSchema = z.object({
  stsHorizon: z.enum(["end_of_month", "next_income"]).default("end_of_month"),
  emergencyTargetMonths: months.default(6),
  essentialsLookbackMonths: months.default(3),
  essentialsOverride: positiveAmount.nullable().default(null),
  notifications: z
    .object({
      bills: z.boolean().default(true),
      billDaysBefore: z.number().int().min(0).max(14).default(3),
      scheduled: z.boolean().default(true),
      cards: z.boolean().default(true),
      loans: z.boolean().default(true),
      budgets: z.boolean().default(true),
      goals: z.boolean().default(true),
      pushShowAmounts: z.boolean().default(false),
    })
    .prefault({}),
});

const ruleSchema = z
  .object({
    freq: z.enum(["once", "daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().min(1).max(366),
    startDate: isoDate,
    endDate: isoDate.nullable(),
    count: z.number().int().min(1).max(10_000).nullable(),
  })
  .refine((r) => !r.endDate || r.endDate >= r.startDate, "End date must be on or after the start date");

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
    preferences: preferencesSchema.prefault({}),
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
    isEssential: z.boolean().default(false),
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
    allocationId: id.nullable().default(null),
    billId: optId,
    scheduleId: optId,
    occurrenceDate: optDate,
    debtId: optId,
    installmentPlanId: optId,
    groupId: optId,
    importBatchId: optId,
    importFingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
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
    transactionId: optId,
    billId: optId,
    filename: z.string().max(200),
    mime: z.string().max(100),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  // ---------------------------------------------------------------- Phase 2
  debt: z.object({
    id,
    accountId: id,
    creditor: name,
    kind: z.enum(["personal", "bank", "installment", "other"]),
    originalPrincipal: z.number().int().min(0).max(MAX_AMOUNT),
    startDate: isoDate,
    aprBp: z.number().int().min(0).max(100_000),
    interestMethod: z.enum(["diminishing", "add_on", "none"]),
    frequency: z.enum(["weekly", "biweekly", "monthly"]),
    minimumPayment: z.number().int().min(0).max(MAX_AMOUNT),
    dueDay: z.number().int().min(1).max(31).nullable(),
    termMonths: z.number().int().min(1).max(600).nullable(),
    status: z.enum(["active", "paid_off", "archived"]),
    notes: text(1000),
  }),
  schedule: z.object({
    id,
    kind: z.enum(["transaction", "bill"]),
    name,
    txnType: z.enum(["income", "expense", "transfer"]),
    amount: positiveAmount,
    accountId: id.nullable(),
    toAccountId: id.nullable(),
    categoryId: id.nullable(),
    description: text(200),
    notes: text(2000),
    tagIds: z.array(id).max(20),
    rule: ruleSchema,
    pauses: z.array(z.object({ from: isoDate, to: isoDate.nullable() })).max(200),
    status: z.enum(["active", "paused", "cancelled"]),
    billKind: z.enum(["general", "card_payment", "loan_installment"]).nullable(),
    cardAccountId: id.nullable(),
    debtId: id.nullable(),
    paysBillScheduleId: id.nullable(),
    reminderDays: z.number().int().min(0).max(30).nullable(),
    previousScheduleId: id.nullable(),
  }),
  scheduleException: z.object({
    id,
    scheduleId: id,
    occurrenceDate: isoDate,
    action: z.enum(["skip", "override"]),
    overrideDate: isoDate.nullable(),
    overrideAmount: positiveAmount.nullable(),
  }),
  bill: z.object({
    id,
    name,
    kind: z.enum(["general", "card_payment", "loan_installment"]),
    categoryId: id.nullable(),
    expectedAmount: z.number().int().min(0).max(MAX_AMOUNT),
    actualAmount: z.number().int().min(0).max(MAX_AMOUNT).nullable(),
    minimumAmount: z.number().int().min(0).max(MAX_AMOUNT).nullable(),
    dueDate: isoDate,
    accountId: id.nullable(),
    notes: text(2000),
    scheduleId: id.nullable(),
    occurrenceDate: isoDate.nullable(),
    cardAccountId: id.nullable(),
    debtId: id.nullable(),
    statementClosingDate: isoDate.nullable(),
    cancelled: z.boolean(),
  }),
  cardProfile: z.object({
    id,
    accountId: id,
    creditLimit: z.number().int().min(0).max(MAX_AMOUNT),
    statementDay: z.number().int().min(1).max(31),
    dueDaysAfterStatement: z.number().int().min(1).max(60),
    minPaymentPctBp: z.number().int().min(0).max(10_000),
    minPaymentFloor: z.number().int().min(0).max(MAX_AMOUNT),
    aprBp: z.number().int().min(0).max(100_000),
    autoBills: z.boolean(),
  }),
  installmentPlan: z.object({
    id,
    cardAccountId: id,
    transactionId: id.nullable(),
    description: z.string().trim().min(1).max(200),
    principal: positiveAmount,
    months: z.number().int().min(1).max(120),
    monthlyAmount: positiveAmount,
    firstBillingDate: isoDate,
    feeAmount: z.number().int().min(0).max(MAX_AMOUNT),
    status: z.enum(["active", "cancelled"]),
  }),
  importBatch: z.object({
    id,
    accountId: id,
    filename: z.string().max(200),
    fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
    rowCount: z.number().int().min(0),
    importedCount: z.number().int().min(0),
    skippedCount: z.number().int().min(0),
  }),
  goal: z.object({
    id,
    name,
    kind: z.enum(["emergency", "travel", "education", "home", "vehicle", "purchase", "general"]),
    targetAmount: z.number().int().min(0).max(MAX_AMOUNT),
    targetDate: isoDate.nullable(),
    accountId: id.nullable(),
    description: text(1000),
    status: z.enum(["active", "completed", "archived"]),
    completedAt: isoDate.nullable(),
  }),
  goalEntry: z.object({
    id,
    goalId: id,
    amount: signedAmount.refine((n) => n !== 0, "Amount cannot be zero"),
    entryDate: isoDate,
    note: text(500),
    transactionId: id.nullable(),
    groupId: id.nullable(),
  }),
  manualAsset: z.object({
    id,
    name,
    kind: z.enum(["investment", "property", "vehicle", "other"]),
    valuations: z.array(z.object({ date: isoDate, value: z.number().int().min(0).max(MAX_AMOUNT) })).min(1).max(1000),
    isActive: z.boolean(),
    notes: text(1000),
  }),
  netWorthSnapshot: z.object({
    id,
    snapshotDate: isoDate,
    kind: z.enum(["auto", "manual"]),
    assets: signedAmount,
    liabilities: signedAmount,
    netWorth: signedAmount,
    breakdown: z
      .array(z.object({ kind: z.enum(["account", "asset"]), id, name: z.string().max(80), liability: z.boolean(), value: signedAmount }))
      .max(500),
    recordedAt: instant,
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
  "debt",
  "schedule",
  "scheduleException",
  "bill",
  "cardProfile",
  "installmentPlan",
  "importBatch",
  "goal",
  "goalEntry",
  "manualAsset",
  "netWorthSnapshot",
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
  /**
   * Ops sharing a groupId are applied ALL-OR-NOTHING (one savepoint). Group ops must be sent
   * contiguously in one push. Ops without a groupId behave exactly as before.
   */
  groupId: id.optional(),
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
