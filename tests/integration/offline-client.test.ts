/**
 * End-to-end tests of the OFFLINE CLIENT (encrypted IndexedDB store, outbox, sync engine,
 * connection policy, vault/PIN) against the real server route handlers and Postgres.
 * IndexedDB is provided by fake-indexeddb.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import * as pushRoute from "@/app/api/sync/push/route";
import * as pullRoute from "@/app/api/sync/pull/route";
import * as meRoute from "@/app/api/auth/me/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as logoutRoute from "@/app/api/auth/logout/route";
import * as deviceKeyRoute from "@/app/api/auth/device-key/route";
import { setFetcher } from "@/client/api";
import { importAesKey, newRawKey, PIN_MAX_FAILURES } from "@/client/crypto";
import { UserDB } from "@/client/local-db";
import { WorkspaceStore } from "@/client/store";
import { SyncEngine } from "@/client/sync-engine";
import type { ConnectionInfo } from "@/lib/sync/connection-policy";
import { TXN_LINKS, type Account, type Transaction } from "@/lib/domain/types";
import { adminSql, createUserAndLogin, login, ORIGIN, resetDatabase, setupAdmin, STRONG } from "./helpers";

type RouteMod = Record<string, (req: Request, ctx: unknown) => Promise<Response>>;
const routes: [string, RouteMod][] = [
  ["/api/sync/push", pushRoute as unknown as RouteMod],
  ["/api/sync/pull", pullRoute as unknown as RouteMod],
  ["/api/auth/me", meRoute as unknown as RouteMod],
  ["/api/auth/login", loginRoute as unknown as RouteMod],
  ["/api/auth/logout", logoutRoute as unknown as RouteMod],
  ["/api/auth/device-key", deviceKeyRoute as unknown as RouteMod],
];

/** A fake browser: routes fetches to handlers, keeps a cookie jar, can drop responses. */
class FakeBrowser {
  cookie: string | null = null;
  calls: string[] = [];
  /** If set, the request reaches the server but the response is "lost" (network error). */
  dropNextResponse = false;
  fetcher = async (path: string, init?: RequestInit) => {
    this.calls.push(path.split("?")[0]!);
    const entry = routes.find(([p]) => path.startsWith(p));
    if (!entry) throw new TypeError("not found");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    headers.set("origin", ORIGIN);
    headers.set("x-forwarded-for", "10.9.9.9");
    if (this.cookie) headers.set("cookie", this.cookie);
    const res = await entry[1][method]!(new Request(ORIGIN + path, { method, headers, body: init?.body }), {});
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!;
    if (this.dropNextResponse) {
      this.dropNextResponse = false;
      throw new TypeError("Failed to fetch");
    }
    return res;
  };
}

const conn = { current: { online: true, apiAvailable: true, type: "wifi" } as ConnectionInfo };
const WIFI: ConnectionInfo = { online: true, apiAvailable: true, type: "wifi" };
const CELL: ConnectionInfo = { online: true, apiAvailable: true, type: "cellular" };
const UNKNOWN: ConnectionInfo = { online: true, apiAvailable: false };
const OFFLINE: ConnectionInfo = { online: false, apiAvailable: true, type: "none" };

let dbCounter = 0;
async function openClient(browser: FakeBrowser, dbName?: string, rawKey?: Uint8Array) {
  setFetcher(browser.fetcher);
  const name = dbName ?? `ft_test_${++dbCounter}_${Date.now()}`;
  const raw = rawKey ?? newRawKey();
  const db = new UserDB(name);
  await db.open();
  const store = new WorkspaceStore(db, await importAesKey(raw), "u");
  await store.load();
  const engine = new SyncEngine(store, () => conn.current);
  await engine.start();
  engine.stop(); // no timers in tests; we call run() explicitly
  return { db, store, engine, name, raw };
}

const account = (id: string, over: Partial<Account> = {}): Account => ({
  id,
  name: "GCash",
  type: "ewallet",
  openingBalance: 500_000,
  openingDate: "2026-11-01",
  color: null,
  icon: null,
  description: null,
  isActive: true,
  countsAsSpendable: true,
  ...over,
});
const txn = (id: string, accountId: string, over: Partial<Transaction> = {}): Transaction => ({
  id,
  type: "expense",
  amount: 15_000,
  accountId,
  toAccountId: null,
  adjustmentDirection: null,
  categoryId: null,
  occurredAt: "2026-11-22T03:00:00.000Z",
  localDate: "2026-11-22",
  description: "Jeepney + lunch",
  notes: null,
  tagIds: [],
  refundOfId: null,
  ...TXN_LINKS,
  ...over,
});

async function serverCount(table: string, id: string) {
  const sql = adminSql();
  const [{ n }] = await sql.unsafe(`select count(*)::int as n from ${table} where id = $1`, [id]);
  await sql.end();
  return n as number;
}

let userEmail = "";
let userPassword = "";
let browser: FakeBrowser;

beforeAll(async () => {
  await resetDatabase();
  await setupAdmin();
  const admin = await login("root@example.test", STRONG);
  const u = await createUserAndLogin(admin.cookie, "olive@example.test");
  userEmail = "olive@example.test";
  userPassword = u.password;
  browser = new FakeBrowser();
  browser.cookie = u.cookie;
});

beforeEach(() => {
  conn.current = WIFI;
  browser.calls = [];
});

describe("offline-first client", () => {
  it("creates and edits data offline; nothing is sent; data survives an app restart", async () => {
    conn.current = OFFLINE;
    const c = await openClient(browser);
    const acc = uuidv7();
    const t = uuidv7();
    await c.store.mutate("account", acc, "create", account(acc));
    await c.store.mutate("transaction", t, "create", txn(t, acc));
    await c.store.mutate("transaction", t, "update", txn(t, acc, { amount: 20_000 }));
    await c.engine.run({ manual: false });
    await c.engine.run({ manual: true }); // even manual does nothing while offline
    expect(browser.calls).toEqual([]);

    // Coalesced: create+update of an unsynced record is a single create.
    expect(c.store.getOutboxSummary().pending).toBe(2);
    // Stored encrypted: no plaintext description in IndexedDB.
    const raw = JSON.stringify(await c.db.records.toArray(), (_k, v) => (v instanceof Uint8Array ? Array.from(v) : v));
    expect(raw).not.toContain("Jeepney");

    // "Close" the app and reopen with the same database and key.
    c.store.close();
    c.db.close();
    const again = await openClient(browser, c.name, c.raw);
    expect(again.store.get("transaction", t)!.data.amount).toBe(20_000);
    expect(again.store.getOutboxSummary().pending).toBe(2);

    // A wrong key cannot read the data.
    const wrong = new WorkspaceStore(again.db, await importAesKey(newRawKey()), "u");
    await expect(wrong.load()).rejects.toThrow();
    wrong.close();

    // Back on Wi-Fi: automatic sync pushes and the server has exactly what we did offline.
    conn.current = WIFI;
    await again.engine.run({ manual: false });
    expect(browser.calls).toContain("/api/sync/push");
    expect(again.engine.getStatus().label).toBe("Synced");
    const sql = adminSql();
    const [row] = await sql`select amount::bigint as a from transactions where id = ${t}`;
    await sql.end();
    expect(Number(row!.a)).toBe(20_000);
    again.store.close();
    again.db.close();
  });

  it("never syncs automatically on mobile data or an unknown connection", async () => {
    const c = await openClient(browser);
    const acc = uuidv7();
    await c.store.mutate("account", acc, "create", account(acc));

    conn.current = CELL;
    await c.engine.run({ manual: false });
    expect(c.engine.getStatus().label).toBe("Paused – Mobile data");
    conn.current = UNKNOWN;
    await c.engine.run({ manual: false });
    expect(c.engine.getStatus().label).toBe("Paused – Connection unknown");
    conn.current = { online: true, apiAvailable: true, type: "wifi", saveData: true };
    await c.engine.run({ manual: false });
    expect(browser.calls).toEqual([]);
    expect(await serverCount("accounts", acc)).toBe(0);

    // Explicit manual sync (after the UI's data-charges confirmation) does sync.
    conn.current = UNKNOWN;
    await c.engine.run({ manual: true });
    expect(await serverCount("accounts", acc)).toBe(1);
    c.store.close();
    c.db.close();
  });

  it("stops between batches if the connection switches from Wi-Fi to mobile data", async () => {
    const c = await openClient(browser);
    for (let i = 0; i < 60; i++) {
      const id = uuidv7();
      await c.store.mutate("tag", id, "create", { id, name: `tag ${i}` });
    }
    // Switch to cellular as soon as the first push request is made.
    const original = browser.fetcher;
    const switching = async (p: string, i?: RequestInit) => {
      const r = await original(p, i);
      conn.current = CELL;
      return r;
    };
    setFetcher(switching);
    await c.engine.run({ manual: false });
    setFetcher(browser.fetcher);
    expect(c.store.getOutboxSummary().pending).toBe(10); // 50 sent in batch 1, 10 left
    conn.current = WIFI;
    await c.engine.run({ manual: false });
    expect(c.store.getOutboxSummary().pending).toBe(0);
    c.store.close();
    c.db.close();
  });

  it("recovers from an interrupted sync without duplicates", async () => {
    const c = await openClient(browser);
    const acc = uuidv7();
    const t = uuidv7();
    await c.store.mutate("account", acc, "create", account(acc));
    await c.store.mutate("transaction", t, "create", txn(t, acc));
    browser.dropNextResponse = true; // server commits, client never hears back
    await c.engine.run({ manual: false });
    expect(c.engine.getStatus().phase).toBe("error");
    expect(c.store.getOutboxSummary().pending).toBe(2);
    expect(await serverCount("transactions", t)).toBe(1);

    // Simulate the app being killed mid-sync: reopen; "inflight" ops return to pending.
    c.store.close();
    c.db.close();
    const again = await openClient(browser, c.name, c.raw);
    await again.engine.run({ manual: true });
    expect(again.store.getOutboxSummary().pending).toBe(0);
    expect(again.store.get("transaction", t)!.version).toBe(1);
    expect(await serverCount("transactions", t)).toBe(1);
    again.store.close();
    again.db.close();
  });

  it("detects conflicts between two devices and lets the user choose", async () => {
    // Device 1 creates and syncs.
    const d1 = await openClient(browser);
    const acc = uuidv7();
    const t = uuidv7();
    await d1.store.mutate("account", acc, "create", account(acc));
    await d1.store.mutate("transaction", t, "create", txn(t, acc));
    await d1.engine.run({ manual: false });

    // Device 2 (separate local DB) pulls the same data.
    const d2 = await openClient(browser);
    await d2.engine.run({ manual: false });
    expect(d2.store.get("transaction", t)!.version).toBe(1);

    // Both edit offline.
    await d1.store.mutate("transaction", t, "update", txn(t, acc, { amount: 11_111 }));
    await d2.store.mutate("transaction", t, "update", txn(t, acc, { amount: 22_222 }));
    await d1.engine.run({ manual: false });
    await d2.engine.run({ manual: false });

    expect(d2.engine.getStatus().label).toBe("Conflict detected");
    const [conflict] = d2.store.getConflicts();
    expect(conflict!.server.data.amount).toBe(11_111);
    expect((conflict!.local.data as { amount: number }).amount).toBe(22_222);
    // Server still has device 1's value: nothing was silently overwritten.
    const sql = adminSql();
    let [row] = await sql`select amount::bigint as a from transactions where id = ${t}`;
    expect(Number(row!.a)).toBe(11_111);

    // User keeps their version explicitly.
    await d2.store.resolveConflict(t, "mine");
    await d2.engine.run({ manual: false });
    [row] = await sql`select amount::bigint as a, version from transactions where id = ${t}`;
    await sql.end();
    expect(Number(row!.a)).toBe(22_222);
    expect(row!.version).toBe(3);
    expect(d2.engine.getStatus().label).toBe("Synced");

    // Device 1 picks up the resolution.
    await d1.engine.run({ manual: false });
    expect(d1.store.get("transaction", t)!.data.amount).toBe(22_222);
    d1.store.close();
    d2.store.close();
  });

  it("soft-deletes offline and the tombstone syncs to other devices; restore works", async () => {
    const d1 = await openClient(browser);
    const d2 = await openClient(browser);
    await d2.engine.run({ manual: false });
    const someTxn = d2.store.list("transaction")[0]!;
    await d2.store.mutate("transaction", someTxn.id, "delete");
    await d2.engine.run({ manual: false });
    await d1.engine.run({ manual: false });
    expect(d1.store.get("transaction", someTxn.id)!.deletedAt).toBeTruthy();
    expect(d1.store.list("transaction").some((r) => r.id === someTxn.id)).toBe(false);
    await d1.store.mutate("transaction", someTxn.id, "restore");
    await d1.engine.run({ manual: false });
    await d2.engine.run({ manual: false });
    expect(d2.store.get("transaction", someTxn.id)!.deletedAt).toBeNull();
    d1.store.close();
    d2.store.close();
  });

  it("server rejections are shown as Failed and can be discarded", async () => {
    const c = await openClient(browser);
    const t = uuidv7();
    await c.store.mutate("transaction", t, "create", txn(t, uuidv7())); // unknown account
    await c.engine.run({ manual: false });
    expect(c.engine.getStatus().label).toBe("Failed");
    expect(c.store.get("transaction", t)!.failed).toBeTruthy();
    await c.store.discardLocal(t);
    expect(c.store.get("transaction", t)).toBeUndefined();
    expect(c.store.getOutboxSummary().failed).toBe(0);
    c.store.close();
  });
});

describe("vault: online login, PIN, lockout, lock", () => {
  it("full PIN lifecycle", async () => {
    const { vault } = await import("@/client/vault");
    const b = new FakeBrowser();
    setFetcher(b.fetcher);
    vault.readConnection = () => conn.current;
    await vault.login(userEmail, userPassword);
    expect(vault.getState().phase).toBe("unlocked");
    await vault.engine!.run({ manual: true });
    expect(vault.store!.list("category").length).toBeGreaterThan(5);

    expect((await vault.setPin("123456")).error).toMatch(/sequence/);
    expect((await vault.setPin("482915")).ok).toBe(true);
    expect(vault.getState().hasPin).toBe(true);

    // Lock wipes decrypted data from memory.
    const storeRef = vault.store!;
    vault.lock();
    expect(vault.getState().phase).toBe("locked");
    expect(vault.store).toBeNull();
    expect(storeRef.list("category")).toHaveLength(0);

    // With a PIN set, the session cookie alone cannot fetch the key.
    const r = await b.fetcher("/api/auth/device-key", { method: "POST", body: "{}" });
    expect(r.status).toBe(403);

    expect((await vault.unlockWithPin("000001")).ok).toBe(false);
    expect(vault.getState().pinFailures).toBe(1);
    expect((await vault.unlockWithPin("482915")).ok).toBe(true);
    expect(vault.getState().phase).toBe("unlocked");
    expect(vault.store!.list("category").length).toBeGreaterThan(5);

    // Lockout escalates; after PIN_MAX_FAILURES the PIN wrap is erased.
    vault.lock();
    const userDb = new UserDB((await import("@/client/local-db")).UserDB.name && (vault as unknown as { db: UserDB }).db.name);
    await userDb.open();
    let last = "";
    for (let i = 0; i < PIN_MAX_FAILURES; i++) {
      await userDb.meta.put({ key: "pinLockedUntil", value: 0 }); // skip waiting in tests
      last = (await vault.unlockWithPin("999990")).error ?? "";
      if (i === 4) expect(vault.getState().pinLockedUntil).toBeGreaterThan(Date.now());
    }
    expect(last).toMatch(/Sign in online/);
    expect(vault.getState().phase).toBe("signed_out");
    expect(vault.getState().hasPin).toBe(false);
    // Correct PIN no longer works.
    expect((await vault.unlockWithPin("482915")).ok).toBe(false);
    userDb.close();
    await vault.logout({ removeLocalData: true });
  });
});
