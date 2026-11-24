"use client";
import * as React from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AmountInput, EmptyState, Field, FormSheet, Money, NativeSelect, SectionTitle, Segmented } from "@/components/finance/primitives";
import { useQuickAdd } from "@/components/finance/transaction-form";
import { ActionError, newId, remove, saveAllocation } from "@/client/actions";
import { useFinance } from "@/client/hooks";
import type { Allocation, AllocationKind } from "@/lib/domain/types";
import { outstandingAmount, paidTowardAllocations } from "@/lib/finance/safe-to-spend";
import { cn } from "@/lib/utils";

export default function AllocationsPage() {
  const f = useFinance();
  const { open: quickAdd } = useQuickAdd();
  const [edit, setEdit] = React.useState<{ open: boolean; a?: Allocation; key: number }>({ open: false, key: 0 });
  const paid = paidTowardAllocations(f.liveTxns);
  const open = f.allocations.filter((a) => a.status === "open");
  const closed = f.allocations.filter((a) => a.status !== "open");

  const row = (a: Allocation) => {
    const out = outstandingAmount(a, paid);
    return (
      <div key={a.id} className="grid gap-2 rounded-2xl border p-3">
        <button type="button" className="flex items-start justify-between gap-2 text-left" onClick={() => setEdit((s) => ({ open: true, a, key: s.key + 1 }))}>
          <span className="grid">
            <span className="font-medium">{a.name}</span>
            <span className="text-xs text-muted-foreground">
              {a.kind === "reserve" ? "Reserve" : "Obligation"}
              {a.dueDate ? ` · due ${a.dueDate}` : ""}
              {a.accountId ? ` · ${f.accountById.get(a.accountId)?.name ?? ""}` : ""}
              {a.status !== "open" ? ` · ${a.status}` : ""}
            </span>
          </span>
          <span className="text-right">
            <Money value={a.status === "open" ? out : a.amount} className="font-semibold" />
            {a.status === "open" && out !== a.amount ? <span className="block text-xs text-muted-foreground">of <Money value={a.amount} /></span> : null}
          </span>
        </button>
        {a.kind === "obligation" && a.status === "open" && out > 0 ? (
          <Button size="sm" variant="outline" onClick={() => quickAdd({ type: "expense", amount: out, allocationId: a.id, description: a.name, accountId: a.accountId ?? undefined })}>
            Record payment
          </Button>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <PageHeader title="Reserves & obligations" back="/app/more" action={<Button size="icon" variant="outline" aria-label="Add" onClick={() => setEdit((s) => ({ open: true, a: undefined, key: s.key + 1 }))}><Plus className="size-4" /></Button>} />
      <p className="mb-4 text-sm text-muted-foreground">
        <b>Reserves</b> are money in spendable accounts you&apos;ve set aside. <b>Obligations</b> are bills you still have to pay. Both are subtracted from Safe to Spend until paid, settled or cancelled.
      </p>
      {f.allocations.length === 0 ? (
        <EmptyState title="Nothing set aside yet" />
      ) : (
        <div className="grid gap-5">
          {open.length ? <section className="grid gap-2"><SectionTitle>Open</SectionTitle>{open.map(row)}</section> : null}
          {closed.length ? <section className="grid gap-2"><SectionTitle>Settled & cancelled</SectionTitle>{closed.map(row)}</section> : null}
        </div>
      )}
      <AllocationSheet key={edit.key} open={edit.open} onOpenChange={(o) => setEdit((s) => ({ ...s, open: o }))} allocation={edit.a} />
    </>
  );
}

function AllocationSheet({ open, onOpenChange, allocation }: { open: boolean; onOpenChange: (o: boolean) => void; allocation?: Allocation }) {
  const f = useFinance();
  const [kind, setKind] = React.useState<AllocationKind>(allocation?.kind ?? "obligation");
  const [name, setName] = React.useState(allocation?.name ?? "");
  const [amount, setAmount] = React.useState<number | null>(allocation?.amount ?? null);
  const [dueDate, setDue] = React.useState(allocation?.dueDate ?? "");
  const [accountId, setAccountId] = React.useState(allocation?.accountId ?? "");
  const [status, setStatus] = React.useState(allocation?.status ?? "open");
  const [notes, setNotes] = React.useState(allocation?.notes ?? "");
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!name.trim()) return setError("Give it a name.");
    if (!amount) return setError("Enter an amount.");
    try {
      await saveAllocation({ id: allocation?.id ?? newId(), kind, name: name.trim(), amount, dueDate: dueDate || null, accountId: accountId || null, status, notes: notes.trim() || null });
      toast.success("Saved");
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ActionError ? e.message : "Couldn't save.");
    }
  };

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={allocation ? "Edit" : "Set money aside"} footer={
      <div className="grid gap-2">
        <Button size="lg" onClick={() => void submit()}>Save</Button>
        {allocation ? <Button variant="destructive" onClick={() => void remove("allocation", allocation.id).then(() => onOpenChange(false))}>Delete</Button> : null}
      </div>
    }>
      <Segmented value={kind} onChange={setKind} options={[{ value: "obligation", label: "Obligation (bill)" }, { value: "reserve", label: "Reserve" }]} />
      <Field label="Name" htmlFor="an"><Input id="an" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={kind === "reserve" ? "e.g. Emergency buffer" : "e.g. Rent, Meralco"} /></Field>
      <Field label="Amount" htmlFor="aa"><AmountInput id="aa" value={amount} onChange={setAmount} /></Field>
      {kind === "obligation" ? (
        <Field label="Due date" htmlFor="ad" hint="Obligations due after the end of this month aren't subtracted yet."><Input id="ad" type="date" value={dueDate} onChange={(e) => setDue(e.target.value)} /></Field>
      ) : null}
      <Field label="Held in / paid from (optional)" htmlFor="aacc" hint="If this money sits in a savings account (not spendable), it won't be subtracted again.">
        <NativeSelect id="aacc" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">Any spendable account</option>
          {f.liveAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </NativeSelect>
      </Field>
      {allocation ? (
        <Field label="Status" htmlFor="ast">
          <NativeSelect id="ast" value={status} onChange={(e) => setStatus(e.target.value as Allocation["status"])} className={cn(status !== "open" && "text-muted-foreground")}>
            <option value="open">Open</option>
            <option value="settled">Settled (paid / released)</option>
            <option value="cancelled">Cancelled</option>
          </NativeSelect>
        </Field>
      ) : null}
      <Field label="Notes" htmlFor="ano"><Textarea id="ano" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </FormSheet>
  );
}
