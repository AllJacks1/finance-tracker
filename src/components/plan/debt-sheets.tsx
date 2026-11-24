"use client";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AmountInput, Field, FormSheet, Money, NativeSelect } from "@/components/finance/primitives";
import { ActionError } from "@/client/actions";
import { createDebt, recordDebtPayment, updateDebt } from "@/client/card-debt-actions";
import { useFinance } from "@/client/hooks";
import type { Debt, InterestMethod } from "@/lib/domain/types";
import { splitPayment } from "@/lib/finance/debts";
import { bpToPct, pctToBp } from "./card-sheets";

export const METHOD_LABEL: Record<InterestMethod, string> = {
  diminishing: "Diminishing balance (amortized)",
  add_on: "Add-on / flat rate",
  none: "No interest",
};

export function DebtSheet({ open, onOpenChange, debt }: { open: boolean; onOpenChange: (o: boolean) => void; debt?: Debt }) {
  const f = useFinance();
  const [creditor, setCreditor] = React.useState(debt?.creditor ?? "");
  const [kind, setKind] = React.useState<Debt["kind"]>(debt?.kind ?? "personal");
  const [principal, setPrincipal] = React.useState<number | null>(debt?.originalPrincipal ?? null);
  const [outstanding, setOutstanding] = React.useState<number | null>(null);
  const [startDate, setStartDate] = React.useState(debt?.startDate ?? f.today);
  const [apr, setApr] = React.useState(debt ? bpToPct(debt.aprBp) : "12");
  const [method, setMethod] = React.useState<InterestMethod>(debt?.interestMethod ?? "diminishing");
  const [frequency, setFrequency] = React.useState<Debt["frequency"]>(debt?.frequency ?? "monthly");
  const [minPay, setMinPay] = React.useState<number | null>(debt?.minimumPayment ?? null);
  const [dueDay, setDueDay] = React.useState(String(debt?.dueDay ?? ""));
  const [term, setTerm] = React.useState(String(debt?.termMonths ?? ""));
  const [notes, setNotes] = React.useState(debt?.notes ?? "");
  const [makeBills, setMakeBills] = React.useState(true);
  const [payFrom, setPayFrom] = React.useState(f.activeAccounts.find((a) => a.countsAsSpendable)?.id ?? "");
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const aprBp = pctToBp(apr);
    if (!creditor.trim()) return setError("Who do you owe?");
    if (principal === null) return setError("Enter the original amount borrowed.");
    if (aprBp === null) return setError("Enter the rate like 12 or 1.5.");
    const base: Omit<Debt, "id" | "accountId"> = {
      creditor: creditor.trim(),
      kind,
      originalPrincipal: principal,
      startDate,
      aprBp: method === "none" ? 0 : aprBp,
      interestMethod: method,
      frequency,
      minimumPayment: minPay ?? 0,
      dueDay: dueDay ? Math.min(Math.max(Number(dueDay), 1), 31) : null,
      termMonths: term ? Math.max(Number(term), 1) : null,
      status: debt?.status ?? "active",
      notes: notes.trim() || null,
    };
    try {
      if (debt) {
        await updateDebt({ ...debt, ...base });
        toast.success("Saved");
      } else {
        const firstDue = (() => {
          const d = Number(dueDay) || Number(f.today.slice(8));
          const y = Number(f.today.slice(0, 4));
          const m = Number(f.today.slice(5, 7));
          const next = d > Number(f.today.slice(8)) ? { y, m } : { y: m === 12 ? y + 1 : y, m: m === 12 ? 1 : m + 1 };
          return `${next.y}-${String(next.m).padStart(2, "0")}-${String(Math.min(d, 28)).padStart(2, "0")}`;
        })();
        await createDebt({
          debt: base,
          outstanding: outstanding ?? principal,
          asOf: f.today,
          installments: makeBills && minPay ? { amount: minPay, firstDue, payFromAccountId: payFrom || null } : null,
        });
        toast.success("Loan added");
      }
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ActionError ? e.message : "Couldn't save.");
    }
  };

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={debt ? "Edit loan" : "Add a debt or loan"} footer={<Button size="lg" onClick={() => void submit()}>Save</Button>}>
      <Field label="Creditor" htmlFor="dc"><Input id="dc" value={creditor} maxLength={80} onChange={(e) => setCreditor(e.target.value)} placeholder="e.g. SSS salary loan, Home Credit, Tito Ben" /></Field>
      <Field label="Type" htmlFor="dk">
        <NativeSelect id="dk" value={kind} onChange={(e) => setKind(e.target.value as Debt["kind"])}>
          <option value="personal">Personal loan</option>
          <option value="bank">Bank loan</option>
          <option value="installment">Installment purchase</option>
          <option value="other">Other</option>
        </NativeSelect>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Original amount" htmlFor="dp"><AmountInput id="dp" value={principal} onChange={setPrincipal} /></Field>
        {!debt ? <Field label="Still owed today" htmlFor="do" hint="Defaults to the original amount"><AmountInput id="do" value={outstanding} onChange={setOutstanding} /></Field> : <Field label="Start date" htmlFor="dsd"><Input id="dsd" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>}
      </div>
      <Field label="Interest method" htmlFor="dm" hint={method === "add_on" ? "Interest is charged on the ORIGINAL amount every period (common for consumer loans)." : undefined}>
        <NativeSelect id="dm" value={method} onChange={(e) => setMethod(e.target.value as InterestMethod)}>
          {(Object.keys(METHOD_LABEL) as InterestMethod[]).map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
        </NativeSelect>
      </Field>
      {method !== "none" ? <Field label="Interest rate (% per year)" htmlFor="dr"><Input id="dr" inputMode="decimal" value={apr} onChange={(e) => setApr(e.target.value)} /></Field> : null}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Pays every" htmlFor="df">
          <NativeSelect id="df" value={frequency} onChange={(e) => setFrequency(e.target.value as Debt["frequency"])}>
            <option value="monthly">Month</option>
            <option value="biweekly">2 weeks</option>
            <option value="weekly">Week</option>
          </NativeSelect>
        </Field>
        <Field label="Payment" htmlFor="dmp"><AmountInput id="dmp" value={minPay} onChange={setMinPay} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Due day (1–31)" htmlFor="ddd"><Input id="ddd" inputMode="numeric" value={dueDay} onChange={(e) => setDueDay(e.target.value)} /></Field>
        <Field label="Term (payments)" htmlFor="dt"><Input id="dt" inputMode="numeric" value={term} onChange={(e) => setTerm(e.target.value)} /></Field>
      </div>
      {!debt ? (
        <>
          <label className="flex items-center justify-between gap-3 rounded-xl border p-3 text-sm">
            <span className="grid"><span className="font-medium">Create installment bills</span><span className="text-xs text-muted-foreground">A bill for each payment, shown in Bills and the calendar.</span></span>
            <Switch checked={makeBills} onCheckedChange={setMakeBills} />
          </label>
          {makeBills ? (
            <Field label="Usually paid from" htmlFor="dpf">
              <NativeSelect id="dpf" value={payFrom} onChange={(e) => setPayFrom(e.target.value)}>
                <option value="">Not set</option>
                {f.activeAccounts.filter((a) => a.type !== "loan" && a.type !== "credit_card").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </NativeSelect>
            </Field>
          ) : null}
        </>
      ) : null}
      <Field label="Notes" htmlFor="dn"><Textarea id="dn" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </FormSheet>
  );
}

/** Record a loan payment not linked to an installment bill. */
export function DebtPaymentSheet({ debt, open, onOpenChange }: { debt: Debt; open: boolean; onOpenChange: (o: boolean) => void }) {
  const f = useFinance();
  const outstanding = -(f.balances.get(debt.accountId) ?? 0);
  const [amount, setAmount] = React.useState<number | null>(debt.minimumPayment || null);
  const [interest, setInterest] = React.useState<number | null>(debt.minimumPayment ? splitPayment(debt, outstanding, debt.minimumPayment).interest : 0);
  const [from, setFrom] = React.useState(f.activeAccounts.find((a) => a.countsAsSpendable)?.id ?? "");
  const [date, setDate] = React.useState(f.today);
  const [error, setError] = React.useState<string | null>(null);
  const interestCat = f.categories.find((c) => c.name === "Interest & Fees" && !c.deletedAt)?.id ?? null;
  const principal = Math.max((amount ?? 0) - (interest ?? 0), 0);
  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={`Pay ${debt.creditor}`} footer={
      <Button size="lg" onClick={() => {
        setError(null);
        if (!amount) return setError("Enter the amount.");
        if (!from) return setError("Choose the account.");
        void recordDebtPayment({ debt, fromAccountId: from, principal, interest: Math.min(interest ?? 0, amount), date, interestCategoryId: interestCat })
          .then(() => { toast.success("Payment recorded"); onOpenChange(false); })
          .catch((e) => setError(e instanceof ActionError ? e.message : "Couldn't save."));
      }}>Record payment</Button>
    }>
      <Field label="Total paid" htmlFor="pt"><AmountInput id="pt" value={amount} onChange={(v) => { setAmount(v); if (v) setInterest(splitPayment(debt, outstanding, v).interest); }} large /></Field>
      <Field label="Interest part" htmlFor="pin" hint="Suggested from the loan's rate. Match the lender's receipt if it differs.">
        <AmountInput id="pin" value={interest} onChange={setInterest} />
      </Field>
      <p className="text-sm">Principal (reduces the loan): <Money value={principal} className="font-semibold" /></p>
      <Field label="Paid from" htmlFor="pf">
        <NativeSelect id="pf" value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="">Choose…</option>
          {f.activeAccounts.filter((a) => a.id !== debt.accountId && a.type !== "loan").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Date" htmlFor="pdt"><Input id="pdt" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">Interest is recorded as an expense; the principal is a transfer that lowers the loan (not spending). Both are saved together.</p>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </FormSheet>
  );
}
