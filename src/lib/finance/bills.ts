/**
 * Bills: one obligation instance each. Status is DERIVED, never stored (except "cancelled"):
 *
 *   due         = actual ?? expected
 *   paid        = Σ linked live payment transactions (card bills: see cards.cardPaymentsFor)
 *   outstanding = max(due - paid, 0)
 *   status      = cancelled | paid | partially_paid | overdue | due_today | upcoming
 *
 * Recurring bills and card statements are VIRTUAL until the user acts on them (pays, enters the
 * actual amount, attaches a receipt, cancels); then they are materialized with a deterministic id.
 * The payment transaction is the only thing that touches balances and budgets; the bill is the
 * only thing that counts as an outstanding obligation — so nothing is counted twice.
 */
import { billOccurrenceId, cardStatementBillId } from "../domain/ids";
import type { Account, Bill, CardProfile, InstallmentPlan, Schedule, ScheduleException, Transaction } from "../domain/types";
import { closingsBetween, cardPaymentsFor, computeStatement } from "./cards";
import type { ISODate } from "./dates";
import { isLive } from "./ledger";
import { add, type Centavos } from "./money";
import { occurrencesBetween } from "./recurrence";

type Txn = Transaction & { deletedAt?: string | null };

export type BillStatus = "cancelled" | "paid" | "partially_paid" | "overdue" | "due_today" | "upcoming";

export interface BillView extends Bill {
  /** Stable key for lists/calendar dedupe. */
  key: string;
  /** Not stored yet (computed from a schedule or card profile). */
  virtual: boolean;
  due: Centavos;
  paid: Centavos;
  outstanding: Centavos;
  status: BillStatus;
  payments: Txn[];
}

export const billDue = (b: Pick<Bill, "actualAmount" | "expectedAmount">) => b.actualAmount ?? b.expectedAmount;

export function billStatus(b: Pick<Bill, "cancelled" | "dueDate">, due: Centavos, paid: Centavos, today: ISODate): BillStatus {
  if (b.cancelled) return "cancelled";
  if (paid >= due && (due > 0 || paid > 0)) return "paid";
  if (due === 0) return "paid";
  if (paid > 0) return b.dueDate < today ? "overdue" : "partially_paid";
  if (b.dueDate < today) return "overdue";
  if (b.dueDate === today) return "due_today";
  return "upcoming";
}

export const STATUS_LABEL: Record<BillStatus, string> = {
  cancelled: "Cancelled",
  paid: "Paid",
  partially_paid: "Partially paid",
  overdue: "Overdue",
  due_today: "Due today",
  upcoming: "Upcoming",
};

function view(b: Bill, virtual: boolean, payments: Txn[], today: ISODate): BillView {
  const due = billDue(b);
  let paid = 0;
  for (const t of payments) paid = add(paid, t.amount);
  return {
    ...b,
    key: `bill:${b.id}`,
    virtual,
    due,
    paid,
    outstanding: Math.max(due - paid, 0),
    status: billStatus(b, due, paid, today),
    payments,
  };
}

/** Virtual bill for a bill-schedule occurrence (honours skip/override exceptions). */
export function virtualBillFor(s: Schedule, nominal: ISODate, exc?: ScheduleException): Bill | null {
  if (exc?.action === "skip") return null;
  return {
    id: billOccurrenceId(s.id, nominal),
    name: s.name,
    kind: s.billKind ?? "general",
    categoryId: s.categoryId,
    expectedAmount: exc?.overrideAmount ?? s.amount,
    actualAmount: null,
    minimumAmount: null,
    dueDate: exc?.overrideDate ?? nominal,
    accountId: s.accountId,
    notes: s.notes,
    scheduleId: s.id,
    occurrenceDate: nominal,
    cardAccountId: s.cardAccountId,
    debtId: s.debtId,
    statementClosingDate: null,
    cancelled: false,
  };
}

export interface BillInputs {
  bills: readonly (Bill & { deletedAt?: string | null })[];
  schedules: readonly (Schedule & { deletedAt?: string | null })[];
  exceptions: readonly (ScheduleException & { deletedAt?: string | null })[];
  cardProfiles: readonly (CardProfile & { deletedAt?: string | null })[];
  plans: readonly (InstallmentPlan & { deletedAt?: string | null })[];
  accounts: readonly (Account & { deletedAt?: string | null })[];
  txns: readonly Txn[];
  today: ISODate;
}

/**
 * All bills relevant to [from, to]: stored bills with a due date in range, plus virtual bills
 * from active bill schedules and card statements in range. Unpaid stored bills before `from`
 * (overdue) are always included. A stored bill replaces its virtual twin (same deterministic id).
 */
export function buildBillViews(input: BillInputs, from: ISODate, to: ISODate): BillView[] {
  const { today } = input;
  const live = input.txns.filter(isLive);
  const byBill = new Map<string, Txn[]>();
  for (const t of live) if (t.billId) (byBill.get(t.billId) ?? byBill.set(t.billId, []).get(t.billId)!).push(t);

  const stored = input.bills.filter((b) => !b.deletedAt);
  const storedIds = new Set(input.bills.map((b) => b.id)); // deleted stored bills suppress their virtual twin too
  const out: BillView[] = [];
  const profiles = new Map(input.cardProfiles.filter((p) => !p.deletedAt).map((p) => [p.accountId, p]));

  const paymentsOf = (b: Bill): Txn[] => {
    if (b.kind === "card_payment" && b.cardAccountId && b.statementClosingDate) {
      const prof = profiles.get(b.cardAccountId);
      if (prof) return cardPaymentsFor(b.id, b.cardAccountId, prof, b.statementClosingDate, live);
    }
    return byBill.get(b.id) ?? [];
  };

  for (const b of stored) {
    const v = view(b, false, paymentsOf(b), today);
    const inRange = b.dueDate >= from && b.dueDate <= to;
    const openOverdue = b.dueDate < from && v.outstanding > 0 && !b.cancelled;
    if (inRange || openOverdue) out.push(v);
  }

  // Recurring bills
  const excBy = new Map<string, ScheduleException>();
  for (const e of input.exceptions) if (!e.deletedAt) excBy.set(`${e.scheduleId}:${e.occurrenceDate}`, e);
  for (const s of input.schedules) {
    if (s.deletedAt || s.kind !== "bill" || s.status === "cancelled") continue;
    for (const d of occurrencesBetween(s.rule, from, to, s.pauses)) {
      const vb = virtualBillFor(s, d, excBy.get(`${s.id}:${d}`));
      if (!vb || storedIds.has(vb.id)) continue;
      out.push(view(vb, true, paymentsOf(vb), today));
    }
  }

  // Card statements (cards with automatic bills)
  for (const prof of profiles.values()) {
    if (!prof.autoBills) continue;
    const card = input.accounts.find((a) => a.id === prof.accountId && !a.deletedAt);
    if (!card) continue;
    const cardPlans = input.plans.filter((p) => !p.deletedAt && p.cardAccountId === card.id);
    // Statements whose DUE date falls in range: closings from (from - 60d) is enough.
    for (const closing of closingsBetween(prof, shift(from, -62), to)) {
      if (closing > today) continue; // a statement exists only once its cycle has closed
      const id = cardStatementBillId(card.id, closing);
      if (storedIds.has(id)) continue;
      const st = computeStatement(prof, card, live, cardPlans, closing);
      if (st.statementBalance === 0) continue;
      const vb: Bill = {
        id,
        name: `${card.name} statement`,
        kind: "card_payment",
        categoryId: null,
        expectedAmount: st.statementBalance,
        actualAmount: null,
        minimumAmount: st.minimumDue,
        dueDate: st.dueDate,
        accountId: null,
        notes: null,
        scheduleId: null,
        occurrenceDate: null,
        cardAccountId: card.id,
        debtId: null,
        statementClosingDate: closing,
        cancelled: false,
      };
      const v = view(vb, true, paymentsOf(vb), today);
      const inRange = v.dueDate >= from && v.dueDate <= to;
      const openOverdue = v.dueDate < from && v.outstanding > 0;
      if (inRange || openOverdue) out.push(v);
    }
  }

  return out.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.name.localeCompare(b.name)));
}

function shift(d: ISODate, days: number): ISODate {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** Bills that still need money, due on or before `until` (overdue included). */
export function outstandingBills(views: readonly BillView[], until: ISODate): BillView[] {
  return views.filter((b) => !b.cancelled && b.outstanding > 0 && b.dueDate <= until);
}
