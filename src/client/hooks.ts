"use client";
/**
 * React bindings for the vault, the local store and the sync engine, plus derived finance views.
 * All finance numbers on screen come from finance-core running on LOCAL data, so they work offline.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Account, Allocation, Bill, Budget, CardProfile, Category, Debt, EntityName, Goal, GoalEntry, InstallmentPlan, ManualAsset, NetWorthSnapshot, Schedule, ScheduleException, Tag, Template, Transaction, WorkspaceSettings } from "@/lib/domain/types";
import { computeBalances, workspaceTotals } from "@/lib/finance/balances";
import { addDays, endOfMonth, todayIn } from "@/lib/finance/dates";
import { buildBillViews } from "@/lib/finance/bills";
import { currentProgress } from "@/lib/finance/budgets";
import { allocatedByGoal, goalEarmarks, goalProgress } from "@/lib/finance/goals";
import { deriveNotifications, nextIncomeDate, scheduledOutflows } from "@/lib/finance/planning";
import { allOccurrences, CONFIRMATION_LOOKBACK_DAYS } from "@/lib/finance/schedules";
import { computeSafeToSpend } from "@/lib/finance/safe-to-spend";
import type { LocalRecord } from "./store";
import type { SyncStatus } from "./sync-engine";
import { vault, type VaultState } from "./vault";
import { DEFAULT_SETTINGS, withPreferences } from "./settings";

export function useVault(): VaultState {
  return useSyncExternalStore(vault.subscribe, vault.getState, vault.getState);
}

const noop = () => () => {};

/** navigator.onLine as React state. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("online", cb);
      window.addEventListener("offline", cb);
      return () => {
        window.removeEventListener("online", cb);
        window.removeEventListener("offline", cb);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}
const zero = () => 0;

/** Re-renders whenever local data changes. */
export function useStoreVersion(): number {
  const state = useVault();
  const store = state.phase === "unlocked" ? vault.store : null;
  return useSyncExternalStore(store?.subscribe ?? noop, store?.getVersion ?? zero, zero);
}

export function useRecords<E extends EntityName>(entity: E, opts: { includeDeleted?: boolean } = {}): LocalRecord<E>[] {
  const v = useStoreVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => vault.store?.list(entity, opts) ?? [], [v, entity, opts.includeDeleted]);
}

export function useRecord<E extends EntityName>(entity: E, id: string | null | undefined): LocalRecord<E> | undefined {
  const v = useStoreVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (id ? vault.store?.get(entity, id) : undefined), [v, entity, id]);
}

const OFFLINE_STATUS = null as SyncStatus | null;
export function useSyncStatus(): SyncStatus | null {
  const state = useVault();
  const engine = state.phase === "unlocked" ? vault.engine : null;
  return useSyncExternalStore(engine?.subscribe ?? noop, engine?.getStatus ?? (() => OFFLINE_STATUS), () => OFFLINE_STATUS);
}

export { DEFAULT_SETTINGS };

export function useSettings(): WorkspaceSettings {
  const s = useRecords("settings");
  return useMemo(() => withPreferences(s[0]?.data), [s]);
}

/** Today's date in the workspace timezone; refreshes every minute so it rolls over at midnight. */
export function useToday(): string {
  const { timezone } = useSettings();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => todayIn(timezone), [timezone, tick]);
}

const data = <T,>(rs: { data: T; deletedAt: string | null }[]) => rs.map((r) => ({ ...r.data, deletedAt: r.deletedAt }));

/** Everything the finance screens need, computed from local data (works offline). */
export function useFinance() {
  const accountsR = useRecords("account", { includeDeleted: true });
  const txnsR = useRecords("transaction", { includeDeleted: true });
  const categoriesR = useRecords("category", { includeDeleted: true });
  const tagsR = useRecords("tag");
  const budgetsR = useRecords("budget");
  const allocationsR = useRecords("allocation");
  const templatesR = useRecords("template");
  // Phase 2
  const schedulesR = useRecords("schedule", { includeDeleted: true });
  const exceptionsR = useRecords("scheduleException", { includeDeleted: true });
  const billsR = useRecords("bill", { includeDeleted: true });
  const cardProfilesR = useRecords("cardProfile");
  const plansR = useRecords("installmentPlan");
  const debtsR = useRecords("debt");
  const goalsR = useRecords("goal");
  const goalEntriesR = useRecords("goalEntry");
  const assetsR = useRecords("manualAsset");
  const snapshotsR = useRecords("netWorthSnapshot");
  const settings = useSettings();
  const today = useToday();

  return useMemo(() => {
    const accounts = data<Account>(accountsR);
    const txns = data<Transaction>(txnsR);
    const categories = data<Category>(categoriesR);
    const allocations = data<Allocation>(allocationsR);
    const schedules = data<Schedule>(schedulesR);
    const exceptions = data<ScheduleException>(exceptionsR);
    const storedBills = data<Bill>(billsR);
    const cardProfiles = cardProfilesR.map((r) => r.data as CardProfile);
    const plans = plansR.map((r) => r.data as InstallmentPlan);
    const debts = debtsR.map((r) => r.data as Debt);
    const goals = goalsR.map((r) => r.data as Goal);
    const goalEntries = goalEntriesR.map((r) => r.data as GoalEntry);
    const assets = assetsR.map((r) => r.data as ManualAsset);
    const snapshots = snapshotsR.map((r) => r.data as NetWorthSnapshot);

    const balances = computeBalances(accounts, txns);
    const totals = workspaceTotals(accounts, balances);

    // Planning window: 4 months back (overdue/history) to 4 months ahead.
    const from = addDays(today, -120);
    const to = addDays(today, 120);
    const billInputs = { bills: storedBills, schedules, exceptions, cardProfiles, plans, accounts, txns, today };
    const bills = buildBillViews(billInputs, from, to);
    const occCtx = { today, exceptions, txns };
    const occurrences = allOccurrences(schedules, addDays(today, -CONFIRMATION_LOOKBACK_DAYS), to, occCtx);
    const pending = occurrences.filter((o) => o.state === "needs_confirmation");

    const allocated = allocatedByGoal(goalEntries);
    const goalViews = goals.map((g) => ({ goal: g, progress: goalProgress(g, allocated.get(g.id) ?? 0, today) }));
    const earmarks = goalEarmarks(goals, allocated, accounts);

    const nextIncome = nextIncomeDate(occurrences, accounts, today);
    const horizonEnd =
      settings.preferences.stsHorizon === "next_income" && nextIncome ? addDays(nextIncome, -1) : endOfMonth(today);
    const sts = computeSafeToSpend({
      accounts,
      balances,
      allocations,
      txns,
      horizonEnd,
      bills,
      scheduled: scheduledOutflows(occurrences, accounts, horizonEnd),
      goals: earmarks,
    });
    const liveTxns = txns.filter((t) => !t.deletedAt);
    const budgets = budgetsR.map((r) => r.data as Budget);
    const budgetViews = budgets
      .filter((b) => b.isActive)
      .map((b) => ({ budget: b, progress: currentProgress(b, liveTxns, today, settings.weekStart) }));
    const notifications = deriveNotifications({
      today,
      prefs: settings.preferences.notifications,
      bills,
      pending,
      budgets: budgetViews,
      goals: goalViews,
    });

    return {
      settings,
      today,
      accounts,
      liveAccounts: accounts.filter((a) => !a.deletedAt),
      activeAccounts: accounts.filter((a) => !a.deletedAt && a.isActive),
      accountById: new Map(accounts.map((a) => [a.id, a])),
      txns,
      liveTxns,
      categories,
      categoryById: new Map(categories.map((c) => [c.id, c])),
      tags: tagsR.map((r) => r.data as Tag),
      tagById: new Map(tagsR.map((r) => [r.id, r.data as Tag])),
      budgets,
      allocations: allocations.filter((a) => !a.deletedAt),
      templates: templatesR.map((r) => r.data as Template),
      balances,
      totals,
      sts,
      txnRecords: new Map(txnsR.map((r) => [r.id, r])),
      // Phase 2
      schedules: schedules.filter((x) => !x.deletedAt),
      exceptions: exceptions.filter((x) => !x.deletedAt),
      storedBills,
      billInputs,
      bills,
      occurrences,
      occCtx,
      pending,
      cardProfiles,
      plans,
      debts,
      goals,
      goalEntries,
      goalViews,
      allocated,
      earmarks,
      assets,
      snapshots,
      notifications,
      nextIncome,
    };
  }, [accountsR, txnsR, categoriesR, tagsR, budgetsR, allocationsR, templatesR, schedulesR, exceptionsR, billsR, cardProfilesR, plansR, debtsR, goalsR, goalEntriesR, assetsR, snapshotsR, settings, today]);
}
export type FinanceView = ReturnType<typeof useFinance>;
