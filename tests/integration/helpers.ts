import postgres from "postgres";
import { randomUUID } from "node:crypto";

export const ORIGIN = "http://localhost:3000";

/** Wipe every table (as the privileged migration user) so each test file starts clean. */
export async function resetDatabase() {
  const admin = postgres(process.env.TEST_MIGRATION_DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    const tables = await admin<{ tablename: string }[]>`
      select tablename from pg_tables where schemaname = 'public'`;
    if (tables.length) {
      await admin.unsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
    }
  } finally {
    await admin.end();
  }
}

/** Privileged connection, for assertions that need to look past RLS. */
export function adminSql() {
  return postgres(process.env.TEST_MIGRATION_DATABASE_URL!, { max: 1, onnotice: () => {} });
}

/** Restricted ft_app connection, for asserting what the app role can and cannot see. */
export function appSql() {
  return postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
}

type Handler = (req: Request, ctx: never) => Promise<Response>;

export interface Call {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  cookie: string | null;
}

export async function call(
  handler: Handler,
  opts: {
    method?: string;
    path?: string;
    body?: unknown;
    cookie?: string | null;
    params?: Record<string, string>;
    origin?: string | null;
    ip?: string;
  } = {},
): Promise<Call> {
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const headers = new Headers({ "content-type": "application/json", "x-forwarded-for": opts.ip ?? `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  if (opts.origin !== null) headers.set("origin", opts.origin ?? ORIGIN);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  const req = new Request(`${ORIGIN}${opts.path ?? "/api/test"}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) } as never);
  const text = await res.text();
  const setCookie = res.headers.get("set-cookie");
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    cookie: setCookie ? setCookie.split(";")[0]! : null,
  };
}

export const SETUP_TOKEN = "test-setup-token-123456";
export const STRONG = "Correct-Horse-Battery-9";
/** Deterministic per-user test password that never contains the email name. */
export const passwordFor = (email: string) => `${STRONG}-${Buffer.from(email).toString("hex").slice(0, 8)}`;

export async function setupAdmin() {
  const { POST } = await import("@/app/api/setup/route");
  const r = await call(POST as Handler, {
    body: { setupToken: SETUP_TOKEN, name: "Root Admin", email: "root@example.test", password: STRONG },
  });
  if (r.status !== 201) throw new Error(`setup failed ${r.status} ${JSON.stringify(r.body)}`);
}

export async function login(email: string, password: string, installId: string = randomUUID()) {
  const { POST } = await import("@/app/api/auth/login/route");
  const r = await call(POST as Handler, { body: { email, password, installId, deviceLabel: "Test" } });
  if (r.status !== 200) throw new Error(`login failed ${r.status} ${JSON.stringify(r.body)}`);
  return { cookie: r.cookie!, ...r.body } as {
    cookie: string;
    deviceId: string;
    recoveryKey: string;
    user: { id: string; mustChangePassword: boolean };
  };
}

/** Admin creates a user, who logs in and sets a permanent password. Returns their session. */
export async function createUserAndLogin(adminCookie: string, email: string, role = "user") {
  const users = await import("@/app/api/admin/users/route");
  const created = await call(users.POST as Handler, { cookie: adminCookie, body: { name: email.split("@")[0], email, role } });
  if (created.status !== 201) throw new Error(`create failed ${created.status} ${JSON.stringify(created.body)}`);
  const first = await login(email, created.body.tempPassword);
  const cp = await import("@/app/api/auth/change-password/route");
  const changed = await call(cp.POST as Handler, {
    cookie: first.cookie,
    body: { currentPassword: created.body.tempPassword, newPassword: passwordFor(email) },
  });
  if (changed.status !== 200) throw new Error(`change pw failed ${JSON.stringify(changed.body)}`);
  const session = await login(email, passwordFor(email));
  return { ...session, id: created.body.id as string, password: passwordFor(email) };
}

export type { Handler };
