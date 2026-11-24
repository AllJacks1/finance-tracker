# Build log

## Phase 1 — Core Finance Tracker and Infrastructure (2026-11-24)

Branch `phase-1`, one commit per milestone. Plan: [docs/PHASE-1-PLAN.md](docs/PHASE-1-PLAN.md)
(approved with default answers to Q1–Q7).

### Milestones
| # | Commit summary |
|---|---|
| M0/M1 | Scaffold (Next.js 16, TS, Tailwind 4, shadcn/ui, Lucide); Drizzle schema; migrations `0000_init`, `0001_security` (grants + RLS); role/migrate/local-setup scripts |
| M2 | finance-core: money (centavos), dates, ledger, balances, budgets, Safe-to-Spend, CSV |
| M3/M4 | Setup (token + lock + singleton), sessions, Argon2id, lockout/rate limits, devices + recovery keys, admin users/roles/permissions, audit, health |
| M5 | Sync push/pull: idempotency ledger, version conflicts, savepoints, tombstones, per-workspace serialisation |
| M6 | Offline client: encrypted IndexedDB, outbox (coalesce/rebase), sync engine, Wi-Fi policy, vault/PIN |
| M7–M9 | Mobile-first UI, admin area, receipts, PWA manifest/icons/service worker |
| M10 | Encrypted logical backups + restore; Playwright E2E; fixes found by E2E |
| M11 | Docs, Railway config, final verification |

### Test results (final run)

| Check | Result |
|---|---|
| `tsc --noEmit` | ✅ clean |
| `eslint .` | ✅ clean |
| Unit — `finance.test.ts` (money, dates, ledger, transfers, refunds, adjustments, budgets, Safe-to-Spend, CSV) | ✅ 30/30 |
| Unit — `permissions.test.ts` (every role × action cell) | ✅ 24/24 |
| Unit — `connection-policy.test.ts` (wifi/ethernet/cellular/unknown/no API/data saver/offline) | ✅ 13/13 |
| Integration — `auth.test.ts` (setup race ×10, setup once, CSRF, login/logout, hashed sessions, rate limit, lockout, user create/deactivate/reactivate/reset, manager grants, concurrent last-Super-Admin, audit content, device key re-auth, device revocation) | ✅ 20/20 |
| Integration — `sync.test.ts` (create/pull, transfers net zero, server local date, lost-response replay, concurrent devices, conflicts, blocked ops, delete/restore balances, in-use protection, validation, **user A vs B tampered IDs**, **admin and raw DB role see zero financial rows**, no hard delete) | ✅ 21/21 |
| Integration — `offline-client.test.ts` (offline create/edit, encryption at rest, restart survival, no auto-sync on cellular/unknown/data-saver, stop mid-batch on network switch, interrupted sync + crash recovery without duplicates, two-device conflict + resolution, tombstones, rejections, PIN lifecycle + lockout + wipe) | ✅ 8/8 |
| Integration — `backup.test.ts` (backup → age encrypt → restore into new DB; wrong key fails; non-empty target refused) | ✅ 1/1 |
| E2E (Playwright, production build, Pixel 7 profile) — setup once; admin; installable PWA + SW; offline PIN unlock, offline create/edit, close/reopen, mobile-data pause, Wi-Fi auto-sync; iOS-like unknown connection + data-charges warning; two users on one browser | ✅ 6/6 |
| `npm run build` | ✅ all `/app/*` pages static; service worker generated |

**Totals: 117 Vitest tests + 6 E2E tests passing.**

### Not verified (needs you / production)
- Real Android Chrome, real iOS Safari / Home Screen app, real Wi-Fi vs cellular detection → [docs/DEVICE-TEST-CHECKLIST.md](docs/DEVICE-TEST-CHECKLIST.md).
- Railway deployment, Railway env vars, production migrations, a production backup run and restore rehearsal → [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Not deployed yet (needs your approval / Railway access).
- Receipt upload against real object storage (no bucket configured locally; code path covered by types and the 503 "storage not configured" behaviour).
- Railway encryption at rest is taken from Railway's documentation, not independently verified ([docs/SECURITY.md](docs/SECURITY.md)).

### Issues found and fixed during testing
- Service worker CSP blocked WebAssembly → Argon2id PIN derivation hung. Added `'wasm-unsafe-eval'`; KDF failures no longer count as wrong PIN attempts; PIN sheet can't hang.
- Device DB queried an unindexed field (`lastUsedAt`) → app stuck on spinner. Added index (schema v2) and a safe fallback when init fails.
- Double unlock after sign-in raced the first sync (data saved but not shown until reload). Init is now a no-op when unlocked; closed stores abort their sync; new stores wait for the old sync.
- Closed stores still reacted to cross-tab messages/timers. Guarded.
- Dev server was served the cached production shell by a leftover service worker. Dev now unregisters workers.

### Deviations from the plan (all minor)
- `next start` instead of `output: "standalone"` (the backup cron service shares the repo and needs `node_modules`).
- Migrations run as the database owner (Railway's `postgres` user) rather than a separate `ft_owner` role; the app still uses only `ft_app`.
- Tags stored as `tag_ids uuid[]` on transactions/templates (validated server-side) instead of a join table — simpler atomic sync.
- Budget amount history stored as `amount_revisions` JSON on the budget instead of a separate table.
- Hand-written service worker generator instead of Serwist (Serwist requires webpack; Next 16 builds with Turbopack).
- Backups use Postgres `COPY` (logical, JSON+CSV, gzip, age) instead of `pg_dump`, so no client binary/version matching is needed on Railway. Railway's native Postgres backups are recommended as a second layer.
- "Run backup now" is done from the Railway backup service, not the web UI (the web service never holds the privileged DB URL).
- Receipts are uploaded through the server (not presigned URLs) so CSP stays `'self'`-only.

### Known limitations
- Automatic sync is impossible on iOS, desktop browsers and Firefox (no connection type) → manual sync with warning.
- Offline PIN strength limits (see SECURITY.md); revoked devices that stay offline keep working with their PIN.
- iOS: Safari and the Home Screen app have separate storage; Safari may evict data for sites unused for ~7 days (installed apps are exempt).
- The whole decrypted dataset is held in memory while unlocked — fine for personal-scale data (tens of thousands of transactions).
- Uploaded receipts are viewable only online; not application-encrypted in the bucket.
- Budget rollover not implemented (column reserved). Obligations are one-off (recurring bills are Phase 2).
- Category budgets are compared with an overall budget only when they share the same period type.
- Transfer fees must be recorded as a separate expense.
- No email delivery: password resets are done by administrators.

### Recommended next steps (Phase 2)
Recurring transactions and bills (generating obligations), debts/loans, savings goals, reports and
charts, split transactions (ledger entries already support multiple lines), budget rollover, push
notifications for budget warnings, WebAuthn PRF unlock, optional email for password reset.

## Phase 2 — Complete Financial Management (2026-11-24)

Branch `phase-2` (from `phase-1`), one commit per milestone. Plan: [docs/PHASE-2-PLAN.md](docs/PHASE-2-PLAN.md)
(approved Q1–Q7 as proposed; Q8 changed: emergency-fund coverage target selectable 3 / 6 / 9 / 12 months,
default 6, plus a selectable averaging window and a manual override).

### Milestones
| # | Commit summary |
|---|---|
| P2-M0 | Phase 2 schema, migrations `0002` (tables/columns/unique indexes) and `0003` (grants + RLS), sync protocol: atomic groups, identical-create `duplicate`, immutable entities |
| P2-M1 | finance-core: recurrence, bills, schedules, cards, debts, goals, net worth, planning/calendar, CSV import, Safe-to-Spend v2 (unit tests) |
| P2-M2 | Migration `0004`: Phase 1 obligations → bills, reserves → goals (tested) |
| P2-M3 | Bills, recurring/scheduled transactions (confirm/skip/reschedule, edit future, pause/resume/cancel), calendar, cash-flow projection, Plan hub |
| P2-M4 | Credit cards: details, statements, minimum due, installments, payments |
| P2-M5 | Debts and loans: principal/interest split, payoff projection, snowball vs avalanche |
| P2-M6 | Savings goals, emergency fund (3/6/9/12 months), net worth with immutable snapshots and manual assets |
| P2-M7 | CSV import (map, validate, duplicates, confirm, undo) and receipts for bills |
| P2-M8 | Notifications: in-app center, system notifications while open, Web Push + daily reminders cron, preferences, Safe-to-Spend horizon setting |
| P2-M9 | Phase 2 E2E, docs, this log |

### Test results (final run)

| Check | Result |
|---|---|
| `tsc --noEmit` | ✅ clean |
| `eslint src scripts tests` | ✅ clean |
| Unit — `finance.test.ts` (Phase 1 core) | ✅ 30/30 |
| Unit — `phase2.test.ts` (recurrence month-end/leap/biweekly/pauses, bill status table, schedules + confirmation, card cycles/statements/minimum/installments, debt interest methods + payment split + payoff + snowball/avalanche, goals + emergency coverage, net worth + snapshots, calendar dedupe, cash flow, notifications, CSV parse/map/duplicates, Safe-to-Spend v2 no-double-count) | ✅ 31/31 |
| Unit — `permissions.test.ts`, `connection-policy.test.ts` | ✅ 24/24, 13/13 |
| Integration — `phase2-sync.test.ts` (link validation, duplicate occurrences: same id → `duplicate`, different data → conflict, different id → DB refusal; atomic groups all-or-nothing + contiguity; immutable snapshots; **user A vs B on Phase 2 records; admin and raw `ft_app` see zero rows in every new table**; duplicate import backstop; bill receipts owner-only) | ✅ 14/14 |
| Integration — `offline-phase2.test.ts` (same occurrence confirmed offline on two devices → one transaction; offline bill payment as one atomic group; server rejection rolls back the whole group) | ✅ 3/3 |
| Integration — `migration-0004.test.ts` | ✅ 1/1 |
| Integration — `reminders.test.ts` (only users with items due are notified; generic text by default; dedupe; names/amounts only when opted in; users can't unsubscribe others' devices; HTTPS endpoints only) | ✅ 5/5 |
| Integration — Phase 1 files (`auth`, `sync`, `offline-client`, `backup` + Phase 2 tables included) | ✅ 20/20, 21/21, 8/8, 1/1 |
| E2E (production build, Pixel 7 profile) — Phase 1 flows (6) + Phase 2: scheduled salary needs confirmation and counts once; bill paid in two parts **offline** then synced on Wi-Fi; card owed/available credit after purchase and payment; CSV import then re-import flagged *already imported*; calendar shows items on their days | ✅ 11/11 |
| `npm run build` | ✅ all `/app/*` pages static; service worker precaches 29 pages |

**Totals: 171 Vitest tests + 11 E2E tests passing.**

### Not verified (needs you / production)
- Web Push on real devices (Android Chrome, iPhone Home Screen app on iOS 16.4+), and the `reminders`
  cron on Railway with real VAPID keys. Locally verified only up to the job's logic (integration test
  with a fake sender) and `reminders_skipped` without keys.
- Bill receipts against real object storage (same as Phase 1 receipts).
- Real Wi-Fi/cellular detection and iOS behaviour for the new screens → docs/DEVICE-TEST-CHECKLIST.md (Phase 2 section).
- Not separately automated from the test plan: pause/resume while offline, bill receipts queued offline,
  CSV import while offline. They use the same outbox/group paths that the tests above cover.
- Not deployed (per your instruction).

### Issues found and fixed during Phase 2
- Identical-create detection compared timestamps as strings (`…Z` vs `…+00:00`) → normalized before comparing.
- Installment plan ↔ purchase transaction created a circular reference → the purchase links to the plan (`transactions.installment_plan_id`) only.
- Automatic net-worth snapshot could record ₱0 before any account existed → only after the earliest opening date.
- A card with automatic statement bills could also get a manual recurring bill (double bill) → the schedule form excludes such cards.
- Stale `.next/types` after removing the Phase 1 `/app/allocations` page broke typecheck → cleaned.
- E2E: password policy rejected a test password containing the email name (expected behaviour).
- Push could keep delivering a signed-out user's reminders to a shared browser → push is unsubscribed on sign-out and on remote revocation; device/user revocation revokes server subscriptions.

### Deviations from the plan (minor)
- Reminders are a **single daily push per user** (08:00 Manila) summarizing new items, not one push per item at its own time (fewer notifications, simpler, cron-friendly).
- `push_subscriptions` and `notification_log` are per-user identity tables without RLS (no financial data; always queried by the session's user id).
- The installment purchase is linked from the transaction to the plan rather than plan → transaction.

### Known limitations
- Reminders reflect data **synced** to the server; changes still on a device are unknown to the job. In-app reminders always use local data.
- Browsers can't schedule notifications for a closed app; without push there are no closed-app reminders. iOS push only for Home-Screen apps.
- Card interest/finance charges are not auto-posted: record them as an expense (e.g. *Interest & Fees*). Card statements are computed from recorded card transactions; enter the actual statement amount if the bank's differs.
- Installment purchases count fully as an expense on the purchase date (approved Q2); spreading monthly is Phase 3.
- Snowball/avalanche and cash-flow are projections only; they never create transactions.
- CSV formats: one account per file; date formats from a fixed list; no OFX/QIF.
- Rolling back to a Phase 1 build after migration `0004` hides converted obligations/reserves (see docs/DEPLOYMENT.md).

### Recommended next steps (Phase 3)
Reports and charts, budget rollover, sub-categories, split transactions, spreading installment
expenses monthly, WebAuthn unlock, email for password resets, OFX/QIF import.
