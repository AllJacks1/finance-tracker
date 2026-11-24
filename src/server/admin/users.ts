import "server-only";
import { and, count, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  canActOn,
  creatableRoles,
  MANAGER_GRANTABLE,
  type AdminPermission,
  type Role,
  type TargetAction,
} from "@/lib/permissions";
import { audit } from "../audit";
import { generateTempPassword, hashPassword } from "../auth/password";
import { revokeUserSessions } from "../auth/session";
import type { AuthContext } from "../authz";
import { db, type Tx } from "../db";
import { adminPermissionGrants, devices, pushSubscriptions, sessions, users } from "../db/schema";
import { ApiError, forbidden, notFound } from "../http";

/**
 * User administration. These functions only touch identity tables (users, devices, sessions,
 * grants). They run WITHOUT any workspace context, so Row-Level Security makes every financial
 * table invisible to them.
 */
export type AdminUserRow = {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: "active" | "deactivated";
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  activeDevices: number;
  permissions: string[];
};

export async function listUsers(): Promise<AdminUserRow[]> {
  const rows = await db()
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      status: users.status,
      mustChangePassword: users.mustChangePassword,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.name);
  const deviceCounts = await db()
    .select({ userId: devices.userId, n: count() })
    .from(devices)
    .where(isNull(devices.revokedAt))
    .groupBy(devices.userId);
  const grants = await db().select().from(adminPermissionGrants);
  return rows.map((u) => ({
    ...u,
    activeDevices: deviceCounts.find((d) => d.userId === u.id)?.n ?? 0,
    permissions: grants.filter((g) => g.userId === u.id).map((g) => g.permission),
  }));
}

export async function listDevices(userId: string) {
  return db()
    .select({
      id: devices.id,
      label: devices.label,
      createdAt: devices.createdAt,
      lastSeenAt: devices.lastSeenAt,
      lastSyncAt: devices.lastSyncAt,
      offlineEnabled: devices.offlineEnabled,
      revokedAt: devices.revokedAt,
    })
    .from(devices)
    .where(eq(devices.userId, userId))
    .orderBy(desc(devices.lastSeenAt));
}

export const createUserInput = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(254)),
  role: z.enum(["user", "manager", "super_admin"]).default("user"),
});

export async function createUser(actor: AuthContext, input: z.infer<typeof createUserInput>, req: Request) {
  if (!actor.permissions.has("users.create")) throw forbidden("missing_permission");
  if (!creatableRoles(actor.permissions).includes(input.role)) throw forbidden("cannot_assign_role");
  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  try {
    const [u] = await db()
      .insert(users)
      .values({ ...input, passwordHash, mustChangePassword: true, createdBy: actor.user.id })
      .returning({ id: users.id });
    await audit({ action: "user.created", actorUserId: actor.user.id, targetUserId: u!.id, metadata: { role: input.role }, req });
    return { id: u!.id, tempPassword };
  } catch (e) {
    if ((e as { code?: string }).code === "23505" || String((e as { cause?: { code?: string } }).cause?.code) === "23505")
      throw new ApiError(409, "email_taken", "A user with this email already exists.");
    throw e;
  }
}

export const userActionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("deactivate") }),
  z.object({ action: z.literal("reactivate") }),
  z.object({ action: z.literal("reset_password") }),
  z.object({ action: z.literal("revoke_devices") }),
  z.object({ action: z.literal("revoke_device"), deviceId: z.uuid() }),
  z.object({ action: z.literal("set_role"), role: z.enum(["user", "manager", "super_admin"]) }),
  z.object({ action: z.literal("set_permissions"), permissions: z.array(z.string()).max(20) }),
]);

async function activeSuperAdminsExcluding(tx: Tx, userId: string) {
  const [r] = await tx
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.role, "super_admin"), eq(users.status, "active"), ne(users.id, userId)));
  return r?.n ?? 0;
}

async function revokeAllDevices(tx: Tx, userId: string) {
  await tx
    .update(devices)
    .set({ revokedAt: sql`now()`, recoveryKeyEnc: null })
    .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)));
  await tx.update(pushSubscriptions).set({ revokedAt: sql`now()` }).where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.revokedAt)));
  await revokeUserSessions(userId, undefined, tx);
}

export async function userAction(
  actor: AuthContext,
  targetId: string,
  input: z.infer<typeof userActionInput>,
  req: Request,
): Promise<{ tempPassword?: string }> {
  const [target] = await db().select().from(users).where(eq(users.id, targetId)).limit(1);
  if (!target) throw notFound();
  const action: TargetAction = input.action === "revoke_device" ? "revoke_devices" : input.action;
  if (!canActOn({ id: actor.user.id, role: actor.user.role, permissions: actor.permissions }, target, action))
    throw forbidden("not_allowed_on_target");

  return db().transaction(async (tx) => {
    // Serialise role/status changes so two admins can't demote the last Super Admin concurrently.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ft_user_admin'))`);
    const base = { actorUserId: actor.user.id, targetUserId: target.id, req };
    switch (input.action) {
      case "deactivate": {
        if (target.role === "super_admin" && (await activeSuperAdminsExcluding(tx, target.id)) === 0)
          throw new ApiError(409, "last_super_admin", "The last active Super Admin cannot be deactivated.");
        await tx.update(users).set({ status: "deactivated", updatedAt: sql`now()` }).where(eq(users.id, target.id));
        await revokeAllDevices(tx, target.id);
        await audit({ ...base, action: "user.deactivated" }, tx);
        return {};
      }
      case "reactivate": {
        await tx
          .update(users)
          .set({ status: "active", failedLoginCount: 0, lockedUntil: null, updatedAt: sql`now()` })
          .where(eq(users.id, target.id));
        await audit({ ...base, action: "user.reactivated" }, tx);
        return {};
      }
      case "reset_password": {
        const tempPassword = generateTempPassword();
        await tx
          .update(users)
          .set({
            passwordHash: await hashPassword(tempPassword),
            mustChangePassword: true,
            failedLoginCount: 0,
            lockedUntil: null,
            updatedAt: sql`now()`,
          })
          .where(eq(users.id, target.id));
        await revokeUserSessions(target.id, undefined, tx);
        await audit({ ...base, action: "user.password_reset" }, tx);
        return { tempPassword };
      }
      case "revoke_devices": {
        await revokeAllDevices(tx, target.id);
        await audit({ ...base, action: "user.devices_revoked" }, tx);
        return {};
      }
      case "revoke_device": {
        const updated = await tx
          .update(devices)
          .set({ revokedAt: sql`now()`, recoveryKeyEnc: null })
          .where(and(eq(devices.id, input.deviceId), eq(devices.userId, target.id)))
          .returning({ id: devices.id });
        if (!updated.length) throw notFound();
        await tx.update(sessions).set({ revokedAt: sql`now()` }).where(eq(sessions.deviceId, input.deviceId));
        await tx.update(pushSubscriptions).set({ revokedAt: sql`now()` }).where(eq(pushSubscriptions.deviceId, input.deviceId));
        await audit({ ...base, action: "device.revoked", metadata: { deviceId: input.deviceId } }, tx);
        return {};
      }
      case "set_role": {
        if (
          target.role === "super_admin" &&
          input.role !== "super_admin" &&
          (await activeSuperAdminsExcluding(tx, target.id)) === 0
        )
          throw new ApiError(409, "last_super_admin", "The last active Super Admin cannot be demoted.");
        await tx.update(users).set({ role: input.role, updatedAt: sql`now()` }).where(eq(users.id, target.id));
        if (input.role !== "manager") {
          await tx.delete(adminPermissionGrants).where(eq(adminPermissionGrants.userId, target.id));
        }
        await revokeUserSessions(target.id, undefined, tx); // privilege change => fresh sessions
        await audit({ ...base, action: "user.role_changed", metadata: { from: target.role, to: input.role } }, tx);
        return {};
      }
      case "set_permissions": {
        if (target.role !== "manager") throw new ApiError(400, "not_manager", "Permissions can only be granted to Managers.");
        const invalid = input.permissions.filter((p) => !MANAGER_GRANTABLE.includes(p as AdminPermission));
        if (invalid.length) throw new ApiError(400, "invalid_permission", `Not grantable: ${invalid.join(", ")}`);
        await tx.delete(adminPermissionGrants).where(eq(adminPermissionGrants.userId, target.id));
        const unique = [...new Set(input.permissions)];
        if (unique.length) {
          await tx.insert(adminPermissionGrants).values(
            unique.map((permission) => ({ userId: target.id, permission, grantedBy: actor.user.id })),
          );
        }
        await audit({ ...base, action: "user.permissions_changed", metadata: { permissions: unique } }, tx);
        return {};
      }
    }
  });
}

/** Own devices (for the user's "Devices" screen). */
export async function revokeOwnDevice(userId: string, deviceId: string, req: Request) {
  const updated = await db()
    .update(devices)
    .set({ revokedAt: sql`now()`, recoveryKeyEnc: null })
    .where(and(eq(devices.id, deviceId), eq(devices.userId, userId), isNull(devices.revokedAt)))
    .returning({ id: devices.id });
  if (!updated.length) throw notFound();
  await db().update(sessions).set({ revokedAt: sql`now()` }).where(eq(sessions.deviceId, deviceId));
  await db().update(pushSubscriptions).set({ revokedAt: sql`now()` }).where(eq(pushSubscriptions.deviceId, deviceId));
  await audit({ action: "device.revoked", actorUserId: userId, targetUserId: userId, metadata: { deviceId }, req });
}

