import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";

/**
 * Phase 2 flows on a phone-sized screen: a bill paid in two parts (offline), confirming a
 * recurring salary, credit-card numbers, CSV import duplicate detection, and the calendar.
 * Self-contained: creates the Super Admin if needed and its own user.
 */
const SETUP_TOKEN = "e2e-setup-token-0123456789";
const ADMIN = { email: "root@e2e.test", password: "E2E-Admin-Password-1" };
const ORIGIN = "http://localhost:3200";
const USER = { email: "plan@e2e.test", password: "Ledger-Quiet-River-58" };

const manilaToday = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const TODAY = manilaToday();

async function mockWifi(context: BrowserContext) {
  await context.addInitScript(() => {
    const conn = Object.assign(new EventTarget(), { type: "wifi", saveData: false });
    Object.defineProperty(navigator, "connection", { get: () => conn, configurable: true });
  });
}

async function api(req: APIRequestContext, path: string, body?: unknown, method = body ? "POST" : "GET") {
  const res = await req.fetch(path, { method, data: body, headers: { origin: ORIGIN } });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

const op = (entity: string, entityId: string, data: Record<string, unknown>) => ({
  opId: randomUUID(),
  entity,
  entityId,
  kind: "create",
  baseVersion: null,
  data,
  clientCreatedAt: new Date().toISOString(),
});

const ids = { bank: randomUUID(), card: randomUUID(), bill: randomUUID(), salary: randomUUID() };
const txn = (over: Record<string, unknown>) => ({
  type: "expense", amount: 0, accountId: ids.bank, toAccountId: null, adjustmentDirection: null, categoryId: null,
  occurredAt: `${TODAY}T01:00:00.000Z`, localDate: TODAY, description: null, notes: null, tagIds: [], refundOfId: null, ...over,
});

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser, playwright }) => {
  // Super Admin (if the offline spec hasn't created it already) and a fresh user.
  const anon = await playwright.request.newContext({ baseURL: ORIGIN });
  const setup = await api(anon, "/api/setup");
  if (!setup.body.setupComplete) {
    expect((await api(anon, "/api/setup", { setupToken: SETUP_TOKEN, name: "Root Admin", email: ADMIN.email, password: ADMIN.password })).status).toBe(201);
  }
  expect((await api(anon, "/api/auth/login", { email: ADMIN.email, password: ADMIN.password, installId: randomUUID(), deviceLabel: "e2e" })).status).toBe(200);
  const created = await api(anon, "/api/admin/users", { name: "Paz Planner", email: USER.email, role: "user" });
  expect(created.status).toBe(201);
  await anon.dispose();

  context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mockWifi(context);
  page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(USER.email);
  await page.getByLabel("Password").fill(created.body.tempPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Temporary password").fill(created.body.tempPassword);
  await page.getByLabel("New password", { exact: true }).fill(USER.password);
  await page.getByLabel("Confirm new password").fill(USER.password);
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("button", { name: /Sync status: Synced/ })).toBeVisible({ timeout: 20_000 });

  // Seed through the sync API (as another device of the same user would).
  const seeded = await api(page.request, "/api/sync/push", {
    ops: [
      op("account", ids.bank, { name: "BDO Savings", type: "bank", openingBalance: 5_000_000, openingDate: addDays(TODAY, -40), color: null, icon: null, description: null, isActive: true, countsAsSpendable: true }),
      op("account", ids.card, { name: "BPI Card", type: "credit_card", openingBalance: 0, openingDate: addDays(TODAY, -40), color: null, icon: null, description: null, isActive: true, countsAsSpendable: false }),
      op("cardProfile", randomUUID(), { accountId: ids.card, creditLimit: 5_000_000, statementDay: 10, dueDaysAfterStatement: 20, minPaymentPctBp: 300, minPaymentFloor: 50_000, aprBp: 3600, autoBills: false }),
      op("transaction", randomUUID(), txn({ accountId: ids.card, amount: 500_000, description: "Appliance store" })),
      op("transaction", randomUUID(), txn({ type: "transfer", accountId: ids.bank, toAccountId: ids.card, amount: 200_000, description: "Card payment" })),
      op("bill", ids.bill, { name: "Meralco", kind: "general", categoryId: null, expectedAmount: 300_000, actualAmount: null, minimumAmount: null, dueDate: addDays(TODAY, 3), accountId: ids.bank, notes: null, scheduleId: null, occurrenceDate: null, cardAccountId: null, debtId: null, statementClosingDate: null, cancelled: false }),
      op("schedule", ids.salary, { kind: "transaction", name: "Salary", txnType: "income", amount: 4_000_000, accountId: ids.bank, toAccountId: null, categoryId: null, description: null, notes: null, tagIds: [], rule: { freq: "monthly", interval: 1, startDate: addDays(TODAY, -1), endDate: null, count: null }, pauses: [], status: "active", billKind: null, cardAccountId: null, debtId: null, paysBillScheduleId: null, reminderDays: null, previousScheduleId: null }),
    ],
  });
  expect(seeded.status).toBe(200);
  expect(seeded.body.results.map((r: { status: string }) => r.status)).toEqual(Array(7).fill("applied"));
  await page.reload();
  await expect(page.getByRole("button", { name: /Sync status: Synced/ })).toBeVisible({ timeout: 20_000 });
});

test.afterAll(async () => {
  await context?.close();
});

test("scheduled salary waits for confirmation, then counts once", async () => {
  await expect(page.getByText(/1 scheduled item\(s\)/)).toBeVisible();
  await page.goto("/app/recurring");
  await page.getByRole("button", { name: "Confirm" }).first().click();
  await expect(page.getByText("Confirmed")).toBeVisible();
  await expect(page.getByRole("button", { name: /Sync status: Synced/ })).toBeVisible({ timeout: 20_000 });
  const pull = await api(page.request, "/api/sync/pull?cursor=0&limit=1000");
  const salary = pull.body.records.filter((r: { entity: string; data: { scheduleId?: string } }) => r.entity === "transaction" && r.data.scheduleId === ids.salary);
  expect(salary).toHaveLength(1);
  expect(salary[0].data.amount).toBe(4_000_000);
});

test("a bill paid in two parts while offline, synced on Wi-Fi", async () => {
  await page.goto(`/app/bills/view?id=${ids.bill}`);
  await expect(page.getByText("Upcoming")).toBeVisible();
  await context.setOffline(true);

  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await page.locator("#pa").fill("1,000");
  await page.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText("Partially paid")).toBeVisible();

  await page.getByRole("button", { name: "Pay more" }).click();
  await page.locator("#pa").fill("2000");
  await page.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Pay more" })).toBeDisabled();

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("button", { name: /Sync status: Synced/ })).toBeVisible({ timeout: 20_000 });
  const pull = await api(page.request, "/api/sync/pull?cursor=0&limit=1000");
  const payments = pull.body.records.filter((r: { entity: string; data: { billId?: string } }) => r.entity === "transaction" && r.data.billId === ids.bill);
  expect(payments.map((p: { data: { amount: number } }) => p.data.amount).sort()).toEqual([100_000, 200_000]);
});

test("credit card: purchase is owed, payment reduces it, available credit follows", async () => {
  await page.goto(`/app/cards/view?id=${ids.card}`);
  await expect(page.getByText("₱3,000.00").first()).toBeVisible(); // 5,000 purchase − 2,000 payment
  await expect(page.getByText("₱47,000.00")).toBeVisible(); // 50,000 limit − 3,000
});

test("CSV import: preview, import, then the same file is flagged as already imported", async () => {
  const csv = Buffer.from(`Date,Description,Amount\n${addDays(TODAY, -2)},Grab ride,-250.00\n${addDays(TODAY, -1)},Refund from Shopee,120.50\n`);
  const upload = async () => {
    await page.goto("/app/import");
    await page.locator("#ia").selectOption({ label: "BDO Savings" });
    await page.locator('input[type="file"]').setInputFiles({ name: "bdo.csv", mimeType: "text/csv", buffer: csv });
    await page.getByRole("button", { name: "Preview" }).click();
  };
  await upload();
  await page.getByRole("button", { name: "Import 2 transactions" }).click();
  await expect(page.getByText("Imported 2 transactions")).toBeVisible();
  await expect(page.getByRole("button", { name: /Sync status: Synced/ })).toBeVisible({ timeout: 20_000 });

  await upload();
  await expect(page.getByText("already imported")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Import 0 transactions" })).toBeDisabled();
});

test("calendar shows the confirmed salary and the bill on their days", async () => {
  await page.goto("/app/calendar");
  await page.getByRole("button", { name: `${addDays(TODAY, 3)}, 1 items` }).click();
  await expect(page.getByText("Meralco").first()).toBeVisible();
  await page.getByRole("button", { name: `${addDays(TODAY, -1)}, 1 items` }).click();
  await expect(page.getByText("Salary").first()).toBeVisible();
});
