"use client";
/**
 * CSV import commit / undo. Rows become ordinary transactions with deterministic ids derived from
 * their fingerprint, so re-running an interrupted import never duplicates anything (and the DB has
 * a unique index on (account, fingerprint) as a backstop). Rows are written in atomic chunks that
 * fit one sync request.
 */
import { importedTxnId } from "@/lib/domain/ids";
import type { Category, ImportBatch, Transaction } from "@/lib/domain/types";
import { TXN_LINKS } from "@/lib/domain/types";
import { matchCategory, type PreviewRow } from "@/lib/finance/csv-import";
import { localDateOf } from "@/lib/finance/dates";
import { entitySchemas } from "@/lib/sync/protocol";
import { ActionError, newId } from "./actions";
import { withPreferences } from "./settings";
import { vault } from "./vault";

const CHUNK = 40;

function store() {
  if (!vault.store) throw new ActionError("Your data is locked.");
  return vault.store;
}

export async function commitImport(input: {
  accountId: string;
  filename: string;
  fileSha256: string;
  rows: readonly PreviewRow[];
  categories: readonly Category[];
}): Promise<{ batchId: string; imported: number; skipped: number }> {
  const s = store();
  const tz = withPreferences(s.list("settings")[0]?.data).timezone;
  const chosen = input.rows.filter((r) => r.selected && r.fingerprint && r.date && r.amount);
  if (!chosen.length) throw new ActionError("No rows selected.");
  const batchId = newId();
  const batch: ImportBatch = entitySchemas.importBatch.parse({
    id: batchId,
    accountId: input.accountId,
    filename: input.filename.slice(0, 200),
    fileSha256: input.fileSha256,
    rowCount: input.rows.length,
    importedCount: chosen.length,
    skippedCount: input.rows.length - chosen.length,
  }) as ImportBatch;

  const txns: Transaction[] = [];
  for (const r of chosen) {
    const id = importedTxnId(input.accountId, r.fingerprint!);
    if (s.get("transaction", id)) continue; // already imported (e.g. an earlier interrupted run)
    const occurredAt = `${r.date}T12:00:00+08:00`;
    txns.push(
      entitySchemas.transaction.parse({
        ...TXN_LINKS,
        id,
        type: r.amount! > 0 ? "income" : "expense",
        amount: Math.abs(r.amount!),
        accountId: input.accountId,
        toAccountId: null,
        adjustmentDirection: null,
        categoryId: matchCategory(r.categoryName, r.amount!, input.categories),
        occurredAt,
        localDate: localDateOf(occurredAt, tz),
        description: r.description || null,
        notes: `Imported from ${input.filename} (line ${r.line})`.slice(0, 2000),
        tagIds: [],
        refundOfId: null,
        importBatchId: batchId,
        importFingerprint: r.fingerprint,
      }) as Transaction,
    );
  }
  for (let i = 0; i < txns.length; i += CHUNK) {
    const chunk = txns.slice(i, i + CHUNK).map((t) => ({ entity: "transaction" as const, id: t.id, kind: "create" as const, data: t }));
    await s.mutateGroup(i === 0 ? [{ entity: "importBatch", id: batchId, kind: "create", data: batch }, ...chunk] : chunk);
  }
  if (!txns.length) await s.mutate("importBatch", batchId, "create", batch);
  return { batchId, imported: txns.length, skipped: input.rows.length - txns.length };
}

/** Undo an import: soft-deletes its transactions (restorable) and the batch record. */
export async function undoImport(batchId: string) {
  const s = store();
  const ids = s.list("transaction").filter((t) => t.data.importBatchId === batchId).map((t) => t.id);
  for (let i = 0; i < ids.length; i += CHUNK) {
    await s.mutateGroup(ids.slice(i, i + CHUNK).map((id) => ({ entity: "transaction" as const, id, kind: "delete" as const })));
  }
  if (s.get("importBatch", batchId)) await s.mutate("importBatch", batchId, "delete");
  return ids.length;
}
