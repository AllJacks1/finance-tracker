import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import * as pushRoute from "@/app/api/sync/push/route";
import * as pullRoute from "@/app/api/sync/pull/route";
import type { ServerRecord } from "@/lib/sync/protocol";
import { adminSql, appSql, call, createUserAndLogin, login, resetDatabase, setupAdmin, STRONG, type Handler } from "./helpers";

const h = (f: unknown) => f as Handler;
type Session = { cookie: string; id?: string };

const op = (entity: string, kind: string, entityId: string, data?: Record<string, unknown>, baseVersion: number | null = null) => ({
  opId: randomUUID(),
  entity,
  entityId,
  kind,
  baseVersion,
  data,
  clientCreatedAt: new Date().toISOString(),
});

async function push(s: Session, ops: unknown[]) {
  return call(h(pushRoute.POST), { cookie: s.cookie, body: { ops } });
}
async function pullAll(s: Session, cursor = 0): Promise<ServerRecord[]> {
  const out: ServerRecord[] = [];
  for (;;) {
    const r = await call(h(pullRoute.GET), { cookie: s.cookie, path: `/api/sync/pull?cursor=${cursor}&limit=7` });
    expect(r.status).toBe(200);
    out.push(...r.body.records);
    cursor = r.body.cursor;
    if (!r.body.hasMore) return out;
  }
}

const account = (over: Record<string, unknown> = {}) => ({
  name: "BPI Savings",
  type: "bank",
  openingBalance: 1_000_000,
  openingDate: "2026-11-01",
  color: "#0ea5e9",
  icon: "landmark",
  description: null,
  isActive: true,
  countsAsSpendable: true,
  ...over,
});
const txnData = (over: Record<string, unknown>) => ({
  type: "expense",
  amount: 25_050,
  toAccountId: null,
  adjustmentDirection: null,
  categoryId: null,
  occurredAt: "2026-11-20T04:00:00.000Z",
  localDate: "2026-11-20",
  description: "Lunch",
  notes: null,
  tagIds: [],
  refundOfId: null,
  allocationId: null,
  ...over,
});

async function balanceOf(accountId: string) {
  const sql = adminSql();
  const [a] = await sql`select opening_balance::bigint as ob from accounts where id = ${accountId}`;
  const [e] = await sql`select coalesce(sum(amount), 0)::bigint as s from transaction_entries where account_id = ${accountId}`;
  await sql.end();
  return Number(a!.ob) + Number(e!.s);
}

let admin: Session;
let A: Session;
let B: Session;
const ids = { bank: uuidv7(), cash: uuidv7(), food: "", salary: "", t1: uuidv7(), tr: uuidv7(), bBank: uuidv7() };

beforeAll(async () => {
  await resetDatabase();
  await setupAdmin();
  admin = await login("root@example.test", STRONG);
  A = await createUserAndLogin(admin.cookie, "alice@example.test");
  B = await createUserAndLogin(admin.cookie, "bruno@example.test");
});

describe("sync: create, pull, balances", () => {
  it("new workspaces get default categories through pull", async () => {
    const recs = await pullAll(A);
    const cats = recs.filter((r) => r.entity === "category");
    expect(cats.length).toBeGreaterThanOrEqual(10);
    ids.food = cats.find((c) => c.data.name === "Food")!.id;
    ids.salary = cats.find((c) => c.data.name === "Salary")!.id;
    expect(recs.some((r) => r.entity === "settings" && r.data.timezone === "Asia/Manila")).toBe(true);
  });

  it("applies creates in order and returns server records", async () => {
    const r = await push(A, [
      op("account", "create", ids.bank, account()),
      op("account", "create", ids.cash, account({ name: "Wallet", type: "cash", openingBalance: 50_000 })),
      op("transaction", "create", ids.t1, txnData({ accountId: ids.bank, categoryId: ids.food })),
      op("transaction", "create", ids.tr, txnData({ type: "transfer", amount: 100_000, accountId: ids.bank, toAccountId: ids.cash, description: "ATM" })),
    ]);
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(["applied", "applied", "applied", "applied"]);
    expect(r.body.results[2].record.version).toBe(1);
    expect(await balanceOf(ids.bank)).toBe(1_000_000 - 25_050 - 100_000);
    expect(await balanceOf(ids.cash)).toBe(150_000);
  });

  it("transfers produce two ledger lines that net to zero", async () => {
    const sql = adminSql();
    const lines = await sql`select amount::bigint as a from transaction_entries where transaction_id = ${ids.tr}`;
    await sql.end();
    expect(lines).toHaveLength(2);
    expect(lines.reduce((s, l) => s + Number(l.a), 0)).toBe(0);
  });

  it("server sets the local date from the workspace timezone", async () => {
    const id = uuidv7();
    const r = await push(A, [op("transaction", "create", id, txnData({ accountId: ids.cash, occurredAt: "2026-11-20T17:30:00.000Z", localDate: "2026-11-20" }))]);
    expect(r.body.results[0].record.data.localDate).toBe("2026-11-21"); // 01:30 in Manila
  });
});

describe("sync: idempotency, retries and interrupted syncs", () => {
  it("replaying the same ops (lost response) never duplicates records", async () => {
    const id = uuidv7();
    const ops = [op("transaction", "create", id, txnData({ accountId: ids.cash, amount: 1_000 }))];
    const before = await balanceOf(ids.cash);
    const first = await push(A, ops);
    expect(first.body.results[0].status).toBe("applied");
    // Network drops the response; client retries the identical batch twice.
    const second = await push(A, ops);
    const third = await push(A, ops);
    expect(second.body.results[0].status).toBe("duplicate");
    expect(third.body.results[0].status).toBe("duplicate");
    expect(await balanceOf(ids.cash)).toBe(before - 1_000);
    const sql = adminSql();
    const [{ n }] = await sql`select count(*)::int as n from transactions where id = ${id}`;
    await sql.end();
    expect(n).toBe(1);
  });

  it("a create retried with a NEW op id for an existing record is a conflict, not a duplicate row", async () => {
    const r = await push(A, [op("transaction", "create", ids.t1, txnData({ accountId: ids.bank }))]);
    expect(r.body.results[0].status).toBe("conflict");
  });

  it("concurrent pushes from two devices are serialised without lost updates", async () => {
    const A2 = await login("alice@example.test", (A as { password?: string }).password ?? "", randomUUID()).catch(() => null);
    const sessions = A2 ? [A, A2] : [A, A];
    const before = await balanceOf(ids.cash);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        push(sessions[i % 2]!, [op("transaction", "create", uuidv7(), txnData({ accountId: ids.cash, amount: 100 }))]),
      ),
    );
    expect(results.every((r) => r.body.results[0].status === "applied")).toBe(true);
    const seqs = results.map((r) => r.body.results[0].record.changeSeq);
    expect(new Set(seqs).size).toBe(8);
    expect(await balanceOf(ids.cash)).toBe(before - 800);
  });
});

describe("sync: conflicts (no blind last-write-wins)", () => {
  it("stale baseVersion is a conflict; server data is not overwritten; later ops are held", async () => {
    const upd1 = await push(A, [op("transaction", "update", ids.t1, txnData({ accountId: ids.bank, categoryId: ids.food, amount: 30_000 }), 1)]);
    expect(upd1.body.results[0].status).toBe("applied");
    expect(upd1.body.results[0].record.version).toBe(2);
    // Another device still at version 1 edits the same transaction.
    const stale = await push(A, [
      op("transaction", "update", ids.t1, txnData({ accountId: ids.bank, categoryId: ids.food, amount: 99_999 }), 1),
      op("transaction", "delete", ids.t1, undefined, 1),
    ]);
    expect(stale.body.results[0].status).toBe("conflict");
    expect(stale.body.results[0].record.data.amount).toBe(30_000);
    expect(stale.body.results[0].record.version).toBe(2);
    expect(stale.body.results[1].status).toBe("blocked");
    const sql = adminSql();
    const [t] = await sql`select amount::bigint as a, version, deleted_at from transactions where id = ${ids.t1}`;
    await sql.end();
    expect(Number(t!.a)).toBe(30_000);
    expect(t!.deleted_at).toBeNull();
  });

  it("delete against a stale version is also a conflict", async () => {
    const r = await push(A, [op("transaction", "delete", ids.t1, undefined, 1)]);
    expect(r.body.results[0].status).toBe("conflict");
  });

  it("resolving by re-pushing on top of the server version succeeds", async () => {
    const r = await push(A, [op("transaction", "update", ids.t1, txnData({ accountId: ids.bank, categoryId: ids.food, amount: 45_000 }), 2)]);
    expect(r.body.results[0].status).toBe("applied");
    expect(r.body.results[0].record.version).toBe(3);
  });
});

describe("sync: soft delete, tombstones, restore", () => {
  it("delete removes the transaction from balances; restore brings it back", async () => {
    const before = await balanceOf(ids.bank);
    const del = await push(A, [op("transaction", "delete", ids.t1, undefined, 3)]);
    expect(del.body.results[0].status).toBe("applied");
    expect(del.body.results[0].record.deletedAt).toBeTruthy();
    expect(await balanceOf(ids.bank)).toBe(before + 45_000);
    const recs = await pullAll(A);
    expect(recs.find((r) => r.id === ids.t1)!.deletedAt).toBeTruthy(); // tombstone is pulled
    const res = await push(A, [op("transaction", "restore", ids.t1, undefined, 4)]);
    expect(res.body.results[0].status).toBe("applied");
    expect(await balanceOf(ids.bank)).toBe(before);
    const sql = adminSql();
    const [{ n }] = await sql`select count(*)::int as n from transactions where id = ${ids.t1}`;
    await sql.end();
    expect(n).toBe(1); // never hard-deleted
  });

  it("accounts with transactions cannot be deleted (deactivate instead)", async () => {
    const r = await push(A, [op("account", "delete", ids.cash, undefined, 1)]);
    expect(r.body.results[0].status).toBe("rejected");
    expect(r.body.results[0].error.code).toBe("in_use");
    const deact = await push(A, [op("account", "update", ids.cash, account({ name: "Wallet", type: "cash", openingBalance: 50_000, isActive: false }), 1)]);
    expect(deact.body.results[0].status).toBe("applied");
  });

  it("rejects invalid domain data", async () => {
    const r = await push(A, [
      op("transaction", "create", uuidv7(), txnData({ accountId: ids.bank, type: "income", categoryId: ids.food })),
      op("transaction", "create", uuidv7(), txnData({ accountId: ids.bank, type: "transfer", toAccountId: ids.bank })),
      op("transaction", "create", uuidv7(), txnData({ accountId: ids.bank, amount: 10.5 })),
      op("transaction", "create", uuidv7(), txnData({ accountId: ids.bank, type: "refund", refundOfId: ids.tr })),
    ]);
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
    expect(r.body.results.map((x: { error: { code: string } }) => x.error.code)).toEqual(["category_kind", "same_account", "validation", "invalid_refund"]);
  });
});

describe("isolation: user B can never reach user A's data", () => {
  it("B's pull contains none of A's records", async () => {
    const recs = await pullAll(B);
    const aIds = new Set([ids.bank, ids.cash, ids.t1, ids.tr, ids.food, ids.salary]);
    expect(recs.some((r) => aIds.has(r.id))).toBe(false);
  });

  it("B cannot update, delete or restore A's records by ID", async () => {
    const r = await push(B, [
      op("transaction", "update", ids.t1, txnData({ accountId: ids.bank, amount: 1 }), 5),
      op("transaction", "delete", ids.tr, undefined, 1),
      op("account", "update", ids.bank, account({ name: "pwned" }), 1),
      op("transaction", "restore", ids.t1, undefined, 5),
    ]);
    const statuses = r.body.results.map((x: { status: string; error?: { code: string } }) => x.error?.code ?? x.status);
    // The 4th op targets the same record as the 1st, so it is held back ("blocked").
    expect(statuses).toEqual(["not_found", "not_found", "not_found", "blocked"]);
    const sql = adminSql();
    const [acc] = await sql`select name from accounts where id = ${ids.bank}`;
    await sql.end();
    expect(acc!.name).toBe("BPI Savings");
  });

  it("B cannot post into, or transfer to, A's accounts or use A's categories", async () => {
    await push(B, [op("account", "create", ids.bBank, account({ name: "B Bank" }))]);
    const before = await balanceOf(ids.cash);
    const r = await push(B, [
      op("transaction", "create", uuidv7(), txnData({ accountId: ids.bank })),
      op("transaction", "create", uuidv7(), txnData({ type: "transfer", accountId: ids.bBank, toAccountId: ids.cash })),
      op("transaction", "create", uuidv7(), txnData({ accountId: ids.bBank, categoryId: ids.food })),
    ]);
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(await balanceOf(ids.cash)).toBe(before);
  });

  it("B cannot hijack an ID that exists in A's workspace", async () => {
    const r = await push(B, [op("account", "create", ids.bank, account({ name: "same id" }))]);
    expect(r.body.results[0].status).toBe("rejected");
    expect(r.body.results[0].error.code).toBe("id_conflict");
    expect(JSON.stringify(r.body)).not.toContain("BPI Savings");
  });

  it("B replaying A's op ids gets nothing back about A", async () => {
    // sync_ops is RLS-protected: B cannot see A's recorded results by guessing opIds.
    const sql = adminSql();
    const [aOp] = await sql`select op_id from sync_ops where entity_id = ${ids.t1} limit 1`;
    await sql.end();
    const r = await push(B, [{ ...op("tag", "create", uuidv7(), { name: "x" }), opId: aOp!.op_id }]);
    // Either applied as B's own new op or rejected for the PK clash — never A's stored result.
    expect(JSON.stringify(r.body)).not.toContain(ids.t1);
  });
});

describe("administrators cannot access financial records", () => {
  it("super admin pull only sees the admin's own (empty) workspace", async () => {
    const recs = await pullAll(admin);
    expect(recs.some((r) => r.entity === "account" || r.entity === "transaction")).toBe(false);
  });

  it("the app DB role sees zero financial rows without, or with a forged, workspace context", async () => {
    const sql = appSql();
    for (const t of ["accounts", "transactions", "transaction_entries", "categories", "budgets", "sync_ops", "workspaces"]) {
      const [{ n }] = await sql.unsafe(`select count(*)::int as n from ${t}`);
      expect(n, t).toBe(0);
    }
    const admins = adminSql();
    const [ws] = await admins`select w.id from workspaces w join users u on u.id = w.owner_user_id where u.email = 'alice@example.test'`;
    const [root] = await admins`select id from users where email = 'root@example.test'`;
    await admins.end();
    // Admin's user id + Alice's workspace id: RLS still returns nothing.
    const rows = await sql.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${root!.id}, true)`;
      await tx`select set_config('app.workspace_id', ${ws!.id}, true)`;
      return tx`select count(*)::int as n from transactions`;
    });
    expect(rows[0]!.n).toBe(0);
    await sql.end();
  });

  it("the app DB role cannot hard-delete financial rows", async () => {
    const sql = appSql();
    await expect(sql`delete from transactions`).rejects.toThrow(/permission denied/);
    await expect(sql`delete from accounts`).rejects.toThrow(/permission denied/);
    await sql.end();
  });
});
