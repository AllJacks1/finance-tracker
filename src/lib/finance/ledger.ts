/**
 * Ledger rules: how each transaction type affects account balances and reports.
 *
 *  type        | ledger entries                         | income/expense reports | budgets
 *  ------------|----------------------------------------|------------------------|--------------------
 *  income      | +amount on account                     | income                 | -
 *  expense     | -amount on account                     | expense                | counts as spending
 *  transfer    | -amount on source, +amount on dest     | excluded               | excluded
 *  refund      | +amount on account                     | reduces expense        | reduces spending
 *  adjustment  | +/-amount on account                   | excluded               | excluded
 */
import type { Account, Category, Transaction } from "../domain/types";
import { add, assertCentavos, MAX_AMOUNT, type Centavos } from "./money";
import { isISODate, type ISODate } from "./dates";

export interface Entry {
  accountId: string;
  amount: Centavos; // signed
}

export type TxnLike = Pick<
  Transaction,
  "type" | "amount" | "accountId" | "toAccountId" | "adjustmentDirection"
>;

export function entriesFor(t: TxnLike): Entry[] {
  assertCentavos(t.amount);
  switch (t.type) {
    case "income":
    case "refund":
      return [{ accountId: t.accountId, amount: t.amount }];
    case "expense":
      return [{ accountId: t.accountId, amount: -t.amount }];
    case "transfer":
      if (!t.toAccountId) throw new Error("Transfer requires a destination account");
      return [
        { accountId: t.accountId, amount: -t.amount },
        { accountId: t.toAccountId, amount: t.amount },
      ];
    case "adjustment":
      return [
        {
          accountId: t.accountId,
          amount: t.adjustmentDirection === "decrease" ? -t.amount : t.amount,
        },
      ];
  }
}

export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
}

export interface ValidationContext {
  accounts: Map<string, Pick<Account, "id">>;
  categories: Map<string, Pick<Category, "id" | "kind">>;
}

/** Domain validation shared by the client (forms) and the server (sync). */
export function validateTransaction(t: Transaction, ctx?: ValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const bad = (field: string, code: string, message: string) =>
    issues.push({ field, code, message });

  if (!Number.isSafeInteger(t.amount) || t.amount <= 0)
    bad("amount", "amount_positive", "Amount must be greater than zero");
  else if (t.amount > MAX_AMOUNT) bad("amount", "amount_too_large", "Amount is too large");
  if (!isISODate(t.localDate)) bad("localDate", "invalid_date", "Invalid date");
  if (Number.isNaN(new Date(t.occurredAt).getTime()))
    bad("occurredAt", "invalid_date", "Invalid date/time");

  if (t.type === "transfer") {
    if (!t.toAccountId) bad("toAccountId", "required", "Choose the destination account");
    else if (t.toAccountId === t.accountId)
      bad("toAccountId", "same_account", "Source and destination must differ");
    if (t.categoryId) bad("categoryId", "not_allowed", "Transfers have no category");
  } else if (t.toAccountId) {
    bad("toAccountId", "not_allowed", "Only transfers have a destination account");
  }

  if (t.type === "adjustment") {
    if (!t.adjustmentDirection)
      bad("adjustmentDirection", "required", "Choose increase or decrease");
    if (t.categoryId) bad("categoryId", "not_allowed", "Adjustments have no category");
  } else if (t.adjustmentDirection) {
    bad("adjustmentDirection", "not_allowed", "Only adjustments have a direction");
  }

  if (t.refundOfId && t.type !== "refund")
    bad("refundOfId", "not_allowed", "Only refunds link to an original expense");

  if (ctx) {
    if (!ctx.accounts.has(t.accountId)) bad("accountId", "unknown_account", "Unknown account");
    if (t.toAccountId && !ctx.accounts.has(t.toAccountId))
      bad("toAccountId", "unknown_account", "Unknown account");
    if (t.categoryId) {
      const c = ctx.categories.get(t.categoryId);
      if (!c) bad("categoryId", "unknown_category", "Unknown category");
      else {
        const want = t.type === "income" ? "income" : "expense";
        if (c.kind !== want) bad("categoryId", "category_kind", `Choose a ${want} category`);
      }
    }
  }
  return issues;
}

type Live = Pick<Transaction, "type" | "amount" | "localDate" | "categoryId"> & {
  deletedAt?: string | null;
};

export const isLive = (t: { deletedAt?: string | null }) => !t.deletedAt;

export interface PeriodTotals {
  income: Centavos;
  expense: Centavos; // gross expenses
  refunds: Centavos;
  netExpense: Centavos; // expense - refunds
  net: Centavos; // income - netExpense
}

/** Income/expense totals for [start, end] (inclusive). Transfers and adjustments are excluded. */
export function periodTotals(txns: readonly Live[], start: ISODate, end: ISODate): PeriodTotals {
  let income = 0;
  let expense = 0;
  let refunds = 0;
  for (const t of txns) {
    if (!isLive(t) || t.localDate < start || t.localDate > end) continue;
    if (t.type === "income") income = add(income, t.amount);
    else if (t.type === "expense") expense = add(expense, t.amount);
    else if (t.type === "refund") refunds = add(refunds, t.amount);
  }
  const netExpense = add(expense, -refunds);
  return { income, expense, refunds, netExpense, net: add(income, -netExpense) };
}

/** Net spending (expenses - refunds) for [start, end], optionally limited to one category. */
export function netSpending(
  txns: readonly Live[],
  start: ISODate,
  end: ISODate,
  categoryId?: string | null,
): Centavos {
  let total = 0;
  for (const t of txns) {
    if (!isLive(t) || t.localDate < start || t.localDate > end) continue;
    if (categoryId && t.categoryId !== categoryId) continue;
    if (t.type === "expense") total = add(total, t.amount);
    else if (t.type === "refund") total = add(total, -t.amount);
  }
  return total;
}
