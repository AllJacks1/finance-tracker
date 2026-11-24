# Database migrations

Migrations are plain SQL in [`drizzle/`](../drizzle), applied in order by `npm run db:migrate`
(Drizzle migrator; applied files are tracked in `drizzle.__drizzle_migrations`). They run with the
privileged `MIGRATION_DATABASE_URL`; the app itself runs as `ft_app`.

| File | Contents | Destructive? |
|---|---|---|
| `0000_init.sql` | All tables, enums, indexes, CHECK constraints, composite foreign keys | No (new database) |
| `0001_security.sql` | `ft_app` grants (no DELETE on financial tables; audit append-only), RLS helper functions, `FORCE ROW LEVEL SECURITY` + policies | No |
| `0002_phase2_schema.sql` | Phase 2 tables (bills, schedules, schedule_exceptions, card_profiles, installment_plans, debts, goals, goal_entries, manual_assets, net_worth_snapshots, import_batches, push_subscriptions, notification_log); nullable link columns on `transactions` (bill, schedule + occurrence date, debt, installment plan, group, import batch + fingerprint) with unique indexes against duplicate occurrences/imports; `attachments` may belong to a bill; `workspaces.preferences`; `categories.is_essential` | No (additive) |
| `0003_phase2_security.sql` | Grants (no DELETE on the 11 financial tables) and `FORCE ROW LEVEL SECURITY` + workspace policies; `push_subscriptions`/`notification_log` are per-user identity tables (no financial data) with DELETE allowed | No |
| `0004_phase2_data.sql` | Data conversion: Phase 1 obligations → bills (same id, payments re-linked), reserves → savings goals (same id, opening contribution), converted allocations soft-deleted; default essential categories marked; "Interest & Fees" category added; every changed row gets a new `change_seq` so devices pull it | **Changes meaning of existing rows** (nothing hard-deleted). Back up first; see DEPLOYMENT.md rollback caveat |

## Roles
- `ft_app` — created by `npm run db:roles` (once per Postgres cluster; needs a privileged URL and
  `APP_DB_PASSWORD`). `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`.
  `0001_security.sql` fails with a clear message if the role does not exist yet.
- The migration/backup user is the database owner (on Railway, the provided `postgres` user).

## Adding a migration
1. Edit `src/server/db/schema.ts`.
2. `npm run db:generate -- --name <short_name>` and **review the generated SQL**.
3. For any new table: add explicit `GRANT`s to `ft_app` and, for financial tables, the RLS policy
   (copy the pattern from `0001_security.sql`) in a custom migration
   (`npx drizzle-kit generate --custom --name <name>`).
4. Run `npm test` (integration tests migrate and use `finance_test`).
5. Commit the SQL and the `drizzle/meta` snapshot together.

## Rules
- Migrations must be **additive** (new tables/columns, nullable or defaulted columns). Any migration
  that drops or rewrites data must be called out and approved before merge, with a backup taken
  first (`npm run backup`).
- Never edit an applied migration; add a new one.
- Railway runs migrations in the **pre-deploy** step; if a migration fails the new version is not
  deployed and the old one keeps running.

## Phase 2 notes
- `0004` temporarily lifts `FORCE ROW LEVEL SECURITY` on the tables it converts (so a non-superuser
  owner can see every workspace) and restores it before the end of the same migration transaction.
- It is idempotent with respect to devices: converted rows keep their ids, and the bumped `change_seq`
  makes every device pull the new bill/goal records and the allocation tombstones on its next sync.
- Tested by `tests/integration/migration-0004.test.ts` (Phase 1 data → migrate → bills/goals with
  correct paid amounts, allocations tombstoned, devices pull the changes).
