"use client";
import * as React from "react";
import { useSearchParams } from "next/navigation";
import { ArrowLeftRight, CheckCircle2, Pencil, Scale } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AccountSheet } from "@/components/finance/account-form";
import { ACCOUNT_TYPE_META } from "@/components/finance/icons";
import { AmountInput, EmptyState, Field, FormSheet, Money, SectionTitle, Segmented } from "@/components/finance/primitives";
import { TransactionRow } from "@/components/finance/transaction-row";
import { useQuickAdd } from "@/components/finance/transaction-form";
import { ActionError, newId, saveReconciliation, saveTransaction } from "@/client/actions";
import { useFinance, useRecords } from "@/client/hooks";
import { balanceHistory, reconciliationDifference } from "@/lib/finance/balances";
import { addDays } from "@/lib/finance/dates";
import { formatPHP } from "@/lib/finance/money";
import { isLiabilityType } from "@/lib/domain/types";

export default function AccountViewPage() {
  return (
    <React.Suspense>
      <AccountView />
    </React.Suspense>
  );
}

function AccountView() {
  const id = useSearchParams().get("id") ?? "";
  const f = useFinance();
  const { open } = useQuickAdd();
  const account = f.accountById.get(id);
  const [edit, setEdit] = React.useState(false);
  const [reconcile, setReconcile] = React.useState(false);
  const [range, setRange] = React.useState<"30" | "90" | "365">("30");
  const recs = useRecords("reconciliation").filter((r) => r.data.accountId === id).sort((a, b) => (a.data.statementDate < b.data.statementDate ? 1 : -1));

  if (!account || account.deletedAt) return (<><PageHeader title="Account" back="/app/accounts" /><EmptyState title="Account not found" /></>);
  const balance = f.balances.get(id) ?? 0;
  const history = balanceHistory(account, f.txns, addDays(f.today, -Number(range) + 1), f.today);
  const txns = f.liveTxns.filter((t) => t.accountId === id || t.toAccountId === id).sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));

  return (
    <>
      <PageHeader title={account.name} back="/app/accounts" action={<Button size="icon" variant="outline" aria-label="Edit account" onClick={() => setEdit(true)}><Pencil className="size-4" /></Button>} />
      <div className="grid gap-4">
        <div className="rounded-2xl border p-4">
          <div className="text-xs text-muted-foreground">
            {ACCOUNT_TYPE_META[account.type].label}{!account.isActive ? " · inactive" : ""}{account.countsAsSpendable && !isLiabilityType(account.type) ? " · spendable" : ""}
          </div>
          <div className="text-3xl font-semibold"><Money value={balance} tone={balance < 0 ? "expense" : "neutral"} /></div>
          {isLiabilityType(account.type) && balance < 0 ? <div className="text-xs text-muted-foreground">You owe {formatPHP(-balance)}</div> : null}
          <Sparkline points={history.map((h) => h.balance)} />
          <Segmented value={range} onChange={setRange} options={[{ value: "30", label: "30 days" }, { value: "90", label: "90 days" }, { value: "365", label: "1 year" }]} className="mt-2" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" onClick={() => open({ type: "transfer", accountId: id })}><ArrowLeftRight className="size-4" /> Transfer</Button>
          <Button variant="outline" onClick={() => setReconcile(true)}><Scale className="size-4" /> Reconcile</Button>
        </div>
        {recs[0] ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground"><CheckCircle2 className="size-3.5 text-income" /> Last reconciled to statement of {recs[0].data.statementDate}</p>
        ) : null}
        <section className="grid gap-1">
          <SectionTitle>Transactions</SectionTitle>
          {txns.length ? txns.slice(0, 200).map((t) => <TransactionRow key={t.id} t={t} f={f} perspectiveAccountId={id} />) : <EmptyState title="No transactions" />}
        </section>
      </div>
      <AccountSheet key={String(edit)} open={edit} onOpenChange={setEdit} account={account} />
      {reconcile ? <ReconcileSheet accountId={id} onClose={() => setReconcile(false)} /> : null}
    </>
  );
}

function ReconcileSheet({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const f = useFinance();
  const account = f.accountById.get(accountId)!;
  const liability = isLiabilityType(account.type);
  const [date, setDate] = React.useState(f.today);
  const [stmt, setStmt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const statementBalance = stmt === null ? null : liability ? -stmt : stmt;
  const diff = statementBalance === null ? null : reconciliationDifference(account, f.txns, date, statementBalance);

  const confirm = async () => {
    if (statementBalance === null || !diff) return;
    try {
      let adjustmentTransactionId: string | null = null;
      if (diff.difference !== 0) {
        adjustmentTransactionId = newId();
        await saveTransaction({
          id: adjustmentTransactionId,
          type: "adjustment",
          amount: Math.abs(diff.difference),
          adjustmentDirection: diff.difference > 0 ? "increase" : "decrease",
          accountId,
          toAccountId: null,
          categoryId: null,
          occurredAt: new Date(`${date}T23:59:00+08:00`).toISOString(),
          description: "Reconciliation adjustment",
          notes: `Statement balance ${formatPHP(statementBalance)} on ${date}`,
          tagIds: [],
          refundOfId: null,
          allocationId: null,
        });
      }
      await saveReconciliation({ id: newId(), accountId, statementDate: date, statementBalance, computedBalance: diff.computed, adjustmentTransactionId, note: null });
      toast.success(diff.difference === 0 ? "Balanced. Reconciliation saved." : "Adjustment added and reconciliation saved.");
      onClose();
    } catch (e) {
      setError(e instanceof ActionError ? e.message : "Couldn't save.");
    }
  };

  return (
    <FormSheet open onOpenChange={(o) => !o && onClose()} title={`Reconcile ${account.name}`} description="Compare with your bank or e-wallet statement." footer={<Button size="lg" disabled={statementBalance === null} onClick={() => void confirm()}>{diff && diff.difference !== 0 ? "Add adjustment & save" : "Mark reconciled"}</Button>}>
      <Field label="Statement date" htmlFor="sd"><Input id="sd" type="date" value={date} max={f.today} onChange={(e) => setDate(e.target.value)} /></Field>
      <Field label={liability ? "Statement amount owed" : "Statement balance"} htmlFor="sb"><AmountInput id="sb" value={stmt} onChange={setStmt} /></Field>
      {diff ? (
        <div className="grid gap-1 rounded-xl bg-muted p-3 text-sm">
          <div className="flex justify-between"><span>App balance on {date}</span><Money value={diff.computed} /></div>
          <div className="flex justify-between"><span>Statement</span><Money value={statementBalance!} /></div>
          <div className="flex justify-between font-semibold"><span>Difference</span><Money value={diff.difference} tone={diff.difference === 0 ? "income" : "expense"} /></div>
          {diff.difference !== 0 ? <p className="text-xs text-muted-foreground">Check for missing transactions first. Otherwise a balance adjustment (not income or expense) will fix the difference.</p> : null}
        </div>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </FormSheet>
  );
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const w = 300;
  const h = 56;
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${((i / (points.length - 1)) * w).toFixed(1)},${(h - 4 - ((p - min) / span) * (h - 8)).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-3 h-14 w-full text-primary" preserveAspectRatio="none" role="img" aria-label="Balance history">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
