"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeftRight, Home, MoreHorizontal, PieChart, Plus } from "lucide-react";
import { CloudDownload, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFinance, useSyncStatus, useVault } from "@/client/hooks";
import { takeSnapshot } from "@/client/goal-actions";
import { showLocalNotifications } from "@/client/notify";
import { autoSnapshotDue } from "@/lib/finance/networth";
import { vault } from "@/client/vault";
import { cn } from "@/lib/utils";
import { LockScreen } from "./lock-screen";
import { SyncChip, SyncSheet } from "./sync-status";
import { isPlanPath } from "@/components/plan/plan-tabs";
import { QuickAddProvider, useQuickAdd } from "@/components/finance/transaction-form";

/** Gate for the finance app: shows the lock screen or redirects to sign-in as needed. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const state = useVault();
  const router = useRouter();

  React.useEffect(() => {
    void vault.init();
  }, []);
  React.useEffect(() => {
    if (state.phase === "signed_out") router.replace(state.mustChangePassword ? "/change-password" : "/login");
  }, [state.phase, state.mustChangePassword, router]);

  // Any interaction pushes back the inactivity auto-lock.
  React.useEffect(() => {
    if (state.phase !== "unlocked") return;
    const bump = () => vault.armAutoLock();
    const onHide = () => {
      if (document.visibilityState === "hidden") vault.armAutoLock();
    };
    window.addEventListener("pointerdown", bump, { passive: true });
    window.addEventListener("keydown", bump);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pointerdown", bump);
      window.removeEventListener("keydown", bump);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [state.phase]);

  if (state.phase === "locked") return <LockScreen />;
  if (state.phase !== "unlocked")
    return (
      <div className="flex min-h-dvh items-center justify-center text-muted-foreground">
        <Loader2 className="size-6 animate-spin" aria-label="Loading" />
      </div>
    );

  return (
    <QuickAddProvider>
      <div className="mx-auto flex min-h-dvh max-w-lg flex-col">
        <main className="flex-1 px-4 pb-28 pt-safe">
          {children}
          <FirstSyncBanner />
          <AutoSnapshot />
          <LocalNotifications />
        </main>
        <BottomNav />
      </div>
    </QuickAddProvider>
  );
}

/** Page header with title and sync status. */
export function PageHeader({ title, back, action }: { title: string; back?: string; action?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-20 -mx-4 mb-3 flex items-center justify-between gap-2 bg-background/90 px-4 pb-2 pt-[calc(0.75rem+env(safe-area-inset-top,0px))] backdrop-blur">
      <div className="flex min-w-0 items-center gap-2">
        {back ? (
          <Link href={back} className="press -ml-2 rounded-lg px-2 py-1 text-sm text-primary">
            ‹ Back
          </Link>
        ) : null}
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
      </div>
      <div className="flex items-center gap-2">
        {action}
        <SyncChip />
      </div>
    </header>
  );
}

/**
 * A device that has never synced has no data yet. Downloading it is an explicit user action;
 * on an unverified connection the sync sheet shows the data-charges warning first.
 */
function FirstSyncBanner() {
  const s = useSyncStatus();
  const [open, setOpen] = React.useState(false);
  if (!s || s.lastSyncAt || s.phase === "syncing" || s.connection.status === "offline") return null;
  return (
    <>
      <div className="fixed inset-x-0 bottom-20 z-20 mx-auto max-w-lg px-4 pb-safe">
        <div className="flex items-center gap-3 rounded-2xl border bg-background p-3 shadow-lg">
          <CloudDownload className="size-5 shrink-0 text-primary" />
          <p className="flex-1 text-sm">Your data hasn&apos;t been downloaded to this device yet.</p>
          <Button size="sm" onClick={() => setOpen(true)}>Download</Button>
        </div>
      </div>
      <SyncSheet open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * Records the month-end net-worth snapshot the first time the app is opened after a month ends.
 * Only after this device has synced (so it isn't computed from incomplete data). Deterministic id:
 * if several devices do this, the first one recorded wins and is never rewritten.
 */
function AutoSnapshot() {
  const f = useFinance();
  const s = useSyncStatus();
  const due = s?.lastSyncAt && f.settings.id ? autoSnapshotDue(f.snapshots, f.today, f.liveAccounts.reduce<string | null>((m, a) => (m === null || a.openingDate < m ? a.openingDate : m), null)) : null;
  React.useEffect(() => {
    if (due) void takeSnapshot("auto", due).catch(() => {});
  }, [due]);
  return null;
}

/** While the app is open, urgent reminders also appear as system notifications (once each). */
function LocalNotifications() {
  const f = useFinance();
  const keys = f.notifications.map((n) => n.key).join("|");
  React.useEffect(() => {
    void showLocalNotifications(f.notifications);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);
  return null;
}

const NAV = [
  { href: "/app", label: "Home", icon: Home },
  { href: "/app/transactions", label: "Activity", icon: ArrowLeftRight },
  { href: "#add", label: "Add", icon: Plus },
  { href: "/app/calendar", label: "Plan", icon: PieChart },
  { href: "/app/more", label: "More", icon: MoreHorizontal },
];

function BottomNav() {
  const path = usePathname();
  const quickAdd = useQuickAdd();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 backdrop-blur pb-safe">
      <ul className="mx-auto grid max-w-lg grid-cols-5">
        {NAV.map((n) => {
          if (n.href === "#add")
            return (
              <li key={n.href} className="flex justify-center">
                <button
                  type="button"
                  aria-label="Quick add transaction"
                  onClick={() => quickAdd.open()}
                  className="press -mt-5 flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/30"
                >
                  <Plus className="size-6" />
                </button>
              </li>
            );
          const active = n.href === "/app" ? path === "/app" : n.href === "/app/calendar" ? isPlanPath(path) : path?.startsWith(n.href);
          return (
            <li key={n.href}>
              <Link
                href={n.href}
                className={cn("press flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground", active && "text-primary")}
                aria-current={active ? "page" : undefined}
              >
                <n.icon className="size-5" />
                {n.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
