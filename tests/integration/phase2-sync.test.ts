import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import * as pushRoute from "@/app/api/sync/push/route";
import * as pullRoute from "@/app/api/sync/pull/route";
import type { ServerRecord } from "@/lib/sync/protocol";
import { adminSql, appSql, call, createUserAndLogin, login, resetDatabase, setupAdmin, STRONG, type Handler } from "./helpers";

const h = (f: unknown) => f as Handler;
type Session = { cookie: string };

const op = (entity: string, kind: string, entityId: string, data?: Record<string, unknown>, baseVersion: number | null = null, groupId?: string) => ({
  opId: randomUUID(),
  entity,
  entityId,
  kind,
  baseVersion,
  data,
  clientCreatedAt: new Date().toISOString(),
  ...(groupId ? { groupId } : {}),
});
const push = (s: Session, ops: unknown[]) => call(h(pushRoute.POST), { cookie: s.cookie, body: { ops } });
async function pullAll(s: Session): Promise<ServerRecord[]> {
  const r = await call(h(pullRoute.GET), { cookie: s.cookie, path: "/api/sync/pull?cursor=0&limit=1000" });
  return r.body.records;
}
const statuses = (r: { body: { results: { status: string; error?: { code: string } }[] } }) =>
  r.body.results.map((x) => (x.status === "rejected" ? `rejected:${x.error?.code}` : x.status));

const account = (over: Record<string, unknown> = {}) => ({
  name: "BDO",
  type: "bank",
  openingBalance: 5_000_000,
  openingDate: "2026-11-01",
  color: null,
  icon: null,
  description: null,
  isActive: true,
  countsAsSpendable: true,
  ...over,
});
const txn = (over: Record<string, unknown>) => ({
  type: "expense",
  amount: 100_000,
  toAccountId: null,
  adjustmentDirection: null,
  categoryId: null,
  occurredAt: "2026-11-20T04:00:00.000Z",
  localDate: "2026-11-20",
  description: null,
  notes: null,
  tagIds: [],
  refundOfId: null,
  ...over,
});
const schedule = (over: Record<string, unknown>) => ({
  kind: "transaction",
  name: "Salary",
  txnType: "income",
  amount: 4_000_000,
  accountId: null,
  toAccountId: null,
  categoryId: null,
  description: null,
  notes: null,
  tagIds: [],
  rule: { freq: "monthly", interval: 1, startDate: "2026-11-15", endDate: null, count: null },
  pauses: [],
  status: "active",
  billKind: null,
  cardAccountId: null,
  debtId: null,
  paysBillScheduleId: null,
  reminderDays: null,
  previousScheduleId: null,
  ...over,
});

let A: Session;
let B: Session;
let admin: Session;
const ids = { bank: uuidv7(), loan: uuidv7(), card: uuidv7(), debt: uuidv7(), sched: uuidv7(), bill: uuidv7() };

beforeAll(async () => {
  await resetDatabase();
  await setupAdmin();
  admin = await login("root@example.test", STRONG);
  A = await createUserAndLogin(admin.cookie, "alma@example.test");
  B = await createUserAndLogin(admin.cookie, "ben@example.test");
  const r = await push(A, [
    op("account", "create", ids.bank, account()),
    op("account", "create", ids.loan, account({ name: "Pag-IBIG loan", type: "loan", openingBalance: -10_000_000, countsAsSpendable: false })),
    op("account", "create", ids.card, account({ name: "BPI card", type: "credit_card", openingBalance: 0, countsAsSpendable: false })),
  ]);
  expect(statuses(r)).toEqual(["applied", "applied", "applied"]);
});

describe("Phase 2 entities validate their links", () => {
  it("debts need a loan account; card profiles need a credit card account", async () => {
    const debt = { accountId: ids.bank, creditor: "Bank", kind: "bank", originalPrincipal: 10_000_000, startDate: "2026-01-01", aprBp: 1200, interestMethod: "diminishing", frequency: "monthly", minimumPayment: 500_000, dueDay: 5, termMonths: 24, status: "active", notes: null };
    const card = { accountId: ids.bank, creditLimit: 10_000_000, statementDay: 10, dueDaysAfterStatement: 20, minPaymentPctBp: 300, minPaymentFloor: 50_000, aprBp: 3600, autoBills: true };
    const bad = await push(A, [op("debt", "create", uuidv7(), debt), op("cardProfile", "create", uuidv7(), card)]);
    expect(statuses(bad)).toEqual(["rejected:debt_account", "rejected:card_account"]);
    const good = await push(A, [op("debt", "create", ids.debt, { ...debt, accountId: ids.loan }), op("cardProfile", "create", uuidv7(), { ...card, accountId: ids.card })]);
    expect(statuses(good)).toEqual(["applied", "applied"]);
  });

  it("schedules validate shape (transfer needs destination, income can't use expense category)", async () => {
    const r = await push(A, [
      op("schedule", "create", uuidv7(), schedule({ txnType: "transfer", accountId: ids.bank })),
      op("schedule", "create", ids.sched, schedule({ accountId: ids.bank })),
    ]);
    expect(statuses(r)).toEqual(["rejected:required", "applied"]);
  });
});

describe("duplicate prevention for scheduled occurrences", () => {
  it("the same occurrence confirmed on two devices (same deterministic id, same data) is one transaction", async () => {
    const occId = uuidv7(); // in the app this is uuidv5(schedule, date)
    const data = txn({ type: "income", accountId: ids.bank, scheduleId: ids.sched, occurrenceDate: "2026-11-15", amount: 4_000_000 });
    const d1 = await push(A, [op("transaction", "create", occId, data)]);
    const d2 = await push(A, [op("transaction", "create", occId, data)]); // different opId, same record
    expect(statuses(d1)).toEqual(["applied"]);
    expect(statuses(d2)).toEqual(["duplicate"]);
    const sql = adminSql();
    const [{ n }] = await sql`select count(*)::int as n from transactions where schedule_id = ${ids.sched}`;
    await sql.end();
    expect(n).toBe(1);
  });

  it("the same occurrence with different data is a visible conflict, not a silent overwrite", async () => {
    const r = await push(A, [op("transaction", "create", (await pullAll(A)).find((x) => x.entity === "transaction")!.id, txn({ type: "income", accountId: ids.bank, scheduleId: ids.sched, occurrenceDate: "2026-11-15", amount: 3_900_000 }))]);
    expect(statuses(r)).toEqual(["conflict"]);
  });

  it("even with a different id, the database refuses a second record for the same occurrence", async () => {
    const r = await push(A, [op("transaction", "create", uuidv7(), txn({ type: "income", accountId: ids.bank, scheduleId: ids.sched, occurrenceDate: "2026-11-15", amount: 4_000_000 }))]);
    expect(statuses(r)).toEqual(["rejected:duplicate_occurrence"]);
  });

  it("an occurrence link needs both schedule and date", async () => {
    const r = await push(A, [op("transaction", "create", uuidv7(), txn({ accountId: ids.bank, scheduleId: ids.sched }))]);
    expect(statuses(r)).toEqual(["rejected:invalid_occurrence"]);
  });
});

describe("atomic groups", () => {
  it("applies all ops of a group together (loan payment: principal transfer + interest expense)", async () => {
    const g = randomUUID();
    const r = await push(A, [
      op("transaction", "create", uuidv7(), txn({ type: "transfer", accountId: ids.bank, toAccountId: ids.loan, amount: 400_000, debtId: ids.debt }), null, g),
      op("transaction", "create", uuidv7(), txn({ accountId: ids.bank, amount: 100_000, debtId: ids.debt }), null, g),
    ]);
    expect(statuses(r)).toEqual(["applied", "applied"]);
  });

  it("rolls back the whole group if one op fails; nothing is half-saved", async () => {
    const g = randomUUID();
    const okId = uuidv7();
    const r = await push(A, [
      op("transaction", "create", okId, txn({ type: "transfer", accountId: ids.bank, toAccountId: ids.loan, amount: 400_000, debtId: ids.debt }), null, g),
      op("transaction", "create", uuidv7(), txn({ accountId: ids.bank, amount: 0, debtId: ids.debt }), null, g), // invalid
    ]);
    expect(statuses(r)).toEqual(["rejected:group_failed", "rejected:validation"]);
    const sql = adminSql();
    const rows = await sql`select id from transactions where id = ${okId}`;
    await sql.end();
    expect(rows).toHaveLength(0);
    // Not recorded as applied: the same group can be retried after fixing.
    const retry = await push(A, [
      { ...r.body.results[0], ...op("transaction", "create", okId, txn({ type: "transfer", accountId: ids.bank, toAccountId: ids.loan, amount: 400_000, debtId: ids.debt }), null, g), opId: r.body.results[0].opId },
    ]);
    expect(statuses(retry)).toEqual(["applied"]);
  });

  it("refuses groups that are not sent contiguously", async () => {
    const g = randomUUID();
    const r = await push(A, [
      op("tag", "create", uuidv7(), { name: "a" }, null, g),
      op("tag", "create", uuidv7(), { name: "b" }),
      op("tag", "create", uuidv7(), { name: "c" }, null, g),
    ]);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_group");
  });
});

describe("immutable net-worth snapshots", () => {
  it("can be created but never updated", async () => {
    const id = uuidv7();
    const snap = { snapshotDate: "2026-10-31", kind: "auto", assets: 5_000_000, liabilities: -10_000_000, netWorth: -5_000_000, breakdown: [], recordedAt: new Date().toISOString() };
    expect(statuses(await push(A, [op("netWorthSnapshot", "create", id, snap)]))).toEqual(["applied"]);
    // A second device creating the same month's snapshot with identical data: duplicate.
    expect(statuses(await push(A, [op("netWorthSnapshot", "create", id, snap)]))).toEqual(["duplicate"]);
    const upd = await push(A, [op("netWorthSnapshot", "update", id, { ...snap, netWorth: 1 }, 1)]);
    expect(statuses(upd)).toEqual(["rejected:immutable"]);
  });
});

describe("Phase 2 isolation", () => {
  it("user B cannot read, change or link to user A's Phase 2 records", async () => {
    const recs = await pullAll(B);
    expect(recs.some((r) => [ids.debt, ids.sched].includes(r.id))).toBe(false);
    const r = await push(B, [
      op("schedule", "update", ids.sched, schedule({ accountId: ids.bank, amount: 1 }), 1),
      op("debt", "delete", ids.debt, undefined, 1),
      op("bill", "create", uuidv7(), { name: "x", kind: "general", categoryId: null, expectedAmount: 100, actualAmount: null, minimumAmount: null, dueDate: "2026-12-01", accountId: ids.bank, notes: null, scheduleId: null, occurrenceDate: null, cardAccountId: null, debtId: null, statementClosingDate: null, cancelled: false }),
      op("goal", "create", uuidv7(), { name: "steal", kind: "general", targetAmount: 1, targetDate: null, accountId: ids.bank, description: null, status: "active", completedAt: null }),
    ]);
    expect(statuses(r)).toEqual(["rejected:not_found", "rejected:not_found", "rejected:unknown_account", "rejected:unknown_account"]);
  });

  it("admins and the raw app DB role see zero rows in every new table", async () => {
    const recs = await pullAll(admin);
    expect(recs.filter((r) => r.entity !== "settings" && r.entity !== "category")).toHaveLength(0);
    const sql = appSql();
    for (const t of ["debts", "schedules", "schedule_exceptions", "bills", "card_profiles", "installment_plans", "import_batches", "goals", "goal_entries", "manual_assets", "net_worth_snapshots"]) {
      const [{ n }] = await sql.unsafe(`select count(*)::int as n from ${t}`);
      expect(n, t).toBe(0);
    }
    await expect(sql`delete from bills`).rejects.toThrow(/permission denied/);
    await expect(sql`delete from goals`).rejects.toThrow(/permission denied/);
    await sql.end();
  });
});
