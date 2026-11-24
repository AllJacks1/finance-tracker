/**
 * Net worth = total assets − total liabilities, where
 *   assets      = asset-account balances (cash, bank, savings, e-wallets, other) + manual assets
 *   liabilities = amounts owed on credit-card and loan accounts (reported as a positive number)
 *
 * Snapshots are IMMUTABLE records of what was computed at the time. The UI always shows them as
 * "Recorded" next to the CURRENT recalculation for the same date; if later edits change the
 * recalculated value, the difference is shown — the snapshot itself is never rewritten.
 */
import type { Account, ManualAsset, NetWorthSnapshot, SnapshotLine, Transaction } from "../domain/types";
import { isLiabilityType } from "../domain/types";
import { computeBalances } from "./balances";
import { addDays, startOfMonth, type ISODate } from "./dates";
import { add, type Centavos } from "./money";

type Live<T> = T & { deletedAt?: string | null };

export function assetValueAsOf(asset: ManualAsset, date: ISODate): Centavos {
  let v: Centavos = 0;
  for (const val of asset.valuations) if (val.date <= date) v = val.value;
  return v;
}

export interface NetWorth {
  date: ISODate;
  assets: Centavos;
  /** Owed on liabilities, as a positive amount. */
  liabilities: Centavos;
  netWorth: Centavos;
  lines: SnapshotLine[];
}

/** Net worth recalculated from current data as of the end of `date`. */
export function netWorthAsOf(
  accounts: readonly Live<Account>[],
  txns: readonly Live<Transaction>[],
  assets: readonly Live<ManualAsset>[],
  date: ISODate,
): NetWorth {
  const live = accounts.filter((a) => !a.deletedAt && a.openingDate <= date);
  const balances = computeBalances(live, txns, date);
  let totalAssets = 0;
  let liabilities = 0;
  const lines: SnapshotLine[] = [];
  for (const a of live) {
    const b = balances.get(a.id) ?? 0;
    const liability = isLiabilityType(a.type);
    if (liability) liabilities = add(liabilities, Math.max(-b, 0));
    else totalAssets = add(totalAssets, b);
    if (b !== 0) lines.push({ kind: "account", id: a.id, name: a.name, liability, value: liability ? Math.max(-b, 0) : b });
  }
  for (const m of assets) {
    if (m.deletedAt || !m.isActive) continue;
    const v = assetValueAsOf(m, date);
    if (v === 0) continue;
    totalAssets = add(totalAssets, v);
    lines.push({ kind: "asset", id: m.id, name: m.name, liability: false, value: v });
  }
  return { date, assets: totalAssets, liabilities, netWorth: add(totalAssets, -liabilities), lines };
}

export function toSnapshot(id: string, nw: NetWorth, kind: "auto" | "manual", recordedAt: string): NetWorthSnapshot {
  return {
    id,
    snapshotDate: nw.date,
    kind,
    assets: nw.assets,
    liabilities: nw.liabilities,
    netWorth: nw.netWorth,
    breakdown: nw.lines,
    recordedAt,
  };
}

/** Month-end date for which an automatic snapshot is due, or null. */
export function autoSnapshotDue(snapshots: readonly Live<NetWorthSnapshot>[], today: ISODate, hasData: boolean): ISODate | null {
  if (!hasData) return null;
  const lastMonthEnd = addDays(startOfMonth(today), -1);
  const exists = snapshots.some((s) => s.kind === "auto" && s.snapshotDate === lastMonthEnd);
  return exists ? null : lastMonthEnd;
}

/** Compare a recorded snapshot with the current recalculation for its date. */
export function snapshotDrift(snapshot: NetWorthSnapshot, current: NetWorth): Centavos {
  return add(current.netWorth, -snapshot.netWorth);
}
