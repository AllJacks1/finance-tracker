import { describe, expect, it } from "vitest";
import { occurrenceTxnId } from "../domain/ids";
import { TXN_LINKS, type Account, type Bill, type CardProfile, type Category, type Debt, type Goal, type GoalEntry, type InstallmentPlan, type ManualAsset, type Schedule, type ScheduleException, type Transaction } from "../domain/types";
import { computeBalances } from "./balances";
import { billStatus, buildBillViews, type BillInputs } from "./bills";
import { availableCredit, closingDateIn, computeStatement, cycleClosingFor, minimumDue } from "./cards";
import { buildPreview, mapRows, parseCsv, parseCsvAmount, parseDate } from "./csv-import";
import { compareStrategies, periodicInterest, progressBp, projectPayoff, rateOf, splitPayment } from "./debts";
import { accountAllocations, allocatedByGoal, crossedMilestones, emergencyCoverage, essentialMonthlyAverage, goalEarmarks, goalProgress } from "./goals";
import { periodTotals } from "./ledger";
import { assetValueAsOf, autoSnapshotDue, netWorthAsOf, snapshotDrift, toSnapshot } from "./networth";
import { calendarItems, deriveNotifications, projectCashflow, scheduledOutflows, spendableEffect } from "./planning";
import { describeRule, nextOccurrence, occurrencesBetween, splitRule } from "./recurrence";
import { computeSafeToSpend } from "./safe-to-spend";
import { occurrenceToTransaction, pendingConfirmations, scheduleOccurrences } from "./schedules";
import { DEFAULT_PREFERENCES } from "../domain/types";

// ------------------------------------------------------------------ fixtures
const acc = (id: string, over: Partial<Account> = {}): Account => ({
  id, name: id, type: "bank", openingBalance: 0, openingDate: "2026-01-01", color: null, icon: null, description: null, isActive: true, countsAsSpendable: true, ...over,
});
let n = 0;
const tx = (over: Partial<Transaction> & Pick<Transaction, "type" | "amount">): Transaction & { deletedAt?: string | null } => ({
  id: `t${++n}`, accountId: "bank", toAccountId: null, adjustmentDirection: null, categoryId: null, occurredAt: "2026-11-10T02:00:00Z",
  localDate: "2026-11-10", description: null, notes: null, tagIds: [], refundOfId: null, ...TXN_LINKS, ...over,
});
const rule = (over: Partial<Schedule["rule"]> = {}): Schedule["rule"] => ({ freq: "monthly", interval: 1, startDate: "2026-01-31", endDate: null, count: null, ...over });
const sched = (over: Partial<Schedule> = {}): Schedule => ({
  id: "s1", kind: "transaction", name: "Salary", txnType: "income", amount: 5_000_000, accountId: "bank", toAccountId: null, categoryId: null,
  description: null, notes: null, tagIds: [], rule: rule({ startDate: "2026-11-15" }), pauses: [], status: "active", billKind: null,
  cardAccountId: null, debtId: null, paysBillScheduleId: null, reminderDays: null, previousScheduleId: null, ...over,
});
const bill = (over: Partial<Bill> = {}): Bill => ({
  id: "b1", name: "Meralco", kind: "general", categoryId: null, expectedAmount: 300_000, actualAmount: null, minimumAmount: null,
  dueDate: "2026-11-20", accountId: "bank", notes: null, scheduleId: null, occurrenceDate: null, cardAccountId: null, debtId: null,
  statementClosingDate: null, cancelled: false, ...over,
});
const card: CardProfile = { id: "cp", accountId: "card", creditLimit: 10_000_000, statementDay: 31, dueDaysAfterStatement: 20, minPaymentPctBp: 300, minPaymentFloor: 50_000, aprBp: 3600, autoBills: true };
const inputs = (over: Partial<BillInputs>): BillInputs => ({ bills: [], schedules: [], exceptions: [], cardProfiles: [], plans: [], accounts: [], txns: [], today: "2026-11-24", ...over });

// ------------------------------------------------------------------ recurrence
describe("recurrence", () => {
  it("monthly keeps the anchor day and clamps short months", () => {
    expect(occurrencesBetween(rule(), "2027-01-01", "2027-04-30")).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
    expect(occurrencesBetween(rule(), "2028-02-01", "2028-02-29")).toEqual(["2028-02-29"]);
  });
  it("biweekly, daily, custom interval, yearly leap day, once", () => {
    expect(occurrencesBetween(rule({ freq: "weekly", interval: 2, startDate: "2026-11-06" }), "2026-11-01", "2026-12-10")).toEqual(["2026-11-06", "2026-11-20", "2026-12-04"]);
    expect(occurrencesBetween(rule({ freq: "daily", interval: 3, startDate: "2020-01-01" }), "2026-11-20", "2026-11-26").length).toBe(2);
    expect(occurrencesBetween(rule({ freq: "monthly", interval: 3, startDate: "2026-01-15" }), "2026-01-01", "2026-12-31")).toEqual(["2026-01-15", "2026-04-15", "2026-07-15", "2026-10-15"]);
    expect(occurrencesBetween(rule({ freq: "yearly", startDate: "2028-02-29" }), "2028-01-01", "2032-12-31")).toEqual(["2028-02-29", "2029-02-28", "2030-02-28", "2031-02-28", "2032-02-29"]);
    expect(occurrencesBetween(rule({ freq: "once", startDate: "2026-12-01" }), "2026-01-01", "2027-01-01")).toEqual(["2026-12-01"]);
  });
  it("honours end date, count and pause windows (no back-fill on resume)", () => {
    expect(occurrencesBetween(rule({ startDate: "2026-01-10", endDate: "2026-03-10" }), "2026-01-01", "2026-12-31")).toHaveLength(3);
    expect(occurrencesBetween(rule({ startDate: "2026-01-10", count: 2 }), "2026-01-01", "2026-12-31")).toEqual(["2026-01-10", "2026-02-10"]);
    const paused = occurrencesBetween(rule({ startDate: "2026-01-10" }), "2026-01-01", "2026-06-30", [{ from: "2026-02-01", to: "2026-04-15" }]);
    expect(paused).toEqual(["2026-01-10", "2026-05-10", "2026-06-10"]);
    expect(nextOccurrence(rule({ startDate: "2026-01-10" }), "2026-02-01", [{ from: "2026-02-01", to: null }])).toBeNull();
  });
  it("splitting a rule for 'edit future occurrences' keeps cadence and history", () => {
    const sp = splitRule(rule({ startDate: "2026-01-15", count: 12 }), "2026-06-01")!;
    expect(sp.ended.endDate).toBe("2026-05-31");
    expect(sp.next.startDate).toBe("2026-06-15");
    expect(sp.ended.count! + sp.next.count!).toBe(12);
    expect(describeRule(rule({ freq: "weekly", interval: 2 }))).toBe("Every 2 weeks");
  });
});

// ------------------------------------------------------------------ schedules
describe("scheduled transactions", () => {
  const s = sched();
  const ctx = (txns: Transaction[] = [], exceptions: ScheduleException[] = []) => ({ today: "2026-12-20", exceptions, txns });
  it("states: completed / needs confirmation / scheduled / skipped; overrides apply", () => {
    const confirmed = tx({ type: "income", amount: 5_000_000, scheduleId: "s1", occurrenceDate: "2026-11-15", id: occurrenceTxnId("s1", "2026-11-15") });
    const skip: ScheduleException = { id: "e1", scheduleId: "s1", occurrenceDate: "2027-01-15", action: "skip", overrideDate: null, overrideAmount: null };
    const occ = scheduleOccurrences(s, "2026-11-01", "2027-02-28", ctx([confirmed], [skip]));
    expect(occ.map((o) => [o.nominalDate, o.state])).toEqual([
      ["2026-11-15", "completed"],
      ["2026-12-15", "needs_confirmation"],
      ["2027-01-15", "skipped"],
      ["2027-02-15", "scheduled"],
    ]);
    const ov: ScheduleException = { id: "e2", scheduleId: "s1", occurrenceDate: "2027-02-15", action: "override", overrideDate: "2027-02-13", overrideAmount: 5_500_000 };
    const o2 = scheduleOccurrences(s, "2027-02-01", "2027-02-28", ctx([], [ov]))[0]!;
    expect([o2.date, o2.amount]).toEqual(["2027-02-13", 5_500_000]);
  });
  it("scheduled items never change actual balances until confirmed", () => {
    const accounts = [acc("bank", { openingBalance: 1_000_000 })];
    expect(computeBalances(accounts, []).get("bank")).toBe(1_000_000); // schedule exists, balance unchanged
    const o = pendingConfirmations([s], ctx())[0]!;
    const t = { ...occurrenceToTransaction(o), localDate: o.date };
    expect(t.id).toBe(occurrenceTxnId("s1", o.nominalDate)); // deterministic: same id on every device
    expect(computeBalances(accounts, [t]).get("bank")).toBe(6_000_000);
  });
  it("cancelled schedules keep history only; paused windows produce nothing", () => {
    expect(scheduleOccurrences({ ...s, status: "cancelled" }, "2026-11-01", "2027-03-01", ctx()).length).toBe(0);
    expect(scheduleOccurrences({ ...s, pauses: [{ from: "2026-12-01", to: null }] }, "2026-12-01", "2027-03-01", ctx()).length).toBe(0);
  });
});

// ------------------------------------------------------------------ bills
describe("bills", () => {
  it("status table", () => {
    const t = "2026-11-20";
    expect(billStatus(bill({ dueDate: "2026-11-25" }), 1000, 0, t)).toBe("upcoming");
    expect(billStatus(bill({ dueDate: t }), 1000, 0, t)).toBe("due_today");
    expect(billStatus(bill({ dueDate: "2026-11-19" }), 1000, 0, t)).toBe("overdue");
    expect(billStatus(bill({ dueDate: "2026-11-25" }), 1000, 400, t)).toBe("partially_paid");
    expect(billStatus(bill({ dueDate: "2026-11-25" }), 1000, 1000, t)).toBe("paid");
    expect(billStatus(bill({ cancelled: true }), 1000, 0, t)).toBe("cancelled");
  });
  it("multiple partial payments, actual amount overrides expected, deleted payment reopens", () => {
    const b = bill({ actualAmount: 320_000 });
    const p1 = tx({ type: "expense", amount: 120_000, billId: "b1" });
    const p2 = tx({ type: "expense", amount: 200_000, billId: "b1" });
    let v = buildBillViews(inputs({ bills: [b], txns: [p1, p2] }), "2026-11-01", "2026-11-30")[0]!;
    expect([v.due, v.paid, v.outstanding, v.status]).toEqual([320_000, 320_000, 0, "paid"]);
    v = buildBillViews(inputs({ bills: [b], txns: [p1, { ...p2, deletedAt: "x" }] }), "2026-11-01", "2026-11-30")[0]!;
    expect([v.outstanding, v.status]).toEqual([200_000, "overdue"]);
  });
  it("payments hit the ledger once; the bill itself never moves money", () => {
    const accounts = [acc("bank", { openingBalance: 1_000_000 })];
    const p = tx({ type: "expense", amount: 300_000, billId: "b1" });
    expect(computeBalances(accounts, [p]).get("bank")).toBe(700_000);
    expect(periodTotals([p], "2026-11-01", "2026-11-30").netExpense).toBe(300_000);
  });
  it("recurring bills are virtual until stored; stored/skip/deleted suppress the virtual twin", () => {
    const bs = sched({ id: "bs", kind: "bill", txnType: "expense", billKind: "general", name: "PLDT", amount: 169_900, rule: rule({ startDate: "2026-11-05" }) });
    let views = buildBillViews(inputs({ schedules: [bs] }), "2026-11-01", "2027-01-31");
    expect(views.map((v) => [v.dueDate, v.virtual])).toEqual([["2026-11-05", true], ["2026-12-05", true], ["2027-01-05", true]]);
    const stored = { ...bill({ name: "PLDT", scheduleId: "bs", occurrenceDate: "2026-12-05", dueDate: "2026-12-05", actualAmount: 180_000 }), id: views[1]!.id };
    const skip: ScheduleException = { id: "x", scheduleId: "bs", occurrenceDate: "2027-01-05", action: "skip", overrideDate: null, overrideAmount: null };
    views = buildBillViews(inputs({ schedules: [bs], bills: [stored], exceptions: [skip] }), "2026-11-01", "2027-01-31");
    expect(views.map((v) => [v.dueDate, v.virtual, v.due])).toEqual([["2026-11-05", true, 169_900], ["2026-12-05", false, 180_000]]);
  });
});

// ------------------------------------------------------------------ credit cards
describe("credit cards", () => {
  const cardAcc = acc("card", { type: "credit_card", countsAsSpendable: false });
  const bank = acc("bank", { openingBalance: 5_000_000 });
  it("statement cycle dates clamp to month end", () => {
    expect(closingDateIn(card, 2027, 2)).toBe("2027-02-28");
    expect(cycleClosingFor({ statementDay: 15 }, "2026-11-16")).toBe("2026-12-15");
  });
  it("purchase = expense + liability; payment = transfer, not another expense", () => {
    const buy = tx({ type: "expense", amount: 250_000, accountId: "card", localDate: "2026-11-05" });
    const pay = tx({ type: "transfer", amount: 250_000, accountId: "bank", toAccountId: "card", localDate: "2026-12-05" });
    const b = computeBalances([cardAcc, bank], [buy, pay]);
    expect(b.get("card")).toBe(0);
    expect(b.get("bank")).toBe(4_750_000);
    expect(periodTotals([buy, pay], "2026-11-01", "2026-12-31").netExpense).toBe(250_000); // counted once
    expect(availableCredit(card, computeBalances([cardAcc], [buy]).get("card")!)).toBe(9_750_000);
  });
  it("installments: full amount uses credit now, only the monthly part is billed", () => {
    const buy = tx({ id: "phone", type: "expense", amount: 2_400_000, accountId: "card", localDate: "2026-10-20" });
    const coffee = tx({ type: "expense", amount: 20_000, accountId: "card", localDate: "2026-10-25" });
    const plan: InstallmentPlan = { id: "ip", cardAccountId: "card", transactionId: "phone", description: "Phone", principal: 2_400_000, months: 12, monthlyAmount: 200_000, firstBillingDate: "2026-10-31", feeAmount: 0, status: "active" };
    const st = computeStatement(card, cardAcc, [buy, coffee], [plan], "2026-10-31");
    expect(st.statementBalance).toBe(220_000); // 2,000 installment + 200 coffee
    expect(st.installmentsBilled).toBe(200_000);
    expect(st.minimumDue).toBe(250_000 > 220_000 ? 220_000 : 250_000); // floor 500 + 2,000 capped at statement
    expect(availableCredit(card, computeBalances([cardAcc], [buy, coffee]).get("card")!)).toBe(10_000_000 - 2_420_000);
    const nov = computeStatement(card, cardAcc, [buy, coffee, tx({ type: "transfer", amount: 220_000, accountId: "bank", toAccountId: "card", localDate: "2026-11-15" })], [plan], "2026-11-30");
    expect(nov.statementBalance).toBe(200_000); // next installment only
    expect(minimumDue(card, 1_000_000, 0)).toBe(50_000);
  });
  it("card statement bills are virtual; payments (linked or in-window) settle them", () => {
    const buy = tx({ type: "expense", amount: 500_000, accountId: "card", localDate: "2026-10-12" });
    const pay = tx({ type: "transfer", amount: 200_000, accountId: "bank", toAccountId: "card", localDate: "2026-11-10" });
    const views = buildBillViews(inputs({ cardProfiles: [card], accounts: [cardAcc, bank], txns: [buy, pay] }), "2026-11-01", "2026-11-30");
    expect(views).toHaveLength(1);
    expect([views[0]!.kind, views[0]!.due, views[0]!.paid, views[0]!.outstanding, views[0]!.dueDate]).toEqual(["card_payment", 500_000, 200_000, 300_000, "2026-11-20"]);
  });
});

// ------------------------------------------------------------------ debts
describe("debts", () => {
  const d: Debt = { id: "d", accountId: "loan", creditor: "Bank", kind: "bank", originalPrincipal: 1_000_000, startDate: "2026-01-01", aprBp: 1200, interestMethod: "diminishing", frequency: "monthly", minimumPayment: 88_849, dueDay: 1, termMonths: 12, status: "active", notes: null };
  it("interest methods and payment split", () => {
    expect(rateOf(10_000_000, 1200, 12)).toBe(100_000); // 1% of 100,000.00
    expect(periodicInterest(d, 1_000_000)).toBe(10_000);
    expect(periodicInterest({ ...d, interestMethod: "add_on" }, 100_000)).toBe(10_000); // flat on original
    expect(periodicInterest({ ...d, interestMethod: "none" }, 1_000_000)).toBe(0);
    expect(splitPayment(d, 1_000_000, 88_849)).toEqual({ interest: 10_000, principal: 78_849 });
  });
  it("amortized payoff matches a standard 12-month schedule; underpayment never pays off", () => {
    const p = projectPayoff(d, 1_000_000, 88_849, "2026-01-01");
    expect(p.periods).toBe(12);
    expect(p.totalInterest).toBeGreaterThan(66_000);
    expect(p.totalInterest).toBeLessThan(66_400);
    expect(p.payoffDate).toBe("2027-01-01");
    expect(projectPayoff(d, 1_000_000, 10_000, "2026-01-01").neverPaysOff).toBe(true);
    expect(progressBp(1_000_000, 250_000)).toBe(7500);
  });
  it("snowball targets the smallest balance; avalanche the highest rate and pays less interest", () => {
    const debts = [
      { id: "small", name: "Small", balance: 300_000, aprBp: 600, minPayment: 30_000 },
      { id: "big", name: "Big", balance: 1_000_000, aprBp: 3600, minPayment: 30_000 },
    ];
    const r = compareStrategies(debts, 500_000);
    const firstPaid = (x: typeof r.snowball) => [...x.payoff].sort((a, b) => (a.month ?? 9e9) - (b.month ?? 9e9))[0]!.id;
    expect(firstPaid(r.snowball)).toBe("small");
    expect(firstPaid(r.avalanche)).toBe("big");
    expect(r.avalanche.totalInterest).toBeLessThanOrEqual(r.snowball.totalInterest);
    expect(r.minimum.months).toBeGreaterThan(r.avalanche.months);
    expect(r.snowball.neverPaysOff).toBe(false);
  });
});

// ------------------------------------------------------------------ goals & emergency fund
describe("goals and emergency fund", () => {
  const goals: Goal[] = [
    { id: "ef", name: "Emergency", kind: "emergency", targetAmount: 6_000_000, targetDate: null, accountId: "save", description: null, status: "active", completedAt: null },
    { id: "trip", name: "Trip", kind: "travel", targetAmount: 1_200_000, targetDate: "2027-05-24", accountId: "bank", description: null, status: "active", completedAt: null },
    { id: "loose", name: "Loose", kind: "general", targetAmount: 100_000, targetDate: null, accountId: null, description: null, status: "active", completedAt: null },
  ];
  const e = (goalId: string, amount: number): GoalEntry => ({ id: `${goalId}${amount}`, goalId, amount, entryDate: "2026-11-01", note: null, transactionId: null, groupId: null });
  const entries = [e("ef", 4_000_000), e("ef", -500_000), e("trip", 300_000), e("loose", 50_000)];
  const accounts = [acc("bank", { openingBalance: 1_000_000 }), acc("save", { type: "savings", openingBalance: 3_000_000, countsAsSpendable: false })];

  it("allocations, progress, suggestions, milestones", () => {
    const alloc = allocatedByGoal(entries);
    expect(alloc.get("ef")).toBe(3_500_000);
    const p = goalProgress(goals[1]!, alloc.get("trip")!, "2026-11-24");
    expect([p.remaining, p.pctBp, p.monthsLeft, p.suggestedMonthly]).toEqual([900_000, 2500, 6, 150_000]);
    expect(crossedMilestones(2400, 5100)).toEqual([25, 50]);
  });
  it("distinguishes account balance from goal allocations; flags over-allocation", () => {
    const balances = computeBalances(accounts, []);
    const per = accountAllocations(goals, allocatedByGoal(entries), balances);
    const save = per.find((x) => x.accountId === "save")!;
    expect([save.balance, save.allocated, save.unallocated, save.overAllocated]).toEqual([3_000_000, 3_500_000, -500_000, true]);
  });
  it("goal money in savings is not subtracted from Safe-to-Spend again; spendable earmarks are", () => {
    const transfer = tx({ type: "transfer", amount: 200_000, accountId: "bank", toAccountId: "save" });
    const balances = computeBalances(accounts, [transfer]);
    const sts = computeSafeToSpend({ accounts, balances, allocations: [], txns: [transfer], horizonEnd: "2026-11-30", goals: goalEarmarks(goals, allocatedByGoal(entries), accounts) });
    expect(sts.spendableBalance).toBe(800_000); // the transfer moved money once
    expect(sts.reserves).toBe(300_000); // trip goal held in the spendable bank account
    expect(sts.excluded.map((x) => x.id).sort()).toEqual(["ef", "loose"]);
    expect(periodTotals([transfer], "2026-11-01", "2026-11-30").netExpense).toBe(0); // saving isn't spending
  });
  it("emergency coverage from essential categories (3/6/9/12 months selectable)", () => {
    const cats: Category[] = [
      { id: "food", name: "Food", kind: "expense", icon: null, color: null, isArchived: false, isEssential: true },
      { id: "fun", name: "Fun", kind: "expense", icon: null, color: null, isArchived: false, isEssential: false },
    ];
    const txns = [
      tx({ type: "expense", amount: 2_000_000, categoryId: "food", localDate: "2026-08-10" }),
      tx({ type: "expense", amount: 2_000_000, categoryId: "food", localDate: "2026-09-10" }),
      tx({ type: "expense", amount: 2_000_000, categoryId: "food", localDate: "2026-10-10" }),
      tx({ type: "expense", amount: 9_999_999, categoryId: "fun", localDate: "2026-10-11" }),
      tx({ type: "expense", amount: 9_999_999, categoryId: "food", localDate: "2026-11-11" }), // current month ignored
    ];
    expect(essentialMonthlyAverage(txns, cats, "2026-11-24", 3).average).toBe(2_000_000);
    expect(essentialMonthlyAverage(txns, cats, "2026-11-24", 6).average).toBe(1_000_000);
    const cov = emergencyCoverage(7_500_000, 2_000_000, 6);
    expect([cov.coverageTenths, cov.targetAmount, cov.pctOfTargetBp]).toEqual([37, 12_000_000, 6250]);
    expect(emergencyCoverage(7_500_000, 2_000_000, 12).targetAmount).toBe(24_000_000);
  });
});

// ------------------------------------------------------------------ net worth
describe("net worth", () => {
  const accounts = [acc("bank", { openingBalance: 2_000_000 }), acc("card", { type: "credit_card", countsAsSpendable: false }), acc("loan", { type: "loan", openingBalance: -5_000_000, countsAsSpendable: false })];
  const asset: ManualAsset = { id: "car", name: "Car", kind: "vehicle", valuations: [{ date: "2026-01-01", value: 50_000_000 }, { date: "2026-10-01", value: 45_000_000 }], isActive: true, notes: null };
  it("assets - liabilities, manual assets as of date", () => {
    const buy = tx({ type: "expense", amount: 300_000, accountId: "card", localDate: "2026-11-05" });
    const nw = netWorthAsOf(accounts, [buy], [asset], "2026-11-30");
    expect([nw.assets, nw.liabilities, nw.netWorth]).toEqual([47_000_000, 5_300_000, 41_700_000]);
    expect(assetValueAsOf(asset, "2026-09-30")).toBe(50_000_000);
  });
  it("snapshots are records of the past: later edits show as drift, never rewrite", () => {
    const snap = toSnapshot("s", netWorthAsOf(accounts, [], [asset], "2026-10-31"), "auto", "2026-11-01T00:00:00Z");
    const late = tx({ type: "expense", amount: 100_000, localDate: "2026-10-15" }); // entered after the snapshot
    const now = netWorthAsOf(accounts, [late], [asset], "2026-10-31");
    expect(snap.netWorth).toBe(42_000_000);
    expect(snapshotDrift(snap, now)).toBe(-100_000);
    expect(autoSnapshotDue([snap], "2026-11-24", "2026-01-01")).toBeNull();
    expect(autoSnapshotDue([snap], "2026-12-02", "2026-01-01")).toBe("2026-11-30");
    expect(autoSnapshotDue([], "2026-12-02", "2026-12-01")).toBeNull(); // no account yet at month end
  });
});

// ------------------------------------------------------------------ planning: no double counting
describe("Safe-to-Spend v2, cash flow, calendar", () => {
  const accounts = [acc("bank", { openingBalance: 3_000_000 }), acc("cash", { type: "cash", openingBalance: 200_000 }), acc("save", { type: "savings", countsAsSpendable: false }), acc("card", { type: "credit_card", countsAsSpendable: false })];
  const today = "2026-11-24";

  it("spendable effect of scheduled flows", () => {
    const m = new Map(accounts.map((a) => [a.id, a]));
    expect(spendableEffect(sched({ txnType: "transfer", accountId: "bank", toAccountId: "cash" }), 100, m)).toBe(0);
    expect(spendableEffect(sched({ txnType: "transfer", accountId: "bank", toAccountId: "save" }), 100, m)).toBe(-100);
    expect(spendableEffect(sched({ txnType: "expense", accountId: "bank" }), 100, m)).toBe(-100);
  });

  it("bill + its payment, scheduled transfer paying a bill, and card spending are each counted once", () => {
    const rent = bill({ id: "rent", name: "Rent", expectedAmount: 1_500_000, dueDate: "2026-11-28" });
    const meralco = bill({ id: "mer", expectedAmount: 300_000, dueDate: "2026-11-26" });
    const paidMer = tx({ type: "expense", amount: 300_000, billId: "mer", localDate: "2026-11-24" });
    const cardBuy = tx({ type: "expense", amount: 400_000, accountId: "card", localDate: "2026-11-02" });
    const txns = [paidMer, cardBuy];
    const balances = computeBalances(accounts, txns);
    const views = buildBillViews(inputs({ bills: [rent, meralco], txns, accounts, today }), "2026-11-01", "2026-11-30");
    // Scheduled transfer to savings (counts) and an autopay transfer that pays the rent bill schedule (counts 0).
    const toSave = sched({ id: "sv", txnType: "transfer", accountId: "bank", toAccountId: "save", amount: 500_000, rule: rule({ startDate: "2026-11-29" }) });
    const autopay = sched({ id: "ap", txnType: "expense", accountId: "bank", amount: 1_500_000, paysBillScheduleId: "rent-schedule", rule: rule({ startDate: "2026-11-28" }) });
    const occ = [toSave, autopay].flatMap((s) => scheduleOccurrences(s, today, "2026-11-30", { today, exceptions: [], txns }));
    const sts = computeSafeToSpend({ accounts, balances, allocations: [], txns, horizonEnd: "2026-11-30", bills: views, scheduled: scheduledOutflows(occ, accounts, "2026-11-30") });
    expect(sts.spendableBalance).toBe(3_200_000 - 300_000); // Meralco paid once from the bank
    expect(sts.obligations).toBe(1_500_000); // rent only; Meralco is paid
    expect(sts.scheduled).toBe(500_000); // savings transfer; autopay for the rent bill not double counted
    expect(sts.safeToSpend).toBe(2_900_000 - 1_500_000 - 500_000);
    // Card purchase lowered nothing spendable and isn't an obligation until its statement bill exists.
    expect(sts.obligationLines.map((l) => l.id)).toEqual(["rent"]);
  });

  it("projected cash flow finds the lowest point", () => {
    const salary = sched({ amount: 2_000_000, rule: rule({ startDate: "2026-11-30" }) });
    const occ = scheduleOccurrences(salary, today, "2026-12-31", { today, exceptions: [], txns: [] });
    const views = buildBillViews(inputs({ bills: [bill({ id: "rent", expectedAmount: 3_000_000, dueDate: "2026-11-28" })], accounts, today }), today, "2026-12-31");
    const cf = projectCashflow({ spendableBalance: 3_200_000, today, days: 14, occurrences: occ, bills: views, accounts });
    expect(cf.lowest.date).toBe("2026-11-28");
    expect(cf.lowest.balance).toBe(200_000);
    expect(cf.days.find((d) => d.date === "2026-11-30")!.balance).toBe(2_200_000);
  });

  it("calendar merges sources without duplicates", () => {
    const bs = sched({ id: "bs", kind: "bill", txnType: "expense", billKind: "general", rule: rule({ startDate: "2026-12-05" }) });
    const views = buildBillViews(inputs({ schedules: [bs], accounts, today }), "2026-12-01", "2026-12-31");
    const occ = scheduleOccurrences(sched(), "2026-12-01", "2026-12-31", { today, exceptions: [], txns: [] });
    const items = calendarItems({ bills: [...views, ...views], occurrences: [...occ, ...occ], goals: [], from: "2026-12-01", to: "2026-12-31", today });
    expect(items.map((i) => i.kind)).toEqual(["bill", "income"]);
  });

  it("derives in-app notifications respecting preferences", () => {
    const views = buildBillViews(inputs({ bills: [bill({ dueDate: "2026-11-22" }), bill({ id: "b2", name: "Water", dueDate: "2026-12-30" })], today }), "2026-11-01", "2026-12-31");
    const list = deriveNotifications({ today, prefs: DEFAULT_PREFERENCES.notifications, bills: views, pending: [], budgets: [], goals: [] });
    expect(list.map((x) => x.title)).toEqual(["Overdue: Meralco"]);
    expect(deriveNotifications({ today, prefs: { ...DEFAULT_PREFERENCES.notifications, bills: false }, bills: views, pending: [], budgets: [], goals: [] })).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ CSV import
describe("CSV import", () => {
  it("parses dates and bank-style amounts", () => {
    expect(parseDate("2026-11-05", "YYYY-MM-DD")).toBe("2026-11-05");
    expect(parseDate("11/05/2026", "MM/DD/YYYY")).toBe("2026-11-05");
    expect(parseDate("05/11/2026", "DD/MM/YYYY")).toBe("2026-11-05");
    expect(parseDate("05-Nov-2026", "DD-MMM-YYYY")).toBe("2026-11-05");
    expect(parseDate("Nov 5, 2026", "MMM DD, YYYY")).toBe("2026-11-05");
    expect(parseDate("02/30/2026", "MM/DD/YYYY")).toBeNull();
    expect(parseCsvAmount("(1,234.50)")).toBe(-123_450);
    expect(parseCsvAmount("1,234.50-")).toBe(-123_450);
    expect(parseCsvAmount("500.00 DR")).toBe(-50_000);
    expect(parseCsvAmount("PHP 500")).toBe(50_000);
    expect(parseCsvAmount("abc")).toBeNull();
  });

  it("maps columns, validates, and flags exact/likely/in-file duplicates", async () => {
    const csv = "Date,Description,Debit,Credit\n2026-11-01,GRAB FOOD,250.00,\n2026-11-02,SALARY,,40000\n2026-13-01,BAD,1,\n2026-11-03,COFFEE,120.00,\n2026-11-03,COFFEE,120.00,\n";
    const rows = mapRows(parseCsv(csv), { hasHeader: true, date: 0, dateFormat: "YYYY-MM-DD", amountMode: "split", amount: null, debit: 2, credit: 3, description: 1, category: null });
    expect(rows.map((r) => r.amount)).toEqual([-25_000, 4_000_000, -100, -12_000, -12_000]);
    expect(rows[2]!.errors[0]).toMatch(/Invalid date/);
    const existing = [tx({ type: "expense", amount: 25_000, accountId: "bank", localDate: "2026-11-02", description: "Grab Food order" })];
    const preview = await buildPreview(rows, "bank", existing);
    expect(preview.map((p) => p.duplicate)).toEqual(["likely", null, null, null, "in_file"]);
    expect(preview.map((p) => p.selected)).toEqual([false, true, false, true, false]);
    // Re-import of the same file: exact duplicates via fingerprint.
    const imported = preview.filter((p) => p.selected).map((p) => tx({ type: p.amount! > 0 ? "income" : "expense", amount: Math.abs(p.amount!), localDate: p.date!, importFingerprint: p.fingerprint }));
    const again = await buildPreview(rows, "bank", [...existing, ...imported]);
    expect(again.filter((p) => p.duplicate === "exact")).toHaveLength(2);
    expect(again.every((p) => !p.selected || p.duplicate === null)).toBe(true);
  });
});
