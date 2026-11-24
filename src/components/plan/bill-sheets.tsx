"use client";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AmountInput, Field, FormSheet, Money, NativeSelect } from "@/components/finance/primitives";
import { ActionError } from "@/client/actions";
import { confirmOccurrence, overrideOccurrence, payBill, saveBill, skipOccurrence, clearException } from "@/client/plan-actions";
import { useFinance } from "@/client/hooks";
import type { BillView } from "@/lib/finance/bills";
import { STATUS_LABEL } from "@/lib/finance/bills";
import { splitPayment } from "@/lib/finance/debts";
import type { Occurrence } from "@/lib/finance/schedules";
import { cn } from "@/lib/utils";

export function StatusBadge({ status }: { status: BillView["status"] }) {
  const tone =
    status === "paid" ? "bg-income/15 text-income" : status === "overdue" ? "bg-expense/15 text-expense" : status === "due_today" || status === "partially_paid" ? "bg-warning/20 text-warning" : status === "cancelled" ? "bg-muted text-muted-foreground line-through" : "bg-muted text-muted-foreground";
  return <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", tone)}>{STATUS_LABEL[status]}</span>;
}

/** Pay a bill fully or partly. Card/loan bills are transfers (not spending). */
export function PayBillSheet({ bill, open, onOpenChange }: { bill: BillView; open: boolean; onOpenChange: (o: boolean) => void }) {
  const f = useFinance();
  const debt = bill.debtId ? f.debts.find((d) => d.id === bill.debtId) : undefined;
  const loanBalance = debt ? -(f.balances.get(debt.accountId) ?? 0) : 0;
  const [amount, setAmount] = React.useState<number | null>(bill.outstanding || bill.due);
  const [accountId, setAccountId] = React.useState(bill.accountId ?? f.activeAccounts.find((a) => a.countsAsSpendable && a.type !== "credit_card")?.id ?? "");
  const [date, setDate] = React.useState(f.today);
  const suggested = debt && amount ? splitPayment(debt, loanBalance, amount).interest : 0;
  const [interest, setInterest] = React.useState<number | null>(suggested);
  const [error, setError] = React.useState<string | null>(null);
  const interestCat = f.categories.find((c) => c.name === "Interest & Fees" && !c.deletedAt)?.id ?? null;

  const submit = async () => {
    setError(null);
    if (!amount) return setError("Enter the amount paid.");
    if (!accountId) return setError("Choose the account you paid from.");
    try {
      await payBill(bill, { amount, accountId, date, interest: interest ?? 0, loanAccountId: debt?.accountId ?? null, categoryId: bill.kind === "loan_installment" ? interestCat : undefined });
      toast.success(amount >= bill.outstanding ? "Bill paid" : "Partial payment recorded");
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ActionError ? e.message : "Couldn't record the payment.");
    }
  };

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={`Pay ${bill.name}`} description={bill.outstanding ? "Pay all of it or part of it." : "This bill is already paid."} footer={<Button size="lg" onClick={() => void submit()}>Record payment</Button>}>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setAmount(bill.outstanding)}>Full <Money value={bill.outstanding} /></Button>
        {bill.minimumAmount ? <Button size="sm" variant="outline" onClick={() => setAmount(Math.min(bill.minimumAmount!, bill.outstanding))}>Minimum <Money value={bill.minimumAmount} /></Button> : null}
      </div>
      <Field label="Amount" htmlFor="pa"><AmountInput id="pa" value={amount} onChange={(v) => { setAmount(v); if (debt && v) setInterest(splitPayment(debt, loanBalance, v).interest); }} large /></Field>
      <Field label="Paid from" htmlFor="pacc">
        <NativeSelect id="pacc" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">Choose…</option>
          {f.activeAccounts.filter((a) => a.id !== bill.cardAccountId && a.id !== debt?.accountId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Date paid" htmlFor="pd"><Input id="pd" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      {bill.kind === "loan_installment" ? (
        <Field label="Interest part" htmlFor="pi" hint="Suggested from the loan's rate; change it to match the lender's receipt. Interest counts as an expense; the rest reduces the loan.">
          <AmountInput id="pi" value={interest} onChange={setInterest} />
        </Field>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {bill.kind === "general"
          ? "Recorded as an expense — it counts in your budgets once."
          : "Recorded as a transfer: it lowers what you owe. The purchases or interest were already counted, so it isn't spending again."}
      </p>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </FormSheet>
  );
}

/** Enter the actual billed amount (e.g. this month's electricity) — saves this occurrence. */
export function ActualAmountSheet({ bill, open, onOpenChange }: { bill: BillView; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [actual, setActual] = React.useState<number | null>(bill.actualAmount ?? bill.expectedAmount);
  const [due, setDue] = React.useState(bill.dueDate);
  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title="Bill details" description="Enter the amount and due date printed on the bill." footer={
      <Button size="lg" onClick={() => void saveBill({ ...bill, actualAmount: actual, dueDate: due }).then(() => { toast.success("Saved"); onOpenChange(false); })}>Save</Button>
    }>
      <Field label="Actual amount" htmlFor="aa"><AmountInput id="aa" value={actual} onChange={setActual} /></Field>
      <Field label="Due date" htmlFor="ad"><Input id="ad" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
    </FormSheet>
  );
}

/** Confirm / skip / reschedule one scheduled occurrence. */
export function OccurrenceSheet({ occurrence, open, onOpenChange }: { occurrence: Occurrence; open: boolean; onOpenChange: (o: boolean) => void }) {
  const f = useFinance();
  const o = occurrence;
  const [amount, setAmount] = React.useState<number | null>(o.amount);
  const [date, setDate] = React.useState(o.date <= f.today ? o.date : f.today);
  const [error, setError] = React.useState<string | null>(null);
  const s = o.schedule;
  const acc = s.accountId ? f.accountById.get(s.accountId)?.name : "—";
  const to = s.toAccountId ? f.accountById.get(s.toAccountId)?.name : null;
  const run = async (fn: () => Promise<void>, msg: string) => {
    setError(null);
    try {
      await fn();
      toast.success(msg);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ActionError ? e.message : "Couldn't save.");
    }
  };
  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={s.name} description={`${s.txnType === "transfer" ? `${acc} → ${to}` : acc} · scheduled ${o.date}`}>
      {o.state === "completed" ? (
        <p className="rounded-xl bg-income/10 p-3 text-sm text-income">Confirmed — it&apos;s in your balances as a normal transaction.</p>
      ) : (
        <>
          <p className="rounded-xl bg-muted p-3 text-xs text-muted-foreground">Scheduled items don&apos;t change your actual balance until you confirm them.</p>
          <Field label="Amount" htmlFor="oa"><AmountInput id="oa" value={amount} onChange={setAmount} /></Field>
          <Field label="Date" htmlFor="od"><Input id="od" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Button size="lg" onClick={() => void run(() => confirmOccurrence(o, { amount: amount ?? o.amount, date }), "Confirmed")} disabled={!amount}>
            Confirm {s.txnType === "income" ? "received" : s.txnType === "transfer" ? "transfer" : "paid"}
          </Button>
          <div className="grid grid-cols-2 gap-2">
            {o.state === "skipped" ? (
              <Button variant="outline" onClick={() => void run(() => clearException(o), "Restored")}>Un-skip</Button>
            ) : (
              <Button variant="outline" onClick={() => void run(() => skipOccurrence(o), "Skipped")}>Skip this one</Button>
            )}
            <Button variant="outline" onClick={() => void run(() => overrideOccurrence(o, { date: date !== o.nominalDate ? date : null, amount: amount !== s.amount ? amount : null }), "Rescheduled")}>
              Save as planned
            </Button>
          </div>
        </>
      )}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </FormSheet>
  );
}
