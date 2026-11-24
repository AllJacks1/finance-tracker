"use client";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AmountInput, Field, FormSheet, NativeSelect, Segmented } from "@/components/finance/primitives";
import { ActionError, newId } from "@/client/actions";
import { editFutureOccurrences, saveSchedule } from "@/client/plan-actions";
import { useFinance } from "@/client/hooks";
import type { BillKind, RecurrenceRule, Schedule } from "@/lib/domain/types";
import { RuleEditor } from "./rule-editor";

type Mode = { kind: "new"; scheduleKind: Schedule["kind"] } | { kind: "edit_all"; schedule: Schedule } | { kind: "edit_future"; schedule: Schedule; from: string };

/**
 * Create or edit a schedule.
 *  - kind "transaction": planned income / expense / transfer (needs confirmation each time)
 *  - kind "bill": recurring bill (each occurrence is a bill you pay, fully or in parts)
 * Editing "this and future" splits the schedule so past occurrences keep their history.
 */
export function ScheduleSheet({ open, onOpenChange, mode }: { open: boolean; onOpenChange: (o: boolean) => void; mode: Mode }) {
  const f = useFinance();
  const existing = mode.kind === "new" ? null : mode.schedule;
  const scheduleKind = existing?.kind ?? (mode.kind === "new" ? mode.scheduleKind : "transaction");
  const [txnType, setTxnType] = React.useState<Schedule["txnType"]>(existing?.txnType ?? (scheduleKind === "bill" ? "expense" : "income"));
  const [name, setName] = React.useState(existing?.name ?? "");
  const [amount, setAmount] = React.useState<number | null>(existing?.amount ?? null);
  const [accountId, setAccountId] = React.useState(existing?.accountId ?? f.activeAccounts.find((a) => a.countsAsSpendable)?.id ?? "");
  const [toAccountId, setToAccountId] = React.useState(existing?.toAccountId ?? "");
  const [categoryId, setCategoryId] = React.useState(existing?.categoryId ?? "");
  const [billKind, setBillKind] = React.useState<BillKind>(existing?.billKind ?? "general");
  const [cardAccountId, setCard] = React.useState(existing?.cardAccountId ?? "");
  const [debtId, setDebt] = React.useState(existing?.debtId ?? "");
  const [notes, setNotes] = React.useState(existing?.notes ?? "");
  const [rule, setRule] = React.useState<RecurrenceRule>(
    mode.kind === "edit_future"
      ? { ...mode.schedule.rule, startDate: mode.from }
      : (existing?.rule ?? { freq: "monthly", interval: 1, startDate: f.today, endDate: null, count: null }),
  );
  const [error, setError] = React.useState<string | null>(null);

  const isBill = scheduleKind === "bill";
  const cats = f.categories.filter((c) => !c.deletedAt && !c.isArchived && c.kind === (txnType === "income" ? "income" : "expense"));
  // Cards with statement tracking already get one bill per statement: never add a second one.
  const autoBillCards = new Set(f.cardProfiles.filter((p) => p.autoBills).map((p) => p.accountId));
  const cards = f.liveAccounts.filter((a) => a.type === "credit_card" && (!autoBillCards.has(a.id) || a.id === existing?.cardAccountId));

  const submit = async () => {
    setError(null);
    if (!name.trim()) return setError("Give it a name.");
    if (!amount) return setError("Enter the amount.");
    if (!isBill && !accountId) return setError("Choose an account.");
    const data: Schedule = {
      id: existing?.id ?? newId(),
      kind: scheduleKind,
      name: name.trim(),
      txnType: isBill ? (billKind === "general" ? "expense" : "transfer") : txnType,
      amount,
      accountId: accountId || null,
      toAccountId: !isBill && txnType === "transfer" ? toAccountId || null : null,
      categoryId: (isBill ? billKind === "general" : txnType !== "transfer") ? categoryId || null : null,
      description: existing?.description ?? null,
      notes: notes.trim() || null,
      tagIds: existing?.tagIds ?? [],
      rule,
      pauses: existing?.pauses ?? [],
      status: existing?.status ?? "active",
      billKind: isBill ? billKind : null,
      cardAccountId: isBill && billKind === "card_payment" ? cardAccountId || null : null,
      debtId: isBill && billKind === "loan_installment" ? debtId || null : null,
      paysBillScheduleId: existing?.paysBillScheduleId ?? null,
      reminderDays: existing?.reminderDays ?? null,
      previousScheduleId: existing?.previousScheduleId ?? null,
    };
    try {
      if (mode.kind === "edit_future") {
        const { id: _id, ...changes } = data;
        void _id;
        await editFutureOccurrences(mode.schedule, mode.from, changes);
        toast.success("Future occurrences updated. Past ones are unchanged.");
      } else {
        await saveSchedule(data);
        toast.success(existing ? "Saved" : isBill ? "Bill added" : "Scheduled");
      }
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ActionError ? e.message : "Couldn't save.");
    }
  };

  const title = mode.kind === "edit_future" ? `Change from ${mode.from} on` : existing ? "Edit schedule" : isBill ? "New bill" : "New scheduled transaction";

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={title} description={isBill ? "Each occurrence becomes a bill you can pay fully or in parts." : "Scheduled items don't change your balance until you confirm them."} footer={<Button size="lg" onClick={() => void submit()}>Save</Button>}>
      {isBill ? (
        <Field label="Bill type" htmlFor="bk">
          <NativeSelect id="bk" value={billKind} onChange={(e) => setBillKind(e.target.value as BillKind)}>
            <option value="general">Regular bill (electricity, rent, subscription…)</option>
            <option value="card_payment">Credit card payment</option>
            <option value="loan_installment">Loan installment</option>
          </NativeSelect>
        </Field>
      ) : (
        <Segmented value={txnType} onChange={(v) => { setTxnType(v); setCategoryId(""); }} options={[{ value: "income", label: "Income" }, { value: "expense", label: "Expense" }, { value: "transfer", label: "Transfer" }]} />
      )}
      <Field label="Name" htmlFor="sn"><Input id="sn" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={isBill ? "e.g. Meralco, PLDT, Rent" : "e.g. Salary, Move to savings"} /></Field>
      <Field label={isBill ? "Expected amount" : "Amount"} htmlFor="sa" hint={isBill ? "You can enter the actual amount on each bill when it arrives." : undefined}>
        <AmountInput id="sa" value={amount} onChange={setAmount} />
      </Field>
      <Field label={isBill ? "Usually paid from (optional)" : txnType === "transfer" ? "From" : "Account"} htmlFor="sacc">
        <NativeSelect id="sacc" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">{isBill ? "Not set" : "Choose…"}</option>
          {f.activeAccounts.filter((a) => a.type !== "credit_card" || !isBill).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </NativeSelect>
      </Field>
      {!isBill && txnType === "transfer" ? (
        <Field label="To" htmlFor="sto">
          <NativeSelect id="sto" value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>
            <option value="">Choose…</option>
            {f.activeAccounts.filter((a) => a.id !== accountId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </NativeSelect>
        </Field>
      ) : null}
      {isBill && billKind === "card_payment" ? (
        <Field label="Credit card" htmlFor="scard">
          <NativeSelect id="scard" value={cardAccountId} onChange={(e) => setCard(e.target.value)}>
            <option value="">Choose…</option>
            {cards.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </NativeSelect>
          {autoBillCards.size ? <p className="text-xs text-muted-foreground">Cards with statement tracking (More → Credit cards) create their payment bills automatically and aren&apos;t listed here.</p> : null}
        </Field>
      ) : null}
      {isBill && billKind === "loan_installment" ? (
        <Field label="Loan" htmlFor="sdebt">
          <NativeSelect id="sdebt" value={debtId} onChange={(e) => setDebt(e.target.value)}>
            <option value="">Choose…</option>
            {f.debts.map((d) => <option key={d.id} value={d.id}>{d.creditor}</option>)}
          </NativeSelect>
        </Field>
      ) : null}
      {(isBill ? billKind === "general" : txnType !== "transfer") ? (
        <Field label="Category" htmlFor="scat">
          <NativeSelect id="scat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Uncategorized</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </NativeSelect>
        </Field>
      ) : null}
      <RuleEditor value={rule} onChange={setRule} />
      <Field label="Notes" htmlFor="snotes"><Textarea id="snotes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </FormSheet>
  );
}
