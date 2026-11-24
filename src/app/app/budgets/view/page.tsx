"use client";
import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Pencil } from "lucide-react";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { BudgetSheet, PERIOD_LABEL } from "@/components/finance/budget-form";
import { EmptyState, Money, SectionTitle } from "@/components/finance/primitives";
import { TransactionRow } from "@/components/finance/transaction-row";
import { useFinance } from "@/client/hooks";
import { budgetHistory, currentProgress } from "@/lib/finance/budgets";
import { cn } from "@/lib/utils";

export default function BudgetViewPage() {
  return (
    <React.Suspense>
      <BudgetView />
    </React.Suspense>
  );
}

function BudgetView() {
  const id = useSearchParams().get("id") ?? "";
  const f = useFinance();
  const [edit, setEdit] = React.useState(false);
  const b = f.budgets.find((x) => x.id === id);
  if (!b) return (<><PageHeader title="Budget" back="/app/budgets" /><EmptyState title="Budget not found" /></>);
  const p = currentProgress(b, f.liveTxns, f.today, f.settings.weekStart);
  const history = budgetHistory(b, f.liveTxns, f.today, f.settings.weekStart, 12);
  const txns = p
    ? f.liveTxns
        .filter((t) => (t.type === "expense" || t.type === "refund") && t.localDate >= p.period.start && t.localDate <= p.period.end && (b.scope === "overall" || t.categoryId === b.categoryId))
        .sort((a, c) => (a.occurredAt < c.occurredAt ? 1 : -1))
    : [];

  return (
    <>
      <PageHeader title={b.name} back="/app/budgets" action={<Button size="icon" variant="outline" aria-label="Edit budget" onClick={() => setEdit(true)}><Pencil className="size-4" /></Button>} />
      <div className="grid gap-5">
        {p ? (
          <div className="grid gap-2 rounded-2xl border p-4">
            <div className="text-xs text-muted-foreground">{PERIOD_LABEL[b.period]} · {p.period.start} to {p.period.end}</div>
            <div className="text-3xl font-semibold">
              {p.remaining < 0 ? <span className="text-expense">Over by <Money value={-p.remaining} /></span> : <><Money value={p.remaining} /> <span className="text-base font-normal text-muted-foreground">left</span></>}
            </div>
            <Progress value={Math.min(p.usedBp / 100, 100)} className={cn(p.state === "exceeded" && "[&>div]:bg-expense", (p.state === "warning" || p.state === "reached") && "[&>div]:bg-warning")} />
            <div className="text-sm text-muted-foreground">Spent <Money value={p.spent} /> of <Money value={p.amount} /> ({(p.usedBp / 100).toFixed(1)}%). Refunds reduce spending; transfers and adjustments don&apos;t count.</div>
          </div>
        ) : (
          <EmptyState title="This budget hasn't started yet" />
        )}

        {history.length > 1 ? (
          <section className="grid gap-2">
            <SectionTitle>History</SectionTitle>
            <div className="grid divide-y rounded-2xl border">
              {history.map((h) => (
                <div key={h.period.start} className="flex items-center justify-between gap-2 px-3 py-2.5 text-sm">
                  <span className="text-muted-foreground">{h.period.start}{h.period.end !== h.period.start ? ` – ${h.period.end.slice(5)}` : ""}</span>
                  <span className={cn("tabular", h.spent > h.amount && "text-expense")}>
                    <Money value={h.spent} /> / <Money value={h.amount} tone="muted" />
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="grid gap-1">
          <SectionTitle>This period&apos;s spending</SectionTitle>
          {txns.length ? txns.map((t) => <TransactionRow key={t.id} t={t} f={f} />) : <EmptyState title="Nothing spent yet" />}
        </section>
      </div>
      <BudgetSheet key={String(edit)} open={edit} onOpenChange={setEdit} budget={b} />
    </>
  );
}
