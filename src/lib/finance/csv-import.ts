/**
 * CSV import (runs on the device, works offline).
 *
 * Nothing is imported silently: every row is parsed and validated, possible duplicates are
 * flagged, and the user confirms which rows to import.
 *
 * Duplicate detection
 *  - exact:  a transaction with the same import fingerprint already exists (re-importing a file).
 *            Also enforced by a DB unique index (account, fingerprint).
 *  - likely: an existing transaction in the account with the same amount, date ±1 day and a
 *            similar (or empty) description.
 *  - in_file: the same row appears earlier in this file (could be legitimate — user decides).
 * Fingerprint = sha256(account | date | signed amount | normalised description | n-th repeat).
 */
import Papa from "papaparse";
import type { Category, Transaction } from "../domain/types";
import { addDays, isISODate, type ISODate } from "./dates";
import { isLive } from "./ledger";
import { parseAmount, type Centavos } from "./money";

export type DateFormat = "YYYY-MM-DD" | "MM/DD/YYYY" | "DD/MM/YYYY" | "DD-MMM-YYYY" | "MMM DD, YYYY";
export const DATE_FORMATS: DateFormat[] = ["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "DD-MMM-YYYY", "MMM DD, YYYY"];

export interface ColumnMapping {
  hasHeader: boolean;
  date: number;
  dateFormat: DateFormat;
  /** signed: one column (+ in, - out); inverted: one column (+ out, - in); split: debit/credit columns */
  amountMode: "signed" | "inverted" | "split";
  amount: number | null;
  debit: number | null; // money out
  credit: number | null; // money in
  description: number | null;
  category: number | null;
}

export function parseCsv(text: string): string[][] {
  const res = Papa.parse<string[]>(text.replace(/^﻿/, ""), { skipEmptyLines: "greedy" });
  return res.data.map((r) => r.map((c) => String(c ?? "").trim()));
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");

export function parseDate(raw: string, fmt: DateFormat): ISODate | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let match: RegExpMatchArray | null;
  switch (fmt) {
    case "YYYY-MM-DD":
      match = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
      if (!match) return null;
      [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
      break;
    case "MM/DD/YYYY":
    case "DD/MM/YYYY":
      match = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})\b/);
      if (!match) return null;
      [m, d] = fmt === "MM/DD/YYYY" ? [Number(match[1]), Number(match[2])] : [Number(match[2]), Number(match[1])];
      y = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
      break;
    case "DD-MMM-YYYY":
      match = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3})[A-Za-z]*[-\s/,]+(\d{2}|\d{4})\b/);
      if (!match) return null;
      d = Number(match[1]);
      m = MONTHS.indexOf(match[2]!.toLowerCase()) + 1;
      y = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
      break;
    case "MMM DD, YYYY":
      match = s.match(/^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
      if (!match) return null;
      m = MONTHS.indexOf(match[1]!.toLowerCase()) + 1;
      d = Number(match[2]);
      y = Number(match[3]);
      break;
  }
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  return m >= 1 && isISODate(iso) ? iso : null;
}

/**
 * Bank-style amounts: "1,234.50", "(1,234.50)" (negative), "1,234.50-", "1,234.50 CR"/"DR",
 * "PHP 1,234.50", "₱1,234.50". Returns signed centavos or null.
 */
export function parseCsvAmount(raw: string): Centavos | null {
  let s = raw.trim().replace(/\s+/g, " ");
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  const suffix = s.match(/\s?(CR|DR)$/i);
  if (suffix) {
    if (suffix[1]!.toUpperCase() === "DR") sign *= -1;
    s = s.slice(0, -suffix[0].length);
  }
  if (s.endsWith("-")) {
    sign *= -1;
    s = s.slice(0, -1);
  }
  s = s.replace(/^(PHP|₱)\s?/i, "");
  const v = parseAmount(s, { allowNegative: true });
  return v === null ? null : v * sign;
}

export interface ImportRow {
  line: number; // 1-based line in the file
  date: ISODate | null;
  /** Signed: + money in, - money out. */
  amount: Centavos | null;
  description: string;
  categoryName: string | null;
  errors: string[];
}

export function mapRows(rows: string[][], map: ColumnMapping): ImportRow[] {
  const body = map.hasHeader ? rows.slice(1) : rows;
  const offset = map.hasHeader ? 2 : 1;
  return body.map((r, i) => {
    const errors: string[] = [];
    const cell = (c: number | null) => (c === null ? "" : (r[c] ?? ""));
    const date = parseDate(cell(map.date), map.dateFormat);
    if (!date) errors.push(`Invalid date "${cell(map.date)}" (expected ${map.dateFormat})`);
    let amount: Centavos | null = null;
    if (map.amountMode === "split") {
      const out = cell(map.debit) ? parseCsvAmount(cell(map.debit)) : 0;
      const inn = cell(map.credit) ? parseCsvAmount(cell(map.credit)) : 0;
      if (out === null || inn === null) errors.push("Invalid debit/credit amount");
      else amount = Math.abs(inn) - Math.abs(out);
    } else {
      const v = parseCsvAmount(cell(map.amount));
      if (v === null) errors.push(`Invalid amount "${cell(map.amount)}"`);
      else amount = map.amountMode === "inverted" ? -v : v;
    }
    if (amount === 0) errors.push("Amount is zero");
    const description = cell(map.description).slice(0, 200);
    return { line: i + offset, date, amount, description, categoryName: cell(map.category) || null, errors };
  });
}

export const normalizeDescription = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function similar(a: string, b: string): boolean {
  const x = normalizeDescription(a);
  const y = normalizeDescription(b);
  if (!x || !y) return true; // missing description: rely on amount + date
  if (x.includes(y) || y.includes(x)) return true;
  const ta = new Set(x.split(" "));
  const tb = new Set(y.split(" "));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  return inter / Math.max(Math.min(ta.size, tb.size), 1) >= 0.5;
}

async function sha256Hex(s: string): Promise<string> {
  const h = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type DuplicateKind = "exact" | "likely" | "in_file" | null;

export interface PreviewRow extends ImportRow {
  fingerprint: string | null;
  duplicate: DuplicateKind;
  duplicateOf: string | null; // existing transaction id
  /** Selected for import by default: valid and not a duplicate. */
  selected: boolean;
}

/** Validate + fingerprint + duplicate detection against the destination account. */
export async function buildPreview(rows: readonly ImportRow[], accountId: string, existing: readonly (Transaction & { deletedAt?: string | null })[]): Promise<PreviewRow[]> {
  const inAccount = existing.filter((t) => isLive(t) && (t.accountId === accountId || t.toAccountId === accountId));
  const byFingerprint = new Map(inAccount.filter((t) => t.importFingerprint).map((t) => [t.importFingerprint!, t.id]));
  const repeats = new Map<string, number>();
  const out: PreviewRow[] = [];
  for (const r of rows) {
    if (r.errors.length || !r.date || r.amount === null) {
      out.push({ ...r, fingerprint: null, duplicate: null, duplicateOf: null, selected: false });
      continue;
    }
    const base = `${accountId}|${r.date}|${r.amount}|${normalizeDescription(r.description)}`;
    const n = repeats.get(base) ?? 0;
    repeats.set(base, n + 1);
    const fingerprint = await sha256Hex(`${base}|${n}`);
    let duplicate: DuplicateKind = null;
    let duplicateOf: string | null = null;
    if (byFingerprint.has(fingerprint)) {
      duplicate = "exact";
      duplicateOf = byFingerprint.get(fingerprint)!;
    } else {
      const lo = addDays(r.date, -1);
      const hi = addDays(r.date, 1);
      const signedOf = (t: Transaction) => (t.type === "income" || t.type === "refund" || (t.type === "transfer" && t.toAccountId === accountId) || (t.type === "adjustment" && t.adjustmentDirection === "increase") ? t.amount : -t.amount);
      const hit = inAccount.find((t) => t.localDate >= lo && t.localDate <= hi && signedOf(t) === r.amount && similar(t.description ?? "", r.description));
      if (hit) {
        duplicate = "likely";
        duplicateOf = hit.id;
      } else if (n > 0) duplicate = "in_file";
    }
    out.push({ ...r, fingerprint, duplicate, duplicateOf, selected: duplicate === null });
  }
  return out;
}

/** Match a category name from the file to an existing category of the right kind. */
export function matchCategory(name: string | null, amount: Centavos, categories: readonly Category[]): string | null {
  if (!name) return null;
  const kind = amount > 0 ? "income" : "expense";
  const n = normalizeDescription(name);
  return categories.find((c) => c.kind === kind && !c.isArchived && normalizeDescription(c.name) === n)?.id ?? null;
}
