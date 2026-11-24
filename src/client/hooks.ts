"use client";
/**
 * React bindings for the vault, the local store and the sync engine, plus derived finance views.
 * All finance numbers on screen come from finance-core running on LOCAL data, so they work offline.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Account, Allocation, Budget, Category, EntityName, Tag, Template, Transaction, WorkspaceSettings } from "@/lib/domain/types";
import { computeBalances, workspaceTotals } from "@/lib/finance/balances";
import { endOfMonth, todayIn } from "@/lib/finance/dates";
import { computeSafeToSpend } from "@/lib/finance/safe-to-spend";
import type { LocalRecord } from "./store";
import type { SyncStatus } from "./sync-engine";
import { vault, type VaultState } from "./vault";

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

export const DEFAULT_SETTINGS: WorkspaceSettings = { id: "", currency: "PHP", timezone: "Asia/Manila", weekStart: 1 };

export function useSettings(): WorkspaceSettings {
  const s = useRecords("settings");
  return s[0]?.data ?? DEFAULT_SETTINGS;
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

/** Everything the finance screens need, computed from local data. */
export function useFinance() {
  const accountsR = useRecords("account", { includeDeleted: true });
  const txnsR = useRecords("transaction", { includeDeleted: true });
  const categoriesR = useRecords("category", { includeDeleted: true });
  const tagsR = useRecords("tag");
  const budgetsR = useRecords("budget");
  const allocationsR = useRecords("allocation");
  const templatesR = useRecords("template");
  const settings = useSettings();
  const today = useToday();

  return useMemo(() => {
    const accounts = data<Account>(accountsR);
    const txns = data<Transaction>(txnsR);
    const categories = data<Category>(categoriesR);
    const allocations = data<Allocation>(allocationsR);
    const balances = computeBalances(accounts, txns);
    const totals = workspaceTotals(accounts, balances);
    const sts = computeSafeToSpend({ accounts, balances, allocations, txns, horizonEnd: endOfMonth(today) });
    return {
      settings,
      today,
      accounts,
      liveAccounts: accounts.filter((a) => !a.deletedAt),
      activeAccounts: accounts.filter((a) => !a.deletedAt && a.isActive),
      accountById: new Map(accounts.map((a) => [a.id, a])),
      txns,
      liveTxns: txns.filter((t) => !t.deletedAt),
      categories,
      categoryById: new Map(categories.map((c) => [c.id, c])),
      tags: tagsR.map((r) => r.data as Tag),
      tagById: new Map(tagsR.map((r) => [r.id, r.data as Tag])),
      budgets: budgetsR.map((r) => r.data as Budget),
      allocations: allocations.filter((a) => !a.deletedAt),
      templates: templatesR.map((r) => r.data as Template),
      balances,
      totals,
      sts,
      txnRecords: new Map(txnsR.map((r) => [r.id, r])),
    };
  }, [accountsR, txnsR, categoriesR, tagsR, budgetsR, allocationsR, templatesR, settings, today]);
}
export type FinanceView = ReturnType<typeof useFinance>;
