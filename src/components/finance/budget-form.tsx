"use client";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AmountInput, Field, FormSheet, NativeSelect, Segmented } from "./primitives";
import { ActionError, newId, remove, saveBudget } from "@/client/actions";
import { useFinance } from "@/client/hooks";
import type { Budget, BudgetPeriod, BudgetScope } from "@/lib/domain/types";
import { amountFor, periodFor } from "@/lib/finance/budgets";
import { startOfMonth } from "@/lib/finance/dates";

export const PERIOD_LABEL: Record<BudgetPeriod, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", custom: "Custom dates" };

export function BudgetSheet({ open, onOpenChange, budget }: { open: boolean; onOpenChange: (o: boolean) => void; budget?: Budget }) {
  const f = useFinance();
  const [scope, setScope] = React.useState<BudgetScope>(budget?.scope ?? "overall");
  const [categoryId, setCategoryId] = React.useState(budget?.categoryId ?? "");
  const [period, setPeriod] = React.useState<BudgetPeriod>(budget?.period ?? "monthly");
  const [startDate, setStartDate] = React.useState(budget?.startDate ?? startOfMonth(f.today));
  const [endDate, setEndDate] = React.useState(budget?.endDate ?? "");
  const currentAmount = budget ? amountFor(budget, periodFor(budget, f.today, f.settings.weekStart)?.start ?? f.today) : null;
  const [amount, setAmount] = React.useState<number | null>(currentAmount);
  const [name, setName] = React.useState(budget?.name ?? "");
  const [warnAtPct, setWarn] = React.useState(budget?.warnAtPct ?? 80);
  const [isActive, setActive] = React.useState(budget?.isActive ?? true);
  const [error, setError] = React.useState<string | null>(null);

  const cats = f.categories.filter((c) => !c.deletedAt && !c.isArchived && c.kind === "expense");
  const defaultName = scope === "overall" ? `${PERIOD_LABEL[period]} budget` : `${cats.find((c) => c.id === categoryId)?.name ?? "Category"} (${PERIOD_LABEL[period].toLowerCase()})`;

  const submit = async () => {
    setError(null);
    if (!amount || amount <= 0) return setError("Enter the budget amount.");
    const id = budget?.id ?? newId();
    let revisions = budget?.amountRevisions ?? [];
    if (!budget) revisions = [{ effectiveFrom: startDate, amount }];
    else if (amount !== currentAmount) {
      // Change applies from the current period; past periods keep their old amount (exact history).
      const draft: Budget = { ...budget, period, startDate, endDate: period === "custom" ? endDate || null : endDate || null };
      const from = periodFor(draft, f.today, f.settings.weekStart)?.start ?? startDate;
      revisions = [...revisions.filter((r) => r.effectiveFrom < from), { effectiveFrom: from, amount }];
    }
    if (revisions.length === 0 || revisions[0]!.effectiveFrom > startDate) revisions = [{ effectiveFrom: startDate, amount }, ...revisions.slice(1)];
    try {
      await saveBudget({
        id,
        name: name.trim() || defaultName,
        scope,
        categoryId: scope === "category" ? categoryId || null : null,
        period,
        startDate,
        endDate: endDate || null,
        amountRevisions: revisions,
        warnAtPct,
        rollover: false,
        isActive,
      });
      toast.success("Budget saved");
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ActionError ? e.message : "Couldn't save.");
    }
  };

  return (
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      title={budget ? "Edit budget" : "New budget"}
      footer={
        <div className="grid gap-2">
          <Button size="lg" onClick={() => void submit()}>Save</Button>
          {budget ? <Button variant="destructive" onClick={() => void remove("budget", budget.id).then(() => onOpenChange(false))}>Delete budget</Button> : null}
        </div>
      }
    >
      <Segmented value={scope} onChange={setScope} options={[{ value: "overall", label: "Overall" }, { value: "category", label: "Category" }]} />
      <p className="-mt-2 text-xs text-muted-foreground">
        {scope === "overall" ? "Counts spending in every category." : "A limit for one category. It sits inside your overall budget, not on top of it."}
      </p>
      {scope === "category" ? (
        <Field label="Category" htmlFor="bcat">
          <NativeSelect id="bcat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="" disabled>Choose…</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </NativeSelect>
        </Field>
      ) : null}
      <Field label="Period" htmlFor="bper">
        <NativeSelect id="bper" value={period} onChange={(e) => setPeriod(e.target.value as BudgetPeriod)}>
          {(Object.keys(PERIOD_LABEL) as BudgetPeriod[]).map((p) => <option key={p} value={p}>{PERIOD_LABEL[p]}</option>)}
        </NativeSelect>
      </Field>
      <Field label={period === "custom" ? "Amount for the whole range" : `Amount per ${period === "daily" ? "day" : period === "weekly" ? "week" : "month"}`} htmlFor="bamt" hint={budget && amount !== currentAmount ? "The new amount applies from the current period. Past periods keep their amount." : undefined}>
        <AmountInput id="bamt" value={amount} onChange={setAmount} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Starts" htmlFor="bstart"><Input id="bstart" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
        <Field label={period === "custom" ? "Ends" : "Ends (optional)"} htmlFor="bend"><Input id="bend" type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} /></Field>
      </div>
      <Field label="Name" htmlFor="bname"><Input id="bname" value={name} maxLength={80} placeholder={defaultName} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label={`Warn me at ${warnAtPct}% used`} htmlFor="bwarn">
        <input id="bwarn" type="range" min={50} max={100} step={5} value={warnAtPct} onChange={(e) => setWarn(Number(e.target.value))} className="accent-[var(--primary)]" />
      </Field>
      {budget ? (
        <label className="flex items-center justify-between rounded-xl border p-3 text-sm">Active <Switch checked={isActive} onCheckedChange={setActive} /></label>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </FormSheet>
  );
}
