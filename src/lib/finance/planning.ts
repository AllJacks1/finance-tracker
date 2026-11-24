/**
 * Planning views that combine modules: scheduled outflows for Safe-to-Spend, projected cash flow,
 * the financial calendar, and in-app notifications. Pure functions; same on server and device.
 *
 * Counting rules (no double counting):
 *  - Actual balances come only from the ledger.
 *  - Obligations come only from BILLS (incl. card statements and loan installments).
 *  - Scheduled transactions add projected flows only while unconfirmed. A scheduled transfer that
 *    `paysBillScheduleId` counts zero: its bill already counts.
 *  - Scheduled income is never added to Safe-to-Spend (not received yet); it is in the cash flow.
 */
import type { Account, Budget, Goal, Preferences, Schedule } from "../domain/types";
import { isSpendable } from "./balances";
import type { BillView } from "./bills";
import { STATUS_LABEL } from "./bills";
import { addDays, type ISODate } from "./dates";
import type { BudgetProgress } from "./budgets";
import type { GoalProgress } from "./goals";
import { add, formatPHP, type Centavos } from "./money";
import type { Occurrence } from "./schedules";

type Acc = Account & { deletedAt?: string | null };

/** Effect of one occurrence on SPENDABLE money (+ in, - out, 0 = moves between spendable accounts). */
export function spendableEffect(s: Schedule, amount: Centavos, accounts: Map<string, Acc>): Centavos {
  const from = s.accountId ? accounts.get(s.accountId) : undefined;
  const to = s.toAccountId ? accounts.get(s.toAccountId) : undefined;
  const fromSp = !!from && isSpendable(from);
  const toSp = !!to && isSpendable(to);
  if (s.txnType === "income") return fromSp ? amount : 0;
  if (s.txnType === "expense") return fromSp ? -amount : 0;
  if (fromSp && !toSp) return -amount;
  if (!fromSp && toSp) return amount;
  return 0;
}

export interface FlowLine {
  key: string;
  name: string;
  date: ISODate;
  amount: Centavos; // positive = money needed (outflow)
  note?: string;
}

/** Unconfirmed scheduled outflows from spendable money due on/before the horizon. */
export function scheduledOutflows(occurrences: readonly Occurrence[], accounts: readonly Acc[], horizon: ISODate): FlowLine[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out: FlowLine[] = [];
  for (const o of occurrences) {
    if (o.state !== "scheduled" && o.state !== "needs_confirmation") continue;
    if (o.date > horizon || o.schedule.paysBillScheduleId) continue;
    const effect = spendableEffect(o.schedule, o.amount, byId);
    if (effect < 0) out.push({ key: o.key, name: o.schedule.name, date: o.date, amount: -effect });
  }
  return out;
}

/** Next date with scheduled income into a spendable account (for the "next income" horizon). */
export function nextIncomeDate(occurrences: readonly Occurrence[], accounts: readonly Acc[], today: ISODate): ISODate | null {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const o of occurrences) {
    if (o.state !== "scheduled" || o.date <= today) continue;
    if (spendableEffect(o.schedule, o.amount, byId) > 0 && o.schedule.txnType === "income") return o.date;
  }
  return null;
}

// --------------------------------------------------------------------------- cash flow

export interface CashflowDay {
  date: ISODate;
  inflow: Centavos;
  outflow: Centavos;
  balance: Centavos;
  items: { key: string; name: string; amount: Centavos }[];
}

/**
 * Projected SPENDABLE balance per day, starting from today's actual spendable balance.
 * Overdue/unconfirmed items are placed on today (they still have to happen).
 */
export function projectCashflow(input: {
  spendableBalance: Centavos;
  today: ISODate;
  days: number;
  occurrences: readonly Occurrence[];
  bills: readonly BillView[];
  accounts: readonly Acc[];
}): { days: CashflowDay[]; lowest: CashflowDay } {
  const { today } = input;
  const end = addDays(today, input.days - 1);
  const byId = new Map(input.accounts.map((a) => [a.id, a]));
  const map = new Map<ISODate, CashflowDay>();
  for (let d = today; d <= end; d = addDays(d, 1)) map.set(d, { date: d, inflow: 0, outflow: 0, balance: 0, items: [] });
  const put = (date: ISODate, key: string, name: string, amount: Centavos) => {
    const day = map.get(date < today ? today : date);
    if (!day || amount === 0) return;
    if (amount > 0) day.inflow = add(day.inflow, amount);
    else day.outflow = add(day.outflow, -amount);
    day.items.push({ key, name, amount });
  };
  for (const o of input.occurrences) {
    if (o.state !== "scheduled" && o.state !== "needs_confirmation") continue;
    if (o.date > end || o.schedule.paysBillScheduleId) continue;
    put(o.date, o.key, o.schedule.name, spendableEffect(o.schedule, o.amount, byId));
  }
  for (const b of input.bills) {
    if (b.cancelled || b.outstanding === 0 || b.dueDate > end) continue;
    const pay = b.accountId ? byId.get(b.accountId) : undefined;
    if (pay && !isSpendable(pay)) continue;
    put(b.dueDate, b.key, b.name, -b.outstanding);
  }
  let running = input.spendableBalance;
  const days = [...map.values()];
  let lowest = days[0]!;
  for (const d of days) {
    running = add(running, d.inflow, -d.outflow);
    d.balance = running;
    if (d.balance < lowest.balance) lowest = d;
  }
  return { days, lowest };
}

// --------------------------------------------------------------------------- calendar

export type CalendarKind = "bill" | "income" | "expense" | "transfer" | "goal";

export interface CalendarItem {
  key: string;
  date: ISODate;
  kind: CalendarKind;
  title: string;
  amount: Centavos;
  status: string;
  overdue: boolean;
  done: boolean;
  ref: { type: "bill"; bill: BillView } | { type: "occurrence"; occurrence: Occurrence } | { type: "goal"; goalId: string };
}

/**
 * One merged, de-duplicated list. Every obligation has exactly one source (bills cover card dues
 * and loan installments), and each item has a stable key, so nothing appears twice.
 */
export function calendarItems(input: {
  bills: readonly BillView[];
  occurrences: readonly Occurrence[];
  goals: readonly { goal: Goal; progress: GoalProgress }[];
  from: ISODate;
  to: ISODate;
  today: ISODate;
}): CalendarItem[] {
  const seen = new Set<string>();
  const out: CalendarItem[] = [];
  const push = (i: CalendarItem) => {
    if (seen.has(i.key)) return;
    seen.add(i.key);
    out.push(i);
  };
  for (const b of input.bills) {
    const date = b.dueDate < input.from && b.outstanding > 0 ? b.dueDate : b.dueDate;
    push({
      key: b.key,
      date,
      kind: "bill",
      title: b.name,
      amount: b.status === "paid" ? b.due : b.outstanding,
      status: STATUS_LABEL[b.status],
      overdue: b.status === "overdue",
      done: b.status === "paid" || b.status === "cancelled",
      ref: { type: "bill", bill: b },
    });
  }
  for (const o of input.occurrences) {
    if (o.date < input.from || o.date > input.to) continue;
    if (o.schedule.paysBillScheduleId && o.state !== "completed") continue; // shown via its bill
    push({
      key: o.key,
      date: o.date,
      kind: o.schedule.txnType,
      title: o.schedule.name,
      amount: o.amount,
      status: o.state === "completed" ? "Confirmed" : o.state === "skipped" ? "Skipped" : o.state === "needs_confirmation" ? "Needs confirmation" : "Scheduled",
      overdue: o.state === "needs_confirmation" && o.date < input.today,
      done: o.state === "completed" || o.state === "skipped",
      ref: { type: "occurrence", occurrence: o },
    });
  }
  // Savings contribution targets: suggested amount on the 1st of each month until the target date.
  for (const { goal, progress } of input.goals) {
    if (goal.status !== "active" || !goal.targetDate || !progress.suggestedMonthly) continue;
    for (let d = firstOfMonthOnOrAfter(input.from); d <= input.to && d <= goal.targetDate; d = nextMonthFirst(d)) {
      push({
        key: `goal:${goal.id}:${d}`,
        date: d,
        kind: "goal",
        title: `Save for ${goal.name}`,
        amount: progress.suggestedMonthly,
        status: "Target",
        overdue: false,
        done: false,
        ref: { type: "goal", goalId: goal.id },
      });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.title.localeCompare(b.title)));
}

function firstOfMonthOnOrAfter(d: ISODate): ISODate {
  return d.endsWith("-01") ? d : nextMonthFirst(d);
}
function nextMonthFirst(d: ISODate): ISODate {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

// --------------------------------------------------------------------------- notifications

export interface AppNotification {
  key: string;
  kind: "bill" | "scheduled" | "card" | "loan" | "budget" | "goal";
  severity: "info" | "warning" | "danger";
  title: string;
  body: string;
  date: ISODate;
  href: string;
}

/** In-app notifications derived from local data (works offline). */
export function deriveNotifications(input: {
  today: ISODate;
  prefs: Preferences["notifications"];
  bills: readonly BillView[];
  pending: readonly Occurrence[];
  budgets: readonly { budget: Budget; progress: BudgetProgress | null }[];
  goals: readonly { goal: Goal; progress: GoalProgress }[];
}): AppNotification[] {
  const { today, prefs } = input;
  const out: AppNotification[] = [];
  const soon = addDays(today, prefs.billDaysBefore);
  for (const b of input.bills) {
    if (b.cancelled || b.outstanding === 0 || b.dueDate > soon) continue;
    const kind = b.kind === "card_payment" ? "card" : b.kind === "loan_installment" ? "loan" : "bill";
    if ((kind === "bill" && !prefs.bills) || (kind === "card" && !prefs.cards) || (kind === "loan" && !prefs.loans)) continue;
    const when = b.status === "overdue" ? `was due ${b.dueDate}` : b.status === "due_today" ? "is due today" : `is due ${b.dueDate}`;
    out.push({
      key: `${b.key}:${b.status}`,
      kind,
      severity: b.status === "overdue" ? "danger" : b.status === "due_today" ? "warning" : "info",
      title: b.status === "overdue" ? `Overdue: ${b.name}` : b.name,
      body: `${formatPHP(b.outstanding)} ${when}${b.status === "partially_paid" ? " (partly paid)" : ""}`,
      date: b.dueDate,
      href: `/app/bills/view?id=${b.id}`,
    });
  }
  if (prefs.scheduled) {
    for (const o of input.pending) {
      out.push({
        key: `${o.key}:confirm`,
        kind: "scheduled",
        severity: "warning",
        title: `Confirm: ${o.schedule.name}`,
        body: `${formatPHP(o.amount)} scheduled for ${o.date}. It isn't in your balance until you confirm it.`,
        date: o.date,
        href: "/app/recurring",
      });
    }
  }
  if (prefs.budgets) {
    for (const { budget, progress } of input.budgets) {
      if (!progress || progress.state === "ok") continue;
      out.push({
        key: `budget:${budget.id}:${progress.period.start}:${progress.state}`,
        kind: "budget",
        severity: progress.state === "exceeded" ? "danger" : "warning",
        title: progress.state === "exceeded" ? `Over budget: ${budget.name}` : `Budget ${Math.floor(progress.usedBp / 100)}% used: ${budget.name}`,
        body: progress.remaining < 0 ? `${formatPHP(-progress.remaining)} over` : `${formatPHP(progress.remaining)} left`,
        date: today,
        href: `/app/budgets/view?id=${budget.id}`,
      });
    }
  }
  if (prefs.goals) {
    for (const { goal, progress } of input.goals) {
      if (goal.status === "archived" || progress.pctBp < 2500) continue;
      const milestone = progress.pctBp >= 10_000 ? 100 : progress.pctBp >= 7500 ? 75 : progress.pctBp >= 5000 ? 50 : 25;
      out.push({
        key: `goal:${goal.id}:${milestone}`,
        kind: "goal",
        severity: "info",
        title: milestone === 100 ? `Goal reached: ${goal.name}` : `${milestone}% of ${goal.name}`,
        body: milestone === 100 ? "Congratulations!" : `${formatPHP(progress.remaining)} to go`,
        date: today,
        href: `/app/goals/view?id=${goal.id}`,
      });
    }
  }
  const rank = { danger: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.date < b.date ? -1 : 1));
}
