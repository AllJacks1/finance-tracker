"use client";
import * as React from "react";
import Link from "next/link";
import { HandCoins, Plus } from "lucide-react";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { AmountInput, EmptyState, Field, Money, SectionTitle } from "@/components/finance/primitives";
import { DebtSheet } from "@/components/plan/debt-sheets";
import { useFinance } from "@/client/hooks";
import { minimumDue, outstandingOf } from "@/lib/finance/cards";
import { compareStrategies, monthlyEquivalent, progressBp, type StrategyDebt, type StrategyResult } from "@/lib/finance/debts";
import { cn } from "@/lib/utils";

export default function DebtsPage() {
  const f = useFinance();
  const [open, setOpen] = React.useState(false);
  const [key, setKey] = React.useState(0);
  const [extra, setExtra] = React.useState<number | null>(200_000);
  const [includeCards, setIncludeCards] = React.useState(true);

  const debts = f.debts.filter((d) => d.status !== "archived");
  const rows = debts.map((d) => ({ d, owed: outstandingOf(f.balances.get(d.accountId) ?? 0) }));
  const totalOwed = rows.reduce((s, r) => s + r.owed, 0);

  const strategyInput: StrategyDebt[] = [
    ...rows.filter((r) => r.owed > 0 && r.d.status === "active").map((r) => ({ id: r.d.id, name: r.d.creditor, balance: r.owed, aprBp: r.d.interestMethod === "none" ? 0 : r.d.aprBp, minPayment: monthlyEquivalent(r.d.minimumPayment, r.d.frequency) })),
    ...(includeCards
      ? f.cardProfiles
          .map((p) => ({ p, acc: f.accountById.get(p.accountId), owed: outstandingOf(f.balances.get(p.accountId) ?? 0) }))
          .filter((x) => x.acc && !x.acc.deletedAt && x.owed > 0)
          .map((x) => ({ id: x.p.accountId, name: x.acc!.name, balance: x.owed, aprBp: x.p.aprBp, minPayment: minimumDue(x.p, x.owed, 0) }))
      : []),
  ];
  const results = strategyInput.length ? compareStrategies(strategyInput, extra ?? 0) : null;

  return (
    <>
      <PageHeader title="Debts & loans" back="/app/more" action={<Button size="icon" variant="outline" aria-label="Add loan" onClick={() => { setKey((k) => k + 1); setOpen(true); }}><Plus className="size-4" /></Button>} />
      {debts.length === 0 ? (
        <EmptyState icon={<HandCoins className="size-8" />} title="No loans tracked">
          <p>Add personal, bank or installment loans to track what you owe, interest, and when you&apos;ll be debt-free.</p>
          <Button className="mt-3" onClick={() => setOpen(true)}>Add a loan</Button>
        </EmptyState>
      ) : (
        <div className="grid gap-5">
          <div className="rounded-2xl border p-4">
            <div className="text-xs text-muted-foreground">Total owed on loans</div>
            <div className="text-2xl font-semibold"><Money value={totalOwed} /></div>
          </div>
          <section className="grid gap-2">
            {rows.map(({ d, owed }) => (
              <Link key={d.id} href={`/app/debts/view?id=${d.id}`} className="press grid gap-2 rounded-2xl border p-4">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{d.creditor}</span>
                  <Money value={owed} className="font-semibold" />
                </div>
                <Progress value={progressBp(d.originalPrincipal, owed) / 100} />
                <div className="text-xs text-muted-foreground">
                  {Math.floor(progressBp(d.originalPrincipal, owed) / 100)}% paid of <Money value={d.originalPrincipal} /> · {d.interestMethod === "none" ? "no interest" : `${(d.aprBp / 100).toFixed(2).replace(/\.00$/, "")}%/yr`}
                  {d.status === "paid_off" ? " · paid off" : ""}
                </div>
              </Link>
            ))}
          </section>
        </div>
      )}

      {strategyInput.length ? (
        <section className="mt-6 grid gap-3 rounded-2xl border p-4">
          <SectionTitle>Payoff strategies</SectionTitle>
          <p className="text-sm text-muted-foreground">
            <b>Snowball</b> pays the smallest balance first (quick wins). <b>Avalanche</b> pays the highest interest first (least interest). Both keep paying every minimum.
          </p>
          <Field label="Extra you can pay each month" htmlFor="extra"><AmountInput id="extra" value={extra} onChange={setExtra} /></Field>
          {f.cardProfiles.length ? (
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeCards} onChange={(e) => setIncludeCards(e.target.checked)} /> Include credit cards</label>
          ) : null}
          {results ? (
            <div className="grid gap-2">
              {(["avalanche", "snowball", "minimum"] as const).map((k) => <StrategyRow key={k} r={results[k]} best={k !== "minimum" && results[k].totalInterest === Math.min(results.avalanche.totalInterest, results.snowball.totalInterest)} />)}
            </div>
          ) : null}
          <p className="rounded-xl bg-warning/10 p-3 text-xs">
            Projection — an estimate, not a guarantee. It assumes fixed rates, monthly interest on the remaining balance and no new borrowing. Lenders compute interest, fees and rounding differently.
          </p>
        </section>
      ) : null}
      <DebtSheet key={key} open={open} onOpenChange={setOpen} />
    </>
  );
}

const LABEL = { avalanche: "Avalanche", snowball: "Snowball", minimum: "Minimums only" } as const;

function StrategyRow({ r, best }: { r: StrategyResult; best: boolean }) {
  const order = [...r.payoff].sort((a, b) => (a.month ?? 1e9) - (b.month ?? 1e9));
  const years = Math.floor(r.months / 12);
  const months = r.months % 12;
  return (
    <div className={cn("grid gap-1 rounded-xl border p-3", best && "border-primary")}>
      <div className="flex items-center justify-between">
        <span className="font-medium">{LABEL[r.strategy]}{best ? " · least interest" : ""}</span>
        <span className="text-sm">{r.neverPaysOff ? "Never pays off" : `${years ? `${years}y ` : ""}${months}m`}</span>
      </div>
      <div className="text-sm text-muted-foreground">Interest <Money value={r.totalInterest} /> · total paid <Money value={r.totalPaid} /></div>
      <div className="text-xs text-muted-foreground">Order: {order.map((p) => `${p.name}${p.month ? ` (month ${p.month})` : ""}`).join(" → ")}</div>
    </div>
  );
}
