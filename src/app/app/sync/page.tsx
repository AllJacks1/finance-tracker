"use client";
import * as React from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/app-shell";
import { SyncSheet } from "@/components/app/sync-status";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionTitle } from "@/components/finance/primitives";
import { useStoreVersion, useSyncStatus } from "@/client/hooks";
import { vault } from "@/client/vault";
import type { ConflictInfo } from "@/client/store";
import { formatPHP } from "@/lib/finance/money";

const ENTITY_LABEL: Record<string, string> = {
  transaction: "Transaction", account: "Account", category: "Category", tag: "Tag", budget: "Budget",
  allocation: "Reserve/obligation", template: "Template", reconciliation: "Reconciliation", settings: "Settings", attachment: "Receipt",
};

function describe(data: Record<string, unknown> | null): [string, string][] {
  if (!data) return [];
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === "id" || v === null || v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    const isMoney = ["amount", "openingBalance", "statementBalance", "computedBalance"].includes(k) && typeof v === "number";
    out.push([k, isMoney ? formatPHP(v as number) : typeof v === "object" ? JSON.stringify(v) : String(v)]);
  }
  return out;
}

export default function SyncPage() {
  useStoreVersion();
  const status = useSyncStatus();
  const [sheet, setSheet] = React.useState(false);
  const conflicts = vault.store?.getConflicts() ?? [];
  const failed = vault.store?.getOutboxSummary().failedOps ?? [];

  return (
    <>
      <PageHeader title="Sync & conflicts" back="/app/more" />
      <Button variant="outline" className="mb-4 w-full" onClick={() => setSheet(true)}>Sync status: {status?.label}</Button>
      {conflicts.length === 0 && failed.length === 0 ? (
        <EmptyState icon={<CheckCircle2 className="size-8 text-income" />} title="No conflicts or failed changes" />
      ) : null}

      {conflicts.length ? (
        <section className="grid gap-3">
          <SectionTitle>Conflicts</SectionTitle>
          <p className="text-sm text-muted-foreground">These records were changed on another device before your change reached the server. Nothing was overwritten. Choose which version to keep.</p>
          {conflicts.map((c) => <ConflictCard key={c.entityId} c={c} />)}
        </section>
      ) : null}

      {failed.length ? (
        <section className="mt-6 grid gap-3">
          <SectionTitle>Changes the server refused</SectionTitle>
          {failed.map((o) => (
            <div key={o.opId} className="grid gap-2 rounded-2xl border border-expense/40 p-3">
              <div className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4 text-expense" /> {ENTITY_LABEL[o.entity] ?? o.entity} · {o.kind}</div>
              <p className="text-sm text-muted-foreground">{o.error}</p>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" onClick={() => void vault.store?.retryFailed(o.entityId)}>Retry</Button>
                <Button variant="destructive" onClick={() => void vault.store?.discardLocal(o.entityId).then(() => toast("Local change discarded"))}>Discard my change</Button>
              </div>
            </div>
          ))}
        </section>
      ) : null}
      <SyncSheet open={sheet} onOpenChange={setSheet} />
    </>
  );
}

function ConflictCard({ c }: { c: ConflictInfo }) {
  const mine = describe(c.local.data);
  const theirs = describe(c.server.data);
  const keys = [...new Set([...mine.map(([k]) => k), ...theirs.map(([k]) => k)])];
  const m = new Map(mine);
  const t = new Map(theirs);
  const changed = keys.filter((k) => m.get(k) !== t.get(k));
  return (
    <div className="grid gap-3 rounded-2xl border border-warning/50 p-3">
      <div className="font-medium">{ENTITY_LABEL[c.entity] ?? c.entity}: {String(c.server.data.description ?? c.server.data.name ?? "")}</div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-muted p-2">
          <div className="mb-1 font-semibold">Your version{c.local.deletedAt ? " (deleted)" : ""}</div>
          {changed.map((k) => <div key={k}><span className="text-muted-foreground">{k}:</span> {m.get(k) ?? "—"}</div>)}
        </div>
        <div className="rounded-lg bg-muted p-2">
          <div className="mb-1 font-semibold">Server version{c.server.deletedAt ? " (deleted)" : ""}</div>
          {changed.map((k) => <div key={k}><span className="text-muted-foreground">{k}:</span> {t.get(k) ?? "—"}</div>)}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={() => void vault.store?.resolveConflict(c.entityId, "server").then(() => toast("Kept the server version"))}>Keep server</Button>
        <Button onClick={() => void vault.store?.resolveConflict(c.entityId, "mine").then(() => toast("Kept your version. It will sync next."))}>Keep mine</Button>
      </div>
    </div>
  );
}
