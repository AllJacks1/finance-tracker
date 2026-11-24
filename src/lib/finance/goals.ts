/**
 * Savings goals and the emergency fund.
 *
 * Goal entries are EARMARKS, not ledger entries: contributing to a goal never changes a balance
 * and never counts as spending. (If money also physically moves, that is a separate ordinary
 * TRANSFER — never an expense — recorded in the same atomic group.)
 *
 *   allocated   = Σ live entries of the goal (contributions +, withdrawals -)
 *   unallocated = account balance - Σ allocated of goals linked to that account
 *
 * Safe-to-Spend subtracts allocations of active/completed goals held in SPENDABLE accounts only;
 * goals in savings accounts were never counted as spendable, so subtracting them would double count.
 */
import type { Account, Category, CoverageMonths, Goal, GoalEntry, Transaction } from "../domain/types";
import { isSpendable } from "./balances";
import { addMonths, endOfMonth, startOfMonth, type ISODate } from "./dates";
import { netSpending } from "./ledger";
import { add, ratioBasisPoints, type Centavos } from "./money";

type Live<T> = T & { deletedAt?: string | null };

export function allocatedByGoal(entries: readonly Live<GoalEntry>[]): Map<string, Centavos> {
  const m = new Map<string, Centavos>();
  for (const e of entries) if (!e.deletedAt) m.set(e.goalId, add(m.get(e.goalId) ?? 0, e.amount));
  return m;
}

export interface GoalProgress {
  allocated: Centavos;
  remaining: Centavos;
  pctBp: number;
  reached: boolean;
  /** Suggested monthly contribution to reach the target by its date (null if no date/reached). */
  suggestedMonthly: Centavos | null;
  monthsLeft: number | null;
}

export function goalProgress(goal: Goal, allocated: Centavos, today: ISODate): GoalProgress {
  const remaining = Math.max(goal.targetAmount - allocated, 0);
  const reached = goal.targetAmount > 0 && allocated >= goal.targetAmount;
  let monthsLeft: number | null = null;
  let suggestedMonthly: Centavos | null = null;
  if (goal.targetDate && !reached) {
    const months =
      (Number(goal.targetDate.slice(0, 4)) - Number(today.slice(0, 4))) * 12 +
      (Number(goal.targetDate.slice(5, 7)) - Number(today.slice(5, 7)));
    monthsLeft = Math.max(months, 0);
    suggestedMonthly = monthsLeft > 0 ? Math.ceil(remaining / monthsLeft) : remaining;
  }
  return { allocated, remaining, pctBp: Math.min(ratioBasisPoints(Math.max(allocated, 0), goal.targetAmount), 10_000), reached, suggestedMonthly, monthsLeft };
}

/** Goals whose allocations still earmark money (archived/deleted goals release it). */
const earmarking = (g: Live<Goal>) => !g.deletedAt && g.status !== "archived";

export interface AccountAllocation {
  accountId: string;
  balance: Centavos;
  allocated: Centavos;
  unallocated: Centavos;
  overAllocated: boolean;
}

export function accountAllocations(
  goals: readonly Live<Goal>[],
  allocated: Map<string, Centavos>,
  balances: Map<string, Centavos>,
): AccountAllocation[] {
  const per = new Map<string, Centavos>();
  for (const g of goals) {
    if (!earmarking(g) || !g.accountId) continue;
    per.set(g.accountId, add(per.get(g.accountId) ?? 0, Math.max(allocated.get(g.id) ?? 0, 0)));
  }
  return [...per.entries()].map(([accountId, alloc]) => {
    const balance = balances.get(accountId) ?? 0;
    return { accountId, balance, allocated: alloc, unallocated: add(balance, -alloc), overAllocated: alloc > Math.max(balance, 0) };
  });
}

export interface EarmarkLine {
  id: string;
  name: string;
  amount: Centavos;
  note?: string;
}

/** Goal money that Safe-to-Spend should subtract, and goals it deliberately does not. */
export function goalEarmarks(
  goals: readonly Live<Goal>[],
  allocated: Map<string, Centavos>,
  accounts: readonly Live<Account>[],
): { deducted: EarmarkLine[]; notDeducted: EarmarkLine[] } {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const deducted: EarmarkLine[] = [];
  const notDeducted: EarmarkLine[] = [];
  for (const g of goals) {
    if (!earmarking(g)) continue;
    const amount = Math.max(allocated.get(g.id) ?? 0, 0);
    if (amount === 0) continue;
    const acc = g.accountId ? byId.get(g.accountId) : undefined;
    if (acc && isSpendable(acc)) deducted.push({ id: g.id, name: g.name, amount });
    else
      notDeducted.push({
        id: g.id,
        name: g.name,
        amount,
        note: acc ? "Held in an account that isn't counted as spendable" : "Not linked to an account",
      });
  }
  return { deducted, notDeducted };
}

/** Milestones (25/50/75/100 %) crossed between two progress values. */
export function crossedMilestones(beforeBp: number, afterBp: number): number[] {
  return [2500, 5000, 7500, 10_000].filter((m) => beforeBp < m && afterBp >= m).map((m) => m / 100);
}

// ------------------------------------------------------------------------- emergency fund

/**
 * Average monthly net spending in ESSENTIAL categories over the last `months` FULL months
 * (the current month is excluded). Integer centavos (floor).
 */
export function essentialMonthlyAverage(
  txns: readonly Live<Transaction>[],
  categories: readonly Live<Category>[],
  today: ISODate,
  months: CoverageMonths,
): { average: Centavos; monthsWithData: number } {
  const essential = categories.filter((c) => !c.deletedAt && c.kind === "expense" && c.isEssential);
  let total = 0;
  let withData = 0;
  for (let i = 1; i <= months; i++) {
    const start = startOfMonth(addMonths(startOfMonth(today), -i));
    const end = endOfMonth(start);
    let month = 0;
    for (const c of essential) month = add(month, netSpending(txns, start, end, c.id));
    if (month > 0) withData++;
    total = add(total, Math.max(month, 0));
  }
  return { average: Math.floor(total / months), monthsWithData: withData };
}

export interface EmergencyCoverage {
  fund: Centavos;
  monthlyEssentials: Centavos;
  /** Months covered, in tenths (e.g. 37 = 3.7 months); null if essentials are unknown. */
  coverageTenths: number | null;
  targetMonths: CoverageMonths;
  targetAmount: Centavos;
  pctOfTargetBp: number;
}

export function emergencyCoverage(fund: Centavos, monthlyEssentials: Centavos, targetMonths: CoverageMonths): EmergencyCoverage {
  const targetAmount = monthlyEssentials * targetMonths;
  return {
    fund,
    monthlyEssentials,
    coverageTenths: monthlyEssentials > 0 ? Math.floor((Math.max(fund, 0) * 10) / monthlyEssentials) : null,
    targetMonths,
    targetAmount,
    pctOfTargetBp: Math.min(ratioBasisPoints(Math.max(fund, 0), targetAmount), 10_000),
  };
}
