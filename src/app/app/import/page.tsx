"use client";
import * as React from "react";
import { AlertTriangle, CheckCircle2, FileUp, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Field, Money, NativeSelect, SectionTitle } from "@/components/finance/primitives";
import { ActionError } from "@/client/actions";
import { commitImport, undoImport } from "@/client/import-actions";
import { sha256Hex } from "@/client/crypto";
import { useFinance, useRecords } from "@/client/hooks";
import { buildPreview, DATE_FORMATS, mapRows, parseCsv, type ColumnMapping, type PreviewRow } from "@/lib/finance/csv-import";
import { cn } from "@/lib/utils";

const MAX_BYTES = 2 * 1024 * 1024;

/** Guess columns from common Philippine bank / e-wallet export headers. */
function guessMapping(header: string[]): ColumnMapping {
  const find = (...words: string[]) => {
    const i = header.findIndex((h) => words.some((w) => h.toLowerCase().includes(w)));
    return i >= 0 ? i : null;
  };
  const debit = find("debit", "withdraw", "out");
  const credit = find("credit", "deposit", "in ");
  const amount = find("amount");
  return {
    hasHeader: true,
    date: find("date") ?? 0,
    dateFormat: "YYYY-MM-DD",
    amountMode: debit !== null && credit !== null ? "split" : "signed",
    amount: amount ?? (debit === null ? 1 : null),
    debit,
    credit,
    description: find("description", "particular", "detail", "remarks", "memo", "reference"),
    category: find("category"),
  };
}

const presetKey = (accountId: string) => `ft_csv_mapping_${accountId}`;

export default function ImportPage() {
  const f = useFinance();
  const batches = useRecords("importBatch");
  const [accountId, setAccountId] = React.useState(f.activeAccounts[0]?.id ?? "");
  const [file, setFile] = React.useState<{ name: string; sha: string; rows: string[][] } | null>(null);
  const [mapping, setMapping] = React.useState<ColumnMapping | null>(null);
  const [preview, setPreview] = React.useState<PreviewRow[] | null>(null);
  const [busy, setBusy] = React.useState(false);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fl = e.target.files?.[0];
    e.target.value = "";
    if (!fl) return;
    if (fl.size > MAX_BYTES) return toast.error("File is larger than 2 MB.");
    const text = await fl.text();
    const rows = parseCsv(text);
    if (rows.length < 1) return toast.error("This file has no rows.");
    setFile({ name: fl.name, sha: await sha256Hex(text), rows });
    let saved: ColumnMapping | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(presetKey(accountId)) ?? "null");
    } catch {
      saved = null;
    }
    setMapping(saved ?? guessMapping(rows[0]!));
    setPreview(null);
  };

  const runPreview = async () => {
    if (!file || !mapping) return;
    setBusy(true);
    const rows = mapRows(file.rows, mapping);
    setPreview(await buildPreview(rows, accountId, f.txns));
    try {
      localStorage.setItem(presetKey(accountId), JSON.stringify(mapping));
    } catch {
      /* private mode */
    }
    setBusy(false);
  };

  const doImport = async () => {
    if (!preview || !file) return;
    setBusy(true);
    try {
      const r = await commitImport({ accountId, filename: file.name, fileSha256: file.sha, rows: preview, categories: f.categories });
      toast.success(`Imported ${r.imported} transactions`);
      setFile(null);
      setMapping(null);
      setPreview(null);
    } catch (e) {
      toast.error(e instanceof ActionError ? e.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  };

  const header = file?.rows[0] ?? [];
  const colOptions = header.map((h, i) => ({ value: String(i), label: mapping?.hasHeader ? `${i + 1}. ${h || "(empty)"}` : `Column ${i + 1}`}));
  const counts = preview
    ? {
        selected: preview.filter((r) => r.selected).length,
        invalid: preview.filter((r) => r.errors.length).length,
        dup: preview.filter((r) => r.duplicate).length,
        total: preview.filter((r) => r.selected).reduce((s, r) => s + (r.amount ?? 0), 0),
      }
    : null;

  return (
    <>
      <PageHeader title="Import CSV" back="/app/more" />
      <div className="grid gap-5">
        <p className="text-sm text-muted-foreground">Import transactions from a bank or e-wallet CSV export. Nothing is imported until you review and confirm. Works offline; imported rows sync like any other change.</p>
        <Field label="Import into account" htmlFor="ia">
          <NativeSelect id="ia" value={accountId} onChange={(e) => { setAccountId(e.target.value); setPreview(null); }}>
            {f.activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </NativeSelect>
        </Field>
        <label className="press flex cursor-pointer items-center justify-center gap-2 rounded-2xl border border-dashed p-6 text-sm">
          <FileUp className="size-5" /> {file ? `${file.name} · ${file.rows.length} lines` : "Choose a CSV file"}
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void onFile(e)} />
        </label>

        {file && mapping ? (
          <section className="grid gap-3 rounded-2xl border p-4">
            <SectionTitle>Map columns</SectionTitle>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={mapping.hasHeader} onChange={(e) => setMapping({ ...mapping, hasHeader: e.target.checked })} /> First line is a header</label>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date column" htmlFor="md"><NativeSelect id="md" value={mapping.date} onChange={(e) => setMapping({ ...mapping, date: Number(e.target.value) })}>{colOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</NativeSelect></Field>
              <Field label="Date format" htmlFor="mf"><NativeSelect id="mf" value={mapping.dateFormat} onChange={(e) => setMapping({ ...mapping, dateFormat: e.target.value as ColumnMapping["dateFormat"] })}>{DATE_FORMATS.map((d) => <option key={d}>{d}</option>)}</NativeSelect></Field>
            </div>
            <Field label="Amounts" htmlFor="mm">
              <NativeSelect id="mm" value={mapping.amountMode} onChange={(e) => setMapping({ ...mapping, amountMode: e.target.value as ColumnMapping["amountMode"], amount: mapping.amount ?? 0 })}>
                <option value="signed">One column: money in +, money out −</option>
                <option value="inverted">One column: money out +, money in −</option>
                <option value="split">Separate debit (out) and credit (in) columns</option>
              </NativeSelect>
            </Field>
            {mapping.amountMode === "split" ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Debit / out" htmlFor="mdb"><NativeSelect id="mdb" value={mapping.debit ?? ""} onChange={(e) => setMapping({ ...mapping, debit: e.target.value === "" ? null : Number(e.target.value) })}><option value="">—</option>{colOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</NativeSelect></Field>
                <Field label="Credit / in" htmlFor="mcr"><NativeSelect id="mcr" value={mapping.credit ?? ""} onChange={(e) => setMapping({ ...mapping, credit: e.target.value === "" ? null : Number(e.target.value) })}><option value="">—</option>{colOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</NativeSelect></Field>
              </div>
            ) : (
              <Field label="Amount column" htmlFor="mam"><NativeSelect id="mam" value={mapping.amount ?? 0} onChange={(e) => setMapping({ ...mapping, amount: Number(e.target.value) })}>{colOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</NativeSelect></Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Description" htmlFor="mde"><NativeSelect id="mde" value={mapping.description ?? ""} onChange={(e) => setMapping({ ...mapping, description: e.target.value === "" ? null : Number(e.target.value) })}><option value="">None</option>{colOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</NativeSelect></Field>
              <Field label="Category (optional)" htmlFor="mca"><NativeSelect id="mca" value={mapping.category ?? ""} onChange={(e) => setMapping({ ...mapping, category: e.target.value === "" ? null : Number(e.target.value) })}><option value="">None</option>{colOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</NativeSelect></Field>
            </div>
            <Button onClick={() => void runPreview()} disabled={busy}>Preview</Button>
          </section>
        ) : null}

        {preview && counts ? (
          <section className="grid gap-3">
            <div className="grid grid-cols-3 gap-2 text-center text-sm">
              <div className="rounded-xl border p-2"><div className="text-xs text-muted-foreground">To import</div><div className="text-lg font-semibold">{counts.selected}</div></div>
              <div className="rounded-xl border p-2"><div className="text-xs text-muted-foreground">Possible duplicates</div><div className="text-lg font-semibold text-warning">{counts.dup}</div></div>
              <div className="rounded-xl border p-2"><div className="text-xs text-muted-foreground">Errors</div><div className="text-lg font-semibold text-expense">{counts.invalid}</div></div>
            </div>
            <p className="text-xs text-muted-foreground">Rows with errors can&apos;t be imported. Possible duplicates are unticked — tick them only if they really are new.</p>
            <div className="grid max-h-[60dvh] gap-1 overflow-y-auto overscroll-contain rounded-2xl border p-1">
              {preview.map((r, i) => (
                <label key={r.line} className={cn("flex items-start gap-2 rounded-lg p-2 text-sm", r.errors.length ? "bg-expense/5" : r.duplicate ? "bg-warning/10" : "")}>
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={r.selected}
                    disabled={!!r.errors.length || r.duplicate === "exact"}
                    onChange={(e) => setPreview((p) => p!.map((x, j) => (j === i ? { ...x, selected: e.target.checked } : x)))}
                  />
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate">{r.description || "(no description)"}</span>
                    <span className="text-xs text-muted-foreground">
                      Line {r.line} · {r.date ?? "?"}
                      {r.duplicate === "exact" ? " · already imported" : r.duplicate === "likely" ? " · looks like an existing transaction" : r.duplicate === "in_file" ? " · repeated in this file" : ""}
                    </span>
                    {r.errors.map((e) => <span key={e} className="flex items-center gap-1 text-xs text-expense"><AlertTriangle className="size-3" /> {e}</span>)}
                  </span>
                  {r.amount !== null ? <Money value={r.amount} tone="auto" sign="always" className="text-sm" /> : null}
                </label>
              ))}
            </div>
            <div className="flex items-center justify-between text-sm"><span>Net of selected rows</span><Money value={counts.total} tone="auto" sign="always" className="font-semibold" /></div>
            <Button size="lg" onClick={() => void doImport()} disabled={busy || counts.selected === 0}>
              <CheckCircle2 className="size-4" /> Import {counts.selected} transactions
            </Button>
          </section>
        ) : null}

        {batches.length ? (
          <section className="grid gap-1">
            <SectionTitle>Previous imports</SectionTitle>
            {batches.map((b) => (
              <div key={b.id} className="flex items-center justify-between gap-2 rounded-xl px-2 py-2 text-sm">
                <span className="grid min-w-0">
                  <span className="truncate">{b.data.filename}</span>
                  <span className="text-xs text-muted-foreground">{f.accountById.get(b.data.accountId)?.name} · {b.data.importedCount} imported, {b.data.skippedCount} skipped</span>
                </span>
                <Button size="sm" variant="outline" onClick={() => void undoImport(b.id).then((n) => toast(`Removed ${n} imported transactions (restorable from Activity → deleted)`))}>
                  <Undo2 className="size-3.5" /> Undo
                </Button>
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </>
  );
}
