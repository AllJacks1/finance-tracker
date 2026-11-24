# Database migrations

Migrations are plain SQL in [`drizzle/`](../drizzle), applied in order by `npm run db:migrate`
(Drizzle migrator; applied files are tracked in `drizzle.__drizzle_migrations`). They run with the
privileged `MIGRATION_DATABASE_URL`; the app itself runs as `ft_app`.

| File | Contents | Destructive? |
|---|---|---|
| `0000_init.sql` | All tables, enums, indexes, CHECK constraints, composite foreign keys | No (new database) |
| `0001_security.sql` | `ft_app` grants (no DELETE on financial tables; audit append-only), RLS helper functions, `FORCE ROW LEVEL SECURITY` + policies | No |

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
