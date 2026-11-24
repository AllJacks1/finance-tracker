"use client";
import * as React from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, TrendingDown } from "lucide-react";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { EmptyState, Money, Segmented } from "@/components/finance/primitives";
import { OccurrenceSheet } from "@/components/plan/bill-sheets";
import { PlanTabs } from "@/components/plan/plan-tabs";
import { useFinance } from "@/client/hooks";
import { buildBillViews } from "@/lib/finance/bills";
import { addDays, addMonths, endOfMonth, startOfMonth, startOfWeek, type ISODate } from "@/lib/finance/dates";
import { calendarItems, projectCashflow, type CalendarItem } from "@/lib/finance/planning";
import { allOccurrences, type Occurrence } from "@/lib/finance/schedules";
import { cn } from "@/lib/utils";

type View = "day" | "week" | "month";
const KIND_COLOR: Record<CalendarItem["kind"], string> = {
  bill: "bg-expense",
  expense: "bg-warning",
  income: "bg-income",
  transfer: "bg-primary",
  goal: "bg-[#8b5cf6]",
};

export default function CalendarPage() {
  const f = useFinance();
  const [view, setView] = React.useState<View>("month");
  const [anchor, setAnchor] = React.useState<ISODate>(f.today);
  const [selected, setSelected] = React.useState<ISODate>(f.today);
  const [occ, setOcc] = React.useState<Occurrence | null>(null);
  const [horizon, setHorizon] = React.useState<"30" | "60" | "90">("30");

  const range = React.useMemo(() => {
    if (view === "day") return { from: anchor, to: anchor };
    if (view === "week") {
      const s = startOfWeek(anchor, f.settings.weekStart);
      return { from: s, to: addDays(s, 6) };
    }
    return { from: startOfMonth(anchor), to: endOfMonth(anchor) };
  }, [view, anchor, f.settings.weekStart]);

  const items = React.useMemo(() => {
    const bills = buildBillViews(f.billInputs, range.from, range.to);
    const occurrences = allOccurrences(f.schedules, range.from, range.to, f.occCtx);
    const includesToday = range.from <= f.today && f.today <= range.to;
    return calendarItems({ bills, occurrences, goals: f.goalViews, from: range.from, to: range.to, today: f.today })
      // Older unpaid bills are pulled in as "overdue"; show them only in the view containing today.
      .filter((i) => (i.date >= range.from && i.date <= range.to) || (includesToday && i.overdue));
  }, [f, range]);

  const cashflow = React.useMemo(() => {
    const days = Number(horizon);
    const occurrences = allOccurrences(f.schedules, addDays(f.today, -90), addDays(f.today, days), f.occCtx);
    const bills = buildBillViews(f.billInputs, addDays(f.today, -120), addDays(f.today, days));
    return projectCashflow({ spendableBalance: f.sts.spendableBalance, today: f.today, days, occurrences, bills, accounts: f.accounts });
  }, [f, horizon]);

  const move = (dir: 1 | -1) => {
    const next = view === "day" ? addDays(anchor, dir) : view === "week" ? addDays(anchor, 7 * dir) : addMonths(startOfMonth(anchor), dir);
    setAnchor(next);
    setSelected(next);
  };
  const title =
    view === "month"
      ? new Date(`${range.from}T00:00:00`).toLocaleDateString("en-PH", { month: "long", year: "numeric" })
      : view === "week"
        ? `${range.from.slice(5)} – ${range.to.slice(5)}`
        : new Date(`${anchor}T00:00:00`).toLocaleDateString("en-PH", { weekday: "long", month: "short", day: "numeric" });

  // On today, also list everything overdue so the banner's items are one tap away.
  const listItems = view === "month" ? items.filter((i) => i.date === selected || (selected === f.today && i.overdue)) : items;
  const overdue = items.filter((i) => i.overdue);

  return (
    <>
      <PageHeader title="Calendar" />
      <PlanTabs />
      <div className="grid gap-4">
        <Segmented value={view} onChange={(v) => { setView(v); setAnchor(selected); }} options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }]} />
        <div className="flex items-center justify-between">
          <Button size="icon" variant="ghost" aria-label="Previous" onClick={() => move(-1)}><ChevronLeft className="size-5" /></Button>
          <button type="button" className="font-semibold" onClick={() => { setAnchor(f.today); setSelected(f.today); }}>{title}</button>
          <Button size="icon" variant="ghost" aria-label="Next" onClick={() => move(1)}><ChevronRight className="size-5" /></Button>
        </div>

        {overdue.length && range.from <= f.today && f.today <= range.to ? (
          <p className="rounded-xl bg-expense/10 p-3 text-sm text-expense">{overdue.length} overdue item(s) need attention.</p>
        ) : null}

        {view === "month" ? <MonthGrid from={range.from} to={range.to} weekStart={f.settings.weekStart} today={f.today} selected={selected} onSelect={setSelected} items={items} /> : null}

        <section className="grid gap-1">
          {view === "month" ? <h2 className="px-1 text-sm font-semibold text-muted-foreground">{new Date(`${selected}T00:00:00`).toLocaleDateString("en-PH", { weekday: "long", month: "short", day: "numeric" })}</h2> : null}
          {listItems.length === 0 ? (
            <EmptyState title="Nothing scheduled" />
          ) : (
            listItems.map((i) => <ItemRow key={i.key} item={i} showDate={view !== "month"} onOpen={(o) => setOcc(o)} />)
          )}
        </section>

        <section className="grid gap-2 rounded-2xl border p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">Projected cash flow</h2>
            <Segmented value={horizon} onChange={setHorizon} options={[{ value: "30", label: "30d" }, { value: "60", label: "60d" }, { value: "90", label: "90d" }]} className="w-40" />
          </div>
          <Sparkline values={cashflow.days.map((d) => d.balance)} />
          <p className="flex items-center gap-1.5 text-sm">
            <TrendingDown className={cn("size-4", cashflow.lowest.balance < 0 ? "text-expense" : "text-muted-foreground")} />
            Lowest: <Money value={cashflow.lowest.balance} tone={cashflow.lowest.balance < 0 ? "expense" : "neutral"} className="font-semibold" /> on {cashflow.lowest.date}
          </p>
          <p className="text-xs text-muted-foreground">
            Projection from your spendable balances today, plus scheduled income, minus scheduled payments and unpaid bills. Estimates only — actual balances change only when you record or confirm transactions.
          </p>
        </section>
      </div>
      {occ ? <OccurrenceSheet key={occ.key} occurrence={occ} open onOpenChange={(o) => !o && setOcc(null)} /> : null}
    </>
  );
}

function ItemRow({ item, showDate, onOpen }: { item: CalendarItem; showDate: boolean; onOpen: (o: Occurrence) => void }) {
  const inner = (
    <>
      <span className={cn("size-2.5 shrink-0 rounded-full", KIND_COLOR[item.kind])} />
      <span className="grid min-w-0 flex-1 text-left">
        <span className={cn("truncate font-medium", item.done && "text-muted-foreground line-through")}>{item.title}</span>
        <span className={cn("text-xs", item.overdue ? "text-expense" : "text-muted-foreground")}>
          {showDate || item.overdue ? `${item.date} · ` : ""}
          {item.status}
        </span>
      </span>
      <Money value={item.amount} tone={item.kind === "income" ? "income" : "neutral"} className="text-sm font-semibold" />
    </>
  );
  const cls = "press flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-muted/60";
  if (item.ref.type === "bill") return <Link className={cls} href={`/app/bills/view?id=${item.ref.bill.id}`}>{inner}</Link>;
  if (item.ref.type === "goal") return <Link className={cls} href={`/app/goals/view?id=${item.ref.goalId}`}>{inner}</Link>;
  const o = item.ref.occurrence;
  return <button type="button" className={cn(cls, "w-full")} onClick={() => onOpen(o)}>{inner}</button>;
}

function MonthGrid({ from, to, weekStart, today, selected, onSelect, items }: { from: ISODate; to: ISODate; weekStart: number; today: ISODate; selected: ISODate; onSelect: (d: ISODate) => void; items: CalendarItem[] }) {
  const start = startOfWeek(from, weekStart);
  const days: ISODate[] = [];
  for (let d = start; d <= to || days.length % 7 !== 0; d = addDays(d, 1)) days.push(d);
  const byDay = new Map<ISODate, CalendarItem[]>();
  for (const i of items) (byDay.get(i.date) ?? byDay.set(i.date, []).get(i.date)!).push(i);
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return (
    <div className="grid grid-cols-7 gap-1 text-center">
      {Array.from({ length: 7 }, (_, i) => <div key={i} className="pb-1 text-[11px] font-medium text-muted-foreground">{names[(weekStart + i) % 7]}</div>)}
      {days.map((d) => {
        const list = byDay.get(d) ?? [];
        const outside = d < from || d > to;
        return (
          <button
            key={d}
            type="button"
            onClick={() => onSelect(d)}
            aria-label={`${d}, ${list.length} items`}
            aria-pressed={d === selected}
            className={cn(
              "press flex aspect-square flex-col items-center justify-start gap-1 rounded-lg pt-1.5 text-sm",
              outside && "text-muted-foreground/50",
              d === selected ? "bg-primary text-primary-foreground" : d === today ? "bg-muted font-semibold" : "",
            )}
          >
            {Number(d.slice(8))}
            <span className="flex gap-0.5">
              {list.slice(0, 3).map((i) => <span key={i.key} className={cn("size-1.5 rounded-full", d === selected ? "bg-primary-foreground" : KIND_COLOR[i.kind], i.done && "opacity-40")} />)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(0, ...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 300;
  const h = 64;
  const y = (v: number) => (h - 4 - ((v - min) / span) * (h - 8)).toFixed(1);
  const d = values.map((v, i) => `${i === 0 ? "M" : "L"}${((i / (values.length - 1)) * w).toFixed(1)},${y(v)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full text-primary" preserveAspectRatio="none" role="img" aria-label="Projected balance">
      {min < 0 ? <line x1="0" x2={w} y1={y(0)} y2={y(0)} stroke="var(--expense)" strokeDasharray="4 4" strokeWidth="1" vectorEffect="non-scaling-stroke" /> : null}
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
