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
  /** Records that can never be updated once created (e.g. net-worth snapshots). */
  immutable?: boolean;
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

/** The referenced account must exist, be live, and have one of the given types. */
async function requireAccountType(tx: Tx, id: string | null | undefined, types: string[], code: string, message: string) {
  if (!id) return;
  const [a] = await tx
    .select({ type: s.accounts.type })
    .from(s.accounts)
    .where(and(eq(s.accounts.id, id), isNull(s.accounts.deletedAt)));
  if (!a) throw new DomainError("unknown_account", "Unknown account");
  if (!types.includes(a.type)) throw new DomainError(code, message);
}

async function requireCategoryKind(tx: Tx, id: string | null | undefined, kind: "income" | "expense") {
  if (!id) return;
  const [c] = await tx
    .select({ kind: s.categories.kind })
    .from(s.categories)
    .where(and(eq(s.categories.id, id), isNull(s.categories.deletedAt)));
  if (!c) throw new DomainError("unknown_category", "Unknown category");
  if (c.kind !== kind) throw new DomainError("category_kind", `Choose a ${kind} category`);
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
      // Phase 2 links
      if (!!data.scheduleId !== !!data.occurrenceDate)
        throw new DomainError("invalid_occurrence", "A scheduled occurrence needs both its schedule and date");
      requireRefs(await liveIds(tx, s.schedules, [data.scheduleId]), [data.scheduleId], "unknown_schedule", "schedule");
      requireRefs(await liveIds(tx, s.debts, [data.debtId]), [data.debtId], "unknown_debt", "debt");
      requireRefs(await liveIds(tx, s.installmentPlans, [data.installmentPlanId]), [data.installmentPlanId], "unknown_installment", "installment plan");
      requireRefs(await liveIds(tx, s.importBatches, [data.importBatchId]), [data.importBatchId], "unknown_import", "import");
      if (data.billId) {
        const [b] = await tx
          .select({ cancelled: s.bills.cancelled })
          .from(s.bills)
          .where(and(eq(s.bills.id, data.billId), isNull(s.bills.deletedAt)));
        if (!b) throw new DomainError("unknown_bill", "Unknown bill");
        if (b.cancelled) throw new DomainError("bill_cancelled", "This bill was cancelled");
        if (data.type !== "expense" && data.type !== "transfer")
          throw new DomainError("invalid_bill_payment", "Bill payments are expenses or transfers");
      }
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
  // ------------------------------------------------------------------ Phase 2
  debt: {
    table: s.debts as any,
    fields: fieldsOf("debt"),
    prepare: async (d, { tx }) => {
      await requireAccountType(tx, d.accountId, ["loan"], "debt_account", "A debt must use a loan account");
      return d;
    },
  },
  schedule: {
    table: s.schedules as any,
    fields: fieldsOf("schedule"),
    prepare: async (d, { tx }) => {
      if (d.kind === "transaction" && !d.accountId) throw new DomainError("required", "Choose an account");
      if (d.txnType === "transfer") {
        if (!d.toAccountId) throw new DomainError("required", "Choose the destination account");
        if (d.toAccountId === d.accountId) throw new DomainError("same_account", "Source and destination must differ");
      } else if (d.toAccountId) throw new DomainError("not_allowed", "Only transfers have a destination account");
      if (d.kind === "bill") {
        if (!d.billKind) throw new DomainError("required", "Choose the bill type");
        if (d.txnType === "income") throw new DomainError("invalid", "Bills are paid, not received");
        if (d.billKind === "card_payment" && !d.cardAccountId) throw new DomainError("required", "Choose the credit card");
        if (d.billKind === "loan_installment" && !d.debtId) throw new DomainError("required", "Choose the loan");
      } else if (d.billKind) throw new DomainError("not_allowed", "Only bill schedules have a bill type");
      requireRefs(await liveIds(tx, s.accounts, [d.accountId, d.toAccountId]), [d.accountId, d.toAccountId], "unknown_account", "account");
      await requireAccountType(tx, d.cardAccountId, ["credit_card"], "card_account", "Choose a credit card account");
      if (d.txnType !== "transfer") await requireCategoryKind(tx, d.categoryId, d.txnType === "income" ? "income" : "expense");
      else if (d.categoryId) throw new DomainError("not_allowed", "Transfers have no category");
      requireRefs(await liveIds(tx, s.debts, [d.debtId]), [d.debtId], "unknown_debt", "debt");
      requireRefs(await liveIds(tx, s.tags, d.tagIds), d.tagIds, "unknown_tag", "tag");
      return d;
    },
  },
  scheduleException: {
    table: s.scheduleExceptions as any,
    fields: fieldsOf("scheduleException"),
    prepare: async (d, { tx }) => {
      requireRefs(await liveIds(tx, s.schedules, [d.scheduleId]), [d.scheduleId], "unknown_schedule", "schedule");
      if (d.action === "skip" && (d.overrideDate || d.overrideAmount))
        throw new DomainError("invalid", "A skipped occurrence has no override");
      return d;
    },
  },
  bill: {
    table: s.bills as any,
    fields: fieldsOf("bill"),
    prepare: async (d, { tx }) => {
      if (!!d.scheduleId !== !!d.occurrenceDate)
        throw new DomainError("invalid_occurrence", "A scheduled bill needs both its schedule and date");
      if (d.kind === "card_payment" && !d.cardAccountId) throw new DomainError("required", "Choose the credit card");
      if (d.kind === "loan_installment" && !d.debtId) throw new DomainError("required", "Choose the loan");
      await requireCategoryKind(tx, d.categoryId, "expense");
      requireRefs(await liveIds(tx, s.accounts, [d.accountId]), [d.accountId], "unknown_account", "account");
      await requireAccountType(tx, d.cardAccountId, ["credit_card"], "card_account", "Choose a credit card account");
      requireRefs(await liveIds(tx, s.debts, [d.debtId]), [d.debtId], "unknown_debt", "debt");
      requireRefs(await liveIds(tx, s.schedules, [d.scheduleId]), [d.scheduleId], "unknown_schedule", "schedule");
      return d;
    },
  },
  cardProfile: {
    table: s.cardProfiles as any,
    fields: fieldsOf("cardProfile"),
    prepare: async (d, { tx }) => {
      await requireAccountType(tx, d.accountId, ["credit_card"], "card_account", "Card details need a credit card account");
      return d;
    },
  },
  installmentPlan: {
    table: s.installmentPlans as any,
    fields: fieldsOf("installmentPlan"),
    prepare: async (d, { tx }) => {
      await requireAccountType(tx, d.cardAccountId, ["credit_card"], "card_account", "Installments belong to a credit card");
      requireRefs(await liveIds(tx, s.transactions, [d.transactionId]), [d.transactionId], "unknown_transaction", "transaction");
      return d;
    },
  },
  importBatch: {
    table: s.importBatches as any,
    fields: fieldsOf("importBatch"),
    prepare: async (d, { tx }) => {
      requireRefs(await liveIds(tx, s.accounts, [d.accountId]), [d.accountId], "unknown_account", "account");
      return d;
    },
  },
  goal: {
    table: s.goals as any,
    fields: fieldsOf("goal"),
    prepare: async (d, { tx }) => {
      requireRefs(await liveIds(tx, s.accounts, [d.accountId]), [d.accountId], "unknown_account", "account");
      return d;
    },
  },
  goalEntry: {
    table: s.goalEntries as any,
    fields: fieldsOf("goalEntry"),
    prepare: async (d, { tx }) => {
      requireRefs(await liveIds(tx, s.goals, [d.goalId]), [d.goalId], "unknown_goal", "goal");
      requireRefs(await liveIds(tx, s.transactions, [d.transactionId]), [d.transactionId], "unknown_transaction", "transaction");
      return d;
    },
  },
  manualAsset: {
    table: s.manualAssets as any,
    fields: fieldsOf("manualAsset"),
    prepare: async (d) => ({
      ...d,
      valuations: [...d.valuations].sort((a: any, b: any) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    }),
  },
  netWorthSnapshot: {
    table: s.netWorthSnapshots as any,
    fields: fieldsOf("netWorthSnapshot"),
    immutable: true,
  },
};

export function toEntityData(def: EntityDef, row: Record<string, any>) {
  const out: Record<string, unknown> = {};
  for (const f of def.fields) out[f] = row[f];
  return out;
}

