"use client";
import * as React from "react";
import Link from "next/link";
import { AlertTriangle, CalendarClock, ChevronRight, Info, Wallet } from "lucide-react";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { EmptyState, FormSheet, Money, SectionTitle } from "@/components/finance/primitives";
import { TransactionRow } from "@/components/finance/transaction-row";
import { useQuickAdd } from "@/components/finance/transaction-form";
import { useFinance, useVault } from "@/client/hooks";
import { currentProgress } from "@/lib/finance/budgets";
import { endOfMonth, startOfMonth } from "@/lib/finance/dates";
import { periodTotals } from "@/lib/finance/ledger";
import { addDays } from "@/lib/finance/dates";
import { StatusBadge } from "@/components/plan/bill-sheets";
import { NotificationBell } from "@/components/plan/notifications";
import { cn } from "@/lib/utils";

export default function Dashboard() {
  const f = useFinance();
  const v = useVault();
  const { open } = useQuickAdd();
  const [stsOpen, setStsOpen] = React.useState(false);
  const month = periodTotals(f.liveTxns, startOfMonth(f.today), endOfMonth(f.today));
  const recent = [...f.liveTxns].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1)).slice(0, 6);
  const budgets = f.budgets
    .filter((b) => b.isActive)
    .map((b) => ({ b, p: currentProgress(b, f.liveTxns, f.today, f.settings.weekStart) }))
    .filter((x) => x.p)
    .sort((a, b) => b.p!.usedBp - a.p!.usedBp);
  const upcoming = f.bills
    .filter((b) => b.outstanding > 0 && !b.cancelled && b.dueDate <= addDays(f.today, 7))
    .sort((a, b) => (a.dueDate ?? "9999") < (b.dueDate ?? "9999") ? -1 : 1)
    .slice(0, 4);
  const hasLiabilities = f.liveAccounts.some((a) => a.type === "credit_card" || a.type === "loan");

  return (
    <>
      <PageHeader title={`Hi, ${v.user?.name?.split(" ")[0] ?? "there"}`} action={<NotificationBell />} />

      {f.liveAccounts.length === 0 ? (
        <EmptyState icon={<Wallet className="size-8" />} title="Add your first account">
          <p className="mb-3">Start with your cash, bank or GCash/Maya balance.</p>
          <Button asChild><Link href="/app/accounts?new=1">Add account</Link></Button>
        </EmptyState>
      ) : (
        <div className="grid gap-5">
          {/* Safe to spend — projected */}
          <button type="button" onClick={() => setStsOpen(true)} className="press rounded-2xl bg-primary p-5 text-left text-primary-foreground shadow-sm">
            <div className="flex items-center justify-between text-sm opacity-90">
              <span>Safe to spend · until {f.sts.horizonEnd.slice(5).replace("-", "/")}{f.settings.preferences.stsHorizon === "next_income" && f.nextIncome ? " (next income)" : ""}</span>
              <Info className="size-4" />
            </div>
            <div className="mt-1 text-4xl font-semibold tracking-tight">
              <Money value={f.sts.safeToSpend} />
            </div>
            <div className="mt-2 text-xs opacity-90">
              Projected: spendable money minus goal savings, unpaid bills and scheduled payments
            </div>
          </button>
          {f.sts.safeToSpend < 0 ? (
            <p className="-mt-3 flex items-center gap-2 text-sm text-expense"><AlertTriangle className="size-4" /> Your obligations and reserves exceed your spendable money.</p>
          ) : null}

          {/* Actual balances */}
          <section className="grid gap-2">
            <SectionTitle action={<Link href="/app/accounts" className="text-sm text-primary">Accounts</Link>}>Actual balances</SectionTitle>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Available funds" value={f.totals.available} hint="Spendable accounts" />
              <Stat label={hasLiabilities ? "Net worth" : "Total balances"} value={hasLiabilities ? f.totals.netWorth : f.totals.assets} />
              <Stat label="Savings" value={f.totals.savings} />
              {hasLiabilities ? (
                <Stat label="Liabilities" value={f.totals.liabilities} tone="expense" />
              ) : (
                <Stat label="Set aside" value={f.sts.reserves + f.sts.obligations + f.sts.scheduled} hint="Goals, bills & scheduled" />
              )}
            </div>
          </section>

          <section className="grid gap-2">
            <SectionTitle>This month</SectionTitle>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Income" value={month.income} tone="income" />
              <Stat label="Expenses" value={month.netExpense} hint={month.refunds ? "Net of refunds" : undefined} />
            </div>
          </section>

          {budgets.length > 0 ? (
            <section className="grid gap-2">
              <SectionTitle action={<Link href="/app/budgets" className="text-sm text-primary">All budgets</Link>}>Budgets</SectionTitle>
              <div className="grid gap-2 rounded-2xl border p-3">
                {budgets.slice(0, 4).map(({ b, p }) => (
                  <Link key={b.id} href={`/app/budgets/view?id=${b.id}`} className="grid gap-1.5 rounded-lg p-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">{b.name}</span>
                      <span className={cn("tabular", p!.state === "exceeded" ? "text-expense" : p!.state === "warning" || p!.state === "reached" ? "text-warning" : "text-muted-foreground")}>
                        <Money value={p!.remaining} /> left
                      </span>
                    </div>
                    <Progress value={Math.min(p!.usedBp / 100, 100)} className={cn(p!.state === "exceeded" && "[&>div]:bg-expense", (p!.state === "warning" || p!.state === "reached") && "[&>div]:bg-warning")} />
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          {f.pending.length > 0 ? (
            <Link href="/app/recurring" className="press flex items-center gap-3 rounded-2xl border border-warning/50 bg-warning/10 p-3">
              <CalendarClock className="size-5 text-warning" />
              <span className="flex-1 text-sm">
                <b>{f.pending.length} scheduled item(s)</b> need confirmation. They aren&apos;t in your balances until you confirm.
              </span>
            </Link>
          ) : null}

          {upcoming.length > 0 ? (
            <section className="grid gap-2">
              <SectionTitle action={<Link href="/app/bills" className="text-sm text-primary">All bills</Link>}>Bills due soon</SectionTitle>
              <div className="grid rounded-2xl border p-1">
                {upcoming.slice(0, 5).map((b) => (
                  <Link key={b.key} href={`/app/bills/view?id=${b.id}`} className="flex items-center gap-3 rounded-xl p-2">
                    <CalendarClock className="size-5 text-muted-foreground" />
                    <span className="grid min-w-0 flex-1">
                      <span className="truncate">{b.name}</span>
                      <span className="text-xs text-muted-foreground">Due {b.dueDate}</span>
                    </span>
                    <span className="grid justify-items-end gap-0.5 text-sm">
                      <Money value={b.outstanding} />
                      <StatusBadge status={b.status} />
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          <section className="grid gap-2">
            <SectionTitle action={<Link href="/app/transactions" className="text-sm text-primary">See all</Link>}>Recent activity</SectionTitle>
            {recent.length ? (
              <div className="grid">{recent.map((t) => <TransactionRow key={t.id} t={t} f={f} />)}</div>
            ) : (
              <EmptyState title="No transactions yet">
                <Button className="mt-2" onClick={() => open()}>Add a transaction</Button>
              </EmptyState>
            )}
          </section>
        </div>
      )}

      <FormSheet open={stsOpen} onOpenChange={setStsOpen} title="How Safe to Spend is calculated" description="Actual balances minus money you've set aside. Budgets are plans, so they are not subtracted.">
        <Breakdown title="Spendable balances (actual)" total={f.sts.spendableBalance} lines={f.sts.spendableAccounts} />
        <Breakdown title="Reserved (projected)" total={-f.sts.reserves} lines={f.sts.reserveLines.map((l) => ({ ...l, amount: -l.amount }))} />
        <Breakdown title={`Unpaid bills due by ${f.sts.horizonEnd}`} total={-f.sts.obligations} lines={f.sts.obligationLines.map((l) => ({ ...l, amount: -l.amount }))} />
        <Breakdown title="Scheduled payments not yet confirmed" total={-f.sts.scheduled} lines={f.sts.scheduledLines.map((l) => ({ ...l, amount: -l.amount }))} />
        <div className="flex items-center justify-between rounded-xl bg-muted p-3 font-semibold">
          <span>Safe to spend</span>
          <Money value={f.sts.safeToSpend} />
        </div>
        {f.sts.excluded.length ? (
          <div className="grid gap-1 text-sm">
            <p className="font-medium">Not subtracted</p>
            {f.sts.excluded.map((e) => (
              <p key={e.id} className="text-muted-foreground">{e.name} (<Money value={e.amount} />) — {e.note}</p>
            ))}
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Savings accounts and credit cards aren&apos;t counted as spendable (change this per account). Goal money in spendable accounts is set aside. Each bill counts once: paying it lowers your balance and removes it from this list. Scheduled income isn&apos;t added until it arrives.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" asChild><Link href="/app/bills">Bills <ChevronRight className="size-4" /></Link></Button>
          <Button variant="outline" asChild><Link href="/app/goals">Goals <ChevronRight className="size-4" /></Link></Button>
        </div>
      </FormSheet>
    </>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone?: "income" | "expense" }) {
  return (
    <div className="rounded-2xl border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold"><Money value={value} tone={tone ?? "neutral"} /></div>
      {hint ? <div className="text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function Breakdown({ title, total, lines }: { title: string; total: number; lines: { id: string; name: string; amount: number; note?: string }[] }) {
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between text-sm font-medium">
        <span>{title}</span>
        <Money value={total} />
      </div>
      {lines.map((l) => (
        <div key={l.id} className="flex items-center justify-between pl-3 text-sm text-muted-foreground">
          <span className="truncate">{l.name}{l.note ? ` · ${l.note}` : ""}</span>
          <Money value={l.amount} tone="muted" />
        </div>
      ))}
    </div>
  );
}
