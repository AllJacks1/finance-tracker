import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import * as pushRoute from "@/app/api/sync/push/route";
import * as subscribeRoute from "@/app/api/push/subscribe/route";
import { runReminders } from "@/server/reminders";
import type { PushPayload } from "@/server/push";
import { adminSql, call, createUserAndLogin, login, resetDatabase, setupAdmin, STRONG, type Handler } from "./helpers";

const h = (f: unknown) => f as Handler;
type Session = { cookie: string };
const op = (entity: string, entityId: string, data: Record<string, unknown>) => ({
  opId: randomUUID(),
  entity,
  entityId,
  kind: "create",
  baseVersion: null,
  data,
  clientCreatedAt: new Date().toISOString(),
});
const push = (s: Session, ops: unknown[]) => call(h(pushRoute.POST), { cookie: s.cookie, body: { ops } });
const account = { name: "BDO", type: "bank", openingBalance: 5_000_000, openingDate: "2026-11-01", color: null, icon: null, description: null, isActive: true, countsAsSpendable: true };
const bill = (accountId: string, name: string, dueDate: string) => ({
  name, kind: "general", categoryId: null, expectedAmount: 250_000, actualAmount: null, minimumAmount: null, dueDate, accountId,
  notes: null, scheduleId: null, occurrenceDate: null, cardAccountId: null, debtId: null, statementClosingDate: null, cancelled: false,
});
const subscribe = (s: Session, endpoint: string) =>
  call(h(subscribeRoute.POST), { cookie: s.cookie, body: { endpoint, keys: { p256dh: "p256dh-key-value-xyz", auth: "auth-key-value" } } });

let A: Session;
let B: Session;
let aId: string;
const NOW = new Date("2026-11-24T02:00:00.000Z"); // 10:00 in Manila
const EP_A = "https://push.example.test/send/alma-device";

beforeAll(async () => {
  await resetDatabase();
  await setupAdmin();
  const admin = await login("root@example.test", STRONG);
  A = await createUserAndLogin(admin.cookie, "alma@example.test");
  B = await createUserAndLogin(admin.cookie, "ben@example.test");
  const accA = uuidv7();
  const accB = uuidv7();
  expect((await push(A, [op("account", accA, account), op("bill", uuidv7(), bill(accA, "Meralco", "2026-11-20"))])).status).toBe(200);
  expect((await push(B, [op("account", accB, account)])).status).toBe(200);
  expect((await subscribe(A, EP_A)).status).toBe(200);
  expect((await subscribe(B, "https://push.example.test/send/ben-device")).status).toBe(200);
  const sql = adminSql();
  [{ id: aId }] = await sql`select id from users where email = 'alma@example.test'`;
  await sql.end();
});

describe("daily push reminders", () => {
  it("only notifies users with something due, with generic text by default", async () => {
    const sent: { userId: string; p: PushPayload }[] = [];
    const r = await runReminders(async (userId, p) => (sent.push({ userId, p }), 1), NOW);
    expect(r).toEqual({ users: 1, pushed: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.userId).toBe(aId); // Ben has nothing due and gets nothing (and never sees Alma's data)
    expect(sent[0]!.p.body).toBe("You have 1 overdue.");
    expect(sent[0]!.p.body).not.toMatch(/Meralco|₱/);
  });

  it("does not repeat a reminder that was already sent", async () => {
    const sent: PushPayload[] = [];
    const r = await runReminders(async (_u, p) => (sent.push(p), 1), NOW);
    expect(r.pushed).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("includes names and amounts only when the user opts in", async () => {
    await push(A, [op("bill", uuidv7(), bill((await firstAccount(A))!, "PLDT", "2026-11-24"))]);
    const sql = adminSql();
    await sql`update workspaces set preferences = jsonb_set(coalesce(preferences, '{}'::jsonb), '{notifications}', '{"pushShowAmounts": true}'::jsonb) where owner_user_id = ${aId}`;
    await sql.end();
    const sent: PushPayload[] = [];
    await runReminders(async (_u, p) => (sent.push(p), 1), NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Due today: PLDT");
    expect(sent[0]!.body).toContain("2,500.00");
    expect(sent[0]!.body).not.toContain("Meralco"); // already sent before
  });

  it("a user cannot unsubscribe someone else's device", async () => {
    const del = await call(h(subscribeRoute.DELETE), { cookie: B.cookie, method: "DELETE", body: { endpoint: EP_A } });
    expect(del.status).toBe(200);
    const sql = adminSql();
    const [{ revoked_at }] = await sql`select revoked_at from push_subscriptions where endpoint = ${EP_A}`;
    await sql.end();
    expect(revoked_at).toBeNull();
  });

  it("rejects non-HTTPS push endpoints", async () => {
    expect((await subscribe(A, "http://push.example.test/x")).status).toBe(400);
  });
});

async function firstAccount(s: Session): Promise<string | undefined> {
  const pull = await import("@/app/api/sync/pull/route");
  const r = await call(h(pull.GET), { cookie: s.cookie, path: "/api/sync/pull?cursor=0&limit=1000" });
  return (r.body.records as { entity: string; id: string }[]).find((x) => x.entity === "account")?.id;
}
