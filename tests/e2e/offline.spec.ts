import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const SETUP_TOKEN = "e2e-setup-token-0123456789";
const ADMIN = { email: "root@e2e.test", password: "E2E-Admin-Password-1" };
const PIN = "482915";

/**
 * Fake Network Information API so we can be "on Wi-Fi" or "on mobile data" in a desktop engine.
 * `type: null` removes the API entirely (like iOS Safari).
 */
async function mockConnection(context: BrowserContext, type: string | null) {
  await context.addInitScript((t) => {
    const w = window as unknown as { __conn?: EventTarget & { type?: string; saveData?: boolean } };
    if (t === null) {
      Object.defineProperty(navigator, "connection", { get: () => undefined, configurable: true });
      return;
    }
    const conn = Object.assign(new EventTarget(), { type: t, saveData: false });
    w.__conn = conn;
    Object.defineProperty(navigator, "connection", { get: () => conn, configurable: true });
  }, type);
}

async function setConnection(page: Page, type: string) {
  await page.evaluate((t) => {
    const c = (window as unknown as { __conn: EventTarget & { type: string } }).__conn;
    c.type = t;
    c.dispatchEvent(new Event("change"));
  }, type);
}

async function api(page: Page, path: string, body?: unknown, method = body ? "POST" : "GET") {
  const res = await page.request.fetch(path, {
    method,
    data: body,
    headers: { origin: "http://localhost:3200" },
  });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

test.describe.configure({ mode: "serial" });

const userEmail = "maria@e2e.test";
let userPassword = "Ledger-Strong-Pass-77";

test("first-time setup creates the Super Admin exactly once; setup then disappears", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel("Setup token").fill(SETUP_TOKEN);
  await page.getByLabel("Your name").fill("Root Admin");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page.getByLabel("Confirm password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Create Super Admin" }).click();
  await expect(page).toHaveURL(/\/login\?setup=1/);
  const again = await page.goto("/setup");
  expect(again?.status()).toBe(404);
});

test("admin creates a user; admin area shows no financial data", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);
  const created = await api(page, "/api/admin/users", { name: "Maria Santos", email: userEmail, role: "user" });
  expect(created.status).toBe(201);
  // First login uses the temporary password.
  userPassword = created.body.tempPassword;
  await page.goto("/admin/users");
  await expect(page.getByText(userEmail)).toBeVisible();
  // A regular user's financial API is unreachable for the admin's session for OTHER users by design;
  // the admin's own pull contains no records from anyone else.
  const pull = await api(page, "/api/sync/pull?cursor=0");
  expect(pull.body.records.filter((r: { entity: string }) => r.entity === "account")).toHaveLength(0);
});

test("installable PWA: manifest, icons and an active service worker", async ({ page }) => {
  await page.goto("/login");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBe("/manifest.webmanifest");
  const manifest = await (await page.request.get(href!)).json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/app");
  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).status()).toBe(200);
  expect(manifest.icons.some((i: { purpose: string }) => i.purpose === "maskable")).toBe(true);
  const sw = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL);
  expect(sw).toContain("/sw.js");
});

test("offline-first: PIN unlock, offline create/edit, restart, Wi-Fi-only sync", async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: "allow", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mockConnection(context, "wifi");
  const page = await context.newPage();

  // First sign-in with the temporary password, then choose a real one.
  await page.goto("/login");
  await page.getByLabel("Email").fill(userEmail);
  await page.getByLabel("Password").fill(userPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/change-password/);
  const newPassword = "Ledger-Strong-Pass-77";
  await page.getByLabel("Temporary password").fill(userPassword);
  await page.getByLabel("New password", { exact: true }).fill(newPassword);
  await page.getByLabel("Confirm new password").fill(newPassword);
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page).toHaveURL(/\/app$/);
  userPassword = newPassword;

  // On (mocked) Wi-Fi the first sync runs automatically and downloads default categories.
  await expect(page.getByRole("button", { name: /Sync status: Synced/ })).toBeVisible({ timeout: 20_000 });

  // Create an account.
  await page.goto("/app/accounts?new=1");
  await page.locator("#atype").selectOption("ewallet");
  await page.locator("#aname").fill("GCash");
  await page.locator("#aopen").fill("5,250.75");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("₱5,250.75").first()).toBeVisible();

  // Set an offline PIN.
  await page.goto("/app/security");
  await page.getByRole("button", { name: "Set up offline PIN" }).click();
  await page.locator("#p1").fill(PIN);
  await page.locator("#p2").fill(PIN);
  await page.getByRole("button", { name: "Save PIN" }).click();
  await expect(page.getByText("PIN is set on this device")).toBeVisible();

  // Make sure the service worker controls the page, so the shell is available offline.
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.goto("/app");
  await expect(page.getByLabel("PIN")).toBeVisible(); // PIN set => locked on reload, even online
  await page.getByLabel("PIN").fill(PIN);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Safe to spend")).toBeVisible();
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  // ---- Go offline and "restart" the app.
  await context.setOffline(true);
  await page.goto("/app");
  await expect(page.getByLabel("PIN")).toBeVisible();
  await page.getByLabel("PIN").fill("000001");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Incorrect PIN.")).toBeVisible();
  await page.getByLabel("PIN").fill(PIN);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("₱5,250.75").first()).toBeVisible();

  // Create a transaction offline.
  await page.getByRole("button", { name: "Quick add transaction" }).click();
  await page.locator("#amount").fill("250.50");
  await page.locator("#cat").selectOption({ label: "Food" });
  await page.locator("#desc").fill("Jollibee lunch");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Jollibee lunch")).toBeVisible();
  await expect(page.getByText("not synced")).toBeVisible();

  // Edit it offline.
  await page.getByText("Jollibee lunch").click();
  await page.locator("#amount").fill("300");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("₱4,950.75").first()).toBeVisible();

  // Close and reopen (still offline): the pending change survives.
  await page.close();
  const page2 = await context.newPage();
  await page2.goto("/app");
  await page2.getByLabel("PIN").fill(PIN);
  await page2.getByRole("button", { name: "Unlock" }).click();
  await expect(page2.getByText("Jollibee lunch")).toBeVisible();
  await expect(page2.getByText("not synced")).toBeVisible();

  // ---- Back online but on MOBILE DATA: nothing syncs automatically.
  await setConnection(page2, "cellular");
  await context.setOffline(false);
  await page2.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page2.getByRole("button", { name: /Paused – Mobile data/ })).toBeVisible();
  await page2.waitForTimeout(3000);
  let pull = await api(page2, "/api/sync/pull?cursor=0");
  expect(pull.body.records.some((r: { entity: string; data: { description?: string } }) => r.entity === "transaction")).toBe(false);

  // ---- Wi-Fi positively identified: automatic sync.
  await setConnection(page2, "wifi");
  await expect(page2.getByRole("button", { name: /Sync status: Synced/ })).toBeVisible({ timeout: 20_000 });
  pull = await api(page2, "/api/sync/pull?cursor=0");
  const txn = pull.body.records.find((r: { entity: string }) => r.entity === "transaction");
  expect(txn.data.description).toBe("Jollibee lunch");
  expect(txn.data.amount).toBe(30_000);
  await context.close();
});

test("unknown connection type (iOS-like) pauses sync; manual sync warns about data charges", async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await mockConnection(context, null);
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(userEmail);
  await page.getByLabel("Password").fill(userPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("button", { name: /Paused – Connection unknown/ })).toBeVisible();
  await expect(page.getByText("hasn't been downloaded")).toBeVisible();
  await page.getByRole("button", { name: "Download" }).click();
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText("Syncing may use mobile data, and data charges may apply.")).toBeVisible();
  await page.getByRole("button", { name: "Sync anyway" }).click();
  await expect(page.getByText("Everything is synced.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Jollibee lunch")).toBeVisible();
  await context.close();
});

test("another user on the same browser cannot see the first user's data", async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await mockConnection(context, "wifi");
  const page = await context.newPage();
  // Admin creates a second user.
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app$/);
  const created = await api(page, "/api/admin/users", { name: "Jun Cruz", email: "jun@e2e.test", role: "user" });
  await api(page, "/api/auth/logout", {});
  // Maria signs in here first (her encrypted data lands in this browser), then signs out keeping data.
  await page.goto("/login?resume=1");
  await page.getByLabel("Email").fill(userEmail);
  await page.getByLabel("Password").fill(userPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Jollibee lunch")).toBeVisible({ timeout: 20_000 });
  await page.goto("/app/more");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: "Sign out, keep encrypted data" }).click();
  await expect(page).toHaveURL(/\/login/);
  // Jun signs in on the same browser.
  await page.getByLabel("Email").fill("jun@e2e.test");
  await page.getByLabel("Password").fill(created.body.tempPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Temporary password").fill(created.body.tempPassword);
  await page.getByLabel("New password", { exact: true }).fill("Jun-Strong-Password-9");
  await page.getByLabel("Confirm new password").fill("Jun-Strong-Password-9");
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByText("Add your first account")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Jollibee lunch")).toHaveCount(0);
  await expect(page.getByText("GCash", { exact: true })).toHaveCount(0);
  // Maria's local database is still present but encrypted with her key; Jun's session can't read it.
  const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).filter((n) => n?.startsWith("ft_u_")));
  expect(dbs.length).toBe(3); // admin, Maria and Jun each have their own encrypted database
  await context.close();
});
