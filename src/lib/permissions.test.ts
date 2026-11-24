import { describe, expect, it } from "vitest";
import {
  ADMIN_PERMISSIONS,
  canActOn,
  creatableRoles,
  effectivePermissions,
  MANAGER_GRANTABLE,
  type AdminPermission,
  type Role,
  type TargetAction,
} from "./permissions";

const SUPER_ONLY: AdminPermission[] = ["roles.assign", "permissions.grant", "system.settings", "backups.trigger"];

describe("permission matrix", () => {
  it("super admin has every admin permission", () => {
    expect([...effectivePermissions("super_admin", [])].sort()).toEqual([...ADMIN_PERMISSIONS].sort());
  });

  it("regular users have no admin permissions, even if grants exist", () => {
    expect(effectivePermissions("user", [...ADMIN_PERMISSIONS]).size).toBe(0);
  });

  it("managers have only what is granted, and never super-admin-only permissions", () => {
    expect(effectivePermissions("manager", []).size).toBe(0);
    for (const p of MANAGER_GRANTABLE) expect(effectivePermissions("manager", [p]).has(p)).toBe(true);
    for (const p of SUPER_ONLY) expect(effectivePermissions("manager", [p]).has(p)).toBe(false);
  });

  it("no permission name refers to financial data", () => {
    for (const p of ADMIN_PERMISSIONS) expect(p).not.toMatch(/financ|transaction|account\.|budget|ledger/);
  });

  it("only super admins can create admin roles", () => {
    expect(creatableRoles(effectivePermissions("super_admin", []))).toEqual(["user", "manager", "super_admin"]);
    expect(creatableRoles(effectivePermissions("manager", [...MANAGER_GRANTABLE]))).toEqual(["user"]);
  });

  const actions: TargetAction[] = ["deactivate", "reactivate", "reset_password", "revoke_devices", "set_role", "set_permissions"];
  const roles: Role[] = ["super_admin", "manager", "user"];
  const actorOf = (role: Role, grants: string[] = [...MANAGER_GRANTABLE]) => ({
    id: "actor",
    role,
    permissions: effectivePermissions(role, grants),
  });

  it.each(roles.flatMap((target) => actions.map((a) => [target, a] as const)))(
    "matrix: target=%s action=%s",
    (targetRole, action) => {
      const target = { id: "target", role: targetRole };
      // Super admin may act on anyone else
      expect(canActOn(actorOf("super_admin"), target, action)).toBe(true);
      // Fully-granted manager: only on regular users, and never role/permission changes
      const mgr = canActOn(actorOf("manager"), target, action);
      const expected = targetRole === "user" && action !== "set_role" && action !== "set_permissions";
      expect(mgr).toBe(expected);
      // Manager without grants: nothing
      expect(canActOn(actorOf("manager", []), target, action)).toBe(false);
      // Regular user: nothing
      expect(canActOn(actorOf("user"), target, action)).toBe(false);
    },
  );

  it("nobody can deactivate themselves or change their own role/permissions", () => {
    const me = { ...actorOf("super_admin"), id: "same" };
    expect(canActOn(me, { id: "same", role: "super_admin" }, "deactivate")).toBe(false);
    expect(canActOn(me, { id: "same", role: "super_admin" }, "set_role")).toBe(false);
    expect(canActOn(me, { id: "same", role: "super_admin" }, "set_permissions")).toBe(false);
    expect(canActOn(me, { id: "same", role: "super_admin" }, "reset_password")).toBe(true);
  });
});
