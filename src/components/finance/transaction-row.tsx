"use client";
import { ArrowLeftRight, CloudUpload, AlertTriangle, SlidersHorizontal, Undo2 } from "lucide-react";
import type { Transaction } from "@/lib/domain/types";
import type { FinanceView } from "@/client/hooks";
import { EntityIcon } from "./icons";
import { Money } from "./primitives";
import { useQuickAdd } from "./transaction-form";

export function signedAmount(t: Transaction): number {
  if (t.type === "income" || t.type === "refund") return t.amount;
  if (t.type === "adjustment") return t.adjustmentDirection === "decrease" ? -t.amount : t.amount;
  if (t.type === "transfer") return 0;
  return -t.amount;
}

export function TransactionRow({ t, f, perspectiveAccountId }: { t: Transaction & { deletedAt?: string | null }; f: FinanceView; perspectiveAccountId?: string }) {
  const { edit } = useQuickAdd();
  const rec = f.txnRecords.get(t.id);
  const cat = t.categoryId ? f.categoryById.get(t.categoryId) : null;
  const acc = f.accountById.get(t.accountId);
  const to = t.toAccountId ? f.accountById.get(t.toAccountId) : null;
  const title = t.description || cat?.name || (t.type === "transfer" ? `${acc?.name ?? "?"} → ${to?.name ?? "?"}` : t.type === "adjustment" ? "Balance adjustment" : "Uncategorized");
  const sub = t.type === "transfer" ? "Transfer" : `${acc?.name ?? "Unknown account"}${cat && t.description ? ` · ${cat.name}` : ""}`;

  let value = signedAmount(t);
  if (t.type === "transfer" && perspectiveAccountId) value = t.accountId === perspectiveAccountId ? -t.amount : t.amount;

  return (
    <button type="button" onClick={() => edit(t.id)} className="press flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-muted/60">
      {t.type === "transfer" ? (
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted"><ArrowLeftRight className="size-[18px]" /></span>
      ) : t.type === "adjustment" ? (
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted"><SlidersHorizontal className="size-[18px]" /></span>
      ) : t.type === "refund" ? (
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-income/15 text-income"><Undo2 className="size-[18px]" /></span>
      ) : (
        <EntityIcon name={cat?.icon} color={cat?.color} />
      )}
      <span className="grid min-w-0 flex-1">
        <span className="truncate font-medium">{title}</span>
        <span className="truncate text-xs text-muted-foreground">
          {sub}
          {rec?.conflict ? (
            <span className="ml-1 inline-flex items-center gap-0.5 text-expense"><AlertTriangle className="size-3" /> conflict</span>
          ) : rec?.failed ? (
            <span className="ml-1 inline-flex items-center gap-0.5 text-expense"><AlertTriangle className="size-3" /> failed</span>
          ) : rec?.pending ? (
            <span className="ml-1 inline-flex items-center gap-0.5"><CloudUpload className="size-3" /> not synced</span>
          ) : null}
        </span>
      </span>
      <span className="text-right">
        {t.type === "transfer" && !perspectiveAccountId ? (
          <Money value={t.amount} tone="muted" className="font-medium" />
        ) : (
          <Money value={value} tone={value > 0 ? "income" : "neutral"} sign={value > 0 ? "always" : "auto"} className="font-medium" />
        )}
        <span className="block text-xs text-muted-foreground">{t.localDate.slice(5).replace("-", "/")}</span>
      </span>
    </button>
  );
}
