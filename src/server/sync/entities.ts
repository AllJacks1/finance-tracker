import "server-only";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { EntityName, Transaction } from "@/lib/domain/types";
import { localDateOf } from "@/lib/finance/dates";
import { entriesFor, validateTransaction } from "@/lib/finance/ledger";
import { entitySchemas } from "@/lib/sync/protocol";
import type { Tx } from "../db";
import * as s from "../db/schema";

export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface EntityCtx {
  tx: Tx;
  workspaceId: string;
  timezone: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface EntityDef {
  table: PgTable & Record<string, any>;
  /** Client-visible fields (also the column property names in the Drizzle schema). */
  fields: string[];
  /** Server-side normalisation + domain validation. Returns the data to store. */
  prepare?: (data: Record<string, any>, ctx: EntityCtx) => Promise<Record<string, any>>;
  /** Refuse deletion when the record is still referenced. */
  beforeDelete?: (id: string, ctx: EntityCtx) => Promise<void>;
  /** Maintain derived data in the same DB transaction. */
  afterWrite?: (row: Record<string, any>, ctx: EntityCtx) => Promise<void>;
  creatable?: boolean; // default true
}

const fieldsOf = (e: EntityName) => Object.keys(entitySchemas[e].shape);

async function liveIds(tx: Tx, table: any, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Set<string>();
  const rows = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(inArray(table.id, wanted), isNull(table.deletedAt)));
  return new Set(rows.map((r: { id: string }) => r.id));
}

function requireRefs(found: Set<string>, ids: (string | null | undefined)[], code: string, what: string) {
  for (const id of ids) if (id && !found.has(id)) throw new DomainError(code, `Unknown ${what}`);
}

async function rebuildEntries(row: Record<string, any>, ctx: EntityCtx) {
  await ctx.tx.delete(s.transactionEntries).where(eq(s.transactionEntries.transactionId, row.id));
  if (row.deletedAt) return; // deleted transactions have no ledger lines
  const lines = entriesFor(row as Transaction);
  await ctx.tx.insert(s.transactionEntries).values(
    lines.map((l, i) => ({
      workspaceId: ctx.workspaceId,
      transactionId: row.id as string,
      lineNo: i + 1,
      accountId: l.accountId,
      amount: l.amount,
    })),
  );
}

export const ENTITIES: Record<EntityName, EntityDef> = {
  settings: {
    table: s.workspaces as any,
    fields: fieldsOf("settings"),
    creatable: false,
  },
  account: {
    table: s.accounts as any,
    fields: fieldsOf("account"),
    beforeDelete: async (id, { tx }) => {
      const used = await tx
        .select({ id: s.transactions.id })
        .from(s.transactions)
        .where(
          and(
            isNull(s.transactions.deletedAt),
            or(eq(s.transactions.accountId, id), eq(s.transactions.toAccountId, id)),
          ),
        )
        .limit(1);
      if (used.length)
        throw new DomainError("in_use", "This account has transactions. Deactivate it instead.");
    },
  },
  category: {
    table: s.categories as any,
    fields: fieldsOf("category"),
    beforeDelete: async (id, { tx }) => {
      const used = await tx
        .select({ id: s.transactions.id })
        .from(s.transactions)
        .where(and(isNull(s.transactions.deletedAt), eq(s.transactions.categoryId, id)))
        .limit(1);
      const budget = await tx
        .select({ id: s.budgets.id })
        .from(s.budgets)
        .where(and(isNull(s.budgets.deletedAt), eq(s.budgets.categoryId, id)))
        .limit(1);
      if (used.length || budget.length)
        throw new DomainError("in_use", "This category is in use. Archive it instead.");
    },
  },
  tag: { table: s.tags as any, fields: fieldsOf("tag") },
  allocation: {
    table: s.allocations as any,
    fields: fieldsOf("allocation"),
    prepare: async (d, { tx }) => {
      requireRefs(await liveIds(tx, s.accounts, [d.accountId]), [d.accountId], "unknown_account", "account");
      return d;
    },
  },
  transaction: {
    table: s.transactions as any,
    fields: fieldsOf("transaction"),
    prepare: async (d, { tx, timezone }) => {
      // The server is authoritative for the local calendar date.
      const data = { ...d, localDate: localDateOf(d.occurredAt, timezone) } as Transaction;
      const accounts = await tx
        .select({ id: s.accounts.id })
        .from(s.accounts)
        .where(and(inArray(s.accounts.id, [data.accountId, data.toAccountId].filter(Boolean) as string[]), isNull(s.accounts.deletedAt)));
      const cats = data.categoryId
        ? await tx
            .select({ id: s.categories.id, kind: s.categories.kind })
            .from(s.categories)
            .where(and(eq(s.categories.id, data.categoryId), isNull(s.categories.deletedAt)))
        : [];
      const issues = validateTransaction(data, {
        accounts: new Map(accounts.map((a) => [a.id, a])),
        categories: new Map(cats.map((c) => [c.id, c])),
      });
      if (issues.length) throw new DomainError(issues[0]!.code, issues[0]!.message);
      requireRefs(await liveIds(tx, s.tags, data.tagIds), data.tagIds, "unknown_tag", "tag");
      if (data.refundOfId) {
        const [orig] = await tx
          .select({ type: s.transactions.type })
          .from(s.transactions)
          .where(eq(s.transactions.id, data.refundOfId));
        if (!orig || orig.type !== "expense")
          throw new DomainError("invalid_refund", "A refund must link to an expense");
      }
      requireRefs(await liveIds(tx, s.allocations, [data.allocationId]), [data.allocationId], "unknown_allocation", "obligation");
      return data;
    },
    afterWrite: rebuildEntries,
  },
  template: {
    table: s.transactionTemplates as any,
    fields: fieldsOf("template"),
    prepare: async (d, { tx }) => {
      requireRefs(await liveIds(tx, s.accounts, [d.accountId, d.toAccountId]), [d.accountId, d.toAccountId], "unknown_account", "account");
      requireRefs(await liveIds(tx, s.categories, [d.categoryId]), [d.categoryId], "unknown_category", "category");
      return d;
    },
  },
  budget: {
    table: s.budgets as any,
    fields: fieldsOf("budget"),
    prepare: async (d, { tx }) => {
      if ((d.scope === "category") !== !!d.categoryId)
        throw new DomainError("invalid_scope", "Category budgets need a category; overall budgets must not have one");
      if (d.period === "custom" && (!d.endDate || d.endDate < d.startDate))
        throw new DomainError("invalid_dates", "Custom budgets need an end date after the start date");
      if (d.categoryId) {
        const [c] = await tx
          .select({ kind: s.categories.kind })
          .from(s.categories)
          .where(and(eq(s.categories.id, d.categoryId), isNull(s.categories.deletedAt)));
        if (!c) throw new DomainError("unknown_category", "Unknown category");
        if (c.kind !== "expense") throw new DomainError("category_kind", "Budgets track expense categories");
      }
      const revs = [...d.amountRevisions].sort((a: any, b: any) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
      return { ...d, amountRevisions: revs };
    },
  },
  reconciliation: {
    table: s.accountReconciliations as any,
    fields: fieldsOf("reconciliation"),
    prepare: async (d, { tx }) => {
      requireRefs(await liveIds(tx, s.accounts, [d.accountId]), [d.accountId], "unknown_account", "account");
      if (d.adjustmentTransactionId) {
        requireRefs(await liveIds(tx, s.transactions, [d.adjustmentTransactionId]), [d.adjustmentTransactionId], "unknown_transaction", "transaction");
      }
      return d;
    },
  },
  attachment: {
    table: s.attachments as any,
    fields: fieldsOf("attachment"),
    creatable: false, // created by the upload endpoint, which stores the file first
  },
};

export function toEntityData(def: EntityDef, row: Record<string, any>) {
  const out: Record<string, unknown> = {};
  for (const f of def.fields) out[f] = row[f];
  return out;
}

