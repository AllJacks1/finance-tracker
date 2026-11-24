"use client";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AmountInput, Field, FormSheet, NativeSelect } from "./primitives";
import { ACCOUNT_TYPE_META, PALETTE } from "./icons";
import { ActionError, newId, remove, saveAccount } from "@/client/actions";
import { useFinance } from "@/client/hooks";
import { ACCOUNT_TYPES, defaultSpendable, isLiabilityType, type Account, type AccountType } from "@/lib/domain/types";
import { cn } from "@/lib/utils";

export function AccountSheet({ open, onOpenChange, account }: { open: boolean; onOpenChange: (o: boolean) => void; account?: Account }) {
  const f = useFinance();
  const [type, setType] = React.useState<AccountType>(account?.type ?? "cash");
  const [name, setName] = React.useState(account?.name ?? "");
  const liability = isLiabilityType(type);
  // Liabilities are entered as "amount owed" (positive) and stored as a negative balance.
  const [opening, setOpening] = React.useState<number | null>(account ? Math.abs(account.openingBalance) : null);
  const [openingNegative, setOpeningNegative] = React.useState(account ? account.openingBalance < 0 && !isLiabilityType(account.type) : false);
  const [openingDate, setOpeningDate] = React.useState(account?.openingDate ?? f.today);
  const [color, setColor] = React.useState(account?.color ?? PALETTE[0]!);
  const [description, setDescription] = React.useState(account?.description ?? "");
  const [isActive, setIsActive] = React.useState(account?.isActive ?? true);
  const [spendable, setSpendable] = React.useState(account?.countsAsSpendable ?? defaultSpendable(type));
  const [touchedSpendable, setTouchedSpendable] = React.useState(!!account);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!name.trim()) return setError("Give the account a name.");
    const abs = opening ?? 0;
    const openingBalance = liability ? -abs : openingNegative ? -abs : abs;
    try {
      await saveAccount({
        id: account?.id ?? newId(),
        name: name.trim(),
        type,
        openingBalance,
        openingDate,
        color,
        icon: ACCOUNT_TYPE_META[type].icon,
        description: description.trim() || null,
        isActive,
        countsAsSpendable: liability ? false : spendable,
      });
      toast.success(account ? "Account saved" : "Account added");
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ActionError ? e.message : "Couldn't save.");
    }
  };

  const del = async () => {
    try {
      await remove("account", account!.id);
      toast.success("Account deleted");
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ActionError ? e.message : "Couldn't delete.");
    }
  };

  return (
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      title={account ? "Edit account" : "New account"}
      footer={
        <div className="grid gap-2">
          <Button size="lg" onClick={() => void submit()}>Save</Button>
          {account ? <Button variant="destructive" onClick={() => void del()}>Delete account</Button> : null}
        </div>
      }
    >
      <Field label="Type" htmlFor="atype">
        <NativeSelect
          id="atype"
          value={type}
          onChange={(e) => {
            const t = e.target.value as AccountType;
            setType(t);
            if (!touchedSpendable) setSpendable(defaultSpendable(t));
          }}
        >
          {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{ACCOUNT_TYPE_META[t].label}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Name" htmlFor="aname">
        <Input id="aname" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. GCash, BDO Savings, Wallet" />
      </Field>
      <Field
        label={liability ? "Amount owed at start" : "Opening balance"}
        htmlFor="aopen"
        hint={liability ? "Credit cards and loans count as liabilities, not spendable money." : "The balance on the opening date. Edit later if needed."}
      >
        <AmountInput id="aopen" value={opening} onChange={setOpening} />
      </Field>
      {!liability ? (
        <label className="-mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={openingNegative} onChange={(e) => setOpeningNegative(e.target.checked)} /> Balance is overdrawn (negative)
        </label>
      ) : null}
      <Field label="Opening date" htmlFor="adate">
        <Input id="adate" type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} />
      </Field>
      <Field label="Color">
        <div className="flex flex-wrap gap-2">
          {PALETTE.map((c) => (
            <button key={c} type="button" aria-label={`Color ${c}`} onClick={() => setColor(c)} className={cn("press size-8 rounded-full ring-offset-2 ring-offset-background", color === c && "ring-2 ring-foreground")} style={{ background: c }} />
          ))}
        </div>
      </Field>
      <Field label="Description" htmlFor="adesc">
        <Textarea id="adesc" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      {!liability ? (
        <label className="flex items-center justify-between gap-3 rounded-xl border p-3 text-sm">
          <span className="grid">
            <span className="font-medium">Count toward Safe to Spend</span>
            <span className="text-xs text-muted-foreground">Turn off for savings or money you don&apos;t spend day to day.</span>
          </span>
          <Switch checked={spendable} onCheckedChange={(v) => { setSpendable(v); setTouchedSpendable(true); }} />
        </label>
      ) : null}
      {account ? (
        <label className="flex items-center justify-between gap-3 rounded-xl border p-3 text-sm">
          <span className="grid">
            <span className="font-medium">Active</span>
            <span className="text-xs text-muted-foreground">Inactive accounts keep their history but are hidden from new transactions.</span>
          </span>
          <Switch checked={isActive} onCheckedChange={setIsActive} />
        </label>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </FormSheet>
  );
}
