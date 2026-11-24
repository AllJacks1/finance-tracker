"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, Download, FolderTree, Landmark, LayoutTemplate, LogOut, RefreshCw, Settings, Shield, ShieldCheck, Wallet2 } from "lucide-react";
import { PageHeader } from "@/components/app/app-shell";
import { useSyncStatus, useVault } from "@/client/hooks";
import { vault } from "@/client/vault";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const ITEMS = [
  { href: "/app/accounts", label: "Accounts", icon: Landmark, desc: "Balances, transfers, reconciliation" },
  { href: "/app/allocations", label: "Reserves & obligations", icon: Wallet2, desc: "Money set aside and bills to pay" },
  { href: "/app/categories", label: "Categories & tags", icon: FolderTree, desc: "Organise your spending" },
  { href: "/app/templates", label: "Templates", icon: LayoutTemplate, desc: "Reusable transactions" },
  { href: "/app/sync", label: "Sync & conflicts", icon: RefreshCw, desc: "Status, conflicts, failed changes" },
  { href: "/app/security", label: "Security", icon: Shield, desc: "Offline PIN, devices, password" },
  { href: "/app/export", label: "Export", icon: Download, desc: "CSV and full JSON export" },
  { href: "/app/settings", label: "Settings", icon: Settings, desc: "Timezone, week start, theme" },
];

export default function MorePage() {
  const v = useVault();
  const s = useSyncStatus();
  const router = useRouter();
  const pending = (s?.pending ?? 0) + (s?.failed ?? 0) + (s?.conflicts ?? 0);
  return (
    <>
      <PageHeader title="More" />
      <div className="mb-4 rounded-2xl border p-4">
        <div className="font-medium">{v.user?.name}</div>
        <div className="text-sm text-muted-foreground">{v.user?.email ?? "Signed in"}</div>
      </div>
      <nav className="grid gap-1">
        {ITEMS.map((i) => (
          <Link key={i.href} href={i.href} className="press flex items-center gap-3 rounded-xl px-2 py-3 hover:bg-muted/60">
            <span className="inline-flex size-9 items-center justify-center rounded-xl bg-muted"><i.icon className="size-[18px]" /></span>
            <span className="grid flex-1">
              <span className="font-medium">{i.label}</span>
              <span className="text-xs text-muted-foreground">{i.desc}</span>
            </span>
            <ChevronRight className="size-4 text-muted-foreground" />
          </Link>
        ))}
        {v.permissions.length > 0 ? (
          <a href="/admin" className="press flex items-center gap-3 rounded-xl px-2 py-3 hover:bg-muted/60">
            <span className="inline-flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary"><ShieldCheck className="size-[18px]" /></span>
            <span className="grid flex-1">
              <span className="font-medium">Administration</span>
              <span className="text-xs text-muted-foreground">Users and system (online only, no financial data)</span>
            </span>
            <ChevronRight className="size-4 text-muted-foreground" />
          </a>
        ) : null}
      </nav>
      <div className="mt-6 grid gap-2">
        {v.hasPin ? (
          <button className="press rounded-xl border px-4 py-3 text-left font-medium" onClick={() => vault.lock()}>Lock now</button>
        ) : null}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button className="press flex items-center gap-2 rounded-xl border px-4 py-3 text-left font-medium text-expense"><LogOut className="size-4" /> Sign out</button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Sign out?</AlertDialogTitle>
              <AlertDialogDescription>
                {pending > 0
                  ? `${pending} change(s) haven't synced yet. If you remove data from this device now, those changes are lost.`
                  : "Your data is synced."}{" "}
                Keep data on this device to use your PIN offline later, or remove it (recommended on shared devices).
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void vault.logout({ removeLocalData: false }).then(() => router.replace("/login"))}>Sign out, keep encrypted data</AlertDialogAction>
              <AlertDialogAction className="bg-destructive text-white" onClick={() => void vault.logout({ removeLocalData: true }).then(() => router.replace("/login"))}>Sign out and remove data</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </>
  );
}
