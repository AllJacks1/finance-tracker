# Deploying to Railway

Services in one Railway project:

| Service | Source | Config file | Notes |
|---|---|---|---|
| `Postgres` | Railway PostgreSQL template | — | Enable Backups on the service. |
| `web` | this repo | `railway.json` | Next.js; pre-deploy runs migrations; health check `/api/health`. |
| `backup` | this repo | `railway.backup.json` | Cron `0 18 * * *` (02:00 Manila), `npm run backup`. |
| `reminders` | this repo | `railway.reminders.json` | Cron `0 0 * * *` (08:00 Manila), `npm run reminders`. Optional (Web Push). |
| `Bucket` | Railway Storage Bucket (or Cloudflare R2) | — | Receipts + backups. |

## 1. Create the project
1. New project → **Deploy PostgreSQL**.
2. **New → GitHub repo** → this repository → name it `web`. Settings → Config-as-code path:
   `railway.json` (default).
3. **New → GitHub repo** again → name it `backup`. Settings → Config-as-code path:
   `railway.backup.json`.
4. **New → Bucket** (Storage Bucket). Note its S3 credentials/variables.
5. Optional, for push reminders: **New → GitHub repo** again → name it `reminders`. Config-as-code
   path: `railway.reminders.json`.

## 2. Create the restricted database role (once)
From your computer with the Railway CLI linked to the project:
```bash
railway link                      # choose the project
railway run --service Postgres -- printenv DATABASE_PUBLIC_URL    # or copy from the dashboard
# then, with that URL:
MIGRATION_DATABASE_URL="<public url>" APP_DB_PASSWORD="<new 32+ char password>" npm run db:roles
```

## 3. Variables
**web**
```
MIGRATION_DATABASE_URL = ${{Postgres.DATABASE_URL}}
DATABASE_URL           = postgresql://ft_app:<APP_DB_PASSWORD>@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}
APP_URL                = https://<your web domain>
APP_ENCRYPTION_KEY     = <node -e "console.log(require('crypto').randomBytes(32).toString('base64'))">
SETUP_TOKEN            = <random 24+ chars>
S3_ENDPOINT / S3_REGION / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY = (from the bucket)
VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY = (npm run vapid:keygen on your computer)   # optional, push
VAPID_SUBJECT          = mailto:<your address>                                   # optional, push
```
**backup**
```
MIGRATION_DATABASE_URL = ${{Postgres.DATABASE_URL}}
BACKUP_AGE_RECIPIENT   = age1…   (npm run backup:keygen on your computer)
S3_* = same as web
```
**reminders** (optional)
```
DATABASE_URL = same ft_app URL as web   (NOT the privileged URL)
VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT = same as web
```
Generate a public domain for `web` (Settings → Networking) and set `APP_URL` to it exactly.

## 4. Deploy
Push to the deployment branch (or click Deploy). For `web`, Railway builds (`npm run build`, which
also generates the service worker), runs `npm run db:migrate` (pre-deploy), starts `npm run start`,
and waits for `/api/health`.

## 5. First-time setup
Open `https://<domain>/` → `/setup` → enter `SETUP_TOKEN`, create the Super Admin. Then **remove
`SETUP_TOKEN`** from the variables. Create users under Administration → Users.

## 6. Verify (production checklist)
- [ ] `/api/health` returns `{"ok":true}`.
- [ ] `/setup` returns 404 after setup.
- [ ] Sign in, add an account and a transaction, sync; sign in on a second device and see it.
- [ ] Administration → Overview shows the database OK and storage configured.
- [ ] Run the `backup` service once ("Run now"); Administration → Backups shows *succeeded*.
- [ ] Download that backup and rehearse a restore into a scratch database (docs/RECOVERY.md).
- [ ] Enable Railway Postgres backups.
- [ ] Response headers include `Strict-Transport-Security` and `Content-Security-Policy`.
- [ ] Migrations `0002`–`0004` applied (pre-deploy log). If Phase 1 data existed: obligations now
      appear under **Bills** and reserves under **Goals** (docs/MIGRATIONS.md).
- [ ] Push (if configured): More → Notifications → *Turn on push*; run the `reminders` service once
      with a bill due → one notification arrives; its text is generic unless "Show names and amounts" is on.
- [ ] Run docs/DEVICE-TEST-CHECKLIST.md on an Android phone and an iPhone.

## Rollback
Redeploy the previous successful deployment in Railway. Migrations are additive, so the previous
version runs against the newer schema. For data problems, follow docs/RECOVERY.md.

**Phase 2 → Phase 1 rollback caveat:** migration `0004` converts Phase 1 obligations/reserves into
bills/goals and soft-deletes the old allocation rows. A Phase 1 build still runs, but it no longer
shows those obligations/reserves (balances and transactions are unaffected). Take a backup before
the first Phase 2 deploy; to fully return to Phase 1, restore that backup.
