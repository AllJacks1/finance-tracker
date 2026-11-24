import "server-only";
import type { DB, Tx } from "./db";
import { db } from "./db";
import { auditLogs } from "./db/schema";
import { clientIp } from "./http";

/**
 * Audit log for administrative and security events.
 * NEVER include financial data (amounts, account names, descriptions…) in metadata.
 */
export type AuditAction =
  | "setup.completed"
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "auth.password_changed"
  | "auth.device_key_issued"
  | "user.created"
  | "user.deactivated"
  | "user.reactivated"
  | "user.password_reset"
  | "user.devices_revoked"
  | "user.role_changed"
  | "user.permissions_changed"
  | "device.revoked"
  | "settings.updated"
  | "backup.triggered";

export async function audit(
  entry: {
    action: AuditAction;
    actorUserId?: string | null;
    targetUserId?: string | null;
    metadata?: Record<string, string | number | boolean | null | string[]>;
    req?: Request;
  },
  tx?: Tx | DB,
) {
  await (tx ?? db()).insert(auditLogs).values({
    action: entry.action,
    actorUserId: entry.actorUserId ?? null,
    targetUserId: entry.targetUserId ?? null,
    metadata: entry.metadata ?? {},
    ip: entry.req ? clientIp(entry.req) : null,
    userAgent: entry.req?.headers.get("user-agent")?.slice(0, 300) ?? null,
  });
}
