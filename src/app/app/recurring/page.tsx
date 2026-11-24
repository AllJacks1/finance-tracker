"use client";
import * as React from "react";
import Link from "next/link";
import { CheckCircle2, Pause, Play, Plus, Repeat } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { EmptyState, Money, SectionTitle } from "@/components/finance/primitives";
import { OccurrenceSheet } from "@/components/plan/bill-sheets";
import { PlanTabs } from "@/components/plan/plan-tabs";
import { ScheduleSheet } from "@/components/plan/schedule-form";
import { confirmOccurrence, pauseSchedule, resumeSchedule } from "@/client/plan-actions";
import { useFinance } from "@/client/hooks";
import type { Schedule } from "@/lib/domain/types";
import { describeRule, nextOccurrence } from "@/lib/finance/recurrence";
import type { Occurrence } from "@/lib/finance/schedules";
import { cn } from "@/lib/utils";

export default function RecurringPage() {
  const f = useFinance();
  const [create, setCreate] = React.useState<{ open: boolean; kind: Schedule["kind"]; key: number }>({ open: false, kind: "transaction", key: 0 });
  const [occ, setOcc] = React.useState<Occurrence | null>(null);
  const txnSchedules = f.schedules.filter((s) => s.kind === "transaction");
  const billSchedules = f.schedules.filter((s) => s.kind === "bill");

  return (
    <>
      <PageHeader title="Recurring" back="/app/bills" />
      <PlanTabs />
      <div className="mb-4 grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={() => setCreate((c) => ({ open: true, kind: "transaction", key: c.key + 1 }))}><Plus className="size-4" /> Income / expense</Button>
        <Button variant="outline" onClick={() => setCreate((c) => ({ open: true, kind: "bill", key: c.key + 1 }))}><Plus className="size-4" /> Bill</Button>
      </div>

      {f.pending.length ? (
        <section className="mb-5 grid gap-2">
          <SectionTitle>Needs confirmation</SectionTitle>
          <p className="px-1 text-xs text-muted-foreground">These dates have arrived. They are not in your balances until you confirm them.</p>
          {f.pending.map((o) => (
            <div key={o.key} className="flex items-center gap-3 rounded-2xl border border-warning/40 p-3">
              <button type="button" className="grid min-w-0 flex-1 text-left" onClick={() => setOcc(o)}>
                <span className="truncate font-medium">{o.schedule.name}</span>
                <span className="text-xs text-muted-foreground">{o.date} · {o.schedule.txnType}</span>
              </button>
              <Money value={o.amount} tone={o.schedule.txnType === "income" ? "income" : "neutral"} className="font-semibold" />
              <Button size="sm" onClick={() => void confirmOccurrence(o).then(() => toast.success("Confirmed")).catch((e) => toast.error(e.message))}>
                <CheckCircle2 className="size-4" /> Confirm
              </Button>
            </div>
          ))}
        </section>
      ) : null}

      {f.schedules.length === 0 ? (
        <EmptyState icon={<Repeat className="size-8" />} title="Nothing scheduled">
          <p>Schedule your salary, transfers to savings, subscriptions or bills. Nothing is posted until you confirm it.</p>
        </EmptyState>
      ) : (
        <div className="grid gap-5">
          <ScheduleList title="Scheduled income, expenses & transfers" items={txnSchedules} />
          <ScheduleList title="Repeating bills" items={billSchedules} />
        </div>
      )}
      <ScheduleSheet key={create.key} open={create.open} onOpenChange={(o) => setCreate((c) => ({ ...c, open: o }))} mode={{ kind: "new", scheduleKind: create.kind }} />
      {occ ? <OccurrenceSheet key={occ.key} occurrence={occ} open onOpenChange={(o) => !o && setOcc(null)} /> : null}
    </>
  );
}

function ScheduleList({ title, items }: { title: string; items: Schedule[] }) {
  const f = useFinance();
  if (!items.length) return null;
  return (
    <section className="grid gap-1">
      <SectionTitle>{title}</SectionTitle>
      {items.map((s) => {
        const next = s.status === "active" ? nextOccurrence(s.rule, f.today, s.pauses) : null;
        return (
          <div key={s.id} className={cn("flex items-center gap-2 rounded-xl px-2 py-2", s.status === "cancelled" && "opacity-50")}>
            <Link href={`/app/recurring/view?id=${s.id}`} className="press grid min-w-0 flex-1">
              <span className="truncate font-medium">{s.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {describeRule(s.rule)} · {s.status === "active" ? (next ? `next ${next}` : "ended") : s.status}
              </span>
            </Link>
            <Money value={s.amount} className="text-sm font-semibold" />
            {s.status === "active" ? (
              <Button size="icon-sm" variant="ghost" aria-label="Pause" onClick={() => void pauseSchedule(s, f.today).then(() => toast("Paused"))}><Pause className="size-4" /></Button>
            ) : s.status === "paused" ? (
              <Button size="icon-sm" variant="ghost" aria-label="Resume" onClick={() => void resumeSchedule(s, f.today).then(() => toast("Resumed. Paused dates are not back-filled."))}><Play className="size-4" /></Button>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
