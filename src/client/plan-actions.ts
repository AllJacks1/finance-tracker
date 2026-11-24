"use client";
/**
 * Phase 2 actions: bills, schedules, occurrences. Everything is written locally and queued for
 * sync; multi-record changes use ATOMIC GROUPS (all-or-nothing, also on the server).
 * Occurrence records use DETERMINISTIC ids so two devices can never create duplicates.
 */
import type { Bill, EntityMap, EntityName, Schedule, ScheduleException, Transaction } from "@/lib/domain/types";
import { TXN_LINKS } from "@/lib/domain/types";
import { scheduleExceptionId } from "@/lib/domain/ids";
import type { BillView } from "@/lib/finance/bills";
import { addDays, localDateOf, type ISODate } from "@/lib/finance/dates";
import { validateTransaction } from "@/lib/finance/ledger";
import type { Centavos } from "@/lib/finance/money";
import { splitRule } from "@/lib/finance/recurrence";
import { occurrenceToTransaction, type Occurrence } from "@/lib/finance/schedules";
import { entitySchemas } from "@/lib/sync/protocol";
import { ActionError, newId } from "./actions";
import { withPreferences } from "./settings";
import { vault } from "./vault";

type Change = { entity: EntityName; id: string; kind: "create" | "update" | "delete" | "restore"; data?: unknown };

function store() {
  if (!vault.store) throw new ActionError("Your data is locked.");
  return vault.store;
}

function timezone(): string {
  return withPreferences(store().list("settings")[0]?.data).timezone;
}

function validated<E extends EntityName>(entity: E, data: EntityMap[E]): EntityMap[E] {
  const r = entitySchemas[entity].safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new ActionError(i ? `${i.path.join(".") || "value"}: ${i.message}` : "Invalid data");
  }
  return r.data as EntityMap[E];
}

/** create, update, or restore+update — whichever the local state needs. */
function upsertChanges<E extends EntityName>(entity: E, data: EntityMap[E]): Change[] {
  const id = (data as { id: string }).id;
  const cur = store().get(entity, id);
  const clean = validated(entity, data);
  if (!cur) return [{ entity, id, kind: "create", data: clean }];
  if (cur.deletedAt) return [{ entity, id, kind: "restore" }];
  return [{ entity, id, kind: "update", data: clean }];
}

async function apply(changes: Change[]) {
  // restore + update of the same record can't share a group (one op per record): do them in order.
  const restores = changes.filter((c) => c.kind === "restore");
  for (const r of restores) await store().mutate(r.entity, r.id, "restore");
  const rest = changes.filter((c) => c.kind !== "restore");
  if (rest.length === 1) {
    const c = rest[0]!;
    await store().mutate(c.entity, c.id, c.kind, c.data as never);
  } else if (rest.length > 1) await store().mutateGroup(rest);
}

function txnWithDate(t: Omit<Transaction, "localDate">): Transaction {
  const full: Transaction = { ...t, localDate: localDateOf(t.occurredAt, timezone()) };
  const s = store();
  const issues = validateTransaction(full, {
    accounts: new Map(s.list("account").map((a) => [a.id, a.data])),
    categories: new Map(s.list("category").map((c) => [c.id, c.data])),
  });
  if (issues.length) throw new ActionError(issues[0]!.message);
  return full;
}

const noonOn = (date: ISODate) => `${date}T12:00:00+08:00`;

// ----------------------------------------------------------------------------- schedules

export async function saveSchedule(s: Schedule) {
  await apply(upsertChanges("schedule", s));
}

export async function pauseSchedule(s: Schedule, from: ISODate) {
  if (s.status !== "active") return;
  await apply(upsertChanges("schedule", { ...s, status: "paused", pauses: [...s.pauses, { from, to: null }] }));
}

/** Resume: closes the open pause window yesterday. Paused occurrences are NOT back-filled. */
export async function resumeSchedule(s: Schedule, today: ISODate) {
  if (s.status !== "paused") return;
  const pauses = s.pauses.map((p) => (p.to === null ? { ...p, to: addDays(today, -1) < p.from ? p.from : addDays(today, -1) } : p));
  await apply(upsertChanges("schedule", { ...s, status: "active", pauses }));
}

export async function cancelSchedule(s: Schedule) {
  await apply(upsertChanges("schedule", { ...s, status: "cancelled" }));
}

/**
 * Edit FUTURE occurrences from `from`: the current schedule ends the day before, and a new
 * schedule (linked via previousScheduleId) starts at the next occurrence. One atomic group.
 */
export async function editFutureOccurrences(s: Schedule, from: ISODate, changes: Partial<Schedule>) {
  const split = splitRule(s.rule, from);
  if (!split) throw new ActionError("There are no future occurrences to change.");
  const next: Schedule = {
    ...s,
    ...changes,
    id: newId(),
    rule: { ...split.next, ...(changes.rule ?? {}) },
    pauses: [],
    status: "active",
    previousScheduleId: s.id,
  };
  await apply([
    ...upsertChanges("schedule", { ...s, rule: split.ended }),
    { entity: "schedule", id: next.id, kind: "create", data: validated("schedule", next) },
  ]);
  return next;
}

// ----------------------------------------------------------------------------- occurrences

/** Confirm a scheduled occurrence: creates the real transaction (deterministic id). */
export async function confirmOccurrence(o: Occurrence, edits: { amount?: Centavos; date?: ISODate } = {}) {
  if (!o.schedule.accountId) throw new ActionError("This schedule has no account.");
  const t = txnWithDate(occurrenceToTransaction(o, { ...edits, occurredAt: edits.date ? noonOn(edits.date) : undefined }));
  await apply(upsertChanges("transaction", t));
}

export async function skipOccurrence(o: Occurrence) {
  const e: ScheduleException = {
    id: scheduleExceptionId(o.scheduleId, o.nominalDate),
    scheduleId: o.scheduleId,
    occurrenceDate: o.nominalDate,
    action: "skip",
    overrideDate: null,
    overrideAmount: null,
  };
  await apply(upsertChanges("scheduleException", e));
}

export async function overrideOccurrence(o: Occurrence, edits: { date: ISODate | null; amount: Centavos | null }) {
  const e: ScheduleException = {
    id: scheduleExceptionId(o.scheduleId, o.nominalDate),
    scheduleId: o.scheduleId,
    occurrenceDate: o.nominalDate,
    action: "override",
    overrideDate: edits.date,
    overrideAmount: edits.amount,
  };
  await apply(upsertChanges("scheduleException", e));
}

/** Undo a skip/override. */
export async function clearException(o: Occurrence) {
  if (o.exception) await store().mutate("scheduleException", o.exception.id, "delete");
}

// ----------------------------------------------------------------------------- bills

function billRecord(b: BillView | Bill): Bill {
  return {
    id: b.id,
    name: b.name,
    kind: b.kind,
    categoryId: b.categoryId,
    expectedAmount: b.expectedAmount,
    actualAmount: b.actualAmount,
    minimumAmount: b.minimumAmount,
    dueDate: b.dueDate,
    accountId: b.accountId,
    notes: b.notes,
    scheduleId: b.scheduleId,
    occurrenceDate: b.occurrenceDate,
    cardAccountId: b.cardAccountId,
    debtId: b.debtId,
    statementClosingDate: b.statementClosingDate,
    cancelled: b.cancelled,
  };
}

/** Save a bill. A virtual (recurring/card) bill is materialized under its deterministic id. */
export async function saveBill(b: BillView | Bill) {
  await apply(upsertChanges("bill", billRecord(b)));
}

export async function cancelBill(b: BillView) {
  await saveBill({ ...billRecord(b), cancelled: true });
}

export async function uncancelBill(b: BillView) {
  await saveBill({ ...billRecord(b), cancelled: false });
}

/**
 * Pay (part of) a bill. One atomic group: [materialize the bill if virtual] + the payment.
 *  - general bills: an EXPENSE (counts as spending once, here)
 *  - card statements / loan installments: a TRANSFER into the card/loan account (not spending;
 *    the purchases/interest were already counted)
 */
export async function payBill(
  b: BillView,
  p: { amount: Centavos; accountId: string; date: ISODate; categoryId?: string | null; interest?: Centavos; loanAccountId?: string | null },
) {
  if (b.cancelled) throw new ActionError("This bill was cancelled.");
  if (p.amount <= 0) throw new ActionError("Enter an amount.");
  const changes: Change[] = [];
  const cur = store().get("bill", b.id);
  if (!cur || cur.deletedAt) changes.push(...upsertChanges("bill", billRecord(b)));
  const base = {
    ...TXN_LINKS,
    adjustmentDirection: null,
    occurredAt: noonOn(p.date),
    notes: null,
    tagIds: [] as string[],
    refundOfId: null,
    billId: b.id,
  };
  if (b.kind === "card_payment") {
    if (!b.cardAccountId) throw new ActionError("This statement has no card.");
    const t = txnWithDate({ ...base, id: newId(), type: "transfer", amount: p.amount, accountId: p.accountId, toAccountId: b.cardAccountId, categoryId: null, description: `${b.name} payment` });
    changes.push({ entity: "transaction", id: t.id, kind: "create", data: validated("transaction", t) });
  } else if (b.kind === "loan_installment") {
    if (!p.loanAccountId) throw new ActionError("This installment has no loan account.");
    const interest = Math.min(p.interest ?? 0, p.amount);
    const principal = p.amount - interest;
    if (principal > 0) {
      const t = txnWithDate({ ...base, id: newId(), type: "transfer", amount: principal, accountId: p.accountId, toAccountId: p.loanAccountId, categoryId: null, description: `${b.name} (principal)`, debtId: b.debtId });
      changes.push({ entity: "transaction", id: t.id, kind: "create", data: validated("transaction", t) });
    }
    if (interest > 0) {
      const t = txnWithDate({ ...base, id: newId(), type: "expense", amount: interest, accountId: p.accountId, toAccountId: null, categoryId: p.categoryId ?? null, description: `${b.name} (interest)`, debtId: b.debtId });
      changes.push({ entity: "transaction", id: t.id, kind: "create", data: validated("transaction", t) });
    }
  } else {
    const t = txnWithDate({ ...base, id: newId(), type: "expense", amount: p.amount, accountId: p.accountId, toAccountId: null, categoryId: p.categoryId ?? b.categoryId, description: b.name });
    changes.push({ entity: "transaction", id: t.id, kind: "create", data: validated("transaction", t) });
  }
  await apply(changes);
}

/** For the Quick Add form: make sure a (possibly virtual) bill exists before linking a payment. */
export async function ensureBillStored(b: BillView) {
  const cur = store().get("bill", b.id);
  if (!cur || cur.deletedAt) await saveBill(b);
}
