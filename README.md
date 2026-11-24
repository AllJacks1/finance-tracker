# Finance Tracker

A private, **offline-first**, mobile-first personal finance tracker (PHP ₱), installable as a PWA.
Phase 1: core finance tracker and infrastructure. Phase 2: bills, recurring and scheduled
transactions, credit cards, debts and loans, savings goals and emergency fund, net worth, financial
calendar, notifications (in-app + Web Push), CSV import and receipts for bills.

- Every user has one private workspace. Administrators manage users and the system but **cannot see anyone's financial records** (enforced in the app *and* by Postgres Row-Level Security).
- All data lives first on the device, **encrypted in IndexedDB**, and syncs to PostgreSQL through an outbox. **Automatic sync runs only on positively-identified Wi-Fi**.
- Offline unlock with a local PIN (key-wrapped data key, attempt limits, lockout).
- Money is integer centavos everywhere — no floating point.

> This is application-level privacy, **not** end-to-end encryption. Infrastructure and database
> administrators can technically access data in PostgreSQL. See [docs/SECURITY.md](docs/SECURITY.md).

## Stack
Next.js 16 (App Router) · TypeScript · Tailwind CSS v4 · shadcn/ui (Radix) · Lucide · PostgreSQL (Drizzle ORM) · Dexie (IndexedDB) · Railway.

## Quick start (local)

Requirements: Node ≥ 22.12, PostgreSQL ≥ 15 running locally.

```bash
npm install
# Put your local Postgres superuser URL in .env.local:
#   LOCAL_PG_SUPERUSER_URL=postgres://postgres:<password>@localhost:5432/postgres
npm run db:local-setup     # creates finance_dev + finance_test, the ft_app role, secrets, runs migrations
npm run dev                # http://localhost:3100 (APP_URL in .env.local must match)
```

Open the app → you are sent to **/setup** → enter the `SETUP_TOKEN` from `.env.local` and create the Super Admin.
Then create users from **More → Administration → Users**.

The service worker is only active in production builds (`npm run build && npm start`).

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js (build also generates `public/sw.js`) |
| `npm run typecheck`, `npm run lint` | Static checks |
| `npm test` | Unit + integration tests (Vitest; integration uses the real `finance_test` DB) |
| `npm run test:e2e` | Playwright E2E on the production build (run `npm run build` first) |
| `npm run db:generate` | Generate a migration from `src/server/db/schema.ts` |
| `npm run db:migrate` | Apply migrations (`MIGRATION_DATABASE_URL`) |
| `npm run db:roles` | Create/update the restricted `ft_app` role |
| `npm run backup` | Encrypted backup to object storage (Railway cron) |
| `npm run backup:restore` | Restore a backup into a new database |
| `npm run backup:keygen` | Generate the age key pair for backups |
| `npm run reminders` | Send daily push reminders (Railway cron; needs `VAPID_*`) |
| `npm run vapid:keygen` | Generate the VAPID key pair for Web Push |

## Documentation

| Doc | |
|---|---|
| [docs/PHASE-1-PLAN.md](docs/PHASE-1-PLAN.md) | Phase 1 approved plan and decisions |
| [docs/PHASE-2-PLAN.md](docs/PHASE-2-PLAN.md) | Phase 2 approved plan and decisions |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture, offline store, sync protocol, Wi-Fi policy |
| [docs/SECURITY.md](docs/SECURITY.md) | Privacy model, encryption, PIN design and limitations |
| [docs/PERMISSIONS.md](docs/PERMISSIONS.md) | Role/permission matrix |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Railway deployment, step by step |
| [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) | Environment variables |
| [docs/MIGRATIONS.md](docs/MIGRATIONS.md) | Database migrations and roles |
| [docs/RECOVERY.md](docs/RECOVERY.md) | Backups and disaster recovery |
| [docs/DEVICE-TEST-CHECKLIST.md](docs/DEVICE-TEST-CHECKLIST.md) | Manual tests on real phones |
| [BUILD-LOG.md](BUILD-LOG.md) | What was built, test results, known limitations |

## Project layout

```
src/
  app/                 routes: /app/* (static offline shell), /admin/*, /login, /setup, /api/*
  client/              offline client: crypto, IndexedDB, store/outbox, sync engine, vault (PIN)
  components/          UI (shadcn/ui in components/ui; app/finance components)
  lib/finance/         finance-core: money, ledger, balances, budgets, safe-to-spend, recurrence,
                       bills, schedules, cards, debts, goals, net worth, planning, CSV import (shared)
  lib/sync/            sync protocol + Wi-Fi connection policy (shared)
  lib/permissions.ts   permission matrix (shared)
  server/              DB, auth, authorization, admin, sync, storage (server only)
drizzle/               version-controlled SQL migrations
scripts/               migrate, roles, backup/restore, reminders, VAPID keys, icons, service-worker generator
tests/                 integration (Vitest) and e2e (Playwright)
```
