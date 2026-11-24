"use client";
import * as React from "react";
import Link from "next/link";
import { AlertTriangle, PieChart, Plus } from "lucide-react";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { BudgetSheet, PERIOD_LABEL } from "@/components/finance/budget-form";
import { EmptyState, Money, SectionTitle } from "@/components/finance/primitives";
import { useFinance } from "@/client/hooks";
import { currentProgress, overallAllocation, type BudgetProgress } from "@/lib/finance/budgets";
import type { Budget } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

export default function BudgetsPage() {
  const f = useFinance();
  const [open, setOpen] = React.useState(false);
  const [key, setKey] = React.useState(0);
  const withProgress = f.budgets.map((b) => ({ b, p: currentProgress(b, f.liveTxns, f.today, f.settings.weekStart) }));
  const overall = withProgress.filter((x) => x.b.scope === "overall" && x.b.isActive);
  const category = withProgress.filter((x) => x.b.scope === "category" && x.b.isActive);
  const inactive = withProgress.filter((x) => !x.b.isActive);

  return (
    <>
      <PageHeader title="Budgets" action={<Button size="icon" variant="outline" aria-label="New budget" onClick={() => { setKey((k) => k + 1); setOpen(true); }}><Plus className="size-4" /></Button>} />
      {f.budgets.length === 0 ? (
        <EmptyState icon={<PieChart className="size-8" />} title="No budgets yet">
          <p>Set an overall monthly budget, then optional limits for categories like Food or Transportation.</p>
          <Button className="mt-3" onClick={() => setOpen(true)}>Create a budget</Button>
        </EmptyState>
      ) : (
        <div className="grid gap-5">
          {overall.length ? (
            <section className="grid gap-2">
              <SectionTitle>Overall</SectionTitle>
              {overall.map(({ b, p }) => {
                const alloc = overallAllocation(b, f.budgets, f.today, f.settings.weekStart);
                return (
                  <BudgetCard key={b.id} b={b} p={p}>
                    {alloc && alloc.categoryBudgetIds.length ? (
                      <p className={cn("text-xs", alloc.overAllocated ? "text-expense" : "text-muted-foreground")}>
                        {alloc.overAllocated ? <AlertTriangle className="mr-1 inline size-3" /> : null}
                        <Money value={alloc.allocatedToCategories} /> assigned to category budgets · <Money value={alloc.unallocated} /> unassigned
                        {alloc.overAllocated ? " (category limits add up to more than this budget)" : ""}
                      </p>
                    ) : null}
                  </BudgetCard>
                );
              })}
            </section>
          ) : null}
          {category.length ? (
            <section className="grid gap-2">
              <SectionTitle>By category</SectionTitle>
              {category.map(({ b, p }) => <BudgetCard key={b.id} b={b} p={p} />)}
            </section>
          ) : null}
          {inactive.length ? (
            <section className="grid gap-2">
              <SectionTitle>Inactive</SectionTitle>
              {inactive.map(({ b, p }) => <BudgetCard key={b.id} b={b} p={p} />)}
            </section>
          ) : null}
        </div>
      )}
      <BudgetSheet key={key} open={open} onOpenChange={setOpen} />
    </>
  );
}

function BudgetCard({ b, p, children }: { b: Budget; p: BudgetProgress | null; children?: React.ReactNode }) {
  const f = useFinance();
  const cat = b.categoryId ? f.categoryById.get(b.categoryId) : null;
  return (
    <Link href={`/app/budgets/view?id=${b.id}`} className="press grid gap-2 rounded-2xl border p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="grid">
          <span className="font-medium">{b.name}</span>
          <span className="text-xs text-muted-foreground">
            {PERIOD_LABEL[b.period]}{cat ? ` · ${cat.name}` : ""}{p ? ` · ${p.period.start.slice(5)} – ${p.period.end.slice(5)}` : " · not started"}
          </span>
        </div>
        {p ? (
          <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", p.state === "exceeded" ? "bg-expense/15 text-expense" : p.state === "ok" ? "bg-muted text-muted-foreground" : "bg-warning/20 text-warning")}>
            {Math.floor(p.usedBp / 100)}%
          </span>
        ) : null}
      </div>
      {p ? (
        <>
          <Progress value={Math.min(p.usedBp / 100, 100)} className={cn(p.state === "exceeded" && "[&>div]:bg-expense", (p.state === "warning" || p.state === "reached") && "[&>div]:bg-warning")} />
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Spent <Money value={p.spent} /> of <Money value={p.amount} /></span>
            <span className={cn("font-medium", p.remaining < 0 && "text-expense")}>
              {p.remaining < 0 ? <>Over by <Money value={-p.remaining} /></> : <><Money value={p.remaining} /> left</>}
            </span>
          </div>
        </>
      ) : null}
      {children}
    </Link>
  );
}
