"use client";
import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { AccountSheet } from "@/components/finance/account-form";
import { ACCOUNT_TYPE_META, EntityIcon } from "@/components/finance/icons";
import { EmptyState, Money, SectionTitle } from "@/components/finance/primitives";
import { useFinance } from "@/client/hooks";
import { isLiabilityType, type Account } from "@/lib/domain/types";

export default function AccountsPage() {
  return (
    <React.Suspense>
      <Accounts />
    </React.Suspense>
  );
}

function Accounts() {
  const f = useFinance();
  const params = useSearchParams();
  const [open, setOpen] = React.useState(params.get("new") === "1");
  const [key, setKey] = React.useState(0);
  const groups: [string, Account[]][] = [
    ["Spendable", f.liveAccounts.filter((a) => a.isActive && a.countsAsSpendable && !isLiabilityType(a.type))],
    ["Savings & other", f.liveAccounts.filter((a) => a.isActive && !a.countsAsSpendable && !isLiabilityType(a.type))],
    ["Liabilities", f.liveAccounts.filter((a) => a.isActive && isLiabilityType(a.type))],
    ["Inactive", f.liveAccounts.filter((a) => !a.isActive)],
  ];
  return (
    <>
      <PageHeader title="Accounts" back="/app/more" action={<Button size="icon" variant="outline" aria-label="Add account" onClick={() => { setKey((k) => k + 1); setOpen(true); }}><Plus className="size-4" /></Button>} />
      <div className="mb-4 grid grid-cols-2 gap-2">
        <div className="rounded-2xl border p-3"><div className="text-xs text-muted-foreground">Available</div><div className="text-lg font-semibold"><Money value={f.totals.available} /></div></div>
        <div className="rounded-2xl border p-3"><div className="text-xs text-muted-foreground">Net worth</div><div className="text-lg font-semibold"><Money value={f.totals.netWorth} /></div></div>
      </div>
      {f.liveAccounts.length === 0 ? (
        <EmptyState title="No accounts yet">
          <Button className="mt-2" onClick={() => setOpen(true)}>Add account</Button>
        </EmptyState>
      ) : (
        <div className="grid gap-4">
          {groups.filter(([, list]) => list.length).map(([title, list]) => (
            <section key={title} className="grid gap-1">
              <SectionTitle>{title}</SectionTitle>
              {list.map((a) => (
                <Link key={a.id} href={`/app/accounts/view?id=${a.id}`} className="press flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-muted/60">
                  <EntityIcon name={a.icon ?? ACCOUNT_TYPE_META[a.type].icon} color={a.color} />
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate font-medium">{a.name}</span>
                    <span className="text-xs text-muted-foreground">{ACCOUNT_TYPE_META[a.type].label}</span>
                  </span>
                  <Money value={f.balances.get(a.id) ?? 0} tone={(f.balances.get(a.id) ?? 0) < 0 ? "expense" : "neutral"} className="font-semibold" />
                </Link>
              ))}
            </section>
          ))}
        </div>
      )}
      <AccountSheet key={key} open={open} onOpenChange={setOpen} />
    </>
  );
}
