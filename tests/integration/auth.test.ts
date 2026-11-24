import { beforeAll, describe, expect, it } from "vitest";
import * as setupRoute from "@/app/api/setup/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as logoutRoute from "@/app/api/auth/logout/route";
import * as meRoute from "@/app/api/auth/me/route";
import * as deviceKeyRoute from "@/app/api/auth/device-key/route";
import * as usersRoute from "@/app/api/admin/users/route";
import * as userRoute from "@/app/api/admin/users/[id]/route";
import * as auditRoute from "@/app/api/admin/audit/route";
import * as healthRoute from "@/app/api/admin/health/route";
import * as settingsRoute from "@/app/api/admin/settings/route";
import { adminSql, call, createUserAndLogin, login, passwordFor, resetDatabase, SETUP_TOKEN, STRONG, type Handler } from "./helpers";

const h = (f: unknown) => f as Handler;

describe("first-time setup", () => {
  beforeAll(resetDatabase);

  it("reports setup not complete and rejects a wrong token", async () => {
    expect((await call(h(setupRoute.GET))).body).toEqual({ setupComplete: false });
    const r = await call(h(setupRoute.POST), {
      body: { setupToken: "wrong-token-xxxxxxx", name: "X", email: "x@example.test", password: STRONG },
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("bad_setup_token");
  });

  it("rejects weak passwords", async () => {
    const r = await call(h(setupRoute.POST), {
      body: { setupToken: SETUP_TOKEN, name: "X", email: "x@example.test", password: "short" },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("weak_password");
  });

  it("creates exactly one Super Admin under 10 concurrent requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        call(h(setupRoute.POST), {
          body: { setupToken: SETUP_TOKEN, name: `Admin ${i}`, email: `admin${i}@example.test`, password: STRONG },
        }),
      ),
    );
    const created = results.filter((r) => r.status === 201);
    expect(created).toHaveLength(1);
    expect(results.filter((r) => r.status !== 201).every((r) => r.status === 409 || r.status === 404)).toBe(true);
    const sql = adminSql();
    const admins = await sql`select count(*)::int as n from users where role = 'super_admin'`;
    await sql.end();
    expect(admins[0]!.n).toBe(1);
  });

  it("cannot be run again afterwards", async () => {
    expect((await call(h(setupRoute.GET))).body).toEqual({ setupComplete: true });
    const r = await call(h(setupRoute.POST), {
      body: { setupToken: SETUP_TOKEN, name: "Late", email: "late@example.test", password: STRONG },
    });
    expect(r.status).toBe(404);
  });

  it("rejects cross-site POSTs (CSRF origin check)", async () => {
    const r = await call(h(loginRoute.POST), {
      origin: "https://evil.example",
      body: { email: "a@b.c", password: "x", installId: crypto.randomUUID() },
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("bad_origin");
  });
});

describe("login, logout and sessions", () => {
  let adminEmail = "";
  beforeAll(async () => {
    const sql = adminSql();
    const [a] = await sql`select email from users where role = 'super_admin'`;
    await sql.end();
    adminEmail = a!.email;
  });

  it("logs in, returns device + recovery key, and stores only a hashed session token", async () => {
    const s = await login(adminEmail, STRONG);
    expect(s.cookie).toMatch(/^ft_session=/);
    expect(Buffer.from(s.recoveryKey, "base64")).toHaveLength(32);
    const token = decodeURIComponent(s.cookie.split("=")[1]!);
    const sql = adminSql();
    const rows = await sql`select id from sessions where id = ${token}`;
    await sql.end();
    expect(rows).toHaveLength(0); // raw token is never stored
    const me = await call(h(meRoute.GET), { cookie: s.cookie });
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe("super_admin");
    expect(me.body.permissions).toContain("users.create");
  });

  it("gives a generic error for wrong password and unknown email", async () => {
    const a = await call(h(loginRoute.POST), { body: { email: adminEmail, password: "nope-nope-nope", installId: crypto.randomUUID() } });
    const b = await call(h(loginRoute.POST), { body: { email: "nobody@example.test", password: "nope-nope-nope", installId: crypto.randomUUID() } });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it("logout revokes the session", async () => {
    const s = await login(adminEmail, STRONG);
    expect((await call(h(logoutRoute.POST), { cookie: s.cookie })).status).toBe(200);
    expect((await call(h(meRoute.GET), { cookie: s.cookie })).status).toBe(401);
  });

  it("rate-limits repeated logins from one IP", async () => {
    let last = 0;
    for (let i = 0; i < 32; i++) {
      last = (await call(h(loginRoute.POST), { ip: "192.0.2.9", body: { email: "x@example.test", password: "wrong-password-1", installId: crypto.randomUUID() } })).status;
    }
    expect(last).toBe(429);
  });

  it("locks an account after repeated failures", async () => {
    const sql = adminSql();
    await sql`update users set failed_login_count = 0, locked_until = null`;
    await sql.end();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await call(h(loginRoute.POST), { body: { email: adminEmail, password: "wrong-password-1", installId: crypto.randomUUID() } })).status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
    // Even the correct password is refused while locked.
    const ok = await call(h(loginRoute.POST), { body: { email: adminEmail, password: STRONG, installId: crypto.randomUUID() } });
    expect(ok.status).toBe(429);
    const sql2 = adminSql();
    await sql2`update users set failed_login_count = 0, locked_until = null`;
    await sql2.end();
  });
});

describe("user administration and role-based access", () => {
  let admin: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    const sql = adminSql();
    const [a] = await sql`select email from users where role = 'super_admin'`;
    await sql.end();
    admin = await login(a!.email, STRONG);
  });

  it("admin creates a user who must change the temporary password first", async () => {
    const created = await call(h(usersRoute.POST), { cookie: admin.cookie, body: { name: "Ana", email: "ana@example.test" } });
    expect(created.status).toBe(201);
    expect(created.body.tempPassword).toMatch(/^[\w]{6}-[\w]{6}-[\w]{6}$/);
    const s = await login("ana@example.test", created.body.tempPassword);
    expect(s.user.mustChangePassword).toBe(true);
    // Blocked from everything except password change / me
    const dk = await call(h(deviceKeyRoute.POST), { cookie: s.cookie, body: {} });
    expect(dk.status).toBe(403);
    expect(dk.body.error.code).toBe("password_change_required");
    const dup = await call(h(usersRoute.POST), { cookie: admin.cookie, body: { name: "Ana2", email: "ANA@example.test" } });
    expect(dup.status).toBe(409);
  });

  it("regular users and managers without grants cannot use admin endpoints", async () => {
    const u = await createUserAndLogin(admin.cookie, "bob@example.test");
    for (const [route, method] of [[usersRoute.GET, "GET"], [auditRoute.GET, "GET"], [healthRoute.GET, "GET"], [settingsRoute.GET, "GET"]] as const) {
      const r = await call(h(route), { cookie: u.cookie, method });
      expect(r.status).toBe(403);
    }
    const create = await call(h(usersRoute.POST), { cookie: u.cookie, body: { name: "Eve", email: "eve@example.test" } });
    expect(create.status).toBe(403);
    const m = await createUserAndLogin(admin.cookie, "mgr@example.test", "manager");
    expect((await call(h(usersRoute.GET), { cookie: m.cookie })).status).toBe(403);
  });

  it("managers get exactly the permissions granted, and cannot act on admins", async () => {
    const sql = adminSql();
    const [m] = await sql`select id from users where email = 'mgr@example.test'`;
    const [root] = await sql`select id from users where role = 'super_admin'`;
    await sql.end();
    const grant = await call(h(userRoute.PATCH), {
      method: "PATCH",
      cookie: admin.cookie,
      params: { id: m!.id },
      body: { action: "set_permissions", permissions: ["users.view", "users.create", "users.deactivate"] },
    });
    expect(grant.status).toBe(200);
    const badGrant = await call(h(userRoute.PATCH), {
      method: "PATCH",
      cookie: admin.cookie,
      params: { id: m!.id },
      body: { action: "set_permissions", permissions: ["roles.assign"] },
    });
    expect(badGrant.status).toBe(400);

    const mgr = await login("mgr@example.test", passwordFor("mgr@example.test"));
    expect((await call(h(usersRoute.GET), { cookie: mgr.cookie })).status).toBe(200);
    expect((await call(h(auditRoute.GET), { cookie: mgr.cookie })).status).toBe(403);
    // Cannot create admins
    const mkAdmin = await call(h(usersRoute.POST), { cookie: mgr.cookie, body: { name: "Z", email: "z@example.test", role: "super_admin" } });
    expect(mkAdmin.status).toBe(403);
    // Cannot deactivate the Super Admin
    const deact = await call(h(userRoute.PATCH), { method: "PATCH", cookie: mgr.cookie, params: { id: root!.id }, body: { action: "deactivate" } });
    expect(deact.status).toBe(403);
  });

  it("deactivation revokes sessions and devices; reactivation allows login again", async () => {
    const c = await createUserAndLogin(admin.cookie, "carl@example.test");
    const r = await call(h(userRoute.PATCH), { method: "PATCH", cookie: admin.cookie, params: { id: c.id }, body: { action: "deactivate" } });
    expect(r.status).toBe(200);
    expect((await call(h(meRoute.GET), { cookie: c.cookie })).status).toBe(401);
    const again = await call(h(loginRoute.POST), { body: { email: "carl@example.test", password: c.password, installId: crypto.randomUUID() } });
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe("account_deactivated");
    await call(h(userRoute.PATCH), { method: "PATCH", cookie: admin.cookie, params: { id: c.id }, body: { action: "reactivate" } });
    expect((await login("carl@example.test", c.password)).deviceId).toBeTruthy();
  });

  it("password reset issues a temp password and revokes sessions", async () => {
    const d = await createUserAndLogin(admin.cookie, "dina@example.test");
    const r = await call(h(userRoute.PATCH), { method: "PATCH", cookie: admin.cookie, params: { id: d.id }, body: { action: "reset_password" } });
    expect(r.body.tempPassword).toBeTruthy();
    expect((await call(h(meRoute.GET), { cookie: d.cookie })).status).toBe(401);
    expect((await login("dina@example.test", r.body.tempPassword)).user.mustChangePassword).toBe(true);
  });

  it("the last Super Admin cannot be demoted or deactivate themselves", async () => {
    const sql = adminSql();
    const [root] = await sql`select id from users where role = 'super_admin'`;
    await sql.end();
    const self = await call(h(userRoute.PATCH), { method: "PATCH", cookie: admin.cookie, params: { id: root!.id }, body: { action: "deactivate" } });
    expect(self.status).toBe(403);
    // A second super admin cannot demote the first if it would leave none... promote one then try.
    const e = await createUserAndLogin(admin.cookie, "erin@example.test");
    await call(h(userRoute.PATCH), { method: "PATCH", cookie: admin.cookie, params: { id: e.id }, body: { action: "set_role", role: "super_admin" } });
    const erin = await login("erin@example.test", e.password);
    const demoteRoot = await call(h(userRoute.PATCH), { method: "PATCH", cookie: erin.cookie, params: { id: root!.id }, body: { action: "set_role", role: "user" } });
    expect(demoteRoot.status).toBe(200);
    // Now erin is the only super admin; root (now a user) can't do anything, and erin can't be demoted.
    const sql2 = adminSql();
    const [erinRow] = await sql2`select id from users where email = 'erin@example.test'`;
    await sql2`update users set role = 'super_admin' where id = ${root!.id}`; // restore for later tests
    await sql2`update users set role = 'super_admin' where id = ${erinRow!.id}`;
    const [rootRow] = await sql2`select email from users where id = ${root!.id}`;
    await sql2.end();
    // The role change revoked root's sessions (privilege change => fresh session).
    expect((await call(h(meRoute.GET), { cookie: admin.cookie })).status).toBe(401);
    admin = await login(rootRow!.email, STRONG);
  });

  it("two Super Admins demoting each other concurrently can never leave zero Super Admins", async () => {
    const sql = adminSql();
    const [root] = await sql`select id, email from users where role = 'super_admin' and email <> 'erin@example.test' limit 1`;
    const [erinRow] = await sql`select id from users where email = 'erin@example.test'`;
    await sql.end();
    const erin = await login("erin@example.test", passwordFor("erin@example.test"));
    const [a, b] = await Promise.all([
      call(h(userRoute.PATCH), { method: "PATCH", cookie: admin.cookie, params: { id: erinRow!.id }, body: { action: "set_role", role: "user" } }),
      call(h(userRoute.PATCH), { method: "PATCH", cookie: erin.cookie, params: { id: root!.id }, body: { action: "set_role", role: "user" } }),
    ]);
    // The loser is refused either by the last-Super-Admin check (409) or, if it lost the race
    // earlier, because the winner's role change already revoked its session (401).
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect([401, 409]).toContain(statuses[1]);
    const sql2 = adminSql();
    const [{ n }] = await sql2`select count(*)::int as n from users where role = 'super_admin' and status = 'active'`;
    await sql2`update users set role = 'super_admin' where id in (${root!.id}, ${erinRow!.id})`;
    await sql2.end();
    expect(n).toBe(1);
    admin = await login(root!.email, STRONG);
  });

  it("audit log records admin actions without financial details", async () => {
    const r = await call(h(auditRoute.GET), { cookie: admin.cookie });
    expect(r.status).toBe(200);
    const actions = r.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["setup.completed", "user.created", "user.deactivated", "user.password_reset"]));
    const allMeta = JSON.stringify(r.body.entries.map((e: { metadata: unknown }) => e.metadata));
    expect(allMeta).not.toMatch(/amount|balance|description/i);
  });

  it("device key requires re-authentication once offline PIN access is enabled", async () => {
    const f = await createUserAndLogin(admin.cookie, "fay@example.test");
    const first = await call(h(deviceKeyRoute.POST), { cookie: f.cookie, body: {} });
    expect(first.status).toBe(200);
    expect(first.body.recoveryKey).toBe(f.recoveryKey);
    const enable = await call(h(deviceKeyRoute.POST), { cookie: f.cookie, body: { setOfflineEnabled: true } });
    expect(enable.body.offlineEnabled).toBe(true);
    const noPw = await call(h(deviceKeyRoute.POST), { cookie: f.cookie, body: {} });
    expect(noPw.status).toBe(403);
    expect(noPw.body.error.code).toBe("reauth_required");
    const disableNoPw = await call(h(deviceKeyRoute.POST), { cookie: f.cookie, body: { setOfflineEnabled: false } });
    expect(disableNoPw.status).toBe(403);
    const withPw = await call(h(deviceKeyRoute.POST), { cookie: f.cookie, body: { password: f.password } });
    expect(withPw.status).toBe(200);
  });

  it("revoked devices are rejected and reset on next login", async () => {
    const g = await createUserAndLogin(admin.cookie, "gil@example.test");
    const r = await call(h(userRoute.PATCH), { method: "PATCH", cookie: admin.cookie, params: { id: g.id }, body: { action: "revoke_device", deviceId: g.deviceId } });
    expect(r.status).toBe(200);
    expect((await call(h(meRoute.GET), { cookie: g.cookie })).status).toBe(401);
    // Same browser install logs in again: told to wipe local data, gets a NEW recovery key.
    const sql = adminSql();
    const [dev] = await sql`select install_id from devices where id = ${g.deviceId}`;
    await sql.end();
    const again = await login("gil@example.test", g.password, dev!.install_id);
    expect(again.deviceId).toBe(g.deviceId);
    expect((again as unknown as { deviceReset: boolean }).deviceReset).toBe(true);
    expect(again.recoveryKey).not.toBe(g.recoveryKey);
  });
});
