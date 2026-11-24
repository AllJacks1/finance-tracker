/**
 * CSV export helpers (RFC 4180 quoting + spreadsheet formula-injection protection).
 */
import type { Account, Category, Tag, Transaction } from "../domain/types";
import { toDecimalString } from "./money";

/** Quote a cell; neutralise values a spreadsheet would execute as a formula. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s) || s.startsWith("'")) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function transactionsCsv(
  txns: readonly Transaction[],
  lookups: { accounts: Map<string, Account>; categories: Map<string, Category>; tags: Map<string, Tag> },
): string {
  const header = [
    "id",
    "date",
    "occurred_at",
    "type",
    "amount_php",
    "signed_amount_php",
    "account",
    "to_account",
    "category",
    "description",
    "notes",
    "tags",
  ];
  const rows = txns.map((t) => {
    const signed =
      t.type === "expense" ||
      (t.type === "adjustment" && t.adjustmentDirection === "decrease") ||
      t.type === "transfer"
        ? -t.amount
        : t.amount;
    return [
      t.id,
      t.localDate,
      t.occurredAt,
      t.type,
      toDecimalString(t.amount),
      toDecimalString(signed),
      lookups.accounts.get(t.accountId)?.name ?? "",
      t.toAccountId ? (lookups.accounts.get(t.toAccountId)?.name ?? "") : "",
      t.categoryId ? (lookups.categories.get(t.categoryId)?.name ?? "") : "",
      t.description ?? "",
      t.notes ?? "",
      t.tagIds.map((id) => lookups.tags.get(id)?.name ?? "").filter(Boolean).join("; "),
    ];
  });
  return toCsv([header, ...rows]);
}
