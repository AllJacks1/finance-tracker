"use client";
import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Pencil, Wallet } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { EmptyState, Money, SectionTitle } from "@/components/finance/primitives";
import { TransactionRow } from "@/components/finance/transaction-row";
import { StatusBadge } from "@/components/plan/bill-sheets";
import { DebtPaymentSheet, DebtSheet, METHOD_LABEL } from "@/components/plan/debt-sheets";
import { updateDebt } from "@/client/card-debt-actions";
import { useFinance } from "@/client/hooks";
import { outstandingOf } from "@/lib/finance/cards";
import { periodicInterest, progressBp, projectPayoff } from "@/lib/finance/debts";

export default function DebtViewPage() {
  return (
    <React.Suspense>
      <DebtView />
    </React.Suspense>
  );
}

function DebtView() {
  const id = useSearchParams().get("id") ?? "";
  const f = useFinance();
  const [edit, setEdit] = React.useState(false);
  const [pay, setPay] = React.useState(false);
  const debt = f.debts.find((d) => d.id === id);
  if (!debt) return (<><PageHeader title="Loan" back="/app/debts" /><EmptyState title="Not found" /></>);

  const owed = outstandingOf(f.balances.get(debt.accountId) ?? 0);
  const linked = f.liveTxns.filter((t) => t.debtId === debt.id || t.toAccountId === debt.accountId).sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  const principalPaid = linked.filter((t) => t.type === "transfer" && t.toAccountId === debt.accountId).reduce((s, t) => s + t.amount, 0);
  const interestPaid = linked.filter((t) => t.type === "expense" && t.debtId === debt.id).reduce((s, t) => s + t.amount, 0);
  const projection = debt.minimumPayment ? projectPayoff(debt, owed, debt.minimumPayment, f.today) : null;
  const bills = f.bills.filter((b) => b.debtId === debt.id && b.outstanding > 0).slice(0, 3);

  return (
    <>
      <PageHeader title={debt.creditor} back="/app/debts" action={<Button size="icon" variant="outline" aria-label="Edit loan" onClick={() => setEdit(true)}><Pencil className="size-4" /></Button>} />
      <div className="grid gap-4">
        <div className="grid gap-2 rounded-2xl border p-4">
          <div className="text-xs text-muted-foreground">Still owed</div>
          <div className="text-3xl font-semibold"><Money value={owed} /></div>
          <Progress value={progressBp(debt.originalPrincipal, owed) / 100} />
          <div className="grid grid-cols-3 gap-2 text-sm">
            <div><div className="text-xs text-muted-foreground">Borrowed</div><Money value={debt.originalPrincipal} /></div>
            <div><div className="text-xs text-muted-foreground">Principal paid</div><Money value={principalPaid} /></div>
            <div><div className="text-xs text-muted-foreground">Interest paid</div><Money value={interestPaid} /></div>
          </div>
          <div className="text-xs text-muted-foreground">
            {METHOD_LABEL[debt.interestMethod]}{debt.interestMethod !== "none" ? ` · ${(debt.aprBp / 100).toFixed(2)}% a year · next interest ≈ ` : ""}
            {debt.interestMethod !== "none" ? <Money value={periodicInterest(debt, owed)} /> : null}
          </div>
        </div>

        {owed > 0 ? <Button size="lg" onClick={() => setPay(true)}><Wallet className="size-4" /> Record a payment</Button> : null}
        {owed === 0 && debt.status === "active" ? (
          <Button variant="outline" onClick={() => void updateDebt({ ...debt, status: "paid_off" }).then(() => toast.success("Marked as paid off"))}>Mark as paid off</Button>
        ) : null}

        {projection ? (
          <div className="rounded-2xl bg-muted/60 p-3 text-sm">
            {projection.neverPaysOff ? (
              <span className="text-expense">At <Money value={debt.minimumPayment} /> per payment, the interest is never covered. Pay more to make progress.</span>
            ) : (
              <>Paying <Money value={debt.minimumPayment} /> each {debt.frequency === "monthly" ? "month" : debt.frequency === "biweekly" ? "2 weeks" : "week"}: paid off around <b>{projection.payoffDate}</b> ({projection.periods} payments), about <Money value={projection.totalInterest} /> more interest.</>
            )}
            <div className="mt-1 text-xs text-muted-foreground">Projection — an estimate, not a guarantee.</div>
          </div>
        ) : null}

        {bills.length ? (
          <section className="grid gap-1">
            <SectionTitle>Upcoming installments</SectionTitle>
            {bills.map((b) => (
              <Link key={b.key} href={`/app/bills/view?id=${b.id}`} className="press flex items-center justify-between rounded-xl px-2 py-2 hover:bg-muted/60">
                <span className="text-sm">Due {b.dueDate}</span>
                <span className="flex items-center gap-2"><StatusBadge status={b.status} /><Money value={b.outstanding} className="text-sm" /></span>
              </Link>
            ))}
          </section>
        ) : null}

        <section className="grid gap-1">
          <SectionTitle>Payment history</SectionTitle>
          {linked.length ? linked.map((t) => <TransactionRow key={t.id} t={t} f={f} perspectiveAccountId={debt.accountId} />) : <p className="px-1 text-sm text-muted-foreground">No payments yet.</p>}
        </section>
        {debt.notes ? <p className="rounded-xl bg-muted/60 p-3 text-sm">{debt.notes}</p> : null}
      </div>
      <DebtSheet key={String(edit)} open={edit} onOpenChange={setEdit} debt={debt} />
      {pay ? <DebtPaymentSheet debt={debt} open={pay} onOpenChange={setPay} /> : null}
    </>
  );
}
