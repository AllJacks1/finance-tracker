"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export const PLAN_TABS = [
  { href: "/app/calendar", label: "Calendar" },
  { href: "/app/bills", label: "Bills" },
  { href: "/app/budgets", label: "Budgets" },
  { href: "/app/goals", label: "Goals" },
];

export const isPlanPath = (p: string | null) =>
  !!p && ["/app/calendar", "/app/bills", "/app/budgets", "/app/goals", "/app/recurring"].some((x) => p.startsWith(x));

/** Tabs of the Plan hub (Calendar · Bills · Budgets · Goals). */
export function PlanTabs() {
  const path = usePathname();
  return (
    <nav className="-mx-4 mb-4 flex gap-1 overflow-x-auto px-4" aria-label="Plan">
      {PLAN_TABS.map((t) => {
        const active = path?.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn("press whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium", active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
