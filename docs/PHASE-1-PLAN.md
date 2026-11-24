# Phase 1 Implementation Plan — Core Finance Tracker and Infrastructure

Status: **Draft, waiting for approval.** No application code has been written yet.

---

## 0. What exists today

| Item | Finding |
|---|---|
| Repository | Empty. `main` has no commits; remote is `github.com/AllJacks1/finance-tracker`. Greenfield build, so nothing existing can break. |
| Local tooling | Node 26.12, npm 11.20, PostgreSQL 18 running locally as a Windows service, Railway CLI 5.75. |
| Not installed | Docker, `gh` CLI, pnpm. None of them are required. I'll use npm, and tests will run against the local Postgres 18. |
| Database schema / auth / deploy setup | None yet. Everything below is new. |

Because the repo is empty, Phase 1 has **no destructive migrations**. From the first migration onward, migrations stay additive. Any later migration that drops or rewrites data will be called out and needs approval first.

---

## 1. Key architecture decisions (summary)

| # | Decision | Why |
|---|---|---|
| D1 | **Next.js (App Router) as one deployable app**: static client shell for the finance UI, plus route handlers for auth, sync, and admin. | One service to deploy on Railway, no separate API server. |
| D2 | **Drizzle ORM + drizzle-kit SQL migrations** (version-controlled `.sql` files). | Explicit SQL, real transactions and row locks, typed queries, no heavy runtime. Raw SQL is easy to add for RLS, roles, and grants. |
| D3 | **Custom session auth** (opaque random token, stored as a SHA-256 hash in the DB, sent in an `httpOnly; Secure; SameSite=Lax` cookie), **Argon2id** via `@node-rs/argon2`. | No public signup, admin-created users, device revocation, and PIN-reset flows don't fit off-the-shelf auth libraries well. The code is small and fully auditable. |
| D4 | **Ledger model**: a `transactions` header plus signed `transaction_entries` lines. Balances are **derived** (opening balance + sum of entries) rather than stored. | A transfer is one transaction with two entries, written atomically. Delete and restore recompute automatically, so there's no drift between a cached balance and history. It also extends to splits and debts in Phase 2. |
| D5 | **Integer centavos everywhere**: `bigint` in Postgres; JS `number` with safe-integer guards; string-based parsing (never `parseFloat × 100`). | Required. One `money.ts` module owns all parsing, formatting, and arithmetic. |
| D6 | **One shared `finance-core` TypeScript module** (pure functions) used by both the server and the offline client. | Balances, budgets, and Safe-to-Spend come out identical online and offline, with one place to test them. |
| D7 | **Single write path for financial data: local store → outbox → `/api/sync`.** No separate REST CRUD for finance. | Online and offline behave the same way, and there's one code path to secure and test. |
| D8 | **Postgres Row-Level Security as defense in depth**, plus a restricted `ft_app` DB role with **no `DELETE` grant on financial tables**. | Even if an app-layer check were missed, admin requests (which have no workspace context) get zero financial rows. The database itself enforces soft deletion. |
| D9 | **Composite foreign keys `(workspace_id, id)`** for every cross-table reference. | The database rejects a transfer into another user's account even if someone tampers with the IDs. |
| D10 | **Local data encrypted in IndexedDB** with a per-user, per-device data key, wrapped by the PIN and by a server-held recovery key (§10.3). | Needed so that users sharing one device can't read each other's data, and for PIN reset and device revocation. |
| D11 | **Automatic sync only when `navigator.connection.type` is `wifi` (or `ethernet`, see open decision Q5).** Everything else, including "API not available", counts as ineligible. | Implements the strict Wi-Fi-only rule (§10.5). |
| D12 | **S3-compatible object storage** (provider chosen in Q2) for receipts and backups. Backups are **encrypted with an `age` public key before upload**; the private key stays offline with you. | Backups stay confidential even if the storage provider's encryption is unverified, and the server can write backups but never read them. |
| D13 | **Every user (including admins) has exactly one private workspace.** Admin rights never reach anyone else's workspace. | See open decision Q1. |

---

## 2. Architecture overview

```
 Phone / Desktop browser (installed PWA)
 ┌──────────────────────────────────────────────────────────────┐
 │  React UI (shadcn/ui, Tailwind, Lucide)                      │
 │     │ reads / writes                                         │
 │  In-memory store (decrypted, only while unlocked)            │
 │     │                         ▲                              │
 │  finance-core (pure TS: money, balances, budgets, STS)       │
 │     │ encrypt/decrypt (AES-GCM, DEK)                         │
 │  IndexedDB (Dexie): one DB per user                          │
 │    entities* │ outbox* │ conflicts* │ sync_meta │ key_wraps  │
 │     │                                    (* = encrypted)     │
 │  Sync engine ── gated by ConnectionPolicy (wifi only)        │
 │  Service worker: app shell precache ONLY (never API data)    │
 └─────│────────────────────────────────────────────────────────┘
       │ HTTPS (TLS by Railway edge)
 ┌─────▼────────────────────────────────────────────────────────┐
 │ Railway service: web (Next.js standalone)                     │
 │   /setup  /login  /admin/*  (server-rendered, online only)    │
 │   /api/auth/*   /api/sync/push   /api/sync/pull               │
 │   /api/admin/*  /api/receipts/*  /api/devices/*               │
 │   authz layer: session → user → (workspace | admin perms)     │
 └─────│───────────────────────────────│────────────────────────┘
       │ ft_app role (RLS enforced)    │ S3 API
 ┌─────▼──────────────┐   ┌────────────▼─────────────┐
 │ Railway PostgreSQL │   │ Object storage (S3-compat)│
 └─────▲──────────────┘   │  receipts/  backups/      │
       │ owner role       └────────────▲─────────────┘
 ┌─────┴──────────────────────────────┴─────┐
 │ Railway cron service: backup              │
 │  pg_dump → age-encrypt → upload → record  │
 └───────────────────────────────────────────┘
```

**Rendering split.** Finance pages (`/app/*`) are statically generated client shells with no server data, so the service worker can serve them offline. All financial data comes from the local store. Admin and setup pages are server-rendered and online-only.

---

## 3. Technology and libraries

| Concern | Choice |
|---|---|
| Framework | Next.js latest stable (App Router), `output: "standalone"`, TypeScript `strict` |
| UI | Tailwind CSS, shadcn/ui, Lucide icons, Vaul drawer (bottom sheets), Sonner (toasts) |
| Forms / validation | react-hook-form + zod (the same zod schemas validate on the client and the server) |
| DB | PostgreSQL, Drizzle ORM, drizzle-kit migrations, `postgres` driver |
| Password hashing | Argon2id (`@node-rs/argon2`; OWASP params m=19 MiB, t=2, p=1 or stronger) |
| Local DB | Dexie (IndexedDB) |
| Client crypto | WebCrypto AES-256-GCM; Argon2id for the PIN KDF via WASM (`hash-wasm`) |
| Service worker | Serwist (`@serwist/next`). If it isn't compatible with the current Next.js bundler, fall back to a small hand-written SW plus a build-time precache manifest. I'll check this at scaffold time. |
| Object storage | `@aws-sdk/client-s3` (works with any S3-compatible provider) |
| Backups | `pg_dump` (client version ≥ server) + `age` encryption, run in a Railway cron service |
| Tests | Vitest (unit + integration against real Postgres), Playwright (E2E, offline, mobile emulation) |
| Lint / format | ESLint + Prettier |

Exact versions get pinned in `package.json` at scaffold time, with Node pinned via `engines`.

---

## 4. Data model (initial migration set)

All IDs are **UUIDv7, generated on the client** for synced entities, so records can be created offline. Every synced table has:
`id, workspace_id, version int, change_seq bigint, created_at, updated_at, deleted_at (tombstone), created_by_device_id, updated_by_device_id`.

### Identity and administration
| Table | Key columns / notes |
|---|---|
| `users` | email (citext, unique), name, password_hash, role `super_admin \| manager \| user`, status `active \| deactivated`, must_change_password, failed_login_count, locked_until |
| `admin_permission_grants` | user_id, permission. Only used for Managers; Super Admin has every admin permission implicitly. |
| `sessions` | id = sha256(token), user_id, device_id, created_at, last_seen_at, idle/absolute expiry, revoked_at |
| `devices` | user_id, label, user_agent, offline_enabled, recovery_key_enc (encrypted with `APP_ENCRYPTION_KEY`), last_sync_at, revoked_at |
| `system_setup` | singleton row (`id boolean PK CHECK (id)`): completed_at, completed_by. Its existence means setup is done. |
| `system_settings` | key/value (default timezone, session lifetimes, etc.) |
| `audit_logs` | actor_user_id, action, target_user_id, metadata jsonb (**never financial data**), ip, user_agent, created_at. The app role can only `INSERT` and `SELECT`. |
| `rate_limits` | Postgres-backed counters for login, setup, and PIN reset (works across multiple replicas) |

### Financial workspace (all have `workspace_id`, RLS-protected)
| Table | Key columns / notes |
|---|---|
| `workspaces` | owner_user_id (unique, so one workspace per user), currency `PHP`, timezone `Asia/Manila`, week_start, change_counter |
| `accounts` | name, type `cash \| bank \| ewallet \| savings \| credit_card \| loan \| other`, class `asset \| liability`, opening_balance_centavos, opening_date, color, icon, description, is_active, counts_as_spendable |
| `categories` | name, kind `income \| expense`, icon, color, is_archived, parent_id (nullable, reserved for Phase 2). Defaults (Food, Transportation, Utilities, Shopping, Entertainment, Salary, …) are seeded per workspace. |
| `tags`, `transaction_tags` | tags are synced as part of their transaction |
| `transactions` | type `income \| expense \| transfer \| refund \| adjustment`, amount_centavos (> 0), occurred_at (timestamptz), local_date, category_id, description, notes, refund_of_transaction_id, reconciliation_id |
| `transaction_entries` | transaction_id, account_id, amount_centavos (**signed**). Transfers have 2 entries; all other types have 1. A DB check enforces that a transfer's entries sum to 0. |
| `transaction_templates` | name, type, amount, account(s), category, description, tags |
| `attachments` | transaction_id, object_key, mime, size, sha256, upload_status |
| `account_reconciliations` | account_id, statement_date, statement_balance, computed_balance, adjustment_transaction_id |
| `budgets` | name, scope `overall \| category`, category_id, period `daily \| weekly \| monthly \| custom`, start_date, end_date, rollover (column exists, feature off in Phase 1), is_active |
| `budget_amount_revisions` | budget_id, effective_from, amount_centavos. Keeps budget history accurate when the amount changes. |
| `allocations` | kind `reserve \| obligation`, name, amount, due_date, account_id (optional), status `open \| settled \| cancelled`, settled_by_transaction_id. Feeds Safe-to-Spend. Phase 2 recurring bills can generate these rows. |
| `sync_ops` | op_id (idempotency key, PK), device_id, received_at, status, result jsonb |
| `sync_events` | user_id, device_id, kind, error_code, count. Lets admins monitor sync health **without seeing payloads**. |

**DB roles (created by migration):**
- `ft_owner`: owns the schema; runs migrations and backups.
- `ft_app`: what the running app uses. Allowed: `SELECT/INSERT/UPDATE` on financial tables (no `DELETE`), `INSERT/SELECT` only on `audit_logs`, `USAGE` on sequences. It isn't the table owner, so RLS applies (`FORCE ROW LEVEL SECURITY` on financial tables).
- RLS policy: `workspace_id = current_setting('app.workspace_id')::uuid`. The value is set with `SET LOCAL` inside each request's transaction, and only after the session has been resolved to a workspace.

> Railway's default `postgres` user is a superuser and **bypasses RLS**. This is why the app must use `ft_app`.

---

## 5. Permission matrix

Admin permissions (Managers only have the ones explicitly granted):

| Capability | Super Admin | Manager | User |
|---|---|---|---|
| `users.view` (name, email, role, status, last login, device count) | ✅ | grant | ❌ |
| `users.create` | ✅ | grant | ❌ |
| `users.deactivate` / `users.reactivate` | ✅ | grant (not on admins) | ❌ |
| `users.reset_password` | ✅ | grant (not on admins) | ❌ |
| `users.revoke_devices` | ✅ | grant (not on admins) | ❌ |
| `roles.assign`, `permissions.grant` | ✅ | ❌ never | ❌ |
| `system.settings` | ✅ | ❌ never | ❌ |
| `system.health` (DB, migrations, sync failure counts, storage) | ✅ | grant | ❌ |
| `backups.view` / `backups.trigger` | ✅ | grant (view only) | ❌ |
| `audit.view` | ✅ | grant | ❌ |
| **Any other user's financial data** | ❌ | ❌ | ❌ |
| Own workspace (if Q1 = yes) | ✅ own only | ✅ own only | ✅ own only |

Rules:
- There is no permission that grants financial access. Financial access is purely `session.user_id = workspace.owner_user_id`.
- The last active Super Admin can't be deactivated or demoted.
- Managers can't act on Super Admins or other Managers, and can't grant permissions.
- Deactivating a user revokes all of their sessions and devices immediately.
- Every admin action writes an `audit_logs` row with no financial fields.

The matrix lives in one `permissions.ts` file and has table-driven tests for every cell.

---

## 6. Authentication and first-time setup

**Setup flow**
1. `GET /setup` checks the `system_setup` row on the server. If it exists, the response is 404, so the setup form is never rendered and client-side tricks can't reopen it.
2. The form asks for a **setup token** (see Q3), plus name, email, and password (minimum 12 characters, checked against a common-password list).
3. `POST /api/setup` runs in one transaction: `pg_advisory_xact_lock`, re-check setup state, insert the user, insert the `system_setup` row (singleton PK). If two requests arrive at once, exactly one succeeds and the other gets a 409. The setup token is compared in constant time and is never logged or sent to the client.
4. Writes an audit event, then redirects to `/login`.

**Why a setup token:** without one, anyone who opens a freshly deployed URL before you do becomes Super Admin. `SETUP_TOKEN` is a Railway env var that only you know, and it's only checked while setup is open.

**Login and sessions**
- Email + password with Argon2id verification.
- Rate limits per IP and per account, with progressive lockout. Error messages are generic.
- The session cookie is an opaque 256-bit token; the DB stores only its hash. Sessions expire after 14 days idle or 60 days absolute (configurable). The session rotates on login and on privilege change.
- Mutating routes check CSRF via `SameSite=Lax` plus an `Origin` header check.
- Users can change their own password. Admin resets issue a one-time temporary password with `must_change_password` set. There's no email-based self-service reset in Phase 1 (no mail provider).

---

## 7. Financial rules (finance-core)

| Type | Entries | Income/expense reports | Budgets | Balance |
|---|---|---|---|---|
| Income | +amount on account | income | — | ↑ |
| Expense | −amount on account | expense | counts | ↓ |
| Transfer | −amount on source, +amount on destination | **excluded** | **excluded** | net 0 across the workspace |
| Refund | +amount on account, category = expense category, optional link to original | **reduces expense** (it is not income) | reduces spending | ↑ |
| Adjustment | ±amount on account | **excluded** | **excluded** | ↑/↓ |

- **Balance** = opening_balance + Σ entries for non-deleted transactions. A liability account's balance is negative when you owe money. Paying a credit card is a transfer from bank to card.
- **Soft delete** sets `deleted_at`; restoring clears it. Every calculation filters `deleted_at IS NULL`, so balances and budgets recompute automatically.
- Accounts and categories that are still referenced can only be archived or deactivated, never deleted.
- **Reconciliation:** you enter the statement balance and date, the app shows the computed balance and the difference, and offers to create an adjustment for the difference. A checkpoint is recorded. Editing a transaction dated before the latest checkpoint triggers a warning.
- **Balance history:** daily running balance per account, computed from entries.
- **Dates:** `occurred_at` (timestamptz) plus `local_date` computed in the workspace timezone (Asia/Manila). All period math (day, week, month) uses `local_date`, so the client and server always agree.
- Transfer fees aren't a special case in Phase 1. You record a fee as a separate expense.

---

## 8. Budgets

- **Overall budget:** all expenses minus refunds in the period, across all categories (transfers and adjustments excluded).
- **Category budget:** the same calculation, limited to one category.
- **No duplicate allowance:** category budgets are *sub-limits inside* the overall budget, never added to it. The overall card shows "₱X allocated to category budgets / ₱Y unallocated". If category budgets total more than the overall budget for an overlapping period, you get a warning.
- Each budget shows spent, remaining, % used, and a progress bar. Warnings appear at 80% and 100% (thresholds configurable): an in-app banner, plus a toast when a new transaction crosses a threshold. Push notifications are out of scope (see §16).
- **History:** past periods are computed using the amount that was in effect then (`budget_amount_revisions`).
- **Periods:** daily, weekly (week start from settings, default Monday), monthly, and custom start/end.
- **Rollover:** the schema column exists but the feature is off in Phase 1, so the core budget math stays simple.

---

## 9. Dashboard and Safe-to-Spend

Dashboard cards: Available funds · Total balances · Income and expenses (this month) · Savings · Liabilities (if any liability accounts exist) · Net worth (assets + liabilities) · Recent transactions · Budget progress · Upcoming obligations (from `allocations`) · Sync status chip.

**Safe-to-Spend** = Σ balances of **spendable** accounts − open **reserves** − open **obligations** due within the horizon (default: end of the current month).

How double deductions are avoided:
1. "Spendable" defaults to cash, bank, and e-wallet. Savings accounts are excluded entirely, so savings are never subtracted a second time as a reserve. A reserve is an earmark *inside* spendable money.
2. An obligation stops counting once it's settled. Recording the payment as an expense lets you mark the obligation settled in the same atomic operation, so it's never subtracted twice (balance already reduced and obligation still open).
3. Remaining budget is **not** subtracted. Budgets are plans, not reserved money. They're shown separately.
4. Liability balances aren't subtracted by default. A card payment you plan to make should be added as an obligation.
5. A negative result is shown as negative, with a warning. It isn't clamped to 0.

The UI labels **Actual** figures (real account balances) separately from **Reserved/Projected** figures, and STS has a "how is this calculated" breakdown sheet.

---

## 10. Offline-first architecture

### 10.1 Local store
- One Dexie database per user per device: `ft_<sha256(userId)>`.
- Tables: entities (accounts, categories, tags, transactions + entries, templates, budgets, revisions, allocations, reconciliations), `outbox`, `conflicts`, `sync_meta` (cursor, last sync), `key_wraps`, and pending receipt blobs.
- Records are stored as `{ id, plaintext indexes needed for sync only (id, version, updated flags), ciphertext }`.
- On unlock, everything is decrypted into an in-memory store, and queries and filters run in memory. That's fine at personal-finance scale (tens of thousands of transactions is a few MB). It's documented as a limitation if the data grows far beyond that.
- `navigator.storage.persist()` is requested to reduce the chance of eviction.

### 10.2 Durability
- Every local mutation writes the entity change **and** its outbox op in a single IndexedDB transaction. Either both persist or neither does.
- On startup, ops left `inflight` by a crash or closed tab go back to `pending` and are retried. Server-side idempotency makes this safe.

### 10.3 Offline login, PIN, and key wrapping
1. You first log in online with email and password. The server registers this **device** and returns a per-device `recovery_key`, which the DB stores only in encrypted form.
2. The client generates a random 256-bit **DEK** (data encryption key) that encrypts all local data.
3. The DEK is wrapped twice and stored:
   - `wrap_pin`: KEK = Argon2id(PIN, salt, ~64 MiB, tuned to about 0.5–1 s on a mid-range phone) → AES-GCM wrap of the DEK.
   - `wrap_recovery`: AES-GCM wrap of the DEK with the server's `recovery_key`. This wrap can only be opened online.
4. **Offline unlock:** you enter the PIN, the client derives the KEK and unwraps the DEK. The data is decrypted in memory only.
5. **Attempt limits:** after 5 failures, delays grow (30 s → 1 min → 5 min → 15 min). After 10 failures, `wrap_pin` is erased and you must sign in online. PINs are at least 6 digits, and trivial ones (`000000`, `123456`, …) are rejected. Longer alphanumeric passcodes are allowed.
6. **PIN reset (online):** you sign in with your password, the server releases the device's `recovery_key`, the client unwraps the DEK, and you set a new PIN, which rewraps it.
7. **Lock and logout:** the decrypted store and DEK reference are dropped from memory. The app auto-locks after inactivity (default 5 minutes) and when it's backgrounded for longer than the timeout. "Sign out" keeps the encrypted data and warns if there are unsynced changes. "Sign out and remove from this device" wipes the local DB.
8. **Device revocation:** an admin (or you) revokes a device, which deletes its `recovery_key` and sessions. The next time that device reaches the server, it's told it was revoked and wipes its local data.
9. **Multiple users on one device:** each user has a separate DB and DEK. Unlocking user A's data never touches user B's.
10. Nothing financial is cached by the service worker or Cache Storage, and API responses are `Cache-Control: no-store`.

**Documented limitations (will appear in SECURITY.md):**
- A 6-digit PIN has only 10⁶ possibilities. If someone copies the browser's IndexedDB files, the attempt limit (which is enforced by the app) no longer applies, and they can brute-force the PIN offline. Argon2id slows this to hours or days, not years. The PIN protects against casual access on a shared device, not a determined attacker who has the device.
- A revoked device that never goes online keeps its encrypted data, and the PIN still works on it.
- Later improvement: unlocking with a passkey (WebAuthn PRF), which is hardware-backed and enforces attempt limits in the OS.

### 10.4 Sync protocol
**Push** (`POST /api/sync/push`, batches of ≤100 ops in order):
- Each op has: `op_id` (UUID idempotency key), `entity`, `entity_id`, `kind` (`create | update | delete | restore`), `base_version`, `payload`.
- The server locks the workspace row (`SELECT … FOR UPDATE`), which serializes all writes to one workspace so the change ordering is gap-free.
- For each op, inside a savepoint:
  1. If `op_id` is already in `sync_ops`, return the stored result. This is what makes retries and interrupted syncs safe.
  2. Validate ownership (the workspace comes from the session, never from the request) and the payload (zod + domain rules: account belongs to the workspace, transfer entries sum to 0, amount > 0).
  3. If `base_version` ≠ the current version, it's a **conflict**. The op isn't applied, and the current server record is returned.
  4. Otherwise apply it, bump `version`, assign `change_seq = ++workspace.change_counter`, and record it in `sync_ops`.
- Later ops for an entity that has a conflict are held back. Ops for other entities continue.
- **Validation errors** are marked Failed and not retried automatically. **Network errors and 5xx** are retried with exponential backoff plus jitter.

**Pull** (`GET /api/sync/pull?cursor=`): returns rows (tombstones included) with `change_seq > cursor`, paginated. Applying a page and advancing the cursor happens in one local transaction.

**Conflicts:** there's never blind last-write-wins. The client stores the conflict, the item shows a "Conflict" badge, and a resolution sheet shows *Your version* and *Server version* side by side with three choices: keep mine (re-push based on the server version), keep the server's, or edit a merged version. This applies to every entity type, including deletes and restores.

**Tombstones:** financial records are never hard-deleted in Phase 1, and tombstones sync to every device.

### 10.5 Wi-Fi-only automatic sync (`ConnectionPolicy`)
A pure function decides from what the browser reports:

| Browser reports | Status | Auto sync |
|---|---|---|
| `navigator.onLine === false` | Offline | No |
| `connection.type === "wifi"` | Eligible | **Yes** |
| `connection.type === "ethernet"` | Eligible (if Q5 = yes) | Yes |
| `connection.type === "cellular"` / `wimax` | **Paused – Mobile data** | No |
| `connection.saveData === true` | Paused – Data saver | No |
| `type` is `unknown`, `other`, `none`, `bluetooth`, or the API is missing | **Paused – Connection unknown** | No |

- The policy is re-checked before **every batch** and on `connection.onchange`. If the connection type changes, sync stops before the next batch.
- Auto sync runs only while the app is open and unlocked. The Background Sync API isn't used, because it can fire on mobile data.
- **Manual sync** is always available. If Wi-Fi can't be verified, it opens a confirmation: *"We can't confirm you're on Wi-Fi. Syncing may use mobile data, and data charges may apply."* The confirmation is required every time.
- Receipt uploads follow the same rule.
- The initial data download right after an online login counts as part of that explicit login action. If the connection isn't verified Wi-Fi, you get the same data-charge notice first.

**Expected support (per MDN compatibility data; I'll re-verify during implementation):**

| Platform | `connection.type` available? | Practical result |
|---|---|---|
| Android Chrome, Samsung Internet, Android Edge | Yes | Auto sync on Wi-Fi works as intended |
| iOS Safari and iOS installed PWA (all iOS browsers use WebKit) | **No** | **Always "Connection unknown", so manual sync only** |
| Desktop Chrome / Edge (Windows, macOS) | **No** (`type` only exists on Android/ChromeOS) | Always "Connection unknown", so manual sync only (see Q4) |
| Firefox (all platforms) | No | Manual sync only |

Other limitations:
- A laptop connected to a phone hotspot reports `wifi`. Android "Wi-Fi assist" may route some traffic over cellular while still reporting `wifi`. The browser can't detect either case.
- Loading the app and downloading app updates use data regardless of network type. The Wi-Fi rule covers **data sync**, not loading the app.

**Sync statuses shown:** Synced · Pending (n) · Syncing · Failed · Conflict detected · Paused – Mobile data · Paused – Connection unknown · Offline · Signed out (needs online login).

### 10.6 Session expiry while offline
Pending ops stay encrypted on the device. When the server session has expired, the status shows "Sign in to sync". After an online login as the **same** user, the outbox resumes. Ops are tied to the user id and are never pushed under a different account.

---

## 11. PWA
- Web app manifest (name, icons including maskable, `display: standalone`, theme colors, `start_url: /app`), plus iOS meta tags and apple-touch-icon.
- The service worker precaches the app shell (static `/app/*` routes, JS, CSS, fonts, icons) and serves an offline fallback.
- An in-app "Update available, reload" prompt. The app never reloads itself while unsaved changes are open.
- An install prompt (Android `beforeinstallprompt`), plus instructions for iOS "Add to Home Screen".
- **iOS notes:** storage in Safari and storage in the installed PWA are separate, so each needs its own sign-in and data download. Safari can evict site data after about 7 days without use; installed PWAs are exempt. Both will be documented.
- Mobile-first layout: bottom navigation (Home · Transactions · ➕ Quick Add · Budgets · More), bottom-sheet forms, 16 px inputs (prevents iOS zoom), `inputmode="decimal"` for amounts, safe-area insets, dark mode.

---

## 12. Receipts, backups, and exports
- **Receipts:** images are compressed on the client (max about 1600 px, size limit 5 MB). While offline, the blob is stored encrypted in IndexedDB and uploaded during sync (Wi-Fi only). The server streams it to the bucket under `receipts/<workspace>/<uuid>`. Downloads go through an ownership-checked route that returns short-lived signed URLs.
- **Scheduled backups:** a Railway cron service (daily, 02:00 Asia/Manila) runs `pg_dump -Fc` → `age` encryption with `BACKUP_AGE_RECIPIENT` (a public key) → upload to `backups/` → a row in `backup_runs` (status, size, checksum, duration, error). Retention is 30 daily + 12 monthly, enforced by the job or by a bucket lifecycle rule.
- **If your Railway plan offers native Postgres volume backups,** I'll recommend enabling them as a second layer.
- **Backup status:** the admin page shows the last success or failure and the history, with no data inside.
- **Restore:** documented in `docs/RECOVERY.md`: download → `age -d` with your private key → `pg_restore` into a new database → run migrations → switch `DATABASE_URL`. It's tested end to end into local Postgres as part of acceptance.
- **Exports:** the user exports CSV of transactions (with the current filters) and a full JSON export. Both are generated **on the device from local data**, so they work offline. CSV-injection protection prefixes cells starting with `= + - @` with `'`.
- **Encryption-at-rest verification:** I'll check Railway's documentation and dashboard for Postgres volumes, Railway's own backups, and the chosen bucket provider, and record exactly what's confirmed vs. unconfirmed in `docs/SECURITY.md`. Our own backups are encrypted with `age` regardless of what the provider does.

---

## 13. Security controls checklist
- [ ] Ownership enforced at three layers: the app (workspace taken from the session), RLS, and composite FKs.
- [ ] Least-privilege DB role `ft_app` (no DELETE on financial tables, no superuser, no BYPASSRLS).
- [ ] Argon2id passwords; opaque, hashed session tokens; rate limiting and lockout.
- [ ] CSRF (SameSite + Origin check); strict CSP; HSTS; `X-Content-Type-Options`; `Referrer-Policy`; `frame-ancestors 'none'`.
- [ ] `Cache-Control: no-store` on all API responses; the service worker never caches API data.
- [ ] Audit log for admin and security events, append-only for the app role, no financial fields.
- [ ] Secrets only in Railway env vars; env validated at startup with zod; no secrets in client bundles (`NEXT_PUBLIC_*` reviewed).
- [ ] Production error handling: generic messages to clients, structured server logs without request bodies, error boundaries in the UI.
- [ ] Honest documentation: application-level privacy, **not** end-to-end encryption. Infrastructure and DB administrators can technically read data in Postgres.

---

## 14. Railway deployment
| Service | Details |
|---|---|
| `web` | Next.js standalone. Pre-deploy command `npm run db:migrate` (uses `MIGRATION_DATABASE_URL`). Healthcheck `/api/health`. |
| `postgres` | Railway PostgreSQL plugin. One-time bootstrap creates the `ft_owner` / `ft_app` roles (script plus docs). |
| `backup` | Same repo, cron schedule, runs `npm run backup`. The image includes a `pg_dump` matching the server's major version, plus `age`. |
| Object storage | Chosen in Q2. |

Deploying requires your Railway account. **I won't create or modify Railway resources until you approve that step.**

## 15. Environment variables (documented in `docs/ENVIRONMENT.md`)
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | App connection as `ft_app` (restricted) |
| `MIGRATION_DATABASE_URL` | Owner connection, used only for migrations and backups |
| `APP_URL` | Public origin (Origin/CSRF checks, manifest) |
| `SETUP_TOKEN` | One-time setup secret (can be removed after setup) |
| `APP_ENCRYPTION_KEY` | 32-byte key that encrypts device recovery keys in the DB |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Object storage |
| `BACKUP_AGE_RECIPIENT` | Public key that backups are encrypted to |
| `SESSION_IDLE_DAYS`, `SESSION_ABSOLUTE_DAYS` | Optional overrides |
| `LOG_LEVEL` | Optional |

---

## 16. Testing strategy
| Layer | What I'll test |
|---|---|
| Unit (Vitest) | money parse/format/arithmetic; balances; transfers; refunds; adjustments; budget periods and boundaries in Asia/Manila (week start, month end, custom); overall-vs-category budgets; Safe-to-Spend, including no double deduction; permission matrix (every cell); ConnectionPolicy (every row of the §10.5 table); conflict detection; PIN lockout schedule; CSV escaping |
| Integration (Vitest + local Postgres) | setup (a race of 10 parallel requests gives exactly one success); setup unreachable afterwards; login/logout; user create/deactivate/reactivate; **Super Admin and Manager get no financial data** (both the app layer and a direct `ft_app` query without workspace context return 0 rows); **user A ↔ user B ID-tampering suite** across every sync entity and the receipt route; atomic transfers; sync idempotency (the same op twice gives one row); interrupted sync (server commits but the response is dropped, then a retry gives no duplicate); version conflicts; delete/restore recalculation; RLS and role-grant checks (no DELETE) |
| E2E (Playwright) | setup → login → create account → quick-add transaction; offline create/edit via `context.setOffline`; reload and close/reopen with pending changes intact; sync gating with a mocked `navigator.connection` (wifi → syncs; cellular → paused; missing → unknown, manual sync shows the warning); conflict resolution flow; PIN unlock and lockout; two users on one browser can't see each other's data; PWA manifest and SW registration; mobile viewports (Pixel and iPhone emulation, Chromium + WebKit engines); desktop Chrome |
| Backup/restore | Run the backup job locally against the real bucket (or an in-process S3 mock in CI), then restore into a scratch DB and compare row counts and checksums |

**What I can't verify myself:** real Android Chrome and real iOS Safari or installed-PWA behavior. Playwright's WebKit is not iOS Safari. I'll write a **manual device test checklist** (`docs/DEVICE-TEST-CHECKLIST.md`) for you to run on your phones, and Phase 1 counts as complete only once you've run it. The same goes for the Railway production deploy and the restore test there, which I can only run once you've approved access.

---

## 17. Implementation milestones

Each milestone ends with tests passing and a `BUILD-LOG.md` entry. I'll pause for review wherever you want checkpoints.

| # | Milestone | Main output |
|---|---|---|
| M0 | Scaffold | Next.js + TS strict + Tailwind + shadcn/ui + Lucide, ESLint/Prettier, Vitest, Playwright, env validation, folder layout, `.env.example` |
| M1 | Database foundation | Drizzle schema, migrations 0001+ (tables, roles, grants, RLS, composite FKs), local dev and test DB scripts |
| M2 | finance-core | money, ledger, balances, budgets, STS, date/period utilities, with unit tests (built test-first; this is the riskiest logic) |
| M3 | Auth and setup | setup flow, login/logout, sessions, rate limits, password change, devices |
| M4 | Admin | users CRUD, roles, permission grants, audit log, health page (sync failure counts, backup status), permission tests |
| M5 | Sync server | push/pull, idempotency, conflicts, workspace serialization, sync_events, isolation tests |
| M6 | Client data layer | Dexie, encryption, DEK/PIN wrapping, lock/unlock, outbox, sync engine, ConnectionPolicy, status UI, conflict resolution UI |
| M7 | Finance UI | accounts (CRUD, deactivate, history, reconcile), transactions (quick add, edit, duplicate, delete/restore, search/filter, tags, templates), transfers, refunds, adjustments, categories |
| M8 | Budgets, dashboard, allocations | budget CRUD/history/warnings, dashboard cards, Safe-to-Spend + breakdown |
| M9 | PWA | manifest, icons, service worker, offline shell, update and install prompts |
| M10 | Receipts, backups, exports | object storage, receipt upload/sync, backup cron job, `backup_runs`, CSV/JSON export, restore test |
| M11 | Hardening and docs | security headers, error handling, full test run, README, BUILD-LOG, DEPLOYMENT, ENVIRONMENT, MIGRATIONS, SECURITY, PERMISSIONS, RECOVERY, device checklist |
| M12 | Railway deploy (**with your approval**) | services, env vars, role bootstrap, migrations, smoke test, backup/restore check, completion report |

Commits: one or more per milestone on a feature branch (`phase-1/…`), unless you'd rather I commit directly to `main`. I won't push without asking.

---

## 18. Main technical risks
1. **Wi-Fi detection is only possible on Android Chromium browsers.** iOS and desktop will always need manual sync. This is the biggest UX trade-off, and it follows directly from the strict rule.
2. **Offline PIN strength** has a hard ceiling (see §10.3). The limitations will be documented honestly.
3. **iOS PWA quirks:** separate storage between Safari and the installed PWA, possible eviction, no background sync, and an update lifecycle where the app updates only after it's fully closed.
4. **Service worker tooling vs. the current Next.js version.** Mitigated by the hand-written SW fallback.
5. **Sync correctness** (ordering, partial failure, conflicts). Mitigated by per-workspace serialization, idempotency keys, savepoints, and a dedicated integration test suite.
6. **Railway encryption-at-rest and role-creation support are unverified.** I'll verify these before relying on them; app-side `age` encryption covers the backups.
7. **Clock skew between devices.** Ordering always uses the server's `change_seq`, never device clocks. `occurred_at` is only user-entered data.

---

## 19. Open decisions (defaults in **bold**; I'll proceed with the defaults unless you say otherwise)
| # | Question | Default |
|---|---|---|
| Q1 | Do admin accounts (Super Admin, Manager) also get their own private finance workspace? | **Yes.** Each person has one account and one private workspace. Admin rights never reach anyone else's workspace. (The alternative is admin-only accounts and a separate login for your own finances.) |
| Q2 | Object storage provider for receipts and backups? | **Railway Storage Buckets if available on your plan; otherwise Cloudflare R2.** The code is provider-agnostic either way. |
| Q3 | Require a `SETUP_TOKEN` env var on the first-time setup page? | **Yes** (prevents setup hijacking on a fresh deployment) |
| Q4 | Desktop browsers can never prove Wi-Fi. Offer a per-device opt-in, "This device has no mobile data — allow automatic sync"? | **No.** Stay strictly manual on unknown connections, as the requirements say. I can add the opt-in if you want it. |
| Q5 | Count `ethernet` as eligible for automatic sync? | **Yes** (it is positively identified and is not mobile data) |
| Q6 | Include simple manual reserves and obligations (one-off items) in Phase 1 so Safe-to-Spend works? Recurring bills stay in Phase 2. | **Yes** |
| Q7 | Branch workflow | **Feature branch per milestone, nothing pushed without asking** |

## 20. Explicitly out of scope for Phase 1
Recurring/scheduled transactions and bills, debts and loans management, goals, reports and charts beyond the dashboard, split transactions, multi-currency, shared or household workspaces, push notifications, email delivery, bank imports, AI features, budget rollover behavior, and native app wrappers. The schema leaves room for each of these (for example `parent_id` on categories, `rollover` on budgets, generated `allocations`, ledger entries for splits).
