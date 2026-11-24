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
