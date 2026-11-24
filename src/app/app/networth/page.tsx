"use client";
import * as React from "react";
import { Camera, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AmountInput, EmptyState, Field, FormSheet, Money, NativeSelect, SectionTitle } from "@/components/finance/primitives";
import { ActionError, newId } from "@/client/actions";
import { deleteAsset, saveAsset, takeSnapshot } from "@/client/goal-actions";
import { useFinance } from "@/client/hooks";
import type { ManualAsset } from "@/lib/domain/types";
import { assetValueAsOf, netWorthAsOf, snapshotDrift } from "@/lib/finance/networth";
import { cn } from "@/lib/utils";

export default function NetWorthPage() {
  const f = useFinance();
  const [assetSheet, setAssetSheet] = React.useState<{ open: boolean; asset?: ManualAsset; key: number }>({ open: false, key: 0 });
  const current = React.useMemo(() => netWorthAsOf(f.accounts, f.txns, f.assets, f.today), [f]);
  const snapshots = [...f.snapshots].sort((a, b) => (a.snapshotDate < b.snapshotDate ? 1 : -1));
  const assetsLines = current.lines.filter((l) => !l.liability);
  const liabilityLines = current.lines.filter((l) => l.liability);

  return (
    <>
      <PageHeader title="Net worth" back="/app/more" />
      <div className="grid gap-5">
        <div className="grid gap-1 rounded-2xl bg-primary p-5 text-primary-foreground">
          <div className="text-sm opacity-90">Current net worth (recalculated now)</div>
          <div className="text-4xl font-semibold"><Money value={current.netWorth} /></div>
          <div className="text-sm opacity-90">Assets <Money value={current.assets} /> − Liabilities <Money value={current.liabilities} /></div>
        </div>

        <section className="grid gap-1">
          <SectionTitle>Assets</SectionTitle>
          {assetsLines.map((l) => (
            <div key={l.id} className="flex justify-between px-1 py-1 text-sm"><span>{l.name}{l.kind === "asset" ? " · manual" : ""}</span><Money value={l.value} /></div>
          ))}
        </section>
        <section className="grid gap-1">
          <SectionTitle>Liabilities</SectionTitle>
          {liabilityLines.length ? liabilityLines.map((l) => (
            <div key={l.id} className="flex justify-between px-1 py-1 text-sm"><span>{l.name}</span><Money value={l.value} tone="expense" /></div>
          )) : <p className="px-1 text-sm text-muted-foreground">No liabilities. Credit cards and loans appear here.</p>}
        </section>

        <section className="grid gap-2">
          <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => setAssetSheet((s) => ({ open: true, asset: undefined, key: s.key + 1 }))}><Plus className="size-3.5" /> Asset</Button>}>Manual assets</SectionTitle>
          <p className="px-1 text-xs text-muted-foreground">Investments, property, vehicles and other things you own that aren&apos;t accounts. Update their value from time to time.</p>
          {f.assets.length ? f.assets.map((a) => (
            <button key={a.id} type="button" onClick={() => setAssetSheet((s) => ({ open: true, asset: a, key: s.key + 1 }))} className="press flex items-center justify-between rounded-xl border p-3 text-left">
              <span className="grid"><span className="font-medium">{a.name}</span><span className="text-xs text-muted-foreground">{a.kind} · valued {a.valuations[a.valuations.length - 1]?.date}</span></span>
              <Money value={assetValueAsOf(a, f.today)} className="font-semibold" />
            </button>
          )) : null}
        </section>

        <section className="grid gap-2">
          <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => void takeSnapshot("manual", f.today).then(() => toast.success("Snapshot recorded")).catch((e) => toast.error(e.message))}><Camera className="size-3.5" /> Snapshot</Button>}>History (recorded snapshots)</SectionTitle>
          <p className="px-1 text-xs text-muted-foreground">
            A snapshot records your net worth as it was computed on that day and is never changed. A month-end snapshot is recorded automatically. If you later edit older transactions, the difference from today&apos;s recalculation is shown instead of rewriting the record.
          </p>
          {snapshots.length === 0 ? <EmptyState title="No snapshots yet" /> : null}
          {snapshots.map((s) => {
            const now = netWorthAsOf(f.accounts, f.txns, f.assets, s.snapshotDate);
            const drift = snapshotDrift(s, now);
            return (
              <div key={s.id} className="grid gap-0.5 rounded-xl border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{s.snapshotDate} · {s.kind === "auto" ? "month end" : "manual"}</span>
                  <Money value={s.netWorth} className="font-semibold" />
                </div>
                <div className="text-xs text-muted-foreground">Recorded {new Date(s.recordedAt).toLocaleDateString("en-PH")} · assets <Money value={s.assets} /> · liabilities <Money value={s.liabilities} /></div>
                {drift !== 0 ? (
                  <div className={cn("text-xs", "text-warning")}>Recalculated today: <Money value={now.netWorth} /> (differs by <Money value={drift} sign="always" />) — later edits to past transactions.</div>
                ) : null}
              </div>
            );
          })}
        </section>
      </div>
      <AssetSheet key={assetSheet.key} open={assetSheet.open} onOpenChange={(o) => setAssetSheet((s) => ({ ...s, open: o }))} asset={assetSheet.asset} />
    </>
  );
}

function AssetSheet({ open, onOpenChange, asset }: { open: boolean; onOpenChange: (o: boolean) => void; asset?: ManualAsset }) {
  const f = useFinance();
  const [name, setName] = React.useState(asset?.name ?? "");
  const [kind, setKind] = React.useState<ManualAsset["kind"]>(asset?.kind ?? "investment");
  const [value, setValue] = React.useState<number | null>(asset ? assetValueAsOf(asset, f.today) : null);
  const [date, setDate] = React.useState(f.today);
  const [error, setError] = React.useState<string | null>(null);
  const submit = async () => {
    setError(null);
    if (!name.trim()) return setError("Name it.");
    if (value === null) return setError("Enter its value.");
    const valuations = [...(asset?.valuations ?? []).filter((v) => v.date !== date), { date, value }];
    try {
      await saveAsset({ id: asset?.id ?? newId(), name: name.trim(), kind, valuations, isActive: true, notes: asset?.notes ?? null });
      toast.success("Saved");
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ActionError ? e.message : "Couldn't save.");
    }
  };
  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={asset ? "Update asset value" : "Add an asset"} footer={
      <div className="grid gap-2">
        <Button size="lg" onClick={() => void submit()}>Save</Button>
        {asset ? <Button variant="destructive" onClick={() => void deleteAsset(asset).then(() => onOpenChange(false))}><Trash2 className="size-4" /> Remove</Button> : null}
      </div>
    }>
      <Field label="Name" htmlFor="an"><Input id="an" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Stocks (COL), Pag-IBIG MP2, Car" /></Field>
      <Field label="Type" htmlFor="ak">
        <NativeSelect id="ak" value={kind} onChange={(e) => setKind(e.target.value as ManualAsset["kind"])}>
          <option value="investment">Investment</option>
          <option value="property">Property</option>
          <option value="vehicle">Vehicle</option>
          <option value="other">Other</option>
        </NativeSelect>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Value" htmlFor="av"><AmountInput id="av" value={value} onChange={setValue} /></Field>
        <Field label="As of" htmlFor="ad"><Input id="ad" type="date" value={date} max={f.today} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      {asset && asset.valuations.length > 1 ? (
        <div className="grid gap-1 text-xs text-muted-foreground">
          {asset.valuations.slice().reverse().slice(0, 6).map((v) => <span key={v.date}>{v.date}: <Money value={v.value} /></span>)}
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </FormSheet>
  );
}
