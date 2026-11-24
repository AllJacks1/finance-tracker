# Environment variables

Validated at first use by [`src/server/env.ts`](../src/server/env.ts). Never prefix secrets with
`NEXT_PUBLIC_` (nothing in this app needs public env vars). Template: [`.env.example`](../.env.example).

## Web service

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | Connection as the **restricted `ft_app` role**. On Railway: `postgresql://ft_app:<APP_DB_PASSWORD>@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}` (private network). |
| `MIGRATION_DATABASE_URL` | ✅ (pre-deploy) | Privileged connection used **only** by `npm run db:migrate` in the pre-deploy step. On Railway: `${{Postgres.DATABASE_URL}}`. |
| `APP_DB_PASSWORD` | for `db:roles` | Password for `ft_app` (≥ 24 chars). Only needed when running `npm run db:roles`. |
| `APP_URL` | ✅ | Exact public origin, e.g. `https://finance.example.com` or `https://<service>.up.railway.app`. Used for the CSRF origin check and the `__Host-` secure cookie. |
| `APP_ENCRYPTION_KEY` | ✅ | 32 random bytes, base64. Encrypts per-device recovery keys. **Changing it invalidates all devices' offline unlock** (users simply sign in again). |
| `SETUP_TOKEN` | until setup | One-time secret for `/setup`. Remove it after creating the Super Admin. |
| `SESSION_IDLE_DAYS` | | Default 14. |
| `SESSION_ABSOLUTE_DAYS` | | Default 60. |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | for receipts | S3-compatible storage. Railway Buckets expose these as variables you can reference. |
| `S3_FORCE_PATH_STYLE` | | `true` for MinIO-style endpoints. |
| `S3_SSE` | | `AES256` only on providers supporting SSE headers (AWS S3). Leave empty on Railway/R2. |
| `LOG_LEVEL` | | `debug` \| `info` (default) \| `warn` \| `error`. |
| `DB_POOL_MAX` | | Postgres pool size (default 10). |

## Backup (cron) service

| Variable | Required | Description |
|---|---|---|
| `MIGRATION_DATABASE_URL` | ✅ | Privileged connection (reads past RLS to snapshot everything). |
| `BACKUP_AGE_RECIPIENT` | ✅ | age public key `age1…` from `npm run backup:keygen` (run on your own computer). |
| `S3_*` | ✅ | Same storage as above (backups go under `backups/`). |

The **private** backup key (`AGE-SECRET-KEY-1…`) must **never** be set on Railway. It is only used
on your computer when restoring (`BACKUP_AGE_IDENTITY` or `--identity-file`).

## Local development & tests
`npm run db:local-setup` writes these to `.env.local` (git-ignored): `LOCAL_PG_SUPERUSER_URL` (you
provide), `APP_DB_PASSWORD`, `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `TEST_DATABASE_URL`,
`TEST_MIGRATION_DATABASE_URL`, `APP_URL` (`http://localhost:3100`), `SETUP_TOKEN`,
`APP_ENCRYPTION_KEY`.
