/**
 * Budget calculations.
 *
 * - Spending = expenses - refunds within the period (transfers and adjustments never count).
 * - An OVERALL budget counts spending in every category.
 * - A CATEGORY budget counts spending in one category.
 * - Category budgets are sub-limits INSIDE the overall budget; their allowances are never added
 *   on top of it. `overallAllocation` reports how much of an overall budget is already assigned to
 *   category budgets so the UI can show "allocated / unallocated" instead of a misleading total.
 * - Budget amount changes are kept as revisions, so past periods use the amount in effect then.
 * - Rollover is not applied in Phase 1.
 */
import type { Budget, Transaction } from "../domain/types";
import {
  addDays,

  endOfMonth,
  maxDate,
  minDate,
  startOfMonth,
  startOfWeek,
  type ISODate,
} from "./dates";
import { netSpending } from "./ledger";
import { add, ratioBasisPoints, type Centavos } from "./money";

type B = Budget & { deletedAt?: string | null };
type Txn = Transaction & { deletedAt?: string | null };

export interface Period {
  start: ISODate;
  end: ISODate;
}

/** Natural (unclipped) period containing `date`. */
function naturalPeriod(b: B, date: ISODate, weekStart: number): Period {
  switch (b.period) {
    case "daily":
      return { start: date, end: date };
    case "weekly": {
      const s = startOfWeek(date, weekStart);
      return { start: s, end: addDays(s, 6) };
    }
    case "monthly":
      return { start: startOfMonth(date), end: endOfMonth(date) };
    case "custom":
      return { start: b.startDate, end: b.endDate ?? b.startDate };
  }
}

/** Period of budget `b` containing `date`, clipped to the budget's start/end dates; null if outside. */
export function periodFor(b: B, date: ISODate, weekStart: number): Period | null {
  if (date < b.startDate) return null;
  if (b.endDate && date > b.endDate) return null;
  const p = naturalPeriod(b, date, weekStart);
  const start = maxDate(p.start, b.startDate);
  const end = b.endDate ? minDate(p.end, b.endDate) : p.end;
  return { start, end };
}

export function amountFor(b: B, periodStart: ISODate): Centavos {
  const revs = [...b.amountRevisions].sort((x, y) => (x.effectiveFrom < y.effectiveFrom ? -1 : 1));
  if (revs.length === 0) return 0;
  let amount = revs[0].amount;
  for (const r of revs) if (r.effectiveFrom <= periodStart) amount = r.amount;
  return amount;
}

export type BudgetState = "ok" | "warning" | "reached" | "exceeded";

export interface BudgetProgress {
  period: Period;
  amount: Centavos;
  spent: Centavos; // may be negative if refunds exceed expenses
  remaining: Centavos; // amount - spent (negative = over budget)
  usedBp: number; // basis points, 10000 = 100 %
  state: BudgetState;
}

export function progressFor(b: B, txns: readonly Txn[], period: Period): BudgetProgress {
  const amount = amountFor(b, period.start);
  const spent = netSpending(txns, period.start, period.end, b.scope === "category" ? b.categoryId : null);
  const remaining = add(amount, -spent);
  const usedBp = ratioBasisPoints(Math.max(spent, 0), amount);
  let state: BudgetState = "ok";
  if (spent > amount) state = "exceeded";
  else if (amount > 0 && spent === amount) state = "reached";
  else if (usedBp >= b.warnAtPct * 100) state = "warning";
  return { period, amount, spent, remaining, usedBp, state };
}

/**
 * Progress for the period containing `today`. For a budget that has ended, the final period;
 * for one not started yet, null.
 */
export function currentProgress(
  b: B,
  txns: readonly Txn[],
  today: ISODate,
  weekStart: number,
): BudgetProgress | null {
  let p = periodFor(b, today, weekStart);
  if (!p && b.endDate && today > b.endDate) p = periodFor(b, b.endDate, weekStart);
  return p ? progressFor(b, txns, p) : null;
}

/** Past and current periods, newest first. */
export function budgetHistory(
  b: B,
  txns: readonly Txn[],
  today: ISODate,
  weekStart: number,
  maxPeriods = 12,
): BudgetProgress[] {
  const out: BudgetProgress[] = [];
  const last = b.endDate ? minDate(today, b.endDate) : today;
  if (last < b.startDate) return out;
  let cursor: ISODate = last;
  while (out.length < maxPeriods && cursor >= b.startDate) {
    const p = periodFor(b, cursor, weekStart);
    if (!p) break;
    out.push(progressFor(b, txns, p));
    if (b.period === "custom") break;
    cursor = addDays(p.start, -1);
  }
  return out;
}

export interface OverallAllocation {
  overallAmount: Centavos;
  allocatedToCategories: Centavos;
  unallocated: Centavos;
  overAllocated: boolean;
  categoryBudgetIds: string[];
}

/**
 * How much of an overall budget's current period is already assigned to category budgets with
 * the same period type (custom budgets must overlap). Category allowances are a breakdown of the
 * overall allowance, never an addition to it.
 */
export function overallAllocation(
  overall: B,
  all: readonly B[],
  today: ISODate,
  weekStart: number,
): OverallAllocation | null {
  const p = periodFor(overall, today, weekStart);
  if (!p) return null;
  const overallAmount = amountFor(overall, p.start);
  let allocated = 0;
  const ids: string[] = [];
  for (const b of all) {
    if (b.deletedAt || !b.isActive || b.scope !== "category" || b.period !== overall.period) continue;
    const bp = periodFor(b, today, weekStart);
    if (!bp) continue;
    if (bp.end < p.start || bp.start > p.end) continue;
    allocated = add(allocated, amountFor(b, bp.start));
    ids.push(b.id);
  }
  return {
    overallAmount,
    allocatedToCategories: allocated,
    unallocated: add(overallAmount, -allocated),
    overAllocated: allocated > overallAmount,
    categoryBudgetIds: ids,
  };
}

/** Did adding `newTxn` push a budget across its warning or limit threshold? (for toasts) */
export function crossedThreshold(before: BudgetProgress, after: BudgetProgress): BudgetState | null {
  const rank: Record<BudgetState, number> = { ok: 0, warning: 1, reached: 2, exceeded: 3 };
  return rank[after.state] > rank[before.state] ? after.state : null;
}

