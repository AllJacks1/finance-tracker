"use client";
import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Ban, CreditCard, Pencil, Repeat, RotateCcw, Wallet } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { EmptyState, Money, SectionTitle } from "@/components/finance/primitives";
import { ReceiptPicker } from "@/components/finance/receipts";
import { TransactionRow } from "@/components/finance/transaction-row";
import { ActualAmountSheet, PayBillSheet, StatusBadge } from "@/components/plan/bill-sheets";
import { ScheduleSheet } from "@/components/plan/schedule-form";
import { cancelBill, ensureBillStored, uncancelBill } from "@/client/plan-actions";
import { useFinance } from "@/client/hooks";
import { buildBillViews } from "@/lib/finance/bills";
import { describeRule } from "@/lib/finance/recurrence";

export default function BillViewPage() {
  return (
    <React.Suspense>
      <BillView />
    </React.Suspense>
  );
}

function BillView() {
  const id = useSearchParams().get("id") ?? "";
  const f = useFinance();
  const [pay, setPay] = React.useState(false);
  const [details, setDetails] = React.useState(false);
  const [series, setSeries] = React.useState(false);
  const bill = React.useMemo(() => {
    const inWindow = f.bills.find((b) => b.id === id);
    if (inWindow) return inWindow;
    const stored = f.storedBills.find((b) => b.id === id && !b.deletedAt);
    return stored ? buildBillViews(f.billInputs, stored.dueDate, stored.dueDate).find((b) => b.id === id) : undefined;
  }, [f, id]);

  if (!bill) return (<><PageHeader title="Bill" back="/app/bills" /><EmptyState title="Bill not found" /></>);
  const schedule = bill.scheduleId ? f.schedules.find((s) => s.id === bill.scheduleId) : undefined;
  const card = bill.cardAccountId ? f.accountById.get(bill.cardAccountId) : undefined;

  return (
    <>
      <PageHeader title={bill.name} back="/app/bills" />
      <div className="grid gap-4">
        <div className="grid gap-2 rounded-2xl border p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Due {bill.dueDate}</span>
            <StatusBadge status={bill.status} />
          </div>
          <div className="text-3xl font-semibold"><Money value={bill.status === "paid" ? bill.paid : bill.outstanding} /></div>
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <div><dt className="text-xs text-muted-foreground">{bill.actualAmount !== null ? "Billed" : "Expected"}</dt><dd><Money value={bill.due} /></dd></div>
            <div><dt className="text-xs text-muted-foreground">Paid</dt><dd><Money value={bill.paid} /></dd></div>
            <div><dt className="text-xs text-muted-foreground">Left</dt><dd><Money value={bill.outstanding} /></dd></div>
          </dl>
          {bill.minimumAmount ? <p className="text-xs text-muted-foreground">Minimum due: <Money value={bill.minimumAmount} /></p> : null}
          {bill.kind === "card_payment" && bill.statementClosingDate ? (
            <p className="text-xs text-muted-foreground">
              Statement closed {bill.statementClosingDate}. The expected amount is computed from your card transactions; enter the amount on your bank statement if it differs.
            </p>
          ) : null}
          {bill.virtual ? <p className="text-xs text-muted-foreground">Not saved yet — paying, editing or attaching a receipt saves this bill.</p> : null}
        </div>

        {bill.cancelled ? (
          <Button variant="outline" onClick={() => void uncancelBill(bill).then(() => toast.success("Bill restored"))}><RotateCcw className="size-4" /> Restore bill</Button>
        ) : (
          <div className="grid gap-2">
            <Button size="lg" onClick={() => setPay(true)} disabled={bill.outstanding === 0}>
              <Wallet className="size-4" /> {bill.paid > 0 ? "Pay more" : "Pay"}
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={() => setDetails(true)}><Pencil className="size-4" /> Amount &amp; date</Button>
              <Button variant="outline" onClick={() => void cancelBill(bill).then(() => toast("Bill cancelled"))}><Ban className="size-4" /> Cancel bill</Button>
            </div>
          </div>
        )}

        {schedule ? (
          <button type="button" onClick={() => setSeries(true)} className="press flex items-center gap-2 rounded-xl border p-3 text-left text-sm">
            <Repeat className="size-4 text-muted-foreground" />
            <span className="flex-1">{describeRule(schedule.rule)}{schedule.status !== "active" ? ` · ${schedule.status}` : ""}</span>
            <span className="text-primary">Edit series</span>
          </button>
        ) : null}
        {card ? (
          <Link href={`/app/cards/view?id=${card.id}`} className="press flex items-center gap-2 rounded-xl border p-3 text-sm"><CreditCard className="size-4 text-muted-foreground" /> {card.name}</Link>
        ) : null}

        <section className="grid gap-1">
          <SectionTitle>Payment history</SectionTitle>
          {bill.payments.length ? bill.payments.map((t) => <TransactionRow key={t.id} t={t} f={f} />) : <p className="px-1 text-sm text-muted-foreground">No payments yet.</p>}
        </section>

        <section className="grid gap-2">
          <SectionTitle>Receipts &amp; documents</SectionTitle>
          <ReceiptPicker billId={bill.id} saved beforeAttach={() => ensureBillStored(bill)} />
        </section>
        {bill.notes ? <p className="rounded-xl bg-muted/60 p-3 text-sm">{bill.notes}</p> : null}
      </div>
      {pay ? <PayBillSheet bill={bill} open={pay} onOpenChange={setPay} /> : null}
      {details ? <ActualAmountSheet bill={bill} open={details} onOpenChange={setDetails} /> : null}
      {series && schedule ? <ScheduleSheet open={series} onOpenChange={setSeries} mode={{ kind: "edit_future", schedule, from: bill.occurrenceDate ?? bill.dueDate }} /> : null}
    </>
  );
}
