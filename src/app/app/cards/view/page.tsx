"use client";
import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeftRight, Layers, Pencil, ShoppingBag, X } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { EmptyState, Money, SectionTitle } from "@/components/finance/primitives";
import { TransactionRow } from "@/components/finance/transaction-row";
import { useQuickAdd } from "@/components/finance/transaction-form";
import { StatusBadge } from "@/components/plan/bill-sheets";
import { CardSheet, InstallmentSheet, bpToPct } from "@/components/plan/card-sheets";
import { cancelInstallment } from "@/client/card-debt-actions";
import { useFinance } from "@/client/hooks";
import { cardStatementBillId } from "@/lib/domain/ids";
import { availableCredit, billedPrincipal, closingsBetween, computeStatement, cycleClosingFor, installmentsBilled, outstandingOf, previousClosing } from "@/lib/finance/cards";
import { addDays } from "@/lib/finance/dates";
import { netSpending } from "@/lib/finance/ledger";

export default function CardViewPage() {
  return (
    <React.Suspense>
      <CardView />
    </React.Suspense>
  );
}

function CardView() {
  const id = useSearchParams().get("id") ?? "";
  const f = useFinance();
  const { open } = useQuickAdd();
  const [edit, setEdit] = React.useState(false);
  const [inst, setInst] = React.useState(false);
  const card = f.accountById.get(id);
  const profile = f.cardProfiles.find((p) => p.accountId === id);
  if (!card || card.deletedAt || card.type !== "credit_card") return (<><PageHeader title="Card" back="/app/cards" /><EmptyState title="Card not found" /></>);

  const balance = f.balances.get(id) ?? 0;
  const owed = outstandingOf(balance);
  const plans = f.plans.filter((p) => p.cardAccountId === id);
  const cardTxns = f.liveTxns.filter((t) => t.accountId === id || t.toAccountId === id).sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  const payments = cardTxns.filter((t) => t.type === "transfer" && t.toAccountId === id);

  let cycle: { start: string; closing: string; spent: number } | null = null;
  let statements: { closing: string; st: ReturnType<typeof computeStatement>; billId: string }[] = [];
  if (profile) {
    const closing = cycleClosingFor(profile, f.today);
    const start = addDays(previousClosing(profile, closing), 1);
    // Card spending this cycle (purchases minus refunds on this card).
    const onCard = f.liveTxns.filter((t) => t.accountId === id);
    cycle = { start, closing, spent: netSpending(onCard, start, f.today) };
    statements = closingsBetween(profile, addDays(f.today, -190), addDays(f.today, -1))
      .reverse()
      .map((c) => ({ closing: c, st: computeStatement(profile, card, f.txns, f.plans, c), billId: cardStatementBillId(id, c) }));
  }

  return (
    <>
      <PageHeader title={card.name} back="/app/cards" action={<Button size="icon" variant="outline" aria-label="Edit card" onClick={() => setEdit(true)}><Pencil className="size-4" /></Button>} />
      <div className="grid gap-4">
        <div className="grid gap-2 rounded-2xl border p-4">
          <div className="text-xs text-muted-foreground">Outstanding balance</div>
          <div className="text-3xl font-semibold"><Money value={owed} /></div>
          {profile ? (
            <>
              <Progress value={Math.min((owed / Math.max(profile.creditLimit, 1)) * 100, 100)} />
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div><div className="text-xs text-muted-foreground">Available credit</div><Money value={availableCredit(profile, balance)} className="font-semibold" /></div>
                <div><div className="text-xs text-muted-foreground">Limit</div><Money value={profile.creditLimit} /></div>
              </div>
              <div className="text-xs text-muted-foreground">
                Statement day {profile.statementDay} · due {profile.dueDaysAfterStatement} days later · min {bpToPct(profile.minPaymentPctBp)}% (at least <Money value={profile.minPaymentFloor} />) · {bpToPct(profile.aprBp)}% a year
              </div>
            </>
          ) : (
            <Button variant="outline" onClick={() => setEdit(true)}>Add limit, statement day and due date</Button>
          )}
        </div>
        {balance > 0 ? <p className="text-xs text-income">You have a credit balance of <Money value={balance} /> on this card.</p> : null}

        <div className="grid grid-cols-3 gap-2">
          <Button variant="outline" onClick={() => open({ type: "expense", accountId: id })}><ShoppingBag className="size-4" /> Purchase</Button>
          <Button variant="outline" onClick={() => open({ type: "transfer", toAccountId: id })}><ArrowLeftRight className="size-4" /> Pay</Button>
          <Button variant="outline" disabled={!profile} onClick={() => setInst(true)}><Layers className="size-4" /> Installment</Button>
        </div>

        {cycle ? (
          <div className="rounded-2xl bg-muted/60 p-3 text-sm">
            Current cycle {cycle.start} – {cycle.closing}: spent <Money value={cycle.spent} className="font-semibold" />
          </div>
        ) : null}

        {statements.length ? (
          <section className="grid gap-1">
            <SectionTitle>Statements</SectionTitle>
            <p className="px-1 text-xs text-muted-foreground">Computed from your card transactions (estimates). Open one to enter the amount from your bank statement.</p>
            {statements.map(({ closing, st, billId }) => {
              const bill = f.bills.find((b) => b.id === billId) ?? f.storedBills.find((b) => b.id === billId);
              const status = bill && "status" in bill ? bill.status : st.statementBalance === 0 ? "paid" : null;
              return (
                <Link key={closing} href={bill ? `/app/bills/view?id=${billId}` : "#"} className="press flex items-center justify-between rounded-xl px-2 py-2 hover:bg-muted/60">
                  <span className="grid text-sm">
                    <span>Closed {closing}</span>
                    <span className="text-xs text-muted-foreground">Due {st.dueDate} · min <Money value={st.minimumDue} /></span>
                  </span>
                  <span className="flex items-center gap-2">
                    {status ? <StatusBadge status={status as never} /> : null}
                    <Money value={bill && "actualAmount" in bill && bill.actualAmount !== null ? bill.actualAmount : st.statementBalance} className="text-sm font-semibold" />
                  </span>
                </Link>
              );
            })}
          </section>
        ) : null}

        {plans.length ? (
          <section className="grid gap-2">
            <SectionTitle>Installments</SectionTitle>
            {plans.map((p) => {
              const n = profile ? installmentsBilled(p, profile, f.today) : 0;
              const billed = profile ? billedPrincipal(p, profile, f.today) : 0;
              return (
                <div key={p.id} className="grid gap-1.5 rounded-2xl border p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{p.description}</span>
                    {p.status === "active" ? (
                      <Button size="icon-sm" variant="ghost" aria-label="Cancel installment plan" onClick={() => void cancelInstallment(p).then(() => toast("Plan cancelled"))}><X className="size-4" /></Button>
                    ) : <span className="text-xs text-muted-foreground">cancelled</span>}
                  </div>
                  <Progress value={(n / p.months) * 100} />
                  <div className="text-xs text-muted-foreground">
                    {n} of {p.months} billed · <Money value={p.monthlyAmount} />/month · <Money value={p.principal - billed} /> not billed yet
                  </div>
                </div>
              );
            })}
          </section>
        ) : null}

        <section className="grid gap-1">
          <SectionTitle>Payments</SectionTitle>
          {payments.length ? payments.slice(0, 20).map((t) => <TransactionRow key={t.id} t={t} f={f} perspectiveAccountId={id} />) : <p className="px-1 text-sm text-muted-foreground">No payments yet.</p>}
        </section>
        <section className="grid gap-1">
          <SectionTitle>Card activity</SectionTitle>
          {cardTxns.filter((t) => t.accountId === id).slice(0, 50).map((t) => <TransactionRow key={t.id} t={t} f={f} perspectiveAccountId={id} />)}
        </section>
      </div>
      <CardSheet key={String(edit)} open={edit} onOpenChange={setEdit} account={card} profile={profile} />
      {profile && inst ? <InstallmentSheet open={inst} onOpenChange={setInst} profile={profile} /> : null}
    </>
  );
}
