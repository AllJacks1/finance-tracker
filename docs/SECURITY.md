# Security and privacy

## Model: application-level privacy (Option A)

- Financial data is accessible **only to its owner**, through the owner's own session.
- Super Admins and Managers manage accounts and the system; **no permission grants financial
  access** (see [PERMISSIONS.md](PERMISSIONS.md)).
- **This is not end-to-end encryption.** Data on the server is stored in PostgreSQL in plaintext
  (protected by access control and the hosting provider's at-rest encryption). Anyone with direct
  database or infrastructure access (Railway account owners, DB superusers) can technically read it.

## How ownership is enforced (three independent layers)

1. **Application**: the workspace is derived from the session (`requireWorkspace`), never from
   request parameters. Changing IDs in a request can only ever address the caller's own workspace.
2. **Row-Level Security**: every financial table has `FORCE ROW LEVEL SECURITY` with a policy
   `workspace_id = app_current_workspace_id()`. That function returns the workspace in
   `app.workspace_id` **only if it is owned by `app.user_id`**. Admin endpoints run with no workspace
   context → zero financial rows. The app connects as `ft_app` (not owner, not superuser,
   `NOBYPASSRLS`).
3. **Composite foreign keys** `(workspace_id, id)` make cross-workspace references impossible.

Additional DB guarantees: `ft_app` has **no DELETE** on financial tables (soft delete only) and only
INSERT/SELECT on `audit_logs` (append-only).

Tested by `tests/integration/sync.test.ts` (user A vs user B with tampered IDs; admin and raw
`ft_app` connections see zero rows, even with a forged workspace id) and E2E.

## Authentication & sessions
- Passwords: Argon2id (`@node-rs/argon2`, m=19 MiB, t=2, p=1), minimum 12 chars, common-password and
  email-name checks. Temporary passwords from admins must be changed at first sign-in.
- Sessions: random 256-bit token in an `HttpOnly; SameSite=Lax; Secure` cookie (`__Host-` prefix on
  HTTPS). Only SHA-256(token) is stored. 14-day idle / 60-day absolute expiry. Password change,
  role change, deactivation and device revocation revoke sessions.
- Brute force: 30 login attempts / 15 min per IP; per-account progressive lockout after 5 failures
  (1 min doubling to 60 min). Generic error messages.
- CSRF: SameSite cookie + `Origin` must equal `APP_URL` on every non-GET API call.
- First-time setup: requires `SETUP_TOKEN`; serialised with an advisory lock; singleton
  `system_setup` row; page and API return 404 afterwards (decided server-side on each request).

## Headers
CSP (`default-src 'self'`; scripts `'self' 'unsafe-inline' 'wasm-unsafe-eval'` — inline is needed by
Next.js static pages, WASM by the Argon2id PIN KDF; no `eval`), HSTS, `X-Frame-Options: DENY`,
`frame-ancestors 'none'`, `nosniff`, strict referrer policy. All `/api/*` responses are `no-store`.

## Local (device) data
- One IndexedDB database per user per device. Records, outbox payloads, conflicts and pending
  receipts are AES-256-GCM encrypted with a random 256-bit **data key (DEK)**.
- The DEK is held in memory only while unlocked, as a non-extractable WebCrypto key. Locking,
  auto-lock (5 min inactivity, with a PIN set) and sign-out drop it and all decrypted data.
- The DEK is stored only wrapped:
  - `wrap_recovery` = AES-GCM(device recovery key, DEK). The recovery key is random per device,
    stored server-side encrypted with `APP_ENCRYPTION_KEY`, and returned on password sign-in. While a
    PIN is enabled the server releases it **only after password re-entry**, so a session cookie
    alone cannot bypass the PIN lock.
  - `wrap_pin` = AES-GCM(Argon2id(PIN, salt, 64 MiB, t=3), DEK).
- PIN rules: ≥ 6 characters, no repeated/sequential digits. 5 failures → 30 s, then 1, 5, 15 min
  delays; 10 failures → `wrap_pin` erased (password sign-in required).
- Multiple users on one device: separate databases and keys; the device-level DB holds only ids and
  display names.
- Device revocation (admin or user): server deletes the device's recovery key and sessions; when the
  device next contacts the server it wipes that user's local data.
- The service worker never caches API responses or financial data.

### Known limitations (honest)
- **A 6-digit PIN has ~20 bits of entropy.** Attempt limits are enforced by the app. Someone who
  copies the browser profile's IndexedDB files can brute-force the PIN offline; Argon2id (64 MiB)
  slows this to hours/days on commodity hardware, not years. The PIN protects against casual access
  on a shared or lost-and-found device, not against a determined attacker with the device and time.
  Longer alphanumeric passcodes help. Future: WebAuthn PRF (passkey/biometric, hardware-backed).
- A revoked device that never goes online keeps its encrypted data and its PIN keeps working.
- Without a PIN, a valid session cookie can unlock the device's data (like any web app session).
- Exports (CSV/JSON) are plaintext files on the user's device.
- Uploaded receipts are not application-encrypted in object storage (they rely on the provider's
  at-rest encryption); they are only served to their owner.

## Encryption at rest — what is verified

| Data | Protection | Status |
|---|---|---|
| In transit | HTTPS/TLS terminated by Railway's edge | Railway-managed |
| PostgreSQL volume, Railway volume backups, PITR archives | AES-256 at rest, Railway-managed keys | **Per Railway's security documentation (docs.railway.com/enterprise/security); not independently verified** |
| Railway Storage Buckets | AES-256 at rest per the same page; S3 server-side-encryption *headers* are not supported by Railway buckets (leave `S3_SSE` empty) | Per Railway docs; not independently verified |
| Our backups | `age` (X25519) encryption to a public key **before upload**; private key kept offline | **Verified by tests** (`tests/integration/backup.test.ts`) — independent of provider |
| Device data | AES-256-GCM (see above) | Verified by tests |
| Device recovery keys in DB | AES-256-GCM with `APP_ENCRYPTION_KEY` | Implemented |

If you use another storage provider (Cloudflare R2: encrypted at rest by default; AWS S3: SSE-S3 by
default since 2023 — set `S3_SSE=AES256` to be explicit), record the verified status here.

## Logging & audit
Structured JSON logs without request bodies, tokens, passwords, PINs or financial payloads. Audit log
(`/admin/audit`) records setup, sign-ins/failures, password changes/resets, user/role/permission
changes, device revocations, settings changes. Sync monitoring stores counts and error codes only.
