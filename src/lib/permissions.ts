/**
 * Permission matrix (shared by server enforcement and UI).
 *
 * IMPORTANT: there is deliberately NO permission that grants access to financial data.
 * Financial access is decided only by workspace ownership (session user = workspace owner),
 * see server/authz.ts. Administrative permissions never imply financial access.
 */
export type Role = "super_admin" | "manager" | "user";

export const ADMIN_PERMISSIONS = [
  "users.view",
  "users.create",
  "users.deactivate",
  "users.reset_password",
  "users.revoke_devices",
  "roles.assign",
  "permissions.grant",
  "system.settings",
  "system.health",
  "backups.view",
  "backups.trigger",
  "audit.view",
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

/** Permissions a Super Admin may grant to a Manager. Everything else is Super-Admin-only. */
export const MANAGER_GRANTABLE: readonly AdminPermission[] = [
  "users.view",
  "users.create",
  "users.deactivate",
  "users.reset_password",
  "users.revoke_devices",
  "system.health",
  "backups.view",
  "audit.view",
];

export const PERMISSION_LABELS: Record<AdminPermission, string> = {
  "users.view": "View users",
  "users.create": "Create users",
  "users.deactivate": "Deactivate / reactivate users",
  "users.reset_password": "Reset user passwords",
  "users.revoke_devices": "Revoke user devices",
  "roles.assign": "Assign roles",
  "permissions.grant": "Grant admin permissions",
  "system.settings": "Manage system settings",
  "system.health": "View system health & sync failures",
  "backups.view": "View backup status",
  "backups.trigger": "Run backups manually",
  "audit.view": "View audit log",
};

export function effectivePermissions(role: Role, grants: readonly string[]): Set<AdminPermission> {
  if (role === "super_admin") return new Set(ADMIN_PERMISSIONS);
  if (role === "manager") {
    return new Set(MANAGER_GRANTABLE.filter((p) => grants.includes(p)));
  }
  return new Set();
}

export function isAdminRole(role: Role): boolean {
  return role === "super_admin" || role === "manager";
}

/** Actions on another user's account that are restricted by the target's role. */
export type TargetAction =
  | "deactivate"
  | "reactivate"
  | "reset_password"
  | "revoke_devices"
  | "set_role"
  | "set_permissions";

const ACTION_PERMISSION: Record<TargetAction, AdminPermission> = {
  deactivate: "users.deactivate",
  reactivate: "users.deactivate",
  reset_password: "users.reset_password",
  revoke_devices: "users.revoke_devices",
  set_role: "roles.assign",
  set_permissions: "permissions.grant",
};

export function permissionForAction(action: TargetAction): AdminPermission {
  return ACTION_PERMISSION[action];
}

/**
 * May `actor` perform `action` on `target`? (The last-Super-Admin rule is checked server-side.)
 * - Requires the matching permission.
 * - Managers may only act on regular users.
 * - Nobody may deactivate themselves or change their own role/permissions.
 */
export function canActOn(
  actor: { id: string; role: Role; permissions: Set<AdminPermission> },
  target: { id: string; role: Role },
  action: TargetAction,
): boolean {
  if (!actor.permissions.has(ACTION_PERMISSION[action])) return false;
  if (actor.role !== "super_admin" && target.role !== "user") return false;
  if (
    actor.id === target.id &&
    (action === "deactivate" || action === "set_role" || action === "set_permissions")
  )
    return false;
  return true;
}

/** Which roles may `actor` create? Only Super Admins (roles.assign) can create admin roles. */
export function creatableRoles(actorPermissions: Set<AdminPermission>): Role[] {
  return actorPermissions.has("roles.assign") ? ["user", "manager", "super_admin"] : ["user"];
}
