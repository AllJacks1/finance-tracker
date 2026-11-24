"use client";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AmountInput, Field, FormSheet, NativeSelect } from "@/components/finance/primitives";
import { ActionError } from "@/client/actions";
import { addInstallmentPurchase, saveCard } from "@/client/card-debt-actions";
import { useFinance } from "@/client/hooks";
import type { Account, CardProfile } from "@/lib/domain/types";

/** Percent ↔ basis points without floating-point surprises ("3.5" → 350). */
export function pctToBp(s: string): number | null {
  const m = s.trim().match(/^(\d{1,3})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}
export const bpToPct = (bp: number) => (bp / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");

export function CardSheet({ open, onOpenChange, account, profile }: { open: boolean; onOpenChange: (o: boolean) => void; account?: Account; profile?: CardProfile }) {
  const f = useFinance();
  const [name, setName] = React.useState(account?.name ?? "");
  const [owed, setOwed] = React.useState<number | null>(account ? null : 0);
  const [limit, setLimit] = React.useState<number | null>(profile?.creditLimit ?? null);
  const [statementDay, setStatementDay] = React.useState(String(profile?.statementDay ?? 15));
  const [dueDays, setDueDays] = React.useState(String(profile?.dueDaysAfterStatement ?? 21));
  const [minPct, setMinPct] = React.useState(profile ? bpToPct(profile.minPaymentPctBp) : "3");
  const [minFloor, setMinFloor] = React.useState<number | null>(profile?.minPaymentFloor ?? 50_000);
  const [apr, setApr] = React.useState(profile ? bpToPct(profile.aprBp) : "36");
  const [autoBills, setAutoBills] = React.useState(profile?.autoBills ?? true);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const pct = pctToBp(minPct);
    const aprBp = pctToBp(apr);
    const day = Number(statementDay);
    const due = Number(dueDays);
    if (!account && !name.trim()) return setError("Name the card.");
    if (!limit) return setError("Enter the credit limit.");
    if (!(day >= 1 && day <= 31)) return setError("Statement day must be 1–31.");
    if (!(due >= 1 && due <= 60)) return setError("Days until due must be 1–60.");
    if (pct === null || aprBp === null) return setError("Enter percentages like 3 or 3.5.");
    try {
      await saveCard({
        accountId: account?.id ?? null,
        name,
        owedNow: owed ?? 0,
        openingDate: f.today,
        profileId: profile?.id,
        profile: { creditLimit: limit, statementDay: day, dueDaysAfterStatement: due, minPaymentPctBp: pct, minPaymentFloor: minFloor ?? 0, aprBp, autoBills },
      });
      toast.success(account ? "Card details saved" : "Card added");
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ActionError ? e.message : "Couldn't save.");
    }
  };

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={account ? `${account.name} details` : "Add credit card"} footer={<Button size="lg" onClick={() => void submit()}>Save</Button>}>
      {!account ? (
        <>
          <Field label="Card name" htmlFor="cn"><Input id="cn" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. BPI Gold, Metrobank Titanium" /></Field>
          <Field label="Amount owed now" htmlFor="co" hint="Your current card balance. Leave 0 if you pay it off."><AmountInput id="co" value={owed} onChange={setOwed} /></Field>
        </>
      ) : null}
      <Field label="Credit limit" htmlFor="cl"><AmountInput id="cl" value={limit} onChange={setLimit} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Statement day" htmlFor="csd" hint="Day of month"><Input id="csd" inputMode="numeric" value={statementDay} onChange={(e) => setStatementDay(e.target.value)} /></Field>
        <Field label="Due after (days)" htmlFor="cdd"><Input id="cdd" inputMode="numeric" value={dueDays} onChange={(e) => setDueDays(e.target.value)} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Minimum payment %" htmlFor="cmp"><Input id="cmp" inputMode="decimal" value={minPct} onChange={(e) => setMinPct(e.target.value)} /></Field>
        <Field label="…but at least" htmlFor="cmf"><AmountInput id="cmf" value={minFloor} onChange={setMinFloor} /></Field>
      </div>
      <Field label="Interest rate (% per year)" htmlFor="capr" hint="Many PH cards charge 3% a month = 36% a year."><Input id="capr" inputMode="decimal" value={apr} onChange={(e) => setApr(e.target.value)} /></Field>
      <label className="flex items-center justify-between gap-3 rounded-xl border p-3 text-sm">
        <span className="grid"><span className="font-medium">Track statements as bills</span><span className="text-xs text-muted-foreground">Each closed statement becomes a bill to pay (counts once in Safe-to-Spend).</span></span>
        <Switch checked={autoBills} onCheckedChange={setAutoBills} />
      </label>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </FormSheet>
  );
}

export function InstallmentSheet({ open, onOpenChange, profile }: { open: boolean; onOpenChange: (o: boolean) => void; profile: CardProfile }) {
  const f = useFinance();
  const [description, setDescription] = React.useState("");
  const [total, setTotal] = React.useState<number | null>(null);
  const [months, setMonths] = React.useState("12");
  const [monthly, setMonthly] = React.useState<number | null>(null);
  const [fee, setFee] = React.useState<number | null>(0);
  const [date, setDate] = React.useState(f.today);
  const [categoryId, setCategoryId] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const n = Math.max(1, Number(months) || 1);
  const suggested = total ? Math.ceil(total / n) : null;

  const submit = async () => {
    setError(null);
    if (!description.trim()) return setError("Describe the purchase.");
    if (!total) return setError("Enter the total amount.");
    try {
      await addInstallmentPurchase({ profile, description, total, months: n, monthly: monthly ?? suggested!, date, categoryId: categoryId || null, feeAmount: fee ?? 0 });
      toast.success("Installment purchase added");
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ActionError ? e.message : "Couldn't save.");
    }
  };

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title="Installment purchase" description="The full amount is recorded as spending today and uses your credit limit; each statement bills only the monthly amount." footer={<Button size="lg" onClick={() => void submit()}>Save</Button>}>
      <Field label="What did you buy?" htmlFor="id"><Input id="id" value={description} maxLength={150} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Phone, Aircon" /></Field>
      <Field label="Total price" htmlFor="it"><AmountInput id="it" value={total} onChange={setTotal} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Months" htmlFor="im">
          <NativeSelect id="im" value={months} onChange={(e) => setMonths(e.target.value)}>
            {[3, 6, 9, 12, 18, 24, 36].map((m) => <option key={m} value={m}>{m}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Monthly amount" htmlFor="imo" hint={suggested ? `Default ₱${(suggested / 100).toFixed(2)}` : undefined}><AmountInput id="imo" value={monthly} onChange={setMonthly} /></Field>
      </div>
      <Field label="Purchase date" htmlFor="idt"><Input id="idt" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <Field label="Category" htmlFor="icat">
        <NativeSelect id="icat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Uncategorized</option>
          {f.categories.filter((c) => !c.deletedAt && !c.isArchived && c.kind === "expense").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Upfront fee (optional)" htmlFor="if" hint="Record any fee as a separate expense when it's charged."><AmountInput id="if" value={fee} onChange={setFee} /></Field>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </FormSheet>
  );
}
