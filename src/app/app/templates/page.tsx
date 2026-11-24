"use client";
import * as React from "react";
import { LayoutTemplate, Play, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { EmptyState, Money } from "@/components/finance/primitives";
import { TYPE_LABEL, useQuickAdd } from "@/components/finance/transaction-form";
import { remove } from "@/client/actions";
import { useFinance } from "@/client/hooks";

export default function TemplatesPage() {
  const f = useFinance();
  const { open } = useQuickAdd();
  return (
    <>
      <PageHeader title="Templates" back="/app/more" />
      <p className="mb-4 text-sm text-muted-foreground">Save a transaction as a template from the Add screen, then reuse it with one tap.</p>
      {f.templates.length === 0 ? (
        <EmptyState icon={<LayoutTemplate className="size-8" />} title="No templates yet" />
      ) : (
        <div className="grid gap-2">
          {f.templates.map((t) => (
            <div key={t.id} className="flex items-center gap-3 rounded-2xl border p-3">
              <span className="grid min-w-0 flex-1">
                <span className="truncate font-medium">{t.name}</span>
                <span className="text-xs text-muted-foreground">
                  {TYPE_LABEL[t.type]}
                  {t.accountId ? ` · ${f.accountById.get(t.accountId)?.name ?? ""}` : ""}
                  {t.categoryId ? ` · ${f.categoryById.get(t.categoryId)?.name ?? ""}` : ""}
                </span>
              </span>
              {t.amount ? <Money value={t.amount} /> : null}
              <Button size="icon" variant="outline" aria-label="Use template" onClick={() => open({ type: t.type, amount: t.amount ?? undefined, accountId: t.accountId ?? undefined, toAccountId: t.toAccountId, categoryId: t.categoryId, description: t.description, notes: t.notes, tagIds: t.tagIds })}>
                <Play className="size-4" />
              </Button>
              <Button size="icon" variant="ghost" aria-label="Delete template" onClick={() => void remove("template", t.id)}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
