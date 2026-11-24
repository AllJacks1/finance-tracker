# Backups and recovery

## What is backed up
1. **Application backups (primary, verified):** the `backup` cron service runs daily at 02:00
   Asia/Manila (`0 18 * * *` UTC). It takes a consistent snapshot of every table (Postgres `COPY` in a
   REPEATABLE READ transaction), gzips it, **encrypts it with age to `BACKUP_AGE_RECIPIENT`**, and
   uploads it to `backups/YYYY/MM/ft-backup-<timestamp>.json.gz.age`. Each run is recorded in
   `backup_runs` (visible at **Administration → Backups**). Retention: daily backups for
   `backupRetentionDays` (default 30), plus the first backup of each month for 12 months.
2. **Railway volume backups / PITR (recommended second layer):** enable in the Railway dashboard on
   the Postgres service (Backups tab). Restores create a new volume/service.
3. **Receipts** live in object storage (`receipts/<workspace>/<id>`) and are not included in the
   database backup. Protect the bucket (provider versioning/replication if available).

Device data that has not synced is not in any backup. Users should sync before uninstalling.

Phase 2 tables are included automatically (the backup enumerates every table in `public`).
After a restore: net-worth snapshots, bills, schedules and goals come back exactly as backed up;
future occurrences are recomputed from schedules (they were never stored). Push subscriptions are
restored too, but if the VAPID keys changed users must turn push on again.

## One-time: create the backup key
On **your own computer** (not the server):
```bash
npm run backup:keygen
```
- Put the **public** key (`age1…`) in Railway → backup service → `BACKUP_AGE_RECIPIENT`.
- Store the **private** key (`AGE-SECRET-KEY-1…`) offline: password manager + a printed copy.
  **Without it, backups cannot be restored. Anyone with it can read them.**

## Run a backup now
Railway → `backup` service → **Run now** (or `railway run --service backup npm run backup`).

## Restore procedure
1. Create a **new, empty** PostgreSQL database (new Railway Postgres service, or locally).
2. Download the backup from the bucket (Railway bucket UI / any S3 client), or let the script fetch
   it with `--key` if `S3_*` is set in your shell.
3. Check out the **same app version** that made the backup (or one with the same migrations).
4. Run, on your computer:
   ```bash
   # private key via file (recommended) or BACKUP_AGE_IDENTITY env var
   npm run backup:restore -- --target "postgres://postgres:...@host:port/newdb" \
     --file ./ft-backup-2026-11-24T18-00-00-000Z.json.gz.age --identity-file ./backup-key.txt
   ```
   The script decrypts, verifies per-table checksums, runs migrations on the target, refuses a
   non-empty target, loads all tables, resets identity sequences and verifies row counts.
5. Create the app role on the new cluster: `MIGRATION_DATABASE_URL=<new> APP_DB_PASSWORD=<pw> npm run db:roles`
6. Point the web service's `DATABASE_URL` and `MIGRATION_DATABASE_URL` at the new database and
   redeploy. Keep `APP_ENCRYPTION_KEY` unchanged (otherwise devices just need to sign in again).
7. Sign in and check balances. Devices with unsynced changes will push them on their next sync.

## Tested
`tests/integration/backup.test.ts` performs backup → encrypt → decrypt → restore into a brand-new
database and compares row counts and transaction totals; it also checks that a wrong key fails and a
non-empty target is refused. Rehearse a restore in Railway once after the first production backup
(see the deployment checklist).
