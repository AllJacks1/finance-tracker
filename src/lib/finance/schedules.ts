/**
 * Scheduled / recurring TRANSACTIONS (planned income, expenses, transfers).
 *
 * Three clearly separate states:
 *   scheduled           — a future occurrence; affects only projections, never balances
 *   needs_confirmation  — its date has arrived; still NOT in balances until confirmed
 *   completed           — confirmed: a real transaction exists (deterministic id + unique index)
 * Skipped occurrences are kept for history. Nothing is ever generated in the background.
 */
import { occurrenceTxnId } from "../domain/ids";
import type { Schedule, ScheduleException, Transaction } from "../domain/types";
import { addDays, type ISODate } from "./dates";
import { isLive } from "./ledger";
import type { Centavos } from "./money";
import { occurrencesBetween } from "./recurrence";

type Txn = Transaction & { deletedAt?: string | null };

export type OccurrenceState = "scheduled" | "needs_confirmation" | "completed" | "skipped";

export interface Occurrence {
  key: string;
  scheduleId: string;
  schedule: Schedule;
  /** Nominal date from the rule (identity of the occurrence). */
  nominalDate: ISODate;
  /** Date after any override. */
  date: ISODate;
  amount: Centavos;
  state: OccurrenceState;
  /** Deterministic id of the transaction created when confirmed. */
  txnId: string;
  transaction: Txn | null;
  exception: ScheduleException | null;
}

/** How far back unconfirmed occurrences are listed as "needs confirmation". */
export const CONFIRMATION_LOOKBACK_DAYS = 90;

export function scheduleOccurrences(
  s: Schedule & { deletedAt?: string | null },
  from: ISODate,
  to: ISODate,
  ctx: { today: ISODate; exceptions: readonly (ScheduleException & { deletedAt?: string | null })[]; txns: readonly Txn[] },
): Occurrence[] {
  if (s.deletedAt || s.kind !== "transaction") return [];
  const exc = new Map(ctx.exceptions.filter((e) => !e.deletedAt && e.scheduleId === s.id).map((e) => [e.occurrenceDate, e]));
  const done = new Map(ctx.txns.filter((t) => isLive(t) && t.scheduleId === s.id && t.occurrenceDate).map((t) => [t.occurrenceDate!, t]));
  const out: Occurrence[] = [];
  for (const d of occurrencesBetween(s.rule, from, to, s.pauses)) {
    const e = exc.get(d) ?? null;
    const t = done.get(d) ?? null;
    const date = e?.overrideDate ?? d;
    let state: OccurrenceState;
    if (t) state = "completed";
    else if (e?.action === "skip") state = "skipped";
    else if (s.status === "cancelled") continue; // cancelled: only history remains
    else state = date <= ctx.today ? "needs_confirmation" : "scheduled";
    out.push({
      key: `schedule:${s.id}:${d}`,
      scheduleId: s.id,
      schedule: s,
      nominalDate: d,
      date,
      amount: t?.amount ?? e?.overrideAmount ?? s.amount,
      state,
      txnId: occurrenceTxnId(s.id, d),
      transaction: t,
      exception: e,
    });
  }
  return out;
}

export function allOccurrences(
  schedules: readonly (Schedule & { deletedAt?: string | null })[],
  from: ISODate,
  to: ISODate,
  ctx: Parameters<typeof scheduleOccurrences>[3],
): Occurrence[] {
  return schedules
    .flatMap((s) => scheduleOccurrences(s, from, to, ctx))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Occurrences waiting for the user's confirmation (date reached, not confirmed/skipped). */
export function pendingConfirmations(
  schedules: readonly (Schedule & { deletedAt?: string | null })[],
  ctx: Parameters<typeof scheduleOccurrences>[3],
): Occurrence[] {
  return allOccurrences(schedules, addDays(ctx.today, -CONFIRMATION_LOOKBACK_DAYS), ctx.today, ctx).filter(
    (o) => o.state === "needs_confirmation",
  );
}

/** The transaction to create when an occurrence is confirmed (amount/date may be edited). */
export function occurrenceToTransaction(
  o: Occurrence,
  edits: { amount?: Centavos; date?: ISODate; occurredAt?: string } = {},
): Omit<Transaction, "localDate"> {
  const s = o.schedule;
  const date = edits.date ?? o.date;
  return {
    id: o.txnId,
    type: s.txnType,
    amount: edits.amount ?? o.amount,
    accountId: s.accountId!,
    toAccountId: s.txnType === "transfer" ? s.toAccountId : null,
    adjustmentDirection: null,
    categoryId: s.txnType === "transfer" ? null : s.categoryId,
    occurredAt: edits.occurredAt ?? `${date}T12:00:00+08:00`,
    description: s.description ?? s.name,
    notes: s.notes,
    tagIds: s.tagIds,
    refundOfId: null,
    allocationId: null,
    billId: null,
    scheduleId: s.id,
    occurrenceDate: o.nominalDate,
    debtId: null,
    installmentPlanId: null,
    groupId: null,
    importBatchId: null,
    importFingerprint: null,
  };
}
