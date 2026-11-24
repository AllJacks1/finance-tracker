/**
 * Account balances are DERIVED: opening balance + sum of ledger entries of live transactions.
 * Nothing is cached, so deleting/restoring a transaction can never leave a balance out of sync.
 * Liability accounts (credit card, loan) are negative when money is owed.
 */
import type { Account, Transaction } from "../domain/types";
import { isLiabilityType } from "../domain/types";
import { addDays, type ISODate } from "./dates";
import { entriesFor, isLive } from "./ledger";
import { add, type Centavos } from "./money";

type Txn = Transaction & { deletedAt?: string | null };
type Acc = Account & { deletedAt?: string | null };

/** Balance per account id, optionally as of the end of a given local date. */
export function computeBalances(
  accounts: readonly Acc[],
  txns: readonly Txn[],
  asOf?: ISODate,
): Map<string, Centavos> {
  const balances = new Map<string, Centavos>();
  for (const a of accounts) balances.set(a.id, a.openingBalance);
  for (const t of txns) {
    if (!isLive(t)) continue;
    if (asOf && t.localDate > asOf) continue;
    for (const e of entriesFor(t)) {
      const prev = balances.get(e.accountId);
      if (prev === undefined) continue; // account not in the given set
      balances.set(e.accountId, add(prev, e.amount));
    }
  }
  return balances;
}

export function accountBalance(account: Acc, txns: readonly Txn[], asOf?: ISODate): Centavos {
  return computeBalances([account], txns, asOf).get(account.id)!;
}

/** Daily end-of-day balances for one account over [from, to]. */
export function balanceHistory(account: Acc, txns: readonly Txn[], from: ISODate, to: ISODate) {
  const perDay = new Map<ISODate, Centavos>();
  let running = account.openingBalance;
  for (const t of txns) {
    if (!isLive(t)) continue;
    for (const e of entriesFor(t)) {
      if (e.accountId !== account.id) continue;
      if (t.localDate < from) running = add(running, e.amount);
      else if (t.localDate <= to)
        perDay.set(t.localDate, add(perDay.get(t.localDate) ?? 0, e.amount));
    }
  }
  const out: { date: ISODate; balance: Centavos }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    running = add(running, perDay.get(d) ?? 0);
    out.push({ date: d, balance: running });
  }
  return out;
}

export interface WorkspaceTotals {
  /** Sum of asset-account balances (everything except credit cards and loans). */
  assets: Centavos;
  /** Sum of liability-account balances (negative when money is owed). */
  liabilities: Centavos;
  /** assets + liabilities */
  netWorth: Centavos;
  /** Savings-type accounts only. */
  savings: Centavos;
  /** Active asset accounts marked "counts as spendable". */
  available: Centavos;
}

export function workspaceTotals(
  accounts: readonly Acc[],
  balances: Map<string, Centavos>,
): WorkspaceTotals {
  let assets = 0;
  let liabilities = 0;
  let savings = 0;
  let available = 0;
  for (const a of accounts) {
    if (a.deletedAt) continue;
    const b = balances.get(a.id) ?? 0;
    if (isLiabilityType(a.type)) liabilities = add(liabilities, b);
    else assets = add(assets, b);
    if (a.type === "savings") savings = add(savings, b);
    if (isSpendable(a)) available = add(available, b);
  }
  return { assets, liabilities, netWorth: add(assets, liabilities), savings, available };
}

export function isSpendable(a: Acc): boolean {
  return !a.deletedAt && a.isActive && a.countsAsSpendable && !isLiabilityType(a.type);
}

/** Reconciliation: difference between a statement balance and the computed balance on that date. */
export function reconciliationDifference(
  account: Acc,
  txns: readonly Txn[],
  statementDate: ISODate,
  statementBalance: Centavos,
) {
  const computed = accountBalance(account, txns, statementDate);
  return { computed, difference: add(statementBalance, -computed) };
}
