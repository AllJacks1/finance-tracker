/**
 * Safe-to-Spend
 *
 *   safeToSpend = spendable balances - open reserves - outstanding obligations due by the horizon
 *
 * Rules that prevent double deductions:
 *  1. Only "spendable" accounts count (active asset accounts flagged counts-as-spendable; by default
 *     cash, bank and e-wallets). Savings accounts are not counted at all, so savings are never
 *     subtracted a second time as a reserve.
 *  2. A reserve/obligation tied to a NON-spendable account (e.g. a reserve kept in a savings
 *     account) is not deducted - that money was never counted as spendable.
 *  3. An obligation's outstanding amount = amount - payments already recorded against it
 *     (transactions linked via allocationId). Once paid, the balance already dropped, so the
 *     obligation no longer deducts anything. Settled/cancelled items deduct nothing.
 *  4. Budgets are plans, not reserved money - they are not deducted.
 *  5. Liability balances are not deducted automatically; add a planned card payment as an obligation.
 *  6. The result is not clamped: a negative value is shown as negative with a warning.
 */
import type { Account, Allocation, Transaction } from "../domain/types";
import { isSpendable } from "./balances";
import { type ISODate } from "./dates";
import { isLive } from "./ledger";
import { add, type Centavos } from "./money";

type Acc = Account & { deletedAt?: string | null };
type Alloc = Allocation & { deletedAt?: string | null };
type Txn = Transaction & { deletedAt?: string | null };

export interface StsLine {
  id: string;
  name: string;
  amount: Centavos; // amount deducted (or counted)
  note?: string;
}

export interface SafeToSpend {
  spendableBalance: Centavos;
  reserves: Centavos;
  obligations: Centavos;
  safeToSpend: Centavos;
  horizonEnd: ISODate;
  spendableAccounts: StsLine[];
  reserveLines: StsLine[];
  obligationLines: StsLine[];
  excluded: StsLine[]; // allocations not deducted, with reason
}

/** Amount already paid towards each allocation, from linked live transactions. */
export function paidTowardAllocations(txns: readonly Txn[]): Map<string, Centavos> {
  const paid = new Map<string, Centavos>();
  for (const t of txns) {
    if (!isLive(t) || !t.allocationId) continue;
    // Payments reduce the obligation; a refund linked to it would not be a payment.
    if (t.type !== "expense" && t.type !== "transfer") continue;
    paid.set(t.allocationId, add(paid.get(t.allocationId) ?? 0, t.amount));
  }
  return paid;
}

export function outstandingAmount(a: Alloc, paid: Map<string, Centavos>): Centavos {
  if (a.deletedAt || a.status !== "open") return 0;
  return Math.max(add(a.amount, -(paid.get(a.id) ?? 0)), 0);
}

export function computeSafeToSpend(input: {
  accounts: readonly Acc[];
  balances: Map<string, Centavos>;
  allocations: readonly Alloc[];
  txns: readonly Txn[];
  horizonEnd: ISODate;
}): SafeToSpend {
  const { accounts, balances, allocations, txns, horizonEnd } = input;
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const spendableAccounts: StsLine[] = [];
  let spendableBalance = 0;
  for (const a of accounts) {
    if (!isSpendable(a)) continue;
    const b = balances.get(a.id) ?? 0;
    spendableBalance = add(spendableBalance, b);
    spendableAccounts.push({ id: a.id, name: a.name, amount: b });
  }

  const paid = paidTowardAllocations(txns);
  const reserveLines: StsLine[] = [];
  const obligationLines: StsLine[] = [];
  const excluded: StsLine[] = [];
  let reserves = 0;
  let obligations = 0;

  for (const al of allocations) {
    if (al.deletedAt || al.status !== "open") continue;
    const outstanding = outstandingAmount(al, paid);
    if (outstanding === 0) continue;
    if (al.accountId) {
      const acc = byId.get(al.accountId);
      if (!acc || !isSpendable(acc)) {
        excluded.push({
          id: al.id,
          name: al.name,
          amount: outstanding,
          note: "Held in an account that is not counted as spendable",
        });
        continue;
      }
    }
    if (al.kind === "reserve") {
      reserves = add(reserves, outstanding);
      reserveLines.push({ id: al.id, name: al.name, amount: outstanding });
    } else {
      if (al.dueDate && al.dueDate > horizonEnd) {
        excluded.push({ id: al.id, name: al.name, amount: outstanding, note: `Due after ${horizonEnd}` });
        continue;
      }
      obligations = add(obligations, outstanding);
      obligationLines.push({
        id: al.id,
        name: al.name,
        amount: outstanding,
        note: al.dueDate ? `Due ${al.dueDate}` : "No due date",
      });
    }
  }

  return {
    spendableBalance,
    reserves,
    obligations,
    safeToSpend: add(spendableBalance, -reserves, -obligations),
    horizonEnd,
    spendableAccounts,
    reserveLines,
    obligationLines,
    excluded,
  };
}
