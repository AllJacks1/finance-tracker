"use client";
import * as React from "react";
import Link from "next/link";
import { AlertTriangle, Check, CloudOff, Loader2, RefreshCw, Signal, Wifi, WifiOff, HelpCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FormSheet } from "@/components/finance/primitives";
import { useSyncStatus } from "@/client/hooks";
import { vault } from "@/client/vault";
import type { SyncStatus } from "@/client/sync-engine";
import { cn } from "@/lib/utils";

function tone(s: SyncStatus) {
  switch (s.label) {
    case "Synced":
      return "text-income";
    case "Syncing":
    case "Pending":
      return "text-primary";
    case "Failed":
    case "Conflict detected":
      return "text-expense";
    default:
      return "text-warning";
  }
}

function StatusIcon({ s, className }: { s: SyncStatus; className?: string }) {
  const c = cn("size-4", className);
  if (s.label === "Syncing") return <Loader2 className={cn(c, "animate-spin")} />;
  if (s.label === "Synced") return <Check className={c} />;
  if (s.label === "Failed" || s.label === "Conflict detected") return <AlertTriangle className={c} />;
  if (s.label === "Offline") return <CloudOff className={c} />;
  if (s.label === "Paused – Mobile data") return <Signal className={c} />;
  if (s.label === "Paused – Connection unknown") return <HelpCircle className={c} />;
  return <RefreshCw className={c} />;
}

/** Compact status chip for the header; opens the sync sheet. */
export function SyncChip() {
  const s = useSyncStatus();
  const [open, setOpen] = React.useState(false);
  if (!s) return null;
  // Compact label for the header; the full status is in the accessible name and the sheet.
  const short = s.label.startsWith("Paused") ? "Paused" : s.label === "Conflict detected" ? "Conflict" : s.label === "Sign in to sync" ? "Sign in" : s.label;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn("press flex items-center gap-1.5 rounded-full border bg-background px-3 py-1.5 text-xs font-medium", tone(s))}
        aria-label={`Sync status: ${s.label}`}
      >
        <StatusIcon s={s} className="size-3.5" />
        <span>{short}</span>
        {s.pending > 0 && s.label !== "Synced" ? <span className="tabular text-muted-foreground">· {s.pending}</span> : null}
      </button>
      <SyncSheet open={open} onOpenChange={setOpen} />
    </>
  );
}

export function SyncSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const s = useSyncStatus();
  const [confirm, setConfirm] = React.useState(false);
  if (!s) return null;
  const verified = s.connection.autoSyncAllowed;

  const runManual = async () => {
    setConfirm(false);
    await vault.engine?.run({ manual: true });
    const after = vault.engine?.getStatus();
    if (after?.label === "Synced") toast.success("Everything is synced.");
    else if (after?.phase === "error") toast.error(after.lastError ?? "Sync failed. It will retry.");
  };

  const ConnIcon = s.connection.status === "wifi" || s.connection.status === "ethernet" ? Wifi : s.connection.status === "offline" ? WifiOff : s.connection.status === "cellular" ? Signal : HelpCircle;

  return (
    <>
      <FormSheet
        open={open}
        onOpenChange={onOpenChange}
        title="Sync"
        description="Your data is saved on this device first, then synced to the server."
        footer={
          <Button
            size="lg"
            disabled={s.connection.status === "offline" || s.label === "Syncing" || s.label === "Sign in to sync"}
            onClick={() => (verified ? void runManual() : setConfirm(true))}
          >
            <RefreshCw className="size-4" /> Sync now
          </Button>
        }
      >
        <div className={cn("flex items-center gap-3 rounded-xl border p-3", tone(s))}>
          <StatusIcon s={s} className="size-5" />
          <div className="grid">
            <span className="font-medium">{s.label}</span>
            <span className="text-xs text-muted-foreground">
              {s.lastSyncAt ? `Last synced ${new Date(s.lastSyncAt).toLocaleString("en-PH")}` : "Not synced yet on this device"}
            </span>
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-xl bg-muted/60 p-3 text-sm">
          <ConnIcon className="mt-0.5 size-4 shrink-0" />
          <div className="grid gap-1">
            <span>{s.connection.reason}</span>
            <span className="text-xs text-muted-foreground">
              Automatic sync only runs when this browser confirms you&apos;re on Wi-Fi. Some browsers (iPhone/iPad, desktop, Firefox) never confirm it, so use Sync now.
            </span>
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-2 text-center text-sm">
          <div className="rounded-xl border p-2"><dt className="text-xs text-muted-foreground">Waiting</dt><dd className="tabular text-lg font-semibold">{s.pending}</dd></div>
          <div className="rounded-xl border p-2"><dt className="text-xs text-muted-foreground">Failed</dt><dd className="tabular text-lg font-semibold">{s.failed}</dd></div>
          <div className="rounded-xl border p-2"><dt className="text-xs text-muted-foreground">Conflicts</dt><dd className="tabular text-lg font-semibold">{s.conflicts}</dd></div>
        </dl>
        {s.failed + s.conflicts > 0 ? (
          <Button variant="outline" asChild onClick={() => onOpenChange(false)}>
            <Link href="/app/sync">Review conflicts and failures</Link>
          </Button>
        ) : null}
        {s.label === "Sign in to sync" ? (
          <Button variant="outline" asChild>
            <Link href="/login?resume=1">Sign in to resume syncing</Link>
          </Button>
        ) : null}
        {s.lastError ? <p className="text-sm text-expense">{s.lastError}</p> : null}
      </FormSheet>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sync without confirmed Wi-Fi?</AlertDialogTitle>
            <AlertDialogDescription>
              {s.connection.status === "cellular"
                ? "You're on mobile data."
                : "We can't confirm you're on Wi-Fi."}{" "}
              Syncing may use mobile data, and data charges may apply.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <AlertDialogAction onClick={() => void runManual()}>Sync anyway</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
