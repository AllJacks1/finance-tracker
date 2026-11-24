/**
 * Debts & loans. A debt is a `loan` liability account (Phase 1): outstanding = -balance.
 * A payment is ONE atomic group of ordinary transactions:
 *   - principal: transfer bank → loan account (reduces the liability; not spending)
 *   - interest:  expense ("Interest & Fees")   (spending)
 *
 * Interest methods
 *   diminishing — periodic rate × current outstanding (amortized; most bank loans)
 *   add_on      — periodic rate × ORIGINAL principal every period (flat; common in PH consumer loans)
 *   none        — 0% (e.g. many installment plans)
 *
 * All projections (payoff dates, strategy comparisons) are ESTIMATES: lenders round, compound
 * and apply fees differently. Integer centavos; BigInt for rate multiplications.
 */
import type { Debt } from "../domain/types";
import { addDays, addMonths, type ISODate } from "./dates";
import type { Centavos } from "./money";

export const PERIODS_PER_YEAR: Record<Debt["frequency"], number> = { weekly: 52, biweekly: 26, monthly: 12 };

/** round(amount × bp / (10000 × periods)) without floating-point or overflow. */
export function rateOf(amount: Centavos, aprBp: number, periodsPerYear: number): Centavos {
  if (amount <= 0 || aprBp <= 0) return 0;
  const num = BigInt(amount) * BigInt(aprBp);
  const den = BigInt(10_000 * periodsPerYear);
  const two = BigInt(2);
  return Number((num * two + den) / (den * two)); // round half up
}

export function periodicInterest(debt: Pick<Debt, "aprBp" | "interestMethod" | "frequency" | "originalPrincipal">, outstanding: Centavos): Centavos {
  const ppy = PERIODS_PER_YEAR[debt.frequency];
  if (outstanding <= 0) return 0;
  switch (debt.interestMethod) {
    case "none":
      return 0;
    case "add_on":
      return rateOf(debt.originalPrincipal, debt.aprBp, ppy); // flat: same every period until paid off
    case "diminishing":
      return rateOf(outstanding, debt.aprBp, ppy);
  }
}

/** Suggested split of a payment into interest and principal (editable to match the receipt). */
export function splitPayment(
  debt: Pick<Debt, "aprBp" | "interestMethod" | "frequency" | "originalPrincipal">,
  outstanding: Centavos,
  payment: Centavos,
): { interest: Centavos; principal: Centavos } {
  const interest = Math.min(payment, periodicInterest(debt, outstanding));
  const principal = Math.min(payment - interest, Math.max(outstanding, 0));
  return { interest, principal };
}

export interface PayoffProjection {
  periods: number;
  totalInterest: Centavos;
  totalPaid: Centavos;
  payoffDate: ISODate | null;
  neverPaysOff: boolean;
}

function stepDate(d: ISODate, freq: Debt["frequency"], n: number): ISODate {
  if (freq === "monthly") return addMonths(d, n);
  return addDays(d, n * (freq === "weekly" ? 7 : 14));
}

/** Payoff projection paying `payment` every period from `from`. */
export function projectPayoff(
  debt: Pick<Debt, "aprBp" | "interestMethod" | "frequency" | "originalPrincipal">,
  outstanding: Centavos,
  payment: Centavos,
  from: ISODate,
  maxPeriods = 1200,
): PayoffProjection {
  let balance = outstanding;
  let totalInterest = 0;
  let totalPaid = 0;
  let n = 0;
  while (balance > 0 && n < maxPeriods) {
    n++;
    const interest = periodicInterest(debt, balance);
    if (payment <= interest && debt.interestMethod === "diminishing")
      return { periods: n, totalInterest, totalPaid, payoffDate: null, neverPaysOff: true };
    const pay = Math.min(payment, balance + interest);
    const principal = pay - Math.min(pay, interest);
    if (principal <= 0) return { periods: n, totalInterest, totalPaid, payoffDate: null, neverPaysOff: true };
    totalInterest += Math.min(pay, interest);
    totalPaid += pay;
    balance -= principal;
  }
  if (balance > 0) return { periods: n, totalInterest, totalPaid, payoffDate: null, neverPaysOff: true };
  return { periods: n, totalInterest, totalPaid, payoffDate: stepDate(from, debt.frequency, n), neverPaysOff: false };
}

export function progressBp(originalPrincipal: Centavos, outstanding: Centavos): number {
  if (originalPrincipal <= 0) return outstanding <= 0 ? 10_000 : 0;
  const paid = Math.max(originalPrincipal - Math.max(outstanding, 0), 0);
  return Math.min(Math.floor((paid * 10_000) / originalPrincipal), 10_000);
}

// ---------------------------------------------------------------------------- strategies

export interface StrategyDebt {
  id: string;
  name: string;
  balance: Centavos;
  aprBp: number;
  /** Monthly minimum payment (convert weekly/biweekly before passing). */
  minPayment: Centavos;
}

export interface StrategyResult {
  strategy: "snowball" | "avalanche" | "minimum";
  months: number;
  totalInterest: Centavos;
  totalPaid: Centavos;
  payoff: { id: string; name: string; month: number | null }[];
  neverPaysOff: boolean;
}

/** Monthly-equivalent of a payment made at another frequency. */
export function monthlyEquivalent(amount: Centavos, freq: Debt["frequency"]): Centavos {
  return Math.round((amount * PERIODS_PER_YEAR[freq]) / 12);
}

/**
 * Month-by-month simulation. Each month: interest accrues (diminishing, monthly), every debt gets
 * its minimum, and the remaining budget (extra + minimums freed by paid-off debts) goes to the
 * target debt: smallest balance (snowball) or highest rate (avalanche).
 */
export function simulateStrategy(
  debts: readonly StrategyDebt[],
  extraMonthly: Centavos,
  strategy: "snowball" | "avalanche" | "minimum",
  maxMonths = 600,
): StrategyResult {
  const state = debts.map((d) => ({ ...d, balance: Math.max(d.balance, 0), paidMonth: d.balance <= 0 ? 0 : (null as number | null) }));
  const budget = debts.reduce((s, d) => s + d.minPayment, 0) + (strategy === "minimum" ? 0 : extraMonthly);
  let totalInterest = 0;
  let totalPaid = 0;
  let month = 0;
  while (state.some((d) => d.balance > 0) && month < maxMonths) {
    month++;
    for (const d of state) {
      if (d.balance <= 0) continue;
      const i = rateOf(d.balance, d.aprBp, 12);
      d.balance += i;
      totalInterest += i;
    }
    let remaining = budget;
    for (const d of state) {
      if (d.balance <= 0) continue;
      const pay = Math.min(d.minPayment, d.balance, remaining);
      d.balance -= pay;
      remaining -= pay;
      totalPaid += pay;
    }
    if (strategy !== "minimum") {
      const order = state
        .filter((d) => d.balance > 0)
        .sort((a, b) =>
          strategy === "snowball" ? a.balance - b.balance || b.aprBp - a.aprBp : b.aprBp - a.aprBp || a.balance - b.balance,
        );
      for (const d of order) {
        if (remaining <= 0) break;
        const pay = Math.min(d.balance, remaining);
        d.balance -= pay;
        remaining -= pay;
        totalPaid += pay;
      }
    }
    for (const d of state) if (d.balance <= 0 && d.paidMonth === null) d.paidMonth = month;
  }
  const neverPaysOff = state.some((d) => d.balance > 0);
  return {
    strategy,
    months: neverPaysOff ? maxMonths : month,
    totalInterest,
    totalPaid,
    payoff: state.map((d) => ({ id: d.id, name: d.name, month: d.paidMonth })),
    neverPaysOff,
  };
}

export function compareStrategies(debts: readonly StrategyDebt[], extraMonthly: Centavos) {
  return {
    minimum: simulateStrategy(debts, extraMonthly, "minimum"),
    snowball: simulateStrategy(debts, extraMonthly, "snowball"),
    avalanche: simulateStrategy(debts, extraMonthly, "avalanche"),
  };
}
