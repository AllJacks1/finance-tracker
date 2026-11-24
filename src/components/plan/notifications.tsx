"use client";
import * as React from "react";
import Link from "next/link";
import { Bell, CalendarClock, CreditCard, HandCoins, PiggyBank, PieChart, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormSheet } from "@/components/finance/primitives";
import { useFinance } from "@/client/hooks";
import type { AppNotification } from "@/lib/finance/planning";
import { cn } from "@/lib/utils";

const ICON: Record<AppNotification["kind"], React.ComponentType<{ className?: string }>> = {
  bill: CalendarClock,
  scheduled: Repeat,
  card: CreditCard,
  loan: HandCoins,
  budget: PieChart,
  goal: PiggyBank,
};

/**
 * In-app notification center. Derived from LOCAL data, so it is always current on this device,
 * including offline. (System/push notifications are configured in More → Notifications.)
 */
export function NotificationBell() {
  const f = useFinance();
  const [open, setOpen] = React.useState(false);
  const urgent = f.notifications.filter((n) => n.severity !== "info").length;
  return (
    <>
      <Button size="icon" variant="ghost" aria-label={`Notifications (${f.notifications.length})`} onClick={() => setOpen(true)} className="relative">
        <Bell className="size-5" />
        {f.notifications.length ? (
          <span className={cn("absolute right-1 top-1 flex size-4 items-center justify-center rounded-full text-[10px] font-semibold text-white", urgent ? "bg-expense" : "bg-primary")}>
            {Math.min(f.notifications.length, 9)}
          </span>
        ) : null}
      </Button>
      <FormSheet open={open} onOpenChange={setOpen} title="Notifications" description="Reminders from your bills, schedules, budgets and goals.">
        {f.notifications.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">You&apos;re all caught up.</p>
        ) : (
          <div className="grid gap-1">
            {f.notifications.map((n) => {
              const Icon = ICON[n.kind];
              return (
                <Link key={n.key} href={n.href} onClick={() => setOpen(false)} className="press flex items-start gap-3 rounded-xl p-2 hover:bg-muted/60">
                  <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg", n.severity === "danger" ? "bg-expense/15 text-expense" : n.severity === "warning" ? "bg-warning/20 text-warning" : "bg-muted")}>
                    <Icon className="size-4" />
                  </span>
                  <span className="grid min-w-0">
                    <span className="font-medium">{n.title}</span>
                    <span className="text-sm text-muted-foreground">{n.body}</span>
                  </span>
                </Link>
              );
            })}
          </div>
        )}
        <Button variant="outline" asChild>
          <Link href="/app/notifications" onClick={() => setOpen(false)}>Notification settings</Link>
        </Button>
      </FormSheet>
    </>
  );
}
