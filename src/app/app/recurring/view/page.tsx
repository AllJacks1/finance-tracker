"use client";
import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Ban, Pause, Pencil, Play } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { EmptyState, Money, SectionTitle } from "@/components/finance/primitives";
import { OccurrenceSheet, StatusBadge } from "@/components/plan/bill-sheets";
import { ScheduleSheet } from "@/components/plan/schedule-form";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cancelSchedule, pauseSchedule, resumeSchedule } from "@/client/plan-actions";
import { useFinance } from "@/client/hooks";
import { buildBillViews } from "@/lib/finance/bills";
import { addDays } from "@/lib/finance/dates";
import { describeRule, nextOccurrence } from "@/lib/finance/recurrence";
import { scheduleOccurrences, type Occurrence } from "@/lib/finance/schedules";
import { cn } from "@/lib/utils";

export default function ScheduleViewPage() {
  return (
    <React.Suspense>
      <ScheduleView />
    </React.Suspense>
  );
}

const STATE_LABEL = { scheduled: "Scheduled", needs_confirmation: "Needs confirmation", completed: "Confirmed", skipped: "Skipped" } as const;

function ScheduleView() {
  const id = useSearchParams().get("id") ?? "";
  const f = useFinance();
  const [edit, setEdit] = React.useState<null | "all" | "future">(null);
  const [occ, setOcc] = React.useState<Occurrence | null>(null);
  const s = f.schedules.find((x) => x.id === id);
  if (!s) return (<><PageHeader title="Schedule" back="/app/recurring" /><EmptyState title="Not found" /></>);

  const from = addDays(f.today, -180);
  const to = addDays(f.today, 180);
  const next = s.status === "active" ? nextOccurrence(s.rule, f.today, s.pauses) : null;
  const previous = s.previousScheduleId ? f.schedules.find((x) => x.id === s.previousScheduleId) : undefined;

  return (
    <>
      <PageHeader title={s.name} back="/app/recurring" />
      <div className="grid gap-4">
        <div className="grid gap-1 rounded-2xl border p-4">
          <div className="text-2xl font-semibold"><Money value={s.amount} /></div>
          <div className="text-sm text-muted-foreground">{describeRule(s.rule)}{s.rule.endDate ? ` until ${s.rule.endDate}` : ""}{s.rule.count ? ` · ${s.rule.count} times` : ""}</div>
          <div className="text-sm">{s.kind === "bill" ? "Repeating bill" : s.txnType} · {s.status === "active" ? (next ? `next ${next}` : "no more occurrences") : s.status}</div>
          {previous ? <Link className="text-xs text-primary" href={`/app/recurring/view?id=${previous.id}`}>Earlier version of this schedule</Link> : null}
        </div>
        {s.status !== "cancelled" ? (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={() => setEdit("future")} disabled={!next}><Pencil className="size-4" /> Change from next</Button>
            <Button variant="outline" onClick={() => setEdit("all")}><Pencil className="size-4" /> Edit all</Button>
            {s.status === "active" ? (
              <Button variant="outline" onClick={() => void pauseSchedule(s, f.today).then(() => toast("Paused"))}><Pause className="size-4" /> Pause</Button>
            ) : (
              <Button variant="outline" onClick={() => void resumeSchedule(s, f.today).then(() => toast("Resumed"))}><Play className="size-4" /> Resume</Button>
            )}
            <AlertDialog>
              <AlertDialogTrigger asChild><Button variant="destructive"><Ban className="size-4" /> Cancel</Button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Cancel this schedule?</AlertDialogTitle>
                  <AlertDialogDescription>No more occurrences will be planned. Everything already confirmed or paid stays in your records.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep it</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void cancelSchedule(s).then(() => toast("Schedule cancelled"))}>Cancel schedule</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">&ldquo;Edit all&rdquo; changes the whole series (past confirmed items keep their own amounts). &ldquo;Change from next&rdquo; starts a new version from the next date and leaves history untouched.</p>

        <section className="grid gap-1">
          <SectionTitle>Occurrences</SectionTitle>
          {s.kind === "bill"
            ? buildBillViews(f.billInputs, from, to)
                .filter((b) => b.scheduleId === s.id)
                .map((b) => (
                  <Link key={b.key} href={`/app/bills/view?id=${b.id}`} className="press flex items-center justify-between rounded-xl px-2 py-2 hover:bg-muted/60">
                    <span className="text-sm">{b.dueDate}</span>
                    <span className="flex items-center gap-2"><StatusBadge status={b.status} /><Money value={b.due} className="text-sm" /></span>
                  </Link>
                ))
            : scheduleOccurrences(s, from, to, f.occCtx).reverse().map((o) => (
                <button key={o.key} type="button" onClick={() => setOcc(o)} className="press flex items-center justify-between rounded-xl px-2 py-2 text-left hover:bg-muted/60">
                  <span className="text-sm">{o.date}</span>
                  <span className="flex items-center gap-2">
                    <span className={cn("rounded-full px-2 py-0.5 text-xs", o.state === "completed" ? "bg-income/15 text-income" : o.state === "needs_confirmation" ? "bg-warning/20 text-warning" : "bg-muted text-muted-foreground")}>{STATE_LABEL[o.state]}</span>
                    <Money value={o.amount} className="text-sm" />
                  </span>
                </button>
              ))}
        </section>
      </div>
      {edit ? (
        <ScheduleSheet
          open
          onOpenChange={(o) => !o && setEdit(null)}
          mode={edit === "all" ? { kind: "edit_all", schedule: s } : { kind: "edit_future", schedule: s, from: next ?? f.today }}
        />
      ) : null}
      {occ ? <OccurrenceSheet key={occ.key} occurrence={occ} open onOpenChange={(o) => !o && setOcc(null)} /> : null}
    </>
  );
}
