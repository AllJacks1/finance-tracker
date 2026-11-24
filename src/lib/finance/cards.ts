/**
 * Credit cards. The card is a liability ACCOUNT (Phase 1): purchases are expenses on it (count as
 * spending once), payments are transfers into it (never spending). This module only DERIVES card
 * figures from the ledger:
 *  - outstanding        = max(-balance, 0)
 *  - available credit   = limit - outstanding (installment principal is already inside outstanding)
 *  - statement cycles   from the statement day (short months clamp)
 *  - computed statement = owed at closing - installment principal not yet billed
 *  - minimum due        = max(floor, pct × non-installment part) + installments billed, capped
 * The amount on the bank's statement (bill.actualAmount) always takes precedence.
 */
import type { Account, CardProfile, InstallmentPlan, Transaction } from "../domain/types";
import { computeBalances } from "./balances";
import { addDays, type ISODate } from "./dates";
import { isLive } from "./ledger";
import { add, type Centavos } from "./money";
import { daysInMonth } from "./recurrence";

type Txn = Transaction & { deletedAt?: string | null };
const pad = (n: number) => String(n).padStart(2, "0");

/** Statement closing date in the given month. */
export function closingDateIn(profile: Pick<CardProfile, "statementDay">, year: number, month: number): ISODate {
  return `${year}-${pad(month)}-${pad(Math.min(profile.statementDay, daysInMonth(year, month)))}`;
}

function shiftMonth(y: number, m: number, by: number) {
  const t = y * 12 + (m - 1) + by;
  return { y: Math.floor(t / 12), m: (t % 12) + 1 };
}

/** Closing date of the cycle that contains `date` (the cycle ends on its closing date). */
export function cycleClosingFor(profile: Pick<CardProfile, "statementDay">, date: ISODate): ISODate {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const thisMonth = closingDateIn(profile, y, m);
  if (date <= thisMonth) return thisMonth;
  const n = shiftMonth(y, m, 1);
  return closingDateIn(profile, n.y, n.m);
}

export function previousClosing(profile: Pick<CardProfile, "statementDay">, closing: ISODate): ISODate {
  const p = shiftMonth(Number(closing.slice(0, 4)), Number(closing.slice(5, 7)), -1);
  return closingDateIn(profile, p.y, p.m);
}

export function nextClosing(profile: Pick<CardProfile, "statementDay">, closing: ISODate): ISODate {
  const n = shiftMonth(Number(closing.slice(0, 4)), Number(closing.slice(5, 7)), 1);
  return closingDateIn(profile, n.y, n.m);
}

export const dueDateFor = (profile: Pick<CardProfile, "dueDaysAfterStatement">, closing: ISODate) =>
  addDays(closing, profile.dueDaysAfterStatement);

/** Closing dates within [from, to]. */
export function closingsBetween(profile: Pick<CardProfile, "statementDay">, from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let c = cycleClosingFor(profile, from); c <= to; c = nextClosing(profile, c)) out.push(c);
  return out;
}

/** How many installments of a plan have been billed on or before `closing`. */
export function installmentsBilled(plan: InstallmentPlan, profile: Pick<CardProfile, "statementDay">, closing: ISODate): number {
  if (plan.status !== "active" || closing < plan.firstBillingDate) return 0;
  let n = 0;
  for (let c = cycleClosingFor(profile, plan.firstBillingDate); c <= closing && n < plan.months; c = nextClosing(profile, c)) n++;
  return n;
}

/** Amount billed for installment number k (1-based); the last one absorbs rounding. */
export function installmentAmount(plan: InstallmentPlan, k: number): Centavos {
  if (k < plan.months) return plan.monthlyAmount;
  return Math.max(plan.principal - plan.monthlyAmount * (plan.months - 1), 0);
}

export function billedPrincipal(plan: InstallmentPlan, profile: Pick<CardProfile, "statementDay">, closing: ISODate): Centavos {
  const n = installmentsBilled(plan, profile, closing);
  let total = 0;
  for (let k = 1; k <= n; k++) total = add(total, installmentAmount(plan, k));
  return Math.min(total, plan.principal);
}

/** Installment principal that is in the card balance but not billed yet as of `closing`. */
export function unbilledInstallments(
  plans: readonly InstallmentPlan[],
  profile: Pick<CardProfile, "statementDay">,
  closing: ISODate,
  purchaseDate: (plan: InstallmentPlan) => ISODate | null = () => null,
): Centavos {
  let total = 0;
  for (const p of plans) {
    if (p.status !== "active") continue;
    // Only purchases already in the balance at this closing (unknown date: billed from the next cycle).
    const bought = purchaseDate(p);
    if (bought ? bought > closing : p.firstBillingDate > nextClosing(profile, closing)) continue;
    total = add(total, p.principal - billedPrincipal(p, profile, closing));
  }
  return total;
}

/** Installment amounts billed in the statement that closes on `closing`. */
export function installmentsDueIn(plans: readonly InstallmentPlan[], profile: Pick<CardProfile, "statementDay">, closing: ISODate): Centavos {
  let total = 0;
  for (const p of plans) {
    const n = installmentsBilled(p, profile, closing);
    const prev = installmentsBilled(p, profile, previousClosing(profile, closing));
    if (n > prev) total = add(total, installmentAmount(p, n));
  }
  return total;
}

export function outstandingOf(balance: Centavos): Centavos {
  return Math.max(-balance, 0);
}

export function availableCredit(profile: Pick<CardProfile, "creditLimit">, balance: Centavos): Centavos {
  return add(profile.creditLimit, -outstandingOf(balance));
}

export interface CardStatement {
  closingDate: ISODate;
  dueDate: ISODate;
  cycleStart: ISODate;
  /** Owed at closing, excluding installment principal not yet billed. */
  statementBalance: Centavos;
  installmentsBilled: Centavos;
  minimumDue: Centavos;
}

export function minimumDue(profile: CardProfile, statementBalance: Centavos, installmentsPart: Centavos): Centavos {
  if (statementBalance <= 0) return 0;
  const revolving = Math.max(statementBalance - installmentsPart, 0);
  const pct = Math.round((revolving * profile.minPaymentPctBp) / 10_000);
  const base = revolving > 0 ? Math.max(profile.minPaymentFloor, pct) : 0;
  return Math.min(add(base, installmentsPart), statementBalance);
}

/** Statement computed from the ledger (an estimate; the bank's figure overrides it). */
export function computeStatement(
  profile: CardProfile,
  card: Account & { deletedAt?: string | null },
  txns: readonly Txn[],
  plans: readonly InstallmentPlan[],
  closing: ISODate,
): CardStatement {
  const balance = computeBalances([card], txns, closing).get(card.id) ?? 0;
  const owed = outstandingOf(balance);
  const cardPlans = plans.filter((p) => p.cardAccountId === card.id);
  const dates = new Map(txns.map((t) => [t.id, t.localDate]));
  const unbilled = unbilledInstallments(cardPlans, profile, closing, (p) => (p.transactionId ? (dates.get(p.transactionId) ?? null) : null));
  const statementBalance = Math.max(owed - unbilled, 0);
  const inst = Math.min(installmentsDueIn(cardPlans, profile, closing), statementBalance);
  return {
    closingDate: closing,
    dueDate: dueDateFor(profile, closing),
    cycleStart: addDays(previousClosing(profile, closing), 1),
    statementBalance,
    installmentsBilled: inst,
    minimumDue: minimumDue(profile, statementBalance, inst),
  };
}

/**
 * Payments toward a card statement: transfers into the card linked to that bill, plus unlinked
 * transfers into the card made after the closing date and up to the next closing.
 */
export function cardPaymentsFor(
  billId: string,
  cardAccountId: string,
  profile: Pick<CardProfile, "statementDay">,
  closing: ISODate,
  txns: readonly Txn[],
): Txn[] {
  const next = nextClosing(profile, closing);
  return txns.filter(
    (t) =>
      isLive(t) &&
      t.type === "transfer" &&
      t.toAccountId === cardAccountId &&
      (t.billId === billId || (!t.billId && t.localDate > closing && t.localDate <= next)),
  );
}
