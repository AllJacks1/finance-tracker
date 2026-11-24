/**
 * Phase 2 offline behaviour, end to end (client store + sync engine + real routes + Postgres):
 *  - the same scheduled occurrence confirmed OFFLINE on two devices becomes ONE transaction
 *  - a bill payment made offline (bill materialization + payment, atomic group) syncs whole
 *  - a group is never half-applied, even if the server rejects one part
 *  - Wi-Fi-only policy still applies to the new modules
 */
import { beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import * as pushRoute from "@/app/api/sync/push/route";
import * as pullRoute from "@/app/api/sync/pull/route";
import { setFetcher } from "@/client/api";
import { importAesKey, newRawKey } from "@/client/crypto";
import { UserDB } from "@/client/local-db";
import { WorkspaceStore } from "@/client/store";
import { SyncEngine } from "@/client/sync-engine";
import { billOccurrenceId, occurrenceTxnId } from "@/lib/domain/ids";
import { TXN_LINKS, type Bill, type Schedule, type Transaction } from "@/lib/domain/types";
import type { ConnectionInfo } from "@/lib/sync/connection-policy";
import { adminSql, createUserAndLogin, login, ORIGIN, resetDatabase, setupAdmin, STRONG } from "./helpers";

type RouteMod = Record<string, (req: Request, ctx: unknown) => Promise<Response>>;
const routes: [string, RouteMod][] = [
  ["/api/sync/push", pushRoute as unknown as RouteMod],
  ["/api/sync/pull", pullRoute as unknown as RouteMod],
];
let cookie = "";
const fetcher = async (path: string, init?: RequestInit) => {
  const entry = routes.find(([p]) => path.startsWith(p))!;
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  headers.set("origin", ORIGIN);
  headers.set("cookie", cookie);
  return entry[1][method]!(new Request(ORIGIN + path, { method, headers, body: init?.body }), {});
};
const conn = { current: { online: true, apiAvailable: true, type: "wifi" } as ConnectionInfo };

async function device() {
  setFetcher(fetcher);
  const db = new UserDB(`ft_p2_${Math.random().toString(36).slice(2)}`);
  await db.open();
  const store = new WorkspaceStore(db, await importAesKey(newRawKey()), "u");
  await store.load();
  const engine = new SyncEngine(store, () => conn.current);
  await engine.start();
  engine.stop();
  return { store, engine };
}

const bank = uuidv7();
const sched: Schedule = {
  id: uuidv7(), kind: "transaction", name: "Salary", txnType: "income", amount: 4_000_000, accountId: bank, toAccountId: null, categoryId: null,
  description: null, notes: null, tagIds: [], rule: { freq: "monthly", interval: 1, startDate: "2026-11-15", endDate: null, count: null },
  pauses: [], status: "active", billKind: null, cardAccountId: null, debtId: null, paysBillScheduleId: null, reminderDays: null, previousScheduleId: null,
};
const billSched: Schedule = { ...sched, id: uuidv7(), kind: "bill", name: "PLDT", txnType: "expense", amount: 169_900, billKind: "general", rule: { ...sched.rule, startDate: "2026-11-05" } };
const confirmTxn = (amount: number): Transaction => ({
  id: occurrenceTxnId(sched.id, "2026-11-15"), type: "income", amount, accountId: bank, toAccountId: null, adjustmentDirection: null, categoryId: null,
  occurredAt: "2026-11-15T04:00:00.000Z", localDate: "2026-11-15", description: "Salary", notes: null, tagIds: [], refundOfId: null,
  ...TXN_LINKS, scheduleId: sched.id, occurrenceDate: "2026-11-15",
});

beforeAll(async () => {
  await resetDatabase();
  await setupAdmin();
  const admin = await login("root@example.test", STRONG);
  cookie = (await createUserAndLogin(admin.cookie, "pia@example.test")).cookie;
  const d = await device();
  await d.store.mutate("account", bank, "create", { id: bank, name: "BPI", type: "bank", openingBalance: 1_000_000, openingDate: "2026-01-01", color: null, icon: null, description: null, isActive: true, countsAsSpendable: true });
  await d.store.mutate("schedule", sched.id, "create", sched);
  await d.store.mutate("schedule", billSched.id, "create", billSched);
  await d.engine.run({ manual: false });
  expect(d.store.getOutboxSummary()).toMatchObject({ pending: 0, failed: 0, conflicts: 0 });
});

describe("Phase 2 offline flows", () => {
  it("confirming the same occurrence offline on two devices creates exactly one transaction", async () => {
    const a = await device();
    const b = await device();
    await a.engine.run({ manual: false });
    await b.engine.run({ manual: false });
    conn.current = { online: false, apiAvailable: true, type: "none" };
    await a.store.mutate("transaction", confirmTxn(4_000_000).id, "create", confirmTxn(4_000_000));
    await b.store.mutate("transaction", confirmTxn(4_000_000).id, "create", confirmTxn(4_000_000));
    conn.current = { online: true, apiAvailable: true, type: "wifi" };
    await a.engine.run({ manual: false });
    await b.engine.run({ manual: false });
    expect(b.engine.getStatus().label).toBe("Synced"); // identical data → duplicate, not a conflict
    const sql = adminSql();
    const [{ n }] = await sql`select count(*)::int as n from transactions where schedule_id = ${sched.id}`;
    await sql.end();
    expect(n).toBe(1);
  });

  it("an offline bill payment (materialize + pay) syncs as one atomic group", async () => {
    const d = await device();
    await d.engine.run({ manual: false });
    conn.current = { online: false, apiAvailable: true, type: "none" };
    const billId = billOccurrenceId(billSched.id, "2026-11-05");
    const bill: Bill = { id: billId, name: "PLDT", kind: "general", categoryId: null, expectedAmount: 169_900, actualAmount: 175_000, minimumAmount: null, dueDate: "2026-11-05", accountId: bank, notes: null, scheduleId: billSched.id, occurrenceDate: "2026-11-05", cardAccountId: null, debtId: null, statementClosingDate: null, cancelled: false };
    const pay: Transaction = { ...confirmTxn(100_000), id: uuidv7(), type: "expense", scheduleId: null, occurrenceDate: null, billId, description: "PLDT" };
    await d.store.mutateGroup([
      { entity: "bill", id: billId, kind: "create", data: bill },
      { entity: "transaction", id: pay.id, kind: "create", data: pay },
    ]);
    await d.engine.run({ manual: false }); // offline: nothing sent
    expect(d.store.getOutboxSummary().pending).toBe(2);
    conn.current = { online: true, apiAvailable: true, type: "cellular" };
    await d.engine.run({ manual: false }); // mobile data: still nothing
    expect(d.store.getOutboxSummary().pending).toBe(2);
    conn.current = { online: true, apiAvailable: true, type: "wifi" };
    await d.engine.run({ manual: false });
    expect(d.store.getOutboxSummary().pending).toBe(0);
    const sql = adminSql();
    const [t] = await sql`select bill_id from transactions where id = ${pay.id}`;
    const [b] = await sql`select actual_amount::int as a from bills where id = ${billId}`;
    await sql.end();
    expect(t!.bill_id).toBe(billId);
    expect(b!.a).toBe(175_000);
  });

  it("if the server rejects one part of a group, nothing from the group is saved", async () => {
    const d = await device();
    await d.engine.run({ manual: false });
    const billId = uuidv7();
    const goodBill: Bill = { id: billId, name: "Water", kind: "general", categoryId: null, expectedAmount: 50_000, actualAmount: null, minimumAmount: null, dueDate: "2026-11-28", accountId: bank, notes: null, scheduleId: null, occurrenceDate: null, cardAccountId: null, debtId: null, statementClosingDate: null, cancelled: false };
    const badPay: Transaction = { ...confirmTxn(50_000), id: uuidv7(), type: "expense", scheduleId: null, occurrenceDate: null, billId, accountId: uuidv7() }; // unknown account
    await d.store.mutateGroup([
      { entity: "bill", id: billId, kind: "create", data: goodBill },
      { entity: "transaction", id: badPay.id, kind: "create", data: badPay },
    ]);
    await d.engine.run({ manual: false });
    expect(d.store.getOutboxSummary().failed).toBe(2);
    const sql = adminSql();
    const rows = await sql`select id from bills where id = ${billId}`;
    await sql.end();
    expect(rows).toHaveLength(0);
    // Discarding one part discards the whole group locally.
    await d.store.discardLocal(badPay.id);
    expect(d.store.getOutboxSummary().failed).toBe(0);
    expect(d.store.get("bill", billId)).toBeUndefined();
  });
});
