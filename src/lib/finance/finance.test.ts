import { describe, expect, it } from "vitest";
import { TXN_LINKS, type Account, type Allocation, type Budget, type Transaction } from "../domain/types";
import { accountBalance, balanceHistory, computeBalances, reconciliationDifference, workspaceTotals } from "./balances";
import { amountFor, budgetHistory, currentProgress, overallAllocation, periodFor } from "./budgets";
import { csvCell } from "./csv";
import { addDays, addMonths, endOfMonth, isISODate, localDateOf, startOfWeek } from "./dates";
import { entriesFor, netSpending, periodTotals, validateTransaction } from "./ledger";
import { add, formatPHP, MoneyError, parseAmount, ratioBasisPoints, toDecimalString } from "./money";
import { computeSafeToSpend } from "./safe-to-spend";

// ---------------------------------------------------------------- fixtures
const acc = (id: string, over: Partial<Account> = {}): Account => ({
  id,
  name: id,
  type: "bank",
  openingBalance: 0,
  openingDate: "2026-01-01",
  color: null,
  icon: null,
  description: null,
  isActive: true,
  countsAsSpendable: true,
  ...over,
});
let n = 0;
const txn = (over: Partial<Transaction> & Pick<Transaction, "type" | "amount">): Transaction & { deletedAt?: string | null } => ({
  id: `t${++n}`,
  accountId: "bank",
  toAccountId: null,
  adjustmentDirection: null,
  categoryId: null,
  occurredAt: "2026-11-10T02:00:00Z",
  localDate: "2026-11-10",
  description: null,
  notes: null,
  tagIds: [],
  refundOfId: null,
  ...TXN_LINKS,
  ...over,
});
const budget = (over: Partial<Budget> = {}): Budget => ({
  id: "b1",
  name: "Monthly",
  scope: "overall",
  categoryId: null,
  period: "monthly",
  startDate: "2026-01-01",
  endDate: null,
  amountRevisions: [{ effectiveFrom: "2026-01-01", amount: 1_000_000 }],
  warnAtPct: 80,
  rollover: false,
  isActive: true,
  ...over,
});

// ---------------------------------------------------------------- money
describe("money", () => {
  it("parses amounts without floating point errors", () => {
    expect(parseAmount("0.1")).toBe(10);
    expect(parseAmount("0.29")).toBe(29); // 0.29*100 = 28.999999999999996 in float
    expect(parseAmount("1,234.56")).toBe(123456);
    expect(parseAmount("₱ 99")).toBe(9900);
    expect(parseAmount(".5")).toBe(50);
    expect(parseAmount("1234.")).toBe(123400);
  });
  it("rejects invalid input", () => {
    for (const bad of ["", "abc", "1.234", "1.2.3", "--1", "1e5", "NaN"]) expect(parseAmount(bad)).toBeNull();
    expect(parseAmount("-5")).toBeNull();
    expect(parseAmount("-5", { allowNegative: true })).toBe(-500);
    expect(parseAmount("9999999999999999")).toBeNull();
  });
  it("formats PHP", () => {
    expect(formatPHP(123456)).toBe("₱1,234.56");
    expect(formatPHP(-5)).toBe("-₱0.05");
    expect(formatPHP(0)).toBe("₱0.00");
    expect(formatPHP(100, { sign: "always" })).toBe("+₱1.00");
    expect(toDecimalString(-123456)).toBe("-1234.56");
  });
  it("refuses non-integer arithmetic", () => {
    expect(() => add(1, 0.5)).toThrow(MoneyError);
    expect(() => add(Number.MAX_SAFE_INTEGER, 1)).toThrow(MoneyError);
    expect(add(10, 20, -5)).toBe(25);
  });
  it("computes basis points", () => {
    expect(ratioBasisPoints(800, 1000)).toBe(8000);
    expect(ratioBasisPoints(1, 3)).toBe(3333);
    expect(ratioBasisPoints(5, 0)).toBe(10000);
  });
});

// ---------------------------------------------------------------- dates
describe("dates", () => {
  it("computes local dates in Asia/Manila (UTC+8)", () => {
    expect(localDateOf("2026-11-30T16:30:00Z", "Asia/Manila")).toBe("2026-12-01");
    expect(localDateOf("2026-11-30T15:59:59Z", "Asia/Manila")).toBe("2026-11-30");
  });
  it("handles month and week arithmetic", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(endOfMonth("2028-02-10")).toBe("2028-02-29");
    expect(startOfWeek("2026-11-24", 1)).toBe("2026-11-23"); // Tuesday -> Monday
    expect(startOfWeek("2026-11-23", 0)).toBe("2026-11-22"); // Monday -> Sunday
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(isISODate("2026-02-30")).toBe(false);
  });
});

// ---------------------------------------------------------------- ledger & balances
describe("ledger and balances", () => {
  const accounts = [
    acc("bank", { openingBalance: 1_000_000 }),
    acc("cash", { type: "cash", openingBalance: 50_000 }),
    acc("card", { type: "credit_card", countsAsSpendable: false }),
    acc("save", { type: "savings", openingBalance: 2_000_000, countsAsSpendable: false }),
  ];

  it("income and expense change one account", () => {
    const b = computeBalances(accounts, [txn({ type: "income", amount: 500_000 }), txn({ type: "expense", amount: 120_050 })]);
    expect(b.get("bank")).toBe(1_000_000 + 500_000 - 120_050);
  });

  it("transfer moves money atomically and nets to zero", () => {
    const t = txn({ type: "transfer", amount: 30_000, accountId: "bank", toAccountId: "cash" });
    const e = entriesFor(t);
    expect(e).toHaveLength(2);
    expect(e[0].amount + e[1].amount).toBe(0);
    const b = computeBalances(accounts, [t]);
    expect(b.get("bank")).toBe(970_000);
    expect(b.get("cash")).toBe(80_000);
    expect(periodTotals([t], "2026-11-01", "2026-11-30")).toMatchObject({ income: 0, expense: 0 });
  });

  it("refund increases balance and reduces expenses, not income", () => {
    const txns = [txn({ type: "expense", amount: 10_000, categoryId: "food" }), txn({ type: "refund", amount: 4_000, categoryId: "food" })];
    expect(accountBalance(accounts[0], txns)).toBe(1_000_000 - 6_000);
    const tot = periodTotals(txns, "2026-11-01", "2026-11-30");
    expect(tot).toEqual({ income: 0, expense: 10_000, refunds: 4_000, netExpense: 6_000, net: -6_000 });
  });

  it("adjustments change balance but not income/expense", () => {
    const txns = [
      txn({ type: "adjustment", amount: 2_500, adjustmentDirection: "decrease" }),
      txn({ type: "adjustment", amount: 1_000, adjustmentDirection: "increase" }),
    ];
    expect(accountBalance(accounts[0], txns)).toBe(1_000_000 - 1_500);
    expect(periodTotals(txns, "2026-11-01", "2026-11-30").net).toBe(0);
  });

  it("soft-deleted transactions are excluded; restoring brings them back", () => {
    const t = txn({ type: "expense", amount: 100_000 });
    expect(accountBalance(accounts[0], [{ ...t, deletedAt: "2026-11-11T00:00:00Z" }])).toBe(1_000_000);
    expect(accountBalance(accounts[0], [{ ...t, deletedAt: null }])).toBe(900_000);
  });

  it("credit card spending is a liability; paying it is a transfer", () => {
    const txns = [
      txn({ type: "expense", amount: 300_000, accountId: "card" }),
      txn({ type: "transfer", amount: 100_000, accountId: "bank", toAccountId: "card" }),
    ];
    const b = computeBalances(accounts, txns);
    expect(b.get("card")).toBe(-200_000);
    const tot = workspaceTotals(accounts, b);
    expect(tot.liabilities).toBe(-200_000);
    expect(tot.assets).toBe(900_000 + 50_000 + 2_000_000);
    expect(tot.netWorth).toBe(tot.assets - 200_000);
    expect(tot.savings).toBe(2_000_000);
    expect(tot.available).toBe(950_000);
  });

  it("balance as-of a date and daily history", () => {
    const txns = [txn({ type: "income", amount: 100, localDate: "2026-11-02" }), txn({ type: "expense", amount: 30, localDate: "2026-11-04" })];
    expect(accountBalance(accounts[0], txns, "2026-11-03")).toBe(1_000_100);
    const h = balanceHistory(accounts[0], txns, "2026-11-01", "2026-11-05");
    expect(h.map((x) => x.balance)).toEqual([1_000_000, 1_000_100, 1_000_100, 1_000_070, 1_000_070]);
  });

  it("reconciliation difference", () => {
    const r = reconciliationDifference(accounts[0], [txn({ type: "expense", amount: 500 })], "2026-11-30", 999_000);
    expect(r).toEqual({ computed: 999_500, difference: -500 });
  });

  it("validates transaction shapes", () => {
    const ctx = {
      accounts: new Map([["bank", { id: "bank" }], ["cash", { id: "cash" }]]),
      categories: new Map([["food", { id: "food", kind: "expense" as const }], ["salary", { id: "salary", kind: "income" as const }]]),
    };
    expect(validateTransaction(txn({ type: "expense", amount: 1, categoryId: "food" }), ctx)).toEqual([]);
    const codes = (t: Transaction) => validateTransaction(t, ctx).map((i) => i.code);
    expect(codes(txn({ type: "expense", amount: 0 }))).toContain("amount_positive");
    expect(codes(txn({ type: "expense", amount: 1.5 }))).toContain("amount_positive");
    expect(codes(txn({ type: "transfer", amount: 1, toAccountId: "bank" }))).toContain("same_account");
    expect(codes(txn({ type: "transfer", amount: 1, toAccountId: "cash", categoryId: "food" }))).toContain("not_allowed");
    expect(codes(txn({ type: "income", amount: 1, categoryId: "food" }))).toContain("category_kind");
    expect(codes(txn({ type: "adjustment", amount: 1 }))).toContain("required");
    expect(codes(txn({ type: "expense", amount: 1, accountId: "someone-elses" }))).toContain("unknown_account");
  });
});

// ---------------------------------------------------------------- budgets
describe("budgets", () => {
  const ws = 1; // Monday
  it("monthly period boundaries and spending (refunds net, transfers excluded)", () => {
    const b = budget();
    const txns = [
      txn({ type: "expense", amount: 300_000, localDate: "2026-11-01" }),
      txn({ type: "expense", amount: 500_000, localDate: "2026-11-30" }),
      txn({ type: "expense", amount: 999_999, localDate: "2026-12-01" }), // next month
      txn({ type: "refund", amount: 50_000, localDate: "2026-11-15" }),
      txn({ type: "transfer", amount: 700_000, toAccountId: "cash", localDate: "2026-11-15" }),
      txn({ type: "income", amount: 700_000, localDate: "2026-11-15" }),
    ];
    const p = currentProgress(b, txns, "2026-11-24", ws)!;
    expect(p.period).toEqual({ start: "2026-11-01", end: "2026-11-30" });
    expect(p.spent).toBe(750_000);
    expect(p.remaining).toBe(250_000);
    expect(p.usedBp).toBe(7500);
    expect(p.state).toBe("ok");
  });

  it("warning, reached and exceeded states", () => {
    const b = budget();
    const at = (amt: number) => currentProgress(b, [txn({ type: "expense", amount: amt })], "2026-11-24", ws)!.state;
    expect(at(799_999)).toBe("ok");
    expect(at(800_000)).toBe("warning");
    expect(at(1_000_000)).toBe("reached");
    expect(at(1_000_001)).toBe("exceeded");
  });

  it("weekly and daily periods, clipped to start date", () => {
    expect(periodFor(budget({ period: "weekly", startDate: "2026-11-25" }), "2026-11-27", ws)).toEqual({ start: "2026-11-25", end: "2026-11-29" });
    expect(periodFor(budget({ period: "weekly" }), "2026-11-24", 0)).toEqual({ start: "2026-11-22", end: "2026-11-28" });
    expect(periodFor(budget({ period: "daily" }), "2026-11-24", ws)).toEqual({ start: "2026-11-24", end: "2026-11-24" });
    expect(periodFor(budget({ startDate: "2026-12-01" }), "2026-11-24", ws)).toBeNull();
  });

  it("custom range budgets", () => {
    const b = budget({ period: "custom", startDate: "2026-12-20", endDate: "2027-01-05" });
    expect(periodFor(b, "2026-12-31", ws)).toEqual({ start: "2026-12-20", end: "2027-01-05" });
    const after = currentProgress(b, [], "2027-02-01", ws)!;
    expect(after.period.end).toBe("2027-01-05");
  });

  it("category budgets count only their category", () => {
    const b = budget({ scope: "category", categoryId: "food", amountRevisions: [{ effectiveFrom: "2026-01-01", amount: 100_000 }] });
    const txns = [txn({ type: "expense", amount: 40_000, categoryId: "food" }), txn({ type: "expense", amount: 70_000, categoryId: "fun" })];
    expect(currentProgress(b, txns, "2026-11-24", ws)!.spent).toBe(40_000);
    expect(netSpending(txns, "2026-11-01", "2026-11-30")).toBe(110_000);
  });

  it("category budgets are sub-limits of the overall budget, never added to it", () => {
    const overall = budget({ id: "o" });
    const food = budget({ id: "f", scope: "category", categoryId: "food", amountRevisions: [{ effectiveFrom: "2026-01-01", amount: 600_000 }] });
    const fun = budget({ id: "g", scope: "category", categoryId: "fun", amountRevisions: [{ effectiveFrom: "2026-01-01", amount: 300_000 }] });
    const weekly = budget({ id: "w", scope: "category", categoryId: "x", period: "weekly" });
    const a = overallAllocation(overall, [overall, food, fun, weekly], "2026-11-24", ws)!;
    expect(a).toMatchObject({ overallAmount: 1_000_000, allocatedToCategories: 900_000, unallocated: 100_000, overAllocated: false });
    // A food expense counts once in the overall budget and once against the food sub-limit.
    const txns = [txn({ type: "expense", amount: 200_000, categoryId: "food" })];
    expect(currentProgress(overall, txns, "2026-11-24", ws)!.spent).toBe(200_000);
    expect(currentProgress(food, txns, "2026-11-24", ws)!.spent).toBe(200_000);
    const over = overallAllocation(overall, [overall, food, fun, { ...fun, id: "h" }], "2026-11-24", ws)!;
    expect(over.overAllocated).toBe(true);
  });

  it("history uses the amount in effect for each period", () => {
    const b = budget({
      amountRevisions: [
        { effectiveFrom: "2026-01-01", amount: 1_000_000 },
        { effectiveFrom: "2026-10-01", amount: 1_500_000 },
      ],
    });
    expect(amountFor(b, "2026-09-01")).toBe(1_000_000);
    expect(amountFor(b, "2026-10-01")).toBe(1_500_000);
    const h = budgetHistory(b, [], "2026-11-24", ws, 3);
    expect(h.map((x) => [x.period.start, x.amount])).toEqual([
      ["2026-11-01", 1_500_000],
      ["2026-10-01", 1_500_000],
      ["2026-09-01", 1_000_000],
    ]);
  });
});

// ---------------------------------------------------------------- safe to spend
describe("safe-to-spend", () => {
  const accounts = [
    acc("bank", { openingBalance: 2_000_000 }),
    acc("gcash", { type: "ewallet", openingBalance: 300_000 }),
    acc("save", { type: "savings", openingBalance: 5_000_000, countsAsSpendable: false }),
    acc("card", { type: "credit_card", openingBalance: -400_000, countsAsSpendable: false }),
    acc("old", { openingBalance: 999_999, isActive: false }),
  ];
  const alloc = (over: Partial<Allocation>): Allocation => ({
    id: "a",
    kind: "obligation",
    name: "x",
    amount: 0,
    dueDate: null,
    accountId: null,
    status: "open",
    notes: null,
    ...over,
  });
  const run = (allocations: Allocation[], txns: Transaction[] = []) =>
    computeSafeToSpend({ accounts, balances: computeBalances(accounts, txns), allocations, txns, horizonEnd: "2026-11-30" });

  it("counts only spendable accounts (no savings, liabilities or inactive)", () => {
    const s = run([]);
    expect(s.spendableBalance).toBe(2_300_000);
    expect(s.safeToSpend).toBe(2_300_000);
  });

  it("subtracts reserves and obligations due by the horizon", () => {
    const s = run([
      alloc({ id: "rent", amount: 1_200_000, dueDate: "2026-11-30" }),
      alloc({ id: "later", amount: 50_000, dueDate: "2026-12-15" }),
      alloc({ id: "emergency", kind: "reserve", amount: 200_000 }),
      alloc({ id: "done", amount: 99_999, status: "settled" }),
    ]);
    expect(s.obligations).toBe(1_200_000);
    expect(s.reserves).toBe(200_000);
    expect(s.safeToSpend).toBe(900_000);
    expect(s.excluded.map((e) => e.id)).toEqual(["later"]);
  });

  it("does not double-deduct a paid obligation (payment linked, status still open)", () => {
    const rent = alloc({ id: "rent", amount: 1_200_000 });
    const pay = txn({ type: "expense", amount: 1_200_000, allocationId: "rent" });
    const s = run([rent], [pay]);
    expect(s.spendableBalance).toBe(1_100_000);
    expect(s.obligations).toBe(0);
    expect(s.safeToSpend).toBe(1_100_000);
  });

  it("partial payments reduce the outstanding obligation", () => {
    const s = run([alloc({ id: "rent", amount: 1_200_000 })], [txn({ type: "expense", amount: 200_000, allocationId: "rent" })]);
    expect(s.obligations).toBe(1_000_000);
    expect(s.safeToSpend).toBe(2_100_000 - 1_000_000);
  });

  it("does not deduct reserves held in non-spendable accounts (no double deduction of savings)", () => {
    const s = run([alloc({ id: "trip", kind: "reserve", amount: 1_000_000, accountId: "save" })]);
    expect(s.reserves).toBe(0);
    expect(s.safeToSpend).toBe(2_300_000);
    expect(s.excluded[0].id).toBe("trip");
  });

  it("budgets are not deducted, and negative results are not clamped", () => {
    const s = run([alloc({ id: "big", amount: 3_000_000 })]);
    expect(s.safeToSpend).toBe(-700_000);
  });
});

describe("csv", () => {
  it("neutralises formulas and quotes", () => {
    expect(csvCell("=SUM(A1)")).toBe(`"'=SUM(A1)"`);
    expect(csvCell("-12.50")).toBe("-12.50");
    expect(csvCell("@cmd")).toBe(`"'@cmd"`);
    expect(csvCell('a "b", c')).toBe(`"a ""b"", c"`);
    expect(csvCell(null)).toBe("");
  });
});
