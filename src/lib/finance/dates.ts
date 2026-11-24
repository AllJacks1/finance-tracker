/**
 * Calendar-date helpers. Financial periods are computed on local calendar dates
 * ("YYYY-MM-DD") in the workspace timezone, so the server and offline clients agree.
 */
export type ISODate = string; // YYYY-MM-DD

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isISODate(s: unknown): s is ISODate {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Local calendar date of an instant in the given IANA timezone. */
export function localDateOf(instant: string | Date, timeZone: string): ISODate {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(d.getTime())) throw new Error("Invalid instant");
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function todayIn(timeZone: string, now: Date = new Date()): ISODate {
  return localDateOf(now, timeZone);
}

function toUTC(date: ISODate): Date {
  return new Date(`${date}T00:00:00Z`);
}
function fromUTC(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: ISODate, days: number): ISODate {
  const d = toUTC(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUTC(d);
}

export function addMonths(date: ISODate, months: number): ISODate {
  const d = toUTC(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return fromUTC(d);
}

/** 0 = Sunday … 6 = Saturday */
export function dayOfWeek(date: ISODate): number {
  return toUTC(date).getUTCDay();
}

export function startOfMonth(date: ISODate): ISODate {
  return `${date.slice(0, 7)}-01`;
}

export function endOfMonth(date: ISODate): ISODate {
  const d = toUTC(date);
  return fromUTC(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

export function startOfWeek(date: ISODate, weekStart: number): ISODate {
  const diff = (dayOfWeek(date) - weekStart + 7) % 7;
  return addDays(date, -diff);
}

export function daysBetweenInclusive(start: ISODate, end: ISODate): number {
  return Math.round((toUTC(end).getTime() - toUTC(start).getTime()) / 86_400_000) + 1;
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return a < b ? a : b;
}
export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a > b ? a : b;
}
