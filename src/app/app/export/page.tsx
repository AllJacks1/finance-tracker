"use client";
import * as React from "react";
import { Download, FileJson, FileSpreadsheet } from "lucide-react";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/finance/primitives";
import { useFinance } from "@/client/hooks";
import { vault } from "@/client/vault";
import { transactionsCsv } from "@/lib/finance/csv";
import { startOfMonth } from "@/lib/finance/dates";

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

export default function ExportPage() {
  const f = useFinance();
  const [from, setFrom] = React.useState(startOfMonth(f.today));
  const [to, setTo] = React.useState(f.today);
  const rows = f.liveTxns.filter((t) => (!from || t.localDate >= from) && (!to || t.localDate <= to)).sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));

  const csv = () =>
    download(
      `transactions_${from || "all"}_${to || "all"}.csv`,
      "﻿" + transactionsCsv(rows, { accounts: f.accountById as never, categories: f.categoryById as never, tags: f.tagById }),
      "text/csv;charset=utf-8",
    );

  const json = () => {
    const s = vault.store!;
    const dump: Record<string, unknown> = { exportedAt: new Date().toISOString(), currency: "PHP", amountsIn: "centavos" };
    for (const e of ["settings", "account", "category", "tag", "transaction", "template", "budget", "allocation", "reconciliation", "attachment"] as const) {
      dump[e] = s.list(e, { includeDeleted: true }).map((r) => ({ ...r.data, deletedAt: r.deletedAt, version: r.version }));
    }
    download(`finance-export_${f.today}.json`, JSON.stringify(dump, null, 2), "application/json");
  };

  return (
    <>
      <PageHeader title="Export" back="/app/more" />
      <div className="grid gap-5">
        <section className="grid gap-3 rounded-2xl border p-4">
          <div className="flex items-center gap-2 font-medium"><FileSpreadsheet className="size-5 text-primary" /> Transactions (CSV)</div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="From" htmlFor="ef"><Input id="ef" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To" htmlFor="et"><Input id="et" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          </div>
          <Button onClick={csv} disabled={!rows.length}><Download className="size-4" /> Download {rows.length} transactions</Button>
          <p className="text-xs text-muted-foreground">Opens in Excel or Google Sheets. Amounts in pesos; transfers show as negative from the source account.</p>
        </section>
        <section className="grid gap-3 rounded-2xl border p-4">
          <div className="flex items-center gap-2 font-medium"><FileJson className="size-5 text-primary" /> Everything (JSON)</div>
          <p className="text-sm text-muted-foreground">All accounts, transactions (including deleted), budgets, categories, templates and settings. Amounts are in centavos.</p>
          <Button variant="outline" onClick={json}><Download className="size-4" /> Download full export</Button>
        </section>
        <p className="text-xs text-muted-foreground">Exports are created on this device from your local data, so they work offline. They include only changes this device knows about; sync first for the latest. Exported files are not encrypted, so store them safely.</p>
      </div>
    </>
  );
}
