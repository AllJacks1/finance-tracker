import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { audit } from "../audit";
import { decryptSecret, encryptSecret } from "../crypto";
import { db } from "../db";
import { devices, users } from "../db/schema";
import { ApiError, clientIp } from "../http";
import { burnPasswordCheck, hashPassword, passwordProblem, verifyPassword } from "./password";
import { lockoutSeconds, rateLimit } from "./rate-limit";
import { createSession, revokeUserSessions } from "./session";

export const loginInput = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().min(1).max(256),
  installId: z.uuid(),
  deviceLabel: z.string().trim().max(100).default("Browser"),
});

const GENERIC = "Incorrect email or password.";

export async function login(input: z.infer<typeof loginInput>, req: Request) {
  const ip = clientIp(req) ?? "unknown";
  const rl = await rateLimit(`login:ip:${ip}`, 30, 900);
  if (!rl.allowed) throw new ApiError(429, "rate_limited", "Too many attempts. Try again later.", { retryAfter: rl.retryAfter });

  const [user] = await db().select().from(users).where(eq(users.email, input.email)).limit(1);
  if (!user) {
    await burnPasswordCheck(input.password);
    await audit({ action: "auth.login_failed", metadata: { reason: "unknown_email" }, req });
    throw new ApiError(401, "invalid_credentials", GENERIC);
  }
  if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
    const retryAfter = Math.ceil((new Date(user.lockedUntil).getTime() - Date.now()) / 1000);
    throw new ApiError(429, "rate_limited", "Too many attempts. Try again later.", { retryAfter });
  }
  const ok = await verifyPassword(user.passwordHash, input.password);
  if (!ok) {
    const failed = user.failedLoginCount + 1;
    const lock = lockoutSeconds(failed);
    await db()
      .update(users)
      .set({
        failedLoginCount: failed,
        lockedUntil: lock ? new Date(Date.now() + lock * 1000).toISOString() : null,
      })
      .where(eq(users.id, user.id));
    await audit({ action: "auth.login_failed", targetUserId: user.id, metadata: { reason: "bad_password", failed }, req });
    throw new ApiError(401, "invalid_credentials", GENERIC);
  }
  if (user.status !== "active") {
    await audit({ action: "auth.login_failed", targetUserId: user.id, metadata: { reason: "deactivated" }, req });
    throw new ApiError(403, "account_deactivated", "This account has been deactivated. Contact your administrator.");
  }

  return db().transaction(async (tx) => {
    await tx
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: sql`now()` })
      .where(eq(users.id, user.id));

    // One device row per (user, browser install). A previously revoked device starts fresh.
    const [existing] = await tx
      .select()
      .from(devices)
      .where(and(eq(devices.userId, user.id), eq(devices.installId, input.installId)))
      .limit(1);
    let deviceId: string;
    let deviceReset = false;
    let recoveryKeyEnc: string;
    if (existing && !existing.revokedAt && existing.recoveryKeyEnc) {
      deviceId = existing.id;
      recoveryKeyEnc = existing.recoveryKeyEnc;
      await tx.update(devices).set({ lastSeenAt: sql`now()`, label: input.deviceLabel }).where(eq(devices.id, deviceId));
    } else {
      recoveryKeyEnc = encryptSecret(randomBytes(32));
      if (existing) {
        deviceReset = !!existing.revokedAt;
        deviceId = existing.id;
        await tx
          .update(devices)
          .set({ revokedAt: null, recoveryKeyEnc, offlineEnabled: false, lastSeenAt: sql`now()`, label: input.deviceLabel })
          .where(eq(devices.id, deviceId));
      } else {
        const [d] = await tx
          .insert(devices)
          .values({
            userId: user.id,
            installId: input.installId,
            label: input.deviceLabel,
            userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
            recoveryKeyEnc,
            lastSeenAt: sql`now()`,
          })
          .returning({ id: devices.id });
        deviceId = d!.id;
      }
    }
    const { cookie } = await createSession({ userId: user.id, deviceId, req }, tx);
    await audit({ action: "auth.login", actorUserId: user.id, targetUserId: user.id, metadata: { deviceId }, req }, tx);
    return {
      cookie,
      body: {
        user: { id: user.id, email: user.email, name: user.name, role: user.role, mustChangePassword: user.mustChangePassword },
        deviceId,
        deviceReset,
        // Fresh password authentication: release the device recovery key (see docs/SECURITY.md).
        recoveryKey: decryptSecret(recoveryKeyEnc).toString("base64"),
      },
    };
  });
}

export const deviceKeyInput = z.object({
  password: z.string().max(256).optional(),
  setOfflineEnabled: z.boolean().optional(),
});

/**
 * Returns this device's recovery key, used to unwrap the local data key.
 * - If offline PIN access is enabled on the device, the key is only released after re-entering
 *   the password (otherwise someone at the PIN lock screen could bypass it with the cookie).
 * - Disabling offline access also requires the password.
 */
export async function deviceKey(
  auth: { user: { id: string; email: string }; deviceId: string | null },
  input: z.infer<typeof deviceKeyInput>,
  req: Request,
) {
  if (!auth.deviceId) throw new ApiError(401, "device_required", "Sign in again on this device");
  const [device] = await db().select().from(devices).where(eq(devices.id, auth.deviceId)).limit(1);
  if (!device || device.revokedAt || !device.recoveryKeyEnc) throw new ApiError(401, "device_revoked", "This device was signed out");

  let passwordOk = false;
  if (input.password) {
    const rl = await rateLimit(`reauth:${auth.user.id}`, 10, 900);
    if (!rl.allowed) throw new ApiError(429, "rate_limited", "Too many attempts. Try again later.");
    const [u] = await db().select({ hash: users.passwordHash }).from(users).where(eq(users.id, auth.user.id));
    passwordOk = !!u && (await verifyPassword(u.hash, input.password));
    if (!passwordOk) throw new ApiError(401, "invalid_credentials", "Incorrect password.");
  }

  let offlineEnabled = device.offlineEnabled;
  if (input.setOfflineEnabled !== undefined && input.setOfflineEnabled !== device.offlineEnabled) {
    if (!input.setOfflineEnabled && !passwordOk) throw new ApiError(403, "reauth_required", "Enter your password");
    offlineEnabled = input.setOfflineEnabled;
    await db().update(devices).set({ offlineEnabled }).where(eq(devices.id, device.id));
  } else if (device.offlineEnabled && !passwordOk) {
    throw new ApiError(403, "reauth_required", "Enter your password");
  }
  await audit({ action: "auth.device_key_issued", actorUserId: auth.user.id, targetUserId: auth.user.id, metadata: { deviceId: device.id, offlineEnabled }, req });
  return { recoveryKey: decryptSecret(device.recoveryKeyEnc).toString("base64"), offlineEnabled };
}

export const changePasswordInput = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

export async function changePassword(
  auth: { sessionId: string; user: { id: string; email: string; name: string } },
  input: z.infer<typeof changePasswordInput>,
  req: Request,
) {
  const rl = await rateLimit(`pwchange:${auth.user.id}`, 10, 900);
  if (!rl.allowed) throw new ApiError(429, "rate_limited", "Too many attempts. Try again later.");
  const [u] = await db().select({ hash: users.passwordHash }).from(users).where(eq(users.id, auth.user.id));
  if (!u || !(await verifyPassword(u.hash, input.currentPassword)))
    throw new ApiError(401, "invalid_credentials", "Current password is incorrect.");
  const problem = passwordProblem(input.newPassword, auth.user);
  if (problem) throw new ApiError(400, "weak_password", problem);
  if (input.newPassword === input.currentPassword) throw new ApiError(400, "weak_password", "Choose a different password.");
  const passwordHash = await hashPassword(input.newPassword);
  await db().transaction(async (tx) => {
    await tx.update(users).set({ passwordHash, mustChangePassword: false, updatedAt: sql`now()` }).where(eq(users.id, auth.user.id));
    await revokeUserSessions(auth.user.id, auth.sessionId, tx);
    await audit({ action: "auth.password_changed", actorUserId: auth.user.id, targetUserId: auth.user.id, req }, tx);
  });
}
