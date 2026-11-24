"use client";
import * as React from "react";
import Link from "next/link";
import { CalendarClock, Plus, Repeat } from "lucide-react";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { EmptyState, Money, SectionTitle } from "@/components/finance/primitives";
import { PlanTabs } from "@/components/plan/plan-tabs";
import { StatusBadge } from "@/components/plan/bill-sheets";
import { ScheduleSheet } from "@/components/plan/schedule-form";
import { useFinance } from "@/client/hooks";
import { addDays } from "@/lib/finance/dates";
import type { BillView } from "@/lib/finance/bills";

export default function BillsPage() {
  const f = useFinance();
  const [open, setOpen] = React.useState(false);
  const [key, setKey] = React.useState(0);
  const soon = addDays(f.today, 7);
  const month = addDays(f.today, 35);
  const overdue = f.bills.filter((b) => b.status === "overdue");
  const dueSoon = f.bills.filter((b) => !["overdue", "paid", "cancelled"].includes(b.status) && b.dueDate <= soon);
  const upcoming = f.bills.filter((b) => !["overdue", "paid", "cancelled"].includes(b.status) && b.dueDate > soon && b.dueDate <= month);
  const recent = f.bills.filter((b) => b.status === "paid" && b.dueDate >= addDays(f.today, -45)).reverse();
  const totalDue = [...overdue, ...dueSoon, ...upcoming].reduce((s, b) => s + b.outstanding, 0);
  const billSchedules = f.schedules.filter((s) => s.kind === "bill" && s.status !== "cancelled");

  return (
    <>
      <PageHeader title="Bills" action={<Button size="icon" variant="outline" aria-label="Add bill" onClick={() => { setKey((k) => k + 1); setOpen(true); }}><Plus className="size-4" /></Button>} />
      <PlanTabs />
      {f.bills.length === 0 && billSchedules.length === 0 ? (
        <EmptyState icon={<CalendarClock className="size-8" />} title="No bills yet">
          <p>Add electricity, water, internet, rent, subscriptions or loans. Set them to repeat and pay each one fully or in parts.</p>
          <Button className="mt-3" onClick={() => setOpen(true)}>Add a bill</Button>
        </EmptyState>
      ) : (
        <div className="grid gap-5">
          <div className="rounded-2xl border p-4">
            <div className="text-xs text-muted-foreground">Due in the next 5 weeks (incl. overdue)</div>
            <div className="text-2xl font-semibold"><Money value={totalDue} /></div>
          </div>
          <BillGroup title="Overdue" bills={overdue} />
          <BillGroup title="Due this week" bills={dueSoon} />
          <BillGroup title="Coming up" bills={upcoming} />
          <BillGroup title="Paid recently" bills={recent} />
          <Link href="/app/recurring" className="press flex items-center gap-2 rounded-xl border p-3 text-sm">
            <Repeat className="size-4 text-muted-foreground" /> Manage repeating bills and scheduled transactions ({billSchedules.length} bill schedules)
          </Link>
        </div>
      )}
      <ScheduleSheet key={key} open={open} onOpenChange={setOpen} mode={{ kind: "new", scheduleKind: "bill" }} />
    </>
  );
}

function BillGroup({ title, bills }: { title: string; bills: BillView[] }) {
  const f = useFinance();
  if (!bills.length) return null;
  return (
    <section className="grid gap-1">
      <SectionTitle>{title}</SectionTitle>
      {bills.map((b) => (
        <Link key={b.key} href={`/app/bills/view?id=${b.id}`} className="press flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-muted/60">
          <span className="flex size-10 shrink-0 flex-col items-center justify-center rounded-xl bg-muted text-[10px] leading-tight">
            <span className="font-semibold">{new Date(`${b.dueDate}T00:00:00`).toLocaleDateString("en-PH", { month: "short" })}</span>
            <span className="text-base font-semibold">{Number(b.dueDate.slice(8))}</span>
          </span>
          <span className="grid min-w-0 flex-1">
            <span className="truncate font-medium">{b.name}</span>
            <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
              <StatusBadge status={b.status} />
              {b.kind === "card_payment" ? "Card" : b.kind === "loan_installment" ? "Loan" : b.categoryId ? f.categoryById.get(b.categoryId)?.name : null}
              {b.scheduleId ? <Repeat className="size-3" /> : null}
            </span>
          </span>
          <span className="text-right">
            <Money value={b.status === "paid" ? b.paid : b.outstanding} className="font-semibold" />
            {b.status === "partially_paid" || (b.status === "overdue" && b.paid > 0) ? <span className="block text-xs text-muted-foreground">of <Money value={b.due} /></span> : null}
          </span>
        </Link>
      ))}
    </section>
  );
}
