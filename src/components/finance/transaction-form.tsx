"use client";
import * as React from "react";
import { Copy, Paperclip, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { AmountInput, Field, FormSheet, NativeSelect, Segmented } from "./primitives";
import { ActionError, duplicateTransaction, newId, remove, restore, saveTag, saveTemplate, saveTransaction } from "@/client/actions";
import { useFinance, useRecord } from "@/client/hooks";
import { vault } from "@/client/vault";
import { pickTxnLinks, type Transaction, type TxnType } from "@/lib/domain/types";
import { currentProgress, crossedThreshold } from "@/lib/finance/budgets";
import { formatPHP, type Centavos } from "@/lib/finance/money";
import { cn } from "@/lib/utils";
import { ReceiptPicker } from "./receipts";
import { ensureBillStored } from "@/client/plan-actions";

export const TYPE_LABEL: Record<TxnType, string> = {
  expense: "Expense",
  income: "Income",
  transfer: "Transfer",
  refund: "Refund",
  adjustment: "Adjust",
};

type Prefill = Partial<Transaction>;
interface QuickAddCtx {
  open: (prefill?: Prefill) => void;
  edit: (id: string) => void;
}
const Ctx = React.createContext<QuickAddCtx>({ open: () => {}, edit: () => {} });
export const useQuickAdd = () => React.useContext(Ctx);

export function QuickAddProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<{ open: boolean; editId: string | null; prefill: Prefill; key: number }>({
    open: false,
    editId: null,
    prefill: {},
    key: 0,
  });
  const ctx = React.useMemo<QuickAddCtx>(
    () => ({
      open: (prefill = {}) => setState((s) => ({ open: true, editId: null, prefill, key: s.key + 1 })),
      edit: (id) => setState((s) => ({ open: true, editId: id, prefill: {}, key: s.key + 1 })),
    }),
    [],
  );
  return (
    <Ctx.Provider value={ctx}>
      {children}
      <TransactionSheet
        key={state.key}
        open={state.open}
        onOpenChange={(open) => setState((s) => ({ ...s, open }))}
        editId={state.editId}
        prefill={state.prefill}
      />
    </Ctx.Provider>
  );
}

function toLocalInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Snapshot budget progress so we can tell whether a change crossed a warning/limit. */
function budgetSnapshot(f: ReturnType<typeof useFinance>) {
  const txns = vault.store!.list("transaction").map((r) => ({ ...r.data, deletedAt: r.deletedAt }));
  return f.budgets
    .filter((b) => b.isActive)
    .map((b) => ({ b, p: currentProgress(b, txns, f.today, f.settings.weekStart) }));
}

function TransactionSheet({
  open,
  onOpenChange,
  editId,
  prefill,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  editId: string | null;
  prefill: Prefill;
}) {
  const f = useFinance();
  const existing = useRecord("transaction", editId);
  const base: Partial<Transaction> = existing?.data ?? prefill;
  const firstAccount = f.activeAccounts[0]?.id ?? "";

  const [type, setType] = React.useState<TxnType>(base.type ?? "expense");
  const [amount, setAmount] = React.useState<Centavos | null>(base.amount ?? null);
  const [accountId, setAccountId] = React.useState(base.accountId ?? firstAccount);
  const [toAccountId, setToAccountId] = React.useState(base.toAccountId ?? "");
  const [direction, setDirection] = React.useState<"increase" | "decrease">(base.adjustmentDirection ?? "decrease");
  const [categoryId, setCategoryId] = React.useState(base.categoryId ?? "");
  const [when, setWhen] = React.useState(toLocalInput(base.occurredAt ?? new Date().toISOString()));
  const [description, setDescription] = React.useState(base.description ?? "");
  const [notes, setNotes] = React.useState(base.notes ?? "");
  const [tagIds, setTagIds] = React.useState<string[]>(base.tagIds ?? []);
  const [billId, setBillId] = React.useState(base.billId ?? "");
  const [refundOfId, setRefundOfId] = React.useState(base.refundOfId ?? "");
  const [newTag, setNewTag] = React.useState("");
  const [asTemplate, setAsTemplate] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [id] = React.useState(() => editId ?? newId());

  const catKind = type === "income" ? "income" : "expense";
  const categories = f.categories.filter((c) => !c.deletedAt && !c.isArchived && c.kind === catKind);
  const showCategory = type !== "transfer" && type !== "adjustment";
  const recentExpenses = React.useMemo(
    () => f.liveTxns.filter((t) => t.type === "expense").sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1)).slice(0, 30),
    [f.liveTxns],
  );
  // Bills this payment could settle: open regular bills for expenses; card statements for transfers into that card.
  const payableBills = f.bills.filter(
    (b) =>
      !b.cancelled &&
      (b.outstanding > 0 || b.id === billId) &&
      (type === "expense" ? b.kind === "general" : type === "transfer" ? b.kind === "card_payment" && b.cardAccountId === toAccountId : false),
  );

  const applyTemplate = (tid: string) => {
    const t = f.templates.find((x) => x.id === tid);
    if (!t) return;
    setType(t.type);
    if (t.amount) setAmount(t.amount);
    if (t.accountId) setAccountId(t.accountId);
    setToAccountId(t.toAccountId ?? "");
    setCategoryId(t.categoryId ?? "");
    setDescription(t.description ?? "");
    setNotes(t.notes ?? "");
    setTagIds(t.tagIds);
  };

  const submit = async () => {
    setError(null);
    if (!amount || amount <= 0) return setError("Enter an amount greater than zero.");
    if (!accountId) return setError("Add an account first (More → Accounts).");
    setBusy(true);
    try {
      const before = budgetSnapshot(f);
      const occurredAt = new Date(when).toISOString();
      const data: Transaction = {
        id,
        type,
        amount,
        accountId,
        toAccountId: type === "transfer" ? toAccountId || null : null,
        adjustmentDirection: type === "adjustment" ? direction : null,
        categoryId: showCategory ? categoryId || null : null,
        occurredAt,
        localDate: "",
        description: description.trim() || null,
        notes: notes.trim() || null,
        tagIds,
        refundOfId: type === "refund" ? refundOfId || null : null,
        // Keep Phase 2 links (schedule, debt, import…) of an existing transaction.
        ...pickTxnLinks(base),
        billId: type === "expense" || type === "transfer" ? billId || null : null,
      };
      const linked = data.billId ? f.bills.find((b) => b.id === data.billId) : undefined;
      if (linked) await ensureBillStored(linked); // a recurring bill is saved before linking
      await saveTransaction(data);
      if (asTemplate) {
        await saveTemplate({
          id: newId(),
          name: description.trim() || `${TYPE_LABEL[type]} ${formatPHP(amount)}`,
          type,
          amount,
          accountId,
          toAccountId: data.toAccountId,
          categoryId: data.categoryId,
          description: data.description,
          notes: data.notes,
          tagIds,
        });
      }
      // Budget warnings
      const after = budgetSnapshot(f);
      for (const a of after) {
        const b = before.find((x) => x.b.id === a.b.id);
        if (!a.p || !b?.p) continue;
        const crossed = crossedThreshold(b.p, a.p);
        if (crossed === "exceeded") toast.error(`Over budget: ${a.b.name}`, { description: `${formatPHP(-a.p.remaining)} over` });
        else if (crossed === "reached") toast.warning(`Budget used up: ${a.b.name}`);
        else if (crossed === "warning") toast.warning(`Approaching budget: ${a.b.name}`, { description: `${formatPHP(a.p.remaining)} left` });
      }
      toast.success(existing ? "Saved" : `${TYPE_LABEL[type]} added`);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ActionError ? e.message : "Couldn't save. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const addTag = async () => {
    const name = newTag.trim();
    if (!name) return;
    const found = f.tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    const tid = found?.id ?? newId();
    if (!found) await saveTag({ id: tid, name });
    setTagIds((ids) => (ids.includes(tid) ? ids : [...ids, tid]));
    setNewTag("");
  };

  const deleted = !!existing?.deletedAt;

  return (
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      title={existing ? (deleted ? "Deleted transaction" : "Edit transaction") : "Add transaction"}
      footer={
        deleted ? (
          <Button size="lg" onClick={() => void restore("transaction", id).then(() => { toast.success("Restored"); onOpenChange(false); })}>
            <RotateCcw className="size-4" /> Restore
          </Button>
        ) : (
          <div className="grid gap-2">
            <Button size="lg" onClick={() => void submit()} disabled={busy}>
              {busy ? "Saving…" : existing ? "Save changes" : "Save"}
            </Button>
            {existing ? (
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  onClick={() => void duplicateTransaction(id).then(() => { toast.success("Duplicated with today's date"); onOpenChange(false); }).catch((e) => setError(e.message))}
                >
                  <Copy className="size-4" /> Duplicate
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void remove("transaction", id).then(() => {
                    toast("Transaction deleted", { action: { label: "Undo", onClick: () => void restore("transaction", id) } });
                    onOpenChange(false);
                  })}
                >
                  <Trash2 className="size-4" /> Delete
                </Button>
              </div>
            ) : null}
          </div>
        )
      }
    >
      {!existing && f.templates.length > 0 ? (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {f.templates.map((t) => (
            <button key={t.id} type="button" onClick={() => applyTemplate(t.id)} className="press shrink-0 rounded-full border px-3 py-1.5 text-sm">
              {t.name}
            </button>
          ))}
        </div>
      ) : null}

      <fieldset disabled={deleted} className="grid gap-4">
        <Segmented
          value={type}
          onChange={(v) => {
            setType(v);
            setCategoryId("");
          }}
          options={(Object.keys(TYPE_LABEL) as TxnType[]).map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
        />
        <Field label="Amount" htmlFor="amount" error={null}>
          <AmountInput id="amount" value={amount} onChange={setAmount} large autoFocus={!existing} />
        </Field>

        {type === "adjustment" ? (
          <Segmented
            value={direction}
            onChange={setDirection}
            options={[
              { value: "decrease", label: "Decrease balance" },
              { value: "increase", label: "Increase balance" },
            ]}
          />
        ) : null}

        <div className={cn("grid gap-3", type === "transfer" && "grid-cols-2")}>
          <Field label={type === "transfer" ? "From" : "Account"} htmlFor="acct">
            <NativeSelect id="acct" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="" disabled>Choose…</option>
              {f.liveAccounts.filter((a) => a.isActive || a.id === accountId).map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </NativeSelect>
          </Field>
          {type === "transfer" ? (
            <Field label="To" htmlFor="to">
              <NativeSelect id="to" value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>
                <option value="" disabled>Choose…</option>
                {f.liveAccounts.filter((a) => (a.isActive || a.id === toAccountId) && a.id !== accountId).map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </NativeSelect>
            </Field>
          ) : null}
        </div>
        {type === "transfer" ? (
          <p className="-mt-2 text-xs text-muted-foreground">Transfers move money between your accounts. They are not income or expenses.</p>
        ) : null}
        {type === "adjustment" ? (
          <p className="-mt-2 text-xs text-muted-foreground">Adjustments correct a balance. They don&apos;t count as income, expenses or budget spending.</p>
        ) : null}

        {showCategory ? (
          <Field label="Category" htmlFor="cat">
            <NativeSelect id="cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Uncategorized</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </NativeSelect>
          </Field>
        ) : null}

        {type === "refund" ? (
          <Field label="Refund of (optional)" htmlFor="refundOf" hint="Refunds reduce your spending; they are not income.">
            <NativeSelect id="refundOf" value={refundOfId} onChange={(e) => {
              setRefundOfId(e.target.value);
              const orig = f.liveTxns.find((t) => t.id === e.target.value);
              if (orig?.categoryId && !categoryId) setCategoryId(orig.categoryId);
            }}>
              <option value="">Not linked</option>
              {recentExpenses.map((t) => (
                <option key={t.id} value={t.id}>{t.localDate} · {t.description ?? "Expense"} · {formatPHP(t.amount)}</option>
              ))}
            </NativeSelect>
          </Field>
        ) : null}

        <Field label="Date & time" htmlFor="when">
          <Input id="when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
        <Field label="Description" htmlFor="desc">
          <Input id="desc" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Groceries at SM" enterKeyHint="done" />
        </Field>

        {(type === "expense" || type === "transfer") && payableBills.length > 0 ? (
          <Field label="This pays a bill (optional)" htmlFor="billlink" hint="Linked payments mark the bill paid, so it isn't counted twice.">
            <NativeSelect id="billlink" value={billId} onChange={(e) => {
              setBillId(e.target.value);
              const b = f.bills.find((x) => x.id === e.target.value);
              if (b && !amount) setAmount(b.outstanding);
              if (b && !description) setDescription(b.name);
              if (b?.categoryId && !categoryId) setCategoryId(b.categoryId);
            }}>
              <option value="">No</option>
              {payableBills.map((b) => (
                <option key={b.id} value={b.id}>{b.name} · due {b.dueDate} · {formatPHP(b.outstanding)} left</option>
              ))}
            </NativeSelect>
          </Field>
        ) : null}

        <Field label="Tags">
          <div className="flex flex-wrap gap-2">
            {f.tags.map((t) => {
              const on = tagIds.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTagIds((ids) => (on ? ids.filter((x) => x !== t.id) : [...ids, t.id]))}
                  className={cn("press rounded-full border px-3 py-1 text-sm", on && "border-primary bg-primary/10 text-primary")}
                  aria-pressed={on}
                >
                  #{t.name}
                </button>
              );
            })}
          </div>
          <div className="flex gap-2">
            <Input value={newTag} maxLength={40} onChange={(e) => setNewTag(e.target.value)} placeholder="New tag" onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void addTag())} />
            <Button type="button" variant="outline" onClick={() => void addTag()}>Add</Button>
          </div>
        </Field>

        <Field label="Notes" htmlFor="notes">
          <Textarea id="notes" value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </Field>

        <Field label="Receipt">
          {existing || amount ? (
            <ReceiptPicker transactionId={id} saved={!!existing} />
          ) : (
            <p className="flex items-center gap-2 text-xs text-muted-foreground"><Paperclip className="size-3.5" /> Save the transaction first, then attach a receipt.</p>
          )}
        </Field>

        {!existing ? (
          <label className="flex items-center gap-3 text-sm">
            <Checkbox checked={asTemplate} onCheckedChange={(v) => setAsTemplate(v === true)} />
            Also save as a reusable template
          </label>
        ) : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      </fieldset>
    </FormSheet>
  );
}
