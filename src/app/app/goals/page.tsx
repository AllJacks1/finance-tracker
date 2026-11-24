"use client";
import * as React from "react";
import Link from "next/link";
import { LifeBuoy, PiggyBank, Plus, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { AmountInput, EmptyState, Field, FormSheet, Money, SectionTitle, Segmented } from "@/components/finance/primitives";
import { GOAL_KIND_LABEL, GoalSheet } from "@/components/plan/goal-sheets";
import { PlanTabs } from "@/components/plan/plan-tabs";
import { ActionError } from "@/client/actions";
import { savePreferences } from "@/client/goal-actions";
import { useFinance } from "@/client/hooks";
import type { CoverageMonths, Goal } from "@/lib/domain/types";
import { accountAllocations, emergencyCoverage, essentialMonthlyAverage } from "@/lib/finance/goals";

const MONTH_OPTIONS = [3, 6, 9, 12] as const;

export default function GoalsPage() {
  const f = useFinance();
  const [sheet, setSheet] = React.useState<{ open: boolean; key: number; preset?: Partial<Goal> }>({ open: false, key: 0 });
  const [efSettings, setEfSettings] = React.useState(false);
  const prefs = f.settings.preferences;
  const emergency = f.goalViews.find((g) => g.goal.kind === "emergency" && g.goal.status !== "archived");
  const avg = essentialMonthlyAverage(f.liveTxns, f.categories, f.today, prefs.essentialsLookbackMonths);
  const monthly = prefs.essentialsOverride ?? avg.average;
  const coverage = emergencyCoverage(emergency?.progress.allocated ?? 0, monthly, prefs.emergencyTargetMonths);
  const others = f.goalViews.filter((g) => g !== emergency && g.goal.status !== "archived");
  const active = others.filter((g) => g.goal.status === "active" && !g.progress.reached);
  const done = others.filter((g) => g.goal.status === "completed" || g.progress.reached);
  const overAllocated = accountAllocations(f.goals, f.allocated, f.balances).filter((a) => a.overAllocated);

  return (
    <>
      <PageHeader title="Goals" action={<Button size="icon" variant="outline" aria-label="New goal" onClick={() => setSheet((s) => ({ open: true, key: s.key + 1 }))}><Plus className="size-4" /></Button>} />
      <PlanTabs />
      <div className="grid gap-5">
        {/* Emergency fund */}
        <section className="grid gap-3 rounded-2xl border p-4">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 font-semibold"><LifeBuoy className="size-5 text-primary" /> Emergency fund</span>
            <Button size="icon-sm" variant="ghost" aria-label="Emergency fund settings" onClick={() => setEfSettings(true)}><Settings2 className="size-4" /></Button>
          </div>
          {monthly > 0 ? (
            <>
              <div className="text-3xl font-semibold">{coverage.coverageTenths === null ? "—" : (coverage.coverageTenths / 10).toFixed(1)} <span className="text-base font-normal text-muted-foreground">months covered</span></div>
              <Progress value={coverage.pctOfTargetBp / 100} />
              <p className="text-sm text-muted-foreground">
                <Money value={coverage.fund} /> saved of <Money value={coverage.targetAmount} /> ({prefs.emergencyTargetMonths} months × <Money value={monthly} /> essential expenses a month)
              </p>
              <p className="text-xs text-muted-foreground">
                {prefs.essentialsOverride ? "Essential expenses set manually." : `Average of essential categories over the last ${prefs.essentialsLookbackMonths} full months${avg.monthsWithData < prefs.essentialsLookbackMonths ? ` (only ${avg.monthsWithData} month(s) of data so far)` : ""}.`}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Not enough spending in essential categories yet to estimate monthly essentials. Record a month of expenses or set the amount manually in settings.</p>
          )}
          {emergency ? (
            <Button variant="outline" asChild><Link href={`/app/goals/view?id=${emergency.goal.id}`}>Open emergency fund</Link></Button>
          ) : (
            <Button onClick={() => setSheet((s) => ({ open: true, key: s.key + 1, preset: { name: "Emergency fund", kind: "emergency", targetAmount: coverage.targetAmount || undefined } }))}>Set up emergency fund</Button>
          )}
        </section>

        {overAllocated.length ? (
          <p className="rounded-xl bg-warning/15 p-3 text-sm">
            More is set aside for goals than is in {overAllocated.map((a) => f.accountById.get(a.accountId)?.name).join(", ")}. Withdraw or move some goal money, or link goals to other accounts.
          </p>
        ) : null}

        {active.length === 0 && done.length === 0 ? (
          <EmptyState icon={<PiggyBank className="size-8" />} title="No savings goals yet">
            <p>Save for travel, education, a home, a vehicle or anything else. Goals set money aside without counting it as spending.</p>
          </EmptyState>
        ) : null}
        {active.length ? <GoalList title="In progress" items={active} /> : null}
        {done.length ? <GoalList title="Completed" items={done} /> : null}
      </div>
      <GoalSheet key={sheet.key} open={sheet.open} onOpenChange={(o) => setSheet((s) => ({ ...s, open: o }))} preset={sheet.preset} />
      {efSettings ? <EmergencySettings open={efSettings} onOpenChange={setEfSettings} /> : null}
    </>
  );
}

function GoalList({ title, items }: { title: string; items: ReturnType<typeof useFinance>["goalViews"] }) {
  const f = useFinance();
  return (
    <section className="grid gap-2">
      <SectionTitle>{title}</SectionTitle>
      {items.map(({ goal, progress }) => (
        <Link key={goal.id} href={`/app/goals/view?id=${goal.id}`} className="press grid gap-2 rounded-2xl border p-4">
          <div className="flex items-center justify-between">
            <span className="font-medium">{goal.name}</span>
            <span className="text-sm text-muted-foreground">{Math.floor(progress.pctBp / 100)}%</span>
          </div>
          <Progress value={progress.pctBp / 100} />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span><Money value={progress.allocated} /> of <Money value={goal.targetAmount} /> · {GOAL_KIND_LABEL[goal.kind]}{goal.accountId ? ` · in ${f.accountById.get(goal.accountId)?.name ?? "?"}` : ""}</span>
            {progress.suggestedMonthly ? <span><Money value={progress.suggestedMonthly} />/mo</span> : null}
          </div>
        </Link>
      ))}
    </section>
  );
}

function EmergencySettings({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const f = useFinance();
  const p = f.settings.preferences;
  const [target, setTarget] = React.useState(String(p.emergencyTargetMonths));
  const [lookback, setLookback] = React.useState(String(p.essentialsLookbackMonths));
  const [override, setOverride] = React.useState<number | null>(p.essentialsOverride);
  const opts = MONTH_OPTIONS.map((m) => ({ value: String(m), label: `${m} mo` }));
  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title="Emergency fund settings" footer={
      <Button size="lg" onClick={() => void savePreferences({ emergencyTargetMonths: Number(target) as CoverageMonths, essentialsLookbackMonths: Number(lookback) as CoverageMonths, essentialsOverride: override })
        .then(() => { toast.success("Saved"); onOpenChange(false); })
        .catch((e) => toast.error(e instanceof ActionError ? e.message : "Couldn't save."))}>Save</Button>
    }>
      <Field label="Target: months of essential expenses"><Segmented value={target} onChange={setTarget} options={opts} /></Field>
      <Field label="Estimate essentials from the last"><Segmented value={lookback} onChange={setLookback} options={opts} /></Field>
      <Field label="Or set monthly essentials yourself (optional)" htmlFor="ov" hint="Leave empty to use the average of categories marked essential (Categories → edit → Essential).">
        <AmountInput id="ov" value={override} onChange={setOverride} />
      </Field>
    </FormSheet>
  );
}
