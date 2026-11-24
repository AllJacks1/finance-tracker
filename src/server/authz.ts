import "server-only";
import { eq } from "drizzle-orm";
import { effectivePermissions, type AdminPermission } from "@/lib/permissions";
import { db } from "./db";
import { adminPermissionGrants } from "./db/schema";
import { ApiError, forbidden, unauthorized } from "./http";
import { loadSession, readSessionToken, type SessionInfo } from "./auth/session";
import { ensureWorkspace } from "./workspace";

export interface AuthContext extends SessionInfo {
  permissions: Set<AdminPermission>;
}

export async function permissionsFor(userId: string, role: SessionInfo["user"]["role"]) {
  if (role === "user") return new Set<AdminPermission>();
  const grants = await db()
    .select({ p: adminPermissionGrants.permission })
    .from(adminPermissionGrants)
    .where(eq(adminPermissionGrants.userId, userId));
  return effectivePermissions(role, grants.map((g) => g.p));
}

/** Authenticate a request. Users who must change their password are blocked unless allowed. */
export async function requireAuth(
  req: Request,
  opts: { allowPasswordChangeRequired?: boolean } = {},
): Promise<AuthContext> {
  const r = await loadSession(readSessionToken(req));
  if (!r.ok) throw unauthorized(r.reason === "no_session" ? "unauthorized" : `session_${r.reason}`);
  if (r.session.deviceRevoked) throw new ApiError(401, "device_revoked", "This device was signed out");
  if (r.session.user.mustChangePassword && !opts.allowPasswordChangeRequired)
    throw new ApiError(403, "password_change_required", "Please change your password first");
  return { ...r.session, permissions: await permissionsFor(r.session.user.id, r.session.user.role) };
}

export async function requirePermission(req: Request, permission: AdminPermission): Promise<AuthContext> {
  const auth = await requireAuth(req);
  if (!auth.permissions.has(permission)) throw forbidden("missing_permission");
  return auth;
}

/**
 * Financial access: ONLY the owner of a workspace, through their own session.
 * The workspace is derived from the session — never from request parameters — so changing IDs
 * in a request can never select another user's workspace. RLS enforces the same rule in Postgres.
 */
export async function requireWorkspace(req: Request): Promise<AuthContext & { workspaceId: string }> {
  const auth = await requireAuth(req);
  if (!auth.deviceId) throw new ApiError(401, "device_required", "Sign in again on this device");
  const workspaceId = await ensureWorkspace(auth.user.id);
  return { ...auth, workspaceId };
}

/**
 * Same checks for Server Components (admin pages), reading the session cookie via next/headers.
 * Returns null if not signed in.
 */
export async function authFromCookies(): Promise<AuthContext | null> {
  const { cookies } = await import("next/headers");
  const { sessionCookieName } = await import("./auth/session");
  const token = (await cookies()).get(sessionCookieName())?.value ?? null;
  const r = await loadSession(token);
  if (!r.ok || r.session.deviceRevoked) return null;
  return { ...r.session, permissions: await permissionsFor(r.session.user.id, r.session.user.role) };
}
