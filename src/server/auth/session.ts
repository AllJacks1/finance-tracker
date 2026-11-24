import "server-only";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db, type Tx } from "../db";
import { devices, sessions, users } from "../db/schema";
import { env } from "../env";
import { randomToken, sha256Hex } from "../crypto";
import { clientIp } from "../http";

/**
 * Opaque session tokens. The browser gets a random 256-bit token in an httpOnly cookie; the DB
 * stores only SHA-256(token). Sessions have an idle timeout and an absolute lifetime.
 */
export function sessionCookieName(): string {
  return new URL(env().APP_URL).protocol === "https:" ? "__Host-ft_session" : "ft_session";
}

export function readSessionToken(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const name = sessionCookieName();
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  const secure = new URL(env().APP_URL).protocol === "https:";
  return [
    `${sessionCookieName()}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    `Max-Age=${maxAgeSeconds}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearSessionCookie(): string {
  return sessionCookie("", 0);
}

export async function createSession(
  input: { userId: string; deviceId: string | null; req: Request },
  tx?: Tx,
): Promise<{ token: string; cookie: string }> {
  const { SESSION_IDLE_DAYS, SESSION_ABSOLUTE_DAYS } = env();
  const token = randomToken(32);
  const now = Date.now();
  const idle = new Date(now + SESSION_IDLE_DAYS * 86_400_000).toISOString();
  const absolute = new Date(now + SESSION_ABSOLUTE_DAYS * 86_400_000).toISOString();
  await (tx ?? db()).insert(sessions).values({
    id: sha256Hex(token),
    userId: input.userId,
    deviceId: input.deviceId,
    idleExpiresAt: idle,
    absoluteExpiresAt: absolute,
    ip: clientIp(input.req),
    userAgent: input.req.headers.get("user-agent")?.slice(0, 300) ?? null,
  });
  return { token, cookie: sessionCookie(token, SESSION_ABSOLUTE_DAYS * 86_400) };
}

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "super_admin" | "manager" | "user";
  status: "active" | "deactivated";
  mustChangePassword: boolean;
};

export type SessionInfo = {
  sessionId: string;
  deviceId: string | null;
  deviceRevoked: boolean;
  user: SessionUser;
};

export type SessionFailure = "no_session" | "expired" | "revoked" | "user_inactive";

export async function loadSession(
  token: string | null,
): Promise<{ ok: true; session: SessionInfo } | { ok: false; reason: SessionFailure }> {
  if (!token) return { ok: false, reason: "no_session" };
  const id = sha256Hex(token);
  const rows = await db()
    .select({
      sessionId: sessions.id,
      revokedAt: sessions.revokedAt,
      idleExpiresAt: sessions.idleExpiresAt,
      absoluteExpiresAt: sessions.absoluteExpiresAt,
      lastSeenAt: sessions.lastSeenAt,
      deviceId: sessions.deviceId,
      deviceRevokedAt: devices.revokedAt,
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        status: users.status,
        mustChangePassword: users.mustChangePassword,
      },
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(devices, eq(devices.id, sessions.deviceId))
    .where(eq(sessions.id, id))
    .limit(1);
  const s = rows[0];
  if (!s) return { ok: false, reason: "no_session" };
  if (s.revokedAt) return { ok: false, reason: "revoked" };
  const now = Date.now();
  if (new Date(s.idleExpiresAt).getTime() < now || new Date(s.absoluteExpiresAt).getTime() < now)
    return { ok: false, reason: "expired" };
  if (s.user.status !== "active") return { ok: false, reason: "user_inactive" };

  // Sliding idle expiry, written at most every 5 minutes.
  if (now - new Date(s.lastSeenAt).getTime() > 5 * 60_000) {
    const idle = new Date(Math.min(now + env().SESSION_IDLE_DAYS * 86_400_000, new Date(s.absoluteExpiresAt).getTime()));
    await db()
      .update(sessions)
      .set({ lastSeenAt: new Date(now).toISOString(), idleExpiresAt: idle.toISOString() })
      .where(eq(sessions.id, id));
    if (s.deviceId) {
      await db().update(devices).set({ lastSeenAt: new Date(now).toISOString() }).where(eq(devices.id, s.deviceId));
    }
  }
  return {
    ok: true,
    session: {
      sessionId: s.sessionId,
      deviceId: s.deviceId,
      deviceRevoked: !!s.deviceRevokedAt,
      user: s.user,
    },
  };
}

export async function revokeSession(sessionId: string) {
  await db().update(sessions).set({ revokedAt: sql`now()` }).where(eq(sessions.id, sessionId));
}

export async function revokeUserSessions(userId: string, exceptSessionId?: string, tx?: Tx) {
  await (tx ?? db())
    .update(sessions)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        exceptSessionId ? ne(sessions.id, exceptSessionId) : undefined,
      ),
    );
}
