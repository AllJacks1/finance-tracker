"use client";
import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Archive, CheckCircle2, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { EmptyState, Money, SectionTitle } from "@/components/finance/primitives";
import { GOAL_KIND_LABEL, GoalMoneySheet, GoalSheet } from "@/components/plan/goal-sheets";
import { saveGoal } from "@/client/goal-actions";
import { useFinance } from "@/client/hooks";

export default function GoalViewPage() {
  return (
    <React.Suspense>
      <GoalView />
    </React.Suspense>
  );
}

function GoalView() {
  const id = useSearchParams().get("id") ?? "";
  const f = useFinance();
  const [edit, setEdit] = React.useState(false);
  const [money, setMoney] = React.useState(false);
  const view = f.goalViews.find((g) => g.goal.id === id);
  if (!view) return (<><PageHeader title="Goal" back="/app/goals" /><EmptyState title="Goal not found" /></>);
  const { goal, progress } = view;
  const entries = f.goalEntries.filter((e) => e.goalId === id).sort((a, b) => (a.entryDate < b.entryDate ? 1 : -1));
  const account = goal.accountId ? f.accountById.get(goal.accountId) : undefined;
  const accountBalance = goal.accountId ? (f.balances.get(goal.accountId) ?? 0) : null;

  return (
    <>
      <PageHeader title={goal.name} back="/app/goals" action={<Button size="icon" variant="outline" aria-label="Edit goal" onClick={() => setEdit(true)}><Pencil className="size-4" /></Button>} />
      <div className="grid gap-4">
        <div className="grid gap-2 rounded-2xl border p-4">
          <div className="text-xs text-muted-foreground">{GOAL_KIND_LABEL[goal.kind]}{goal.status !== "active" ? ` · ${goal.status}` : ""}</div>
          <div className="text-3xl font-semibold"><Money value={progress.allocated} /> <span className="text-base font-normal text-muted-foreground">of <Money value={goal.targetAmount} /></span></div>
          <Progress value={progress.pctBp / 100} />
          <div className="text-sm text-muted-foreground">
            {progress.reached ? "Target reached!" : <><Money value={progress.remaining} /> to go</>}
            {goal.targetDate && !progress.reached ? <> · by {goal.targetDate}{progress.suggestedMonthly ? <> · about <Money value={progress.suggestedMonthly} /> a month</> : null}</> : null}
          </div>
          {account ? (
            <div className="text-xs text-muted-foreground">
              Kept in {account.name} (balance <Money value={accountBalance ?? 0} />). {account.countsAsSpendable ? "This money is set aside from Safe-to-Spend." : "That account isn't counted as spendable, so it isn't subtracted again."}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">Not linked to an account: tracked, but not subtracted from Safe-to-Spend.</div>
          )}
        </div>
        <Button size="lg" onClick={() => setMoney(true)}><Plus className="size-4" /> Add, withdraw or move money</Button>
        <div className="grid grid-cols-2 gap-2">
          {goal.status === "active" ? (
            <Button variant="outline" onClick={() => void saveGoal({ ...goal, status: "completed", completedAt: f.today }).then(() => toast.success("Goal completed"))}><CheckCircle2 className="size-4" /> Mark completed</Button>
          ) : (
            <Button variant="outline" onClick={() => void saveGoal({ ...goal, status: "active", completedAt: null }).then(() => toast("Goal reopened"))}>Reopen</Button>
          )}
          <Button variant="outline" onClick={() => void saveGoal({ ...goal, status: "archived" }).then(() => toast("Archived. Its money is no longer set aside."))}><Archive className="size-4" /> Archive</Button>
        </div>
        <section className="grid gap-1">
          <SectionTitle>Contribution history</SectionTitle>
          {entries.length ? entries.map((e) => (
            <div key={e.id} className="flex items-center justify-between rounded-xl px-2 py-2">
              <span className="grid text-sm">
                <span>{e.amount > 0 ? "Added" : "Withdrawn"}{e.note ? ` · ${e.note}` : ""}</span>
                <span className="text-xs text-muted-foreground">{e.entryDate}{e.transactionId ? " · with transfer" : ""}</span>
              </span>
              <Money value={e.amount} tone={e.amount > 0 ? "income" : "neutral"} sign="always" className="text-sm font-semibold" />
            </div>
          )) : <p className="px-1 text-sm text-muted-foreground">No contributions yet.</p>}
        </section>
        {goal.description ? <p className="rounded-xl bg-muted/60 p-3 text-sm">{goal.description}</p> : null}
      </div>
      <GoalSheet key={String(edit)} open={edit} onOpenChange={setEdit} goal={goal} />
      {money ? <GoalMoneySheet goal={goal} open={money} onOpenChange={setMoney} /> : null}
    </>
  );
}
