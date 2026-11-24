import "server-only";
import { count, desc, eq, gt, isNull, sql, sum } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit";
import type { AuthContext } from "../authz";
import { db } from "../db";
import { auditLogs, backupRuns, devices, sessions, syncEvents, systemSettings, users } from "../db/schema";
import { storageConfigured } from "../storage";

/** System health for admins: counts and statuses only — never financial data. */
export async function systemHealth() {
  const t0 = Date.now();
  await db().execute(sql`select 1`);
  const dbLatencyMs = Date.now() - t0;
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [userCounts] = await db()
    .select({ total: count(), active: sum(sql<number>`case when ${users.status} = 'active' then 1 else 0 end`) })
    .from(users);
  const [activeSessions] = await db()
    .select({ n: count() })
    .from(sessions)
    .where(sql`${sessions.revokedAt} is null and ${sessions.idleExpiresAt} > now()`);
  const [activeDevices] = await db().select({ n: count() }).from(devices).where(isNull(devices.revokedAt));
  const [sync] = await db()
    .select({
      pushes: count(),
      applied: sum(syncEvents.applied),
      conflicts: sum(syncEvents.conflicts),
      rejected: sum(syncEvents.rejected),
      errors: sum(sql<number>`case when ${syncEvents.errorCode} is not null then 1 else 0 end`),
    })
    .from(syncEvents)
    .where(gt(syncEvents.createdAt, since));
  const recentFailures = await db()
    .select({
      at: syncEvents.createdAt,
      userEmail: users.email,
      kind: syncEvents.kind,
      conflicts: syncEvents.conflicts,
      rejected: syncEvents.rejected,
      errorCode: syncEvents.errorCode,
    })
    .from(syncEvents)
    .leftJoin(users, eq(users.id, syncEvents.userId))
    .where(sql`${syncEvents.createdAt} > ${since} and (${syncEvents.rejected} > 0 or ${syncEvents.conflicts} > 0 or ${syncEvents.errorCode} is not null)`)
    .orderBy(desc(syncEvents.createdAt))
    .limit(20);
  const [lastBackup] = await db().select().from(backupRuns).orderBy(desc(backupRuns.startedAt)).limit(1);
  const [lastSuccess] = await db()
    .select()
    .from(backupRuns)
    .where(eq(backupRuns.status, "succeeded"))
    .orderBy(desc(backupRuns.startedAt))
    .limit(1);
  return {
    database: { ok: true, latencyMs: dbLatencyMs },
    users: { total: userCounts?.total ?? 0, active: Number(userCounts?.active ?? 0) },
    activeSessions: activeSessions?.n ?? 0,
    activeDevices: activeDevices?.n ?? 0,
    sync7d: {
      pushes: sync?.pushes ?? 0,
      applied: Number(sync?.applied ?? 0),
      conflicts: Number(sync?.conflicts ?? 0),
      rejected: Number(sync?.rejected ?? 0),
      errors: Number(sync?.errors ?? 0),
      recentFailures,
    },
    backups: {
      last: lastBackup ?? null,
      lastSuccess: lastSuccess ?? null,
      recentSuccess: !!lastSuccess && Date.now() - new Date(lastSuccess.startedAt).getTime() < 36 * 3600_000,
      storageConfigured: storageConfigured(),
    },
    version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? process.env.npm_package_version ?? "dev",
  };
}

export async function listAudit(limit = 100, before?: number) {
  const q = db()
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      createdAt: auditLogs.createdAt,
      metadata: auditLogs.metadata,
      ip: auditLogs.ip,
      actorEmail: sql<string | null>`(select email from users where id = ${auditLogs.actorUserId})`,
      targetEmail: sql<string | null>`(select email from users where id = ${auditLogs.targetUserId})`,
    })
    .from(auditLogs)
    .orderBy(desc(auditLogs.id))
    .limit(Math.min(limit, 500));
  return before ? q.where(sql`${auditLogs.id} < ${before}`) : q;
}

export const SETTINGS_SCHEMA = z.object({
  loginNotice: z.string().trim().max(300).default(""),
  backupRetentionDays: z.coerce.number().int().min(7).max(365).default(30),
});
export type SystemSettings = z.infer<typeof SETTINGS_SCHEMA>;

export async function getSettings(): Promise<SystemSettings> {
  const rows = await db().select().from(systemSettings);
  const obj = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return SETTINGS_SCHEMA.parse(obj);
}

export async function updateSettings(actor: AuthContext, input: Partial<SystemSettings>, req: Request) {
  const parsed = SETTINGS_SCHEMA.partial().parse(input);
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined) continue;
    await db()
      .insert(systemSettings)
      .values({ key, value, updatedBy: actor.user.id })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedBy: actor.user.id, updatedAt: sql`now()` } });
  }
  await audit({ action: "settings.updated", actorUserId: actor.user.id, metadata: { keys: Object.keys(parsed) }, req });
  return getSettings();
}
