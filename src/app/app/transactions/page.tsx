"use client";
import * as React from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, Field, FormSheet, Money, NativeSelect } from "@/components/finance/primitives";
import { TransactionRow, signedAmount } from "@/components/finance/transaction-row";
import { TYPE_LABEL } from "@/components/finance/transaction-form";
import { useFinance } from "@/client/hooks";
import { addDays, startOfMonth } from "@/lib/finance/dates";
import { add } from "@/lib/finance/money";
import type { TxnType } from "@/lib/domain/types";

interface Filters {
  from: string;
  to: string;
  accountId: string;
  categoryId: string;
  type: "" | TxnType;
  tagId: string;
  showDeleted: boolean;
}
const EMPTY: Filters = { from: "", to: "", accountId: "", categoryId: "", type: "", tagId: "", showDeleted: false };

export default function TransactionsPage() {
  const f = useFinance();
  const [q, setQ] = React.useState("");
  const [filters, setFilters] = React.useState<Filters>(EMPTY);
  const [open, setOpen] = React.useState(false);
  const [limit, setLimit] = React.useState(100);

  const list = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return f.txns
      .filter((t) => (filters.showDeleted ? !!t.deletedAt : !t.deletedAt))
      .filter((t) => !filters.from || t.localDate >= filters.from)
      .filter((t) => !filters.to || t.localDate <= filters.to)
      .filter((t) => !filters.accountId || t.accountId === filters.accountId || t.toAccountId === filters.accountId)
      .filter((t) => !filters.categoryId || t.categoryId === filters.categoryId)
      .filter((t) => !filters.type || t.type === filters.type)
      .filter((t) => !filters.tagId || t.tagIds.includes(filters.tagId))
      .filter((t) => {
        if (!needle) return true;
        const hay = [t.description, t.notes, f.categoryById.get(t.categoryId ?? "")?.name, f.accountById.get(t.accountId)?.name, ...t.tagIds.map((id) => f.tagById.get(id)?.name)]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(needle) || String(t.amount / 100).includes(needle);
      })
      .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  }, [f, q, filters]);

  const active = Object.entries(filters).filter(([k, v]) => v && k !== "showDeleted").length + (filters.showDeleted ? 1 : 0);
  const net = list.reduce((s, t) => add(s, signedAmount(t)), 0);

  // Group by date for scanning
  const groups: [string, typeof list][] = [];
  for (const t of list.slice(0, limit)) {
    const g = groups[groups.length - 1];
    if (g && g[0] === t.localDate) g[1].push(t);
    else groups.push([t.localDate, [t]]);
  }

  const preset = (from: string, to: string) => setFilters((x) => ({ ...x, from, to }));

  return (
    <>
      <PageHeader title={filters.showDeleted ? "Deleted" : "Activity"} />
      <div className="sticky top-[calc(3.5rem+env(safe-area-inset-top,0px))] z-10 -mx-4 mb-2 flex gap-2 bg-background/90 px-4 pb-2 backdrop-blur">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" enterKeyHint="search" placeholder="Search description, notes, tags…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>
        <Button variant="outline" size="icon" aria-label="Filters" onClick={() => setOpen(true)} className="relative h-11 w-11">
          <SlidersHorizontal className="size-4" />
          {active ? <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">{active}</span> : null}
        </Button>
      </div>

      {active ? (
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{list.length} results · net <Money value={net} tone="auto" /></span>
          <button className="flex items-center gap-1 text-primary" onClick={() => setFilters(EMPTY)}><X className="size-3.5" /> Clear</button>
        </div>
      ) : null}

      {groups.length === 0 ? (
        <EmptyState title={filters.showDeleted ? "Nothing deleted" : "No transactions found"} />
      ) : (
        <div className="grid gap-3">
          {groups.map(([date, items]) => (
            <section key={date}>
              <h2 className="px-2 pb-1 text-xs font-semibold text-muted-foreground">
                {new Date(`${date}T00:00:00`).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", year: date.slice(0, 4) === f.today.slice(0, 4) ? undefined : "numeric" })}
              </h2>
              {items.map((t) => <TransactionRow key={t.id} t={t} f={f} />)}
            </section>
          ))}
          {list.length > limit ? <Button variant="outline" onClick={() => setLimit((l) => l + 200)}>Show more</Button> : null}
        </div>
      )}

      <FormSheet open={open} onOpenChange={setOpen} title="Filter" footer={<Button size="lg" onClick={() => setOpen(false)}>Show {list.length} results</Button>}>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => preset(startOfMonth(f.today), f.today)}>This month</Button>
          <Button size="sm" variant="outline" onClick={() => preset(addDays(f.today, -6), f.today)}>Last 7 days</Button>
          <Button size="sm" variant="outline" onClick={() => preset(addDays(f.today, -29), f.today)}>Last 30 days</Button>
          <Button size="sm" variant="outline" onClick={() => preset("", "")}>Any time</Button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From" htmlFor="from"><Input id="from" type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></Field>
          <Field label="To" htmlFor="to"><Input id="to" type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></Field>
        </div>
        <Field label="Type" htmlFor="type">
          <NativeSelect id="type" value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value as Filters["type"] })}>
            <option value="">All types</option>
            {(Object.keys(TYPE_LABEL) as TxnType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Account" htmlFor="account">
          <NativeSelect id="account" value={filters.accountId} onChange={(e) => setFilters({ ...filters, accountId: e.target.value })}>
            <option value="">All accounts</option>
            {f.liveAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.isActive ? "" : " (inactive)"}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Category" htmlFor="category">
          <NativeSelect id="category" value={filters.categoryId} onChange={(e) => setFilters({ ...filters, categoryId: e.target.value })}>
            <option value="">All categories</option>
            {f.categories.filter((c) => !c.deletedAt).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </NativeSelect>
        </Field>
        {f.tags.length ? (
          <Field label="Tag" htmlFor="tag">
            <NativeSelect id="tag" value={filters.tagId} onChange={(e) => setFilters({ ...filters, tagId: e.target.value })}>
              <option value="">All tags</option>
              {f.tags.map((t) => <option key={t.id} value={t.id}>#{t.name}</option>)}
            </NativeSelect>
          </Field>
        ) : null}
        <label className="flex items-center justify-between rounded-xl border p-3 text-sm">
          Show deleted transactions (to restore)
          <input type="checkbox" className="size-5 accent-[var(--primary)]" checked={filters.showDeleted} onChange={(e) => setFilters({ ...filters, showDeleted: e.target.checked })} />
        </label>
      </FormSheet>
    </>
  );
}
