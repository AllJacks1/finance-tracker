"use client";
/**
 * Credit card and debt actions. Money still moves only through ordinary transactions:
 *  - card purchase  = expense on the card account (spending, once)
 *  - card payment   = transfer bank → card (not spending)
 *  - loan payment   = transfer bank → loan (principal, not spending) + expense (interest)
 * Multi-record operations are atomic groups.
 */
import type { Account, CardProfile, Debt, InstallmentPlan, Schedule, Transaction } from "@/lib/domain/types";
import { TXN_LINKS } from "@/lib/domain/types";
import { cycleClosingFor } from "@/lib/finance/cards";
import { localDateOf, type ISODate } from "@/lib/finance/dates";
import type { Centavos } from "@/lib/finance/money";
import { entitySchemas } from "@/lib/sync/protocol";
import { ActionError, newId } from "./actions";
import { withPreferences } from "./settings";
import { vault } from "./vault";

function store() {
  if (!vault.store) throw new ActionError("Your data is locked.");
  return vault.store;
}
const tz = () => withPreferences(store().list("settings")[0]?.data).timezone;
const noon = (d: ISODate) => `${d}T12:00:00+08:00`;

function check<T>(entity: keyof typeof entitySchemas, data: T): T {
  const r = entitySchemas[entity].safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new ActionError(i ? `${i.path.join(".") || "value"}: ${i.message}` : "Invalid data");
  }
  return r.data as T;
}

function txn(t: Omit<Transaction, "localDate">): Transaction {
  return check("transaction", { ...t, localDate: localDateOf(t.occurredAt, tz()) });
}

// ------------------------------------------------------------------------------- cards

/** Create a new card (account + details) or update details of an existing card account. */
export async function saveCard(input: {
  accountId: string | null;
  name: string;
  owedNow: Centavos;
  openingDate: ISODate;
  profile: Omit<CardProfile, "id" | "accountId">;
  profileId?: string;
}) {
  const s = store();
  if (input.accountId) {
    const id = input.profileId ?? newId();
    const profile = check<CardProfile>("cardProfile", { id, accountId: input.accountId, ...input.profile });
    await s.mutate("cardProfile", id, input.profileId ? "update" : "create", profile);
    return input.accountId;
  }
  const accountId = newId();
  const account: Account = check("account", {
    id: accountId,
    name: input.name.trim(),
    type: "credit_card",
    openingBalance: -Math.abs(input.owedNow),
    openingDate: input.openingDate,
    color: "#6366f1",
    icon: "credit-card",
    description: null,
    isActive: true,
    countsAsSpendable: false,
  });
  const profileId = newId();
  const profile = check<CardProfile>("cardProfile", { id: profileId, accountId, ...input.profile });
  await s.mutateGroup([
    { entity: "account", id: accountId, kind: "create", data: account },
    { entity: "cardProfile", id: profileId, kind: "create", data: profile },
  ]);
  return accountId;
}

/**
 * Installment purchase: the full amount is an expense on the card today (Q2) and uses credit
 * immediately; statements bill only the monthly amount. One atomic group (plan + purchase).
 */
export async function addInstallmentPurchase(input: {
  profile: CardProfile;
  description: string;
  total: Centavos;
  months: number;
  monthly: Centavos;
  date: ISODate;
  categoryId: string | null;
  feeAmount: Centavos;
}) {
  if (input.months < 1) throw new ActionError("Enter the number of months.");
  if (input.monthly * input.months < input.total - input.months) throw new ActionError("Monthly amount × months is less than the total.");
  const planId = newId();
  const plan: InstallmentPlan = check("installmentPlan", {
    id: planId,
    cardAccountId: input.profile.accountId,
    transactionId: null,
    description: input.description.trim(),
    principal: input.total,
    months: input.months,
    monthlyAmount: input.monthly,
    firstBillingDate: cycleClosingFor(input.profile, input.date),
    feeAmount: input.feeAmount,
    status: "active",
  });
  const purchase = txn({
    ...TXN_LINKS,
    id: newId(),
    type: "expense",
    amount: input.total,
    accountId: input.profile.accountId,
    toAccountId: null,
    adjustmentDirection: null,
    categoryId: input.categoryId,
    occurredAt: noon(input.date),
    description: `${input.description.trim()} (${input.months}× installment)`,
    notes: null,
    tagIds: [],
    refundOfId: null,
    installmentPlanId: planId,
  });
  await store().mutateGroup([
    { entity: "installmentPlan", id: planId, kind: "create", data: plan },
    { entity: "transaction", id: purchase.id, kind: "create", data: purchase },
  ]);
}

export async function cancelInstallment(plan: InstallmentPlan) {
  await store().mutate("installmentPlan", plan.id, "update", check("installmentPlan", { ...plan, status: "cancelled" }));
}

// ------------------------------------------------------------------------------- debts

/**
 * New debt: creates the loan (liability) account with the current outstanding balance, the debt
 * details, and optionally an installment bill schedule — one atomic group.
 */
export async function createDebt(input: {
  debt: Omit<Debt, "id" | "accountId">;
  outstanding: Centavos;
  asOf: ISODate;
  installments: { amount: Centavos; firstDue: ISODate; payFromAccountId: string | null } | null;
}) {
  const accountId = newId();
  const debtId = newId();
  const account: Account = check("account", {
    id: accountId,
    name: input.debt.creditor,
    type: "loan",
    openingBalance: -Math.abs(input.outstanding),
    openingDate: input.asOf,
    color: "#dc2626",
    icon: "hand-coins",
    description: null,
    isActive: true,
    countsAsSpendable: false,
  });
  const debt: Debt = check("debt", { ...input.debt, id: debtId, accountId });
  const changes: { entity: "account" | "debt" | "schedule"; id: string; kind: "create"; data: unknown }[] = [
    { entity: "account", id: accountId, kind: "create", data: account },
    { entity: "debt", id: debtId, kind: "create", data: debt },
  ];
  if (input.installments) {
    const sid = newId();
    const freq = input.debt.frequency === "monthly" ? { freq: "monthly" as const, interval: 1 } : { freq: "weekly" as const, interval: input.debt.frequency === "biweekly" ? 2 : 1 };
    const schedule: Schedule = check("schedule", {
      id: sid,
      kind: "bill",
      name: `${input.debt.creditor} installment`,
      txnType: "transfer",
      amount: input.installments.amount,
      accountId: input.installments.payFromAccountId,
      toAccountId: null,
      categoryId: null,
      description: null,
      notes: null,
      tagIds: [],
      rule: { ...freq, startDate: input.installments.firstDue, endDate: null, count: input.debt.termMonths },
      pauses: [],
      status: "active",
      billKind: "loan_installment",
      cardAccountId: null,
      debtId,
      paysBillScheduleId: null,
      reminderDays: null,
      previousScheduleId: null,
    });
    changes.push({ entity: "schedule", id: sid, kind: "create", data: schedule });
  }
  await store().mutateGroup(changes);
  return debtId;
}

export async function updateDebt(debt: Debt) {
  await store().mutate("debt", debt.id, "update", check("debt", debt));
}

/**
 * A loan payment not tied to a bill: principal transfer + interest expense, atomic.
 */
export async function recordDebtPayment(input: {
  debt: Debt;
  fromAccountId: string;
  principal: Centavos;
  interest: Centavos;
  date: ISODate;
  interestCategoryId: string | null;
}) {
  const groupItems: { entity: "transaction"; id: string; kind: "create"; data: Transaction }[] = [];
  const base = { ...TXN_LINKS, adjustmentDirection: null, occurredAt: noon(input.date), notes: null, tagIds: [] as string[], refundOfId: null, debtId: input.debt.id };
  if (input.principal > 0) {
    const t = txn({ ...base, id: newId(), type: "transfer", amount: input.principal, accountId: input.fromAccountId, toAccountId: input.debt.accountId, categoryId: null, description: `${input.debt.creditor} (principal)` });
    groupItems.push({ entity: "transaction", id: t.id, kind: "create", data: t });
  }
  if (input.interest > 0) {
    const t = txn({ ...base, id: newId(), type: "expense", amount: input.interest, accountId: input.fromAccountId, toAccountId: null, categoryId: input.interestCategoryId, description: `${input.debt.creditor} (interest)` });
    groupItems.push({ entity: "transaction", id: t.id, kind: "create", data: t });
  }
  if (!groupItems.length) throw new ActionError("Enter the payment.");
  if (groupItems.length === 1) await store().mutate("transaction", groupItems[0]!.id, "create", groupItems[0]!.data);
  else await store().mutateGroup(groupItems);
}
