# Architecture

## Overview

```
Browser / installed PWA
  React UI ──► in-memory store (decrypted, only while unlocked)
                 │  finance-core (shared pure TS) computes balances, budgets, Safe-to-Spend
                 ▼
  IndexedDB (Dexie), one DB per user: records*, outbox*, conflicts*, receipt blobs*, key wraps
                 │                                           (* AES-256-GCM encrypted)
  Sync engine ── ConnectionPolicy (auto only on Wi-Fi/Ethernet) ──► /api/sync/push, /api/sync/pull
  Service worker: caches the static app shell only (never API data)

Next.js server (Railway "web")
  /api/auth/*, /api/setup, /api/admin/*, /api/sync/*, /api/receipts/*  (route handlers)
  /admin/* (server-rendered, online only)
  connects as ft_app (RLS enforced, no DELETE on financial tables)

PostgreSQL (Railway)     Object storage (S3-compatible): receipts/, backups/
Railway "backup" cron service: COPY snapshot → gzip → age-encrypt → upload
```

**Rendering split.** All `/app/*` pages are statically prerendered client shells with no server
data, so the service worker can serve them offline. Pages that need IDs use query strings
(`/app/accounts/view?id=…`) so a single cached shell serves every record.

## Data model highlights

- `transactions` (header) + derived `transaction_entries` (signed ledger lines). Entries are rebuilt
  from the header in the same DB transaction on every write; balances are always derived
  (opening balance + Σ entries of live transactions). A transfer is one transaction with two lines
  summing to zero (enforced by a CHECK on the header shape and by construction).
- Soft deletion everywhere (`deleted_at`); deleted transactions have no ledger lines, so balances and
  budgets recompute automatically on delete/restore.
- Composite foreign keys `(workspace_id, x_id) → x(workspace_id, id)` make cross-workspace links
  impossible at the database level.
- Budget amount changes are stored as `amount_revisions` (JSON) so history uses the amount in effect.
- Phase 1 `allocations` (reserves/obligations) were replaced in Phase 2 by **bills** and **savings
  goals** (migration `0004`); the table is kept for history only.

## finance-core (`src/lib/finance`)
Pure functions used by both server and client: `money.ts` (centavos parse/format, safe integer
arithmetic), `dates.ts` (local calendar dates per timezone), `ledger.ts` (entries, validation,
period totals), `balances.ts`, `budgets.ts`, `safe-to-spend.ts`, `csv.ts`. Unit-tested in
`finance.test.ts`.

## Offline store (`src/client`)
- `crypto.ts` — DEK generation, AES-GCM, Argon2id PIN KDF, key wrapping. See SECURITY.md.
- `local-db.ts` — Dexie schemas. `ft_device` (install id, known users — no financial data) and
  `ft_u_<hash(userId)>` per user.
- `store.ts` — decrypted in-memory view + `mutate()`: writes the encrypted record **and** its outbox
  op in one IndexedDB transaction (crash-safe). Pending ops for the same record are coalesced
  (create+update → create; create+delete → nothing). Encryption always happens *before* opening an
  IndexedDB transaction (awaiting WebCrypto inside one would auto-commit it).
- `sync-engine.ts` — push then pull; statuses; retry with exponential backoff + jitter.
- `vault.ts` — sign-in, unlock (recovery key or PIN), lock/auto-lock, logout, revocation wipe.

## Sync protocol (`src/lib/sync/protocol.ts`, `src/server/sync/*`)

**Push** `POST /api/sync/push {ops[≤100]}`. Each op: `opId` (idempotency key), `entity`,
`entityId`, `kind` (create/update/delete/restore), `baseVersion`, `data`.
Server, in one DB transaction with the workspace row locked (serialises writes per workspace):
1. `opId` already in `sync_ops` → return the stored result (`duplicate`). Retries after a lost
   response never apply twice.
2. Each op runs in a SAVEPOINT: validation (zod + domain rules), ownership (workspace from the
   session; RLS), `baseVersion` check → `conflict` with the current server record (not applied).
3. Applied/rejected results are recorded in `sync_ops`. Later ops for an entity that conflicted or
   was rejected in the same batch are `blocked` (order preserved).
4. Every write gets `change_seq = ++workspace.change_counter` (gap-free ordering per workspace).

**Pull** `GET /api/sync/pull?cursor=N` → records with `change_seq > N` (tombstones included),
paginated. The client never overwrites a record that has unsynced local changes; a stale pending
op is detected as a conflict at push time.

**Conflicts** are never resolved by last-write-wins. The UI (More → Sync & conflicts) shows both
versions; "Keep mine" re-applies the local version on top of the server version as a new op.

**Interrupted sync**: ops are marked `inflight` before sending; on startup inflight ops return to
`pending` and are resent; the server dedupes by `opId`.

## Wi-Fi-only automatic sync (`src/lib/sync/connection-policy.ts`)

| Browser reports | Status | Auto sync |
|---|---|---|
| offline | Offline | no |
| `connection.type = wifi` | Wi-Fi | **yes** |
| `connection.type = ethernet` | Ethernet | yes |
| `cellular` / `wimax` | Paused – Mobile data | no |
| `saveData = true` | Paused – Data saver | no |
| anything else / API missing | Paused – Connection unknown | no |

Checked before every batch and on `connection.change`. Automatic sync runs only while the app is
open and unlocked (no Background Sync API, which could fire on mobile data). Manual "Sync now" on an
unverified connection always shows "Syncing may use mobile data, and data charges may apply."

Practical support: Android Chrome/Edge/Samsung Internet report `type`; **iOS (all browsers), desktop
Chrome/Edge and Firefox do not**, so they always need manual sync. A laptop on a phone hotspot
reports `wifi`; the browser cannot tell.

## Service worker (`scripts/sw-template.js` → `public/sw.js`)
Generated after `next build` with the build id as version. Precaches every static app page
(discovered from `.next/server/app/**/*.html`; 29 after Phase 2),
all `/_next/static` assets, icons and the manifest. `/api`, `/admin`, `/setup` are network-only.
RSC fetches fail fast offline so Next falls back to a full navigation, served from the cached shell.
Updates wait for the user to tap "Update" (never auto-reload over unsaved input).
Phase 2 adds `push` (show the notification from the encrypted payload) and `notificationclick`
(focus an open window or open the target page) handlers.

## Phase 2: planning layer

**Principle: money moves only through ordinary transactions.** Bills, schedules, cards, debts, goals
and snapshots are metadata layered on the ledger; balances are still derived only from transactions.

| Concept | How it works |
|---|---|
| Recurrence (`recurrence.ts`) | Rules (daily/weekly/biweekly/monthly/yearly/custom interval, end date or count, pauses) are expanded on the fly. Month-end safe (31st → last day). |
| Virtual occurrences | Future occurrences are **computed, never stored**. One is materialized only when the user acts on it (confirm, pay, skip, override), using a **deterministic UUIDv5 id** (`src/lib/domain/ids.ts`, e.g. `uuidv5(scheduleId + date)`). Two devices acting on the same occurrence produce the same id → the server sees an identical create (`duplicate`) or a visible conflict, never two records. DB unique indexes (`transactions_occurrence_uq`, `bills_occurrence_uq`) are the final backstop. |
| Scheduled transactions | Shown as *pending confirmation* from their date (90-day lookback); they **never affect actual balances** until confirmed, which creates a normal transaction linked by `schedule_id` + `occurrence_date`. Edit future = end the old rule and start a new one (`previous_schedule_id`), so history is unchanged. |
| Bills (`bills.ts`) | The single obligation mechanism: one-off bills, recurring bill schedules, credit-card statements and loan installments are all bills. Status is **derived** (upcoming / due today / partially paid / paid / overdue / cancelled) from due date and linked payments (`transactions.bill_id`). Partial and multiple payments are just several linked transactions. |
| Credit cards (`cards.ts`) | `card_profiles` holds limit, statement day, due offset, minimum rule, APR. Statements are computed from card transactions in each cycle. Purchases are expenses on the card account; payments are **transfers** (not expenses). Installments (`installment_plans`) record one purchase expense and bill monthly amounts against the card. |
| Debts (`debts.ts`) | A debt is metadata on a `loan` account. Payment = group of transfer (principal) + expense (interest, "Interest & Fees"). Diminishing / add-on / no-interest methods; payoff projection; snowball vs avalanche are **projections only**. |
| Goals (`goals.ts`) | Goal contributions are **earmarks** (`goal_entries`), not ledger lines; optionally paired with a real transfer. Emergency fund coverage = funds ÷ monthly essentials, target 3/6/9/12 months (user choice), essentials averaged over the last 3/6/9/12 full months (user choice) or a manual override. |
| Net worth (`networth.ts`) | Assets − liabilities from account balances + manual assets. Snapshots are **immutable** (server rejects updates); monthly auto snapshot with a deterministic id per month. |
| Safe-to-Spend v2 (`safe-to-spend.ts`) | Spendable balances − goal earmarks held in spendable accounts − outstanding bills up to the horizon (end of month or next scheduled income) − unconfirmed scheduled outflows. Scheduled income is never added. |
| Calendar / cash flow (`planning.ts`) | Merges bills, schedule occurrences and confirmed transactions per day without double counting (a paid occurrence shows once). 30/60/90-day projection from spendable balances. |
| CSV import (`csv-import.ts`) | Parsed **on the device** (the file is never uploaded). Column mapping, validation per row, duplicate detection (exact re-import by fingerprint, likely match against existing transactions, repeats inside the file), confirm, undo. Server unique index on `(workspace, import_fingerprint)` prevents double imports from two devices. |
| Notifications (`planning.ts → deriveNotifications`, `client/notify.ts`, `server/reminders.ts`) | In-app center computed locally (works offline). While the app is open, urgent items are also shown as system notifications. When closed, only Web Push can notify: a daily cron computes reminders per user and sends one push per user with new items. |

### Sync protocol additions
- **Atomic groups**: ops sharing a `groupId` (e.g. loan payment principal + interest, contribution +
  transfer, bill payment + bill materialization) are applied all-or-nothing inside one savepoint and
  are sent contiguously by the outbox. A failed group is not recorded in `sync_ops`, so a fixed retry
  can succeed.
- **Identical create ⇒ `duplicate`** (timestamps normalized before comparison), used by deterministic
  ids. **Immutable entities** (net-worth snapshots) reject updates.
- Unique violations map to explicit rejections: `duplicate_occurrence`, `duplicate_import`.

## Phase 3 extension points
`categories.parent_id` (sub-categories), `budgets.rollover`, ledger entries (splits), entity registry
in `server/sync/entities.ts` (add an entity = schema + zod schema + registry entry + migration with
grants/RLS).
