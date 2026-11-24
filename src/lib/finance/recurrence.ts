/**
 * Recurrence rules → occurrence dates. Pure and deterministic: the same rule always yields the
 * same dates on every device, which is what lets occurrences stay VIRTUAL (computed, never
 * generated in the background) until the user acts on one.
 *
 * Date rules
 *  - monthly: the start date's day is the anchor; short months clamp (Jan 31 → Feb 28 → Mar 31).
 *  - yearly: Feb 29 falls back to Feb 28 in non-leap years.
 *  - biweekly = weekly with interval 2; "custom" = any interval.
 *  - `count` limits the total number of occurrences from the start.
 *  - Pause windows suppress occurrences inside them; resuming does not back-fill.
 */
import type { PauseWindow, RecurrenceRule } from "../domain/types";
import { addDays, type ISODate } from "./dates";

const pad = (n: number) => String(n).padStart(2, "0");
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1-12

function parts(d: ISODate) {
  return { y: Number(d.slice(0, 4)), m: Number(d.slice(5, 7)), d: Number(d.slice(8, 10)) };
}

function daysBetween(a: ISODate, b: ISODate) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** The n-th (0-based) nominal occurrence of a rule, ignoring end date / count / pauses. */
export function nthOccurrence(rule: RecurrenceRule, n: number): ISODate {
  const s = parts(rule.startDate);
  switch (rule.freq) {
    case "once":
      return rule.startDate;
    case "daily":
      return addDays(rule.startDate, n * rule.interval);
    case "weekly":
      return addDays(rule.startDate, n * 7 * rule.interval);
    case "monthly": {
      const total = s.m - 1 + n * rule.interval;
      const y = s.y + Math.floor(total / 12);
      const m = (total % 12) + 1;
      return `${y}-${pad(m)}-${pad(Math.min(s.d, daysInMonth(y, m)))}`;
    }
    case "yearly": {
      const y = s.y + n * rule.interval;
      return `${y}-${pad(s.m)}-${pad(Math.min(s.d, daysInMonth(y, s.m)))}`;
    }
  }
}

/** First index whose occurrence could be on/after `from` (a safe lower bound). */
function firstIndexFrom(rule: RecurrenceRule, from: ISODate): number {
  if (from <= rule.startDate) return 0;
  const days = daysBetween(rule.startDate, from);
  switch (rule.freq) {
    case "once":
      return 0;
    case "daily":
      return Math.max(0, Math.floor(days / rule.interval) - 1);
    case "weekly":
      return Math.max(0, Math.floor(days / (7 * rule.interval)) - 1);
    case "monthly": {
      const a = parts(rule.startDate);
      const b = parts(from);
      const months = (b.y - a.y) * 12 + (b.m - a.m);
      return Math.max(0, Math.floor(months / rule.interval) - 1);
    }
    case "yearly":
      return Math.max(0, Math.floor((parts(from).y - parts(rule.startDate).y) / rule.interval) - 1);
  }
}

export function isPaused(date: ISODate, pauses: readonly PauseWindow[]): boolean {
  return pauses.some((p) => date >= p.from && (p.to === null || date <= p.to));
}

/** Nominal occurrence dates within [from, to] (inclusive), honouring end date, count and pauses. */
export function occurrencesBetween(
  rule: RecurrenceRule,
  from: ISODate,
  to: ISODate,
  pauses: readonly PauseWindow[] = [],
  maxResults = 5000,
): ISODate[] {
  const out: ISODate[] = [];
  if (to < rule.startDate) return out;
  if (rule.freq === "once") {
    if (rule.startDate >= from && rule.startDate <= to && !isPaused(rule.startDate, pauses)) out.push(rule.startDate);
    return out;
  }
  for (let n = firstIndexFrom(rule, from); out.length < maxResults; n++) {
    if (rule.count !== null && n >= rule.count) break;
    const d = nthOccurrence(rule, n);
    if (rule.endDate && d > rule.endDate) break;
    if (d > to) break;
    if (d >= from && !isPaused(d, pauses)) out.push(d);
  }
  return out;
}

/** Next occurrence on or after `date`, or null if the rule has ended. */
export function nextOccurrence(rule: RecurrenceRule, date: ISODate, pauses: readonly PauseWindow[] = []): ISODate | null {
  // Search a bounded window (12 years covers yearly rules with large pauses).
  const list = occurrencesBetween(rule, date, addDays(date, 366 * 12), pauses, 1);
  return list[0] ?? null;
}

/**
 * "Edit future occurrences from `from`": end the current rule the day before `from` and start a
 * new rule at the first occurrence on/after `from` (keeping the cadence). Past occurrences and
 * their confirmed transactions are untouched.
 */
export function splitRule(rule: RecurrenceRule, from: ISODate): { ended: RecurrenceRule; next: RecurrenceRule } | null {
  const first = nextOccurrence(rule, from);
  if (!first) return null;
  const consumed = rule.count === null ? null : occurrencesBetween(rule, rule.startDate, addDays(first, -1)).length;
  return {
    ended: { ...rule, endDate: addDays(from, -1), count: rule.count === null ? null : consumed },
    next: { ...rule, startDate: first, count: rule.count === null ? null : Math.max(rule.count - (consumed ?? 0), 1) },
  };
}

export function describeRule(rule: RecurrenceRule): string {
  const every = (unit: string) => (rule.interval === 1 ? `Every ${unit}` : `Every ${rule.interval} ${unit}s`);
  switch (rule.freq) {
    case "once":
      return `Once on ${rule.startDate}`;
    case "daily":
      return every("day");
    case "weekly":
      return rule.interval === 2 ? "Every 2 weeks" : every("week");
    case "monthly":
      return `${every("month")} on day ${Number(rule.startDate.slice(8, 10))}`;
    case "yearly":
      return `${every("year")} on ${rule.startDate.slice(5)}`;
  }
}
