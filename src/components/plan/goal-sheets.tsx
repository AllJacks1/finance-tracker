"use client";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AmountInput, Field, FormSheet, NativeSelect, Segmented } from "@/components/finance/primitives";
import { ActionError, newId } from "@/client/actions";
import { contribute, reallocate, saveGoal, withdraw } from "@/client/goal-actions";
import { useFinance } from "@/client/hooks";
import type { Goal, GoalKind } from "@/lib/domain/types";

export const GOAL_KIND_LABEL: Record<GoalKind, string> = {
  emergency: "Emergency fund",
  travel: "Travel",
  education: "Education",
  home: "Home",
  vehicle: "Vehicle",
  purchase: "Major purchase",
  general: "General savings",
};

export function GoalSheet({ open, onOpenChange, goal, preset }: { open: boolean; onOpenChange: (o: boolean) => void; goal?: Goal; preset?: Partial<Goal> }) {
  const f = useFinance();
  const base = goal ?? preset;
  const [name, setName] = React.useState(base?.name ?? "");
  const [kind, setKind] = React.useState<GoalKind>(base?.kind ?? "general");
  const [target, setTarget] = React.useState<number | null>(base?.targetAmount ?? null);
  const [targetDate, setTargetDate] = React.useState(base?.targetDate ?? "");
  const [accountId, setAccountId] = React.useState(base?.accountId ?? "");
  const [description, setDescription] = React.useState(base?.description ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const submit = async () => {
    setError(null);
    if (!name.trim()) return setError("Name the goal.");
    if (!target) return setError("Enter a target amount.");
    try {
      await saveGoal({
        id: goal?.id ?? newId(),
        name: name.trim(),
        kind,
        targetAmount: target,
        targetDate: targetDate || null,
        accountId: accountId || null,
        description: description.trim() || null,
        status: goal?.status ?? "active",
        completedAt: goal?.completedAt ?? null,
      });
      toast.success("Goal saved");
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ActionError ? e.message : "Couldn't save.");
    }
  };
  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={goal ? "Edit goal" : "New savings goal"} footer={<Button size="lg" onClick={() => void submit()}>Save</Button>}>
      <Field label="Name" htmlFor="gn"><Input id="gn" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Japan trip, Tuition" /></Field>
      <Field label="Type" htmlFor="gk">
        <NativeSelect id="gk" value={kind} onChange={(e) => setKind(e.target.value as GoalKind)}>
          {(Object.keys(GOAL_KIND_LABEL) as GoalKind[]).map((k) => <option key={k} value={k}>{GOAL_KIND_LABEL[k]}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Target amount" htmlFor="gt"><AmountInput id="gt" value={target} onChange={setTarget} /></Field>
      <Field label="Target date (optional)" htmlFor="gd"><Input id="gd" type="date" value={targetDate} min={f.today} onChange={(e) => setTargetDate(e.target.value)} /></Field>
      <Field label="Where is the money kept? (optional)" htmlFor="ga" hint="Goal money in a savings account isn't subtracted from Safe-to-Spend again. In a spendable account, it's set aside.">
        <NativeSelect id="ga" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">Not linked</option>
          {f.activeAccounts.filter((a) => a.type !== "credit_card" && a.type !== "loan").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Description" htmlFor="gde"><Textarea id="gde" rows={2} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </FormSheet>
  );
}

type Mode = "contribute" | "withdraw" | "move";

export function GoalMoneySheet({ goal, open, onOpenChange, initial = "contribute" }: { goal: Goal; open: boolean; onOpenChange: (o: boolean) => void; initial?: Mode }) {
  const f = useFinance();
  const [mode, setMode] = React.useState<Mode>(initial);
  const [amount, setAmount] = React.useState<number | null>(null);
  const [date, setDate] = React.useState(f.today);
  const [note, setNote] = React.useState("");
  const [transferFrom, setTransferFrom] = React.useState("");
  const [toGoal, setToGoal] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const others = f.goals.filter((g) => g.id !== goal.id && g.status !== "archived");

  const submit = async () => {
    setError(null);
    if (!amount) return setError("Enter an amount.");
    try {
      if (mode === "contribute") await contribute(goal, amount, date, note.trim() || null, transferFrom || null);
      else if (mode === "withdraw") await withdraw(goal, amount, date, note.trim() || null);
      else {
        const target = others.find((g) => g.id === toGoal);
        if (!target) return setError("Choose the goal to move it to.");
        await reallocate(goal, target, amount, date);
      }
      toast.success("Saved");
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ActionError ? e.message : "Couldn't save.");
    }
  };

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={goal.name} footer={<Button size="lg" onClick={() => void submit()}>Save</Button>}>
      <Segmented value={mode} onChange={setMode} options={[{ value: "contribute", label: "Add" }, { value: "withdraw", label: "Withdraw" }, { value: "move", label: "Move to goal" }]} />
      <Field label="Amount" htmlFor="gma"><AmountInput id="gma" value={amount} onChange={setAmount} large /></Field>
      <Field label="Date" htmlFor="gmd"><Input id="gmd" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      {mode === "contribute" && goal.accountId ? (
        <Field label="Also transfer the money? (optional)" htmlFor="gmt" hint="Records a transfer into the goal's account. A transfer is never counted as spending.">
          <NativeSelect id="gmt" value={transferFrom} onChange={(e) => setTransferFrom(e.target.value)}>
            <option value="">No, the money is already there</option>
            {f.activeAccounts.filter((a) => a.id !== goal.accountId && a.type !== "credit_card" && a.type !== "loan").map((a) => <option key={a.id} value={a.id}>From {a.name}</option>)}
          </NativeSelect>
        </Field>
      ) : null}
      {mode === "move" ? (
        <Field label="Move to" htmlFor="gmg">
          <NativeSelect id="gmg" value={toGoal} onChange={(e) => setToGoal(e.target.value)}>
            <option value="">Choose…</option>
            {others.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </NativeSelect>
        </Field>
      ) : null}
      {mode !== "move" ? <Field label="Note" htmlFor="gmn"><Input id="gmn" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field> : null}
      <p className="text-xs text-muted-foreground">Goal amounts set money aside — they don&apos;t change account balances and aren&apos;t expenses.</p>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </FormSheet>
  );
}
