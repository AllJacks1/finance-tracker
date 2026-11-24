"use client";
import * as React from "react";
import Link from "next/link";
import { CreditCard, Plus } from "lucide-react";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { EmptyState, Money } from "@/components/finance/primitives";
import { CardSheet } from "@/components/plan/card-sheets";
import { StatusBadge } from "@/components/plan/bill-sheets";
import { useFinance } from "@/client/hooks";
import { availableCredit, dueDateFor, outstandingOf, previousClosing, cycleClosingFor } from "@/lib/finance/cards";
import { cardStatementBillId } from "@/lib/domain/ids";

export default function CardsPage() {
  const f = useFinance();
  const [open, setOpen] = React.useState(false);
  const [key, setKey] = React.useState(0);
  const cards = f.liveAccounts.filter((a) => a.type === "credit_card");
  return (
    <>
      <PageHeader title="Credit cards" back="/app/more" action={<Button size="icon" variant="outline" aria-label="Add card" onClick={() => { setKey((k) => k + 1); setOpen(true); }}><Plus className="size-4" /></Button>} />
      <p className="mb-4 text-sm text-muted-foreground">Purchases on a card count as spending once. Paying the card is a transfer — it lowers what you owe but isn&apos;t spending again.</p>
      {cards.length === 0 ? (
        <EmptyState icon={<CreditCard className="size-8" />} title="No credit cards">
          <Button className="mt-2" onClick={() => setOpen(true)}>Add a card</Button>
        </EmptyState>
      ) : (
        <div className="grid gap-3">
          {cards.map((c) => {
            const profile = f.cardProfiles.find((p) => p.accountId === c.id);
            const balance = f.balances.get(c.id) ?? 0;
            const owed = outstandingOf(balance);
            const lastClosing = profile ? (cycleClosingFor(profile, f.today) === f.today ? f.today : previousClosing(profile, cycleClosingFor(profile, f.today))) : null;
            const bill = profile && lastClosing ? f.bills.find((b) => b.id === cardStatementBillId(c.id, lastClosing)) : undefined;
            return (
              <Link key={c.id} href={`/app/cards/view?id=${c.id}`} className="press grid gap-2 rounded-2xl border p-4">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{c.name}</span>
                  {bill ? <StatusBadge status={bill.status} /> : null}
                </div>
                <div className="flex items-end justify-between">
                  <div>
                    <div className="text-xs text-muted-foreground">Owed</div>
                    <div className="text-xl font-semibold"><Money value={owed} /></div>
                  </div>
                  {profile ? (
                    <div className="text-right">
                      <div className="text-xs text-muted-foreground">Available credit</div>
                      <div className="font-semibold"><Money value={availableCredit(profile, balance)} /></div>
                    </div>
                  ) : null}
                </div>
                {profile ? (
                  <>
                    <Progress value={Math.min((owed / Math.max(profile.creditLimit, 1)) * 100, 100)} />
                    <div className="text-xs text-muted-foreground">
                      Limit <Money value={profile.creditLimit} /> · statement day {profile.statementDay}
                      {lastClosing ? ` · last due ${dueDateFor(profile, lastClosing)}` : ""}
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-primary">Add limit and statement dates →</div>
                )}
              </Link>
            );
          })}
        </div>
      )}
      <CardSheet key={key} open={open} onOpenChange={setOpen} />
    </>
  );
}
