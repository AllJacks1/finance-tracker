import "server-only";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { audit } from "./audit";
import { hashPassword, passwordProblem } from "./auth/password";
import { rateLimit } from "./auth/rate-limit";
import { safeEqual } from "./crypto";
import { db } from "./db";
import { systemSetup, users } from "./db/schema";
import { env } from "./env";
import { ApiError, clientIp } from "./http";

export async function isSetupComplete(): Promise<boolean> {
  const rows = await db().select({ id: systemSetup.id }).from(systemSetup).limit(1);
  return rows.length > 0;
}

export const setupInput = z.object({
  setupToken: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(254)),
  password: z.string().min(1).max(256),
});

/**
 * One-time creation of the first Super Admin.
 * - Requires SETUP_TOKEN (prevents a stranger claiming a fresh deployment).
 * - Serialised with a transaction-scoped advisory lock; the singleton `system_setup` row makes a
 *   second completion impossible even without the lock.
 */
export async function performSetup(input: z.infer<typeof setupInput>, req: Request) {
  const rl = await rateLimit(`setup:${clientIp(req) ?? "unknown"}`, 10, 900);
  if (!rl.allowed) throw new ApiError(429, "rate_limited", "Too many attempts. Try again later.");

  const expected = env().SETUP_TOKEN;
  if (!expected) throw new ApiError(503, "setup_token_missing", "SETUP_TOKEN is not configured on the server.");
  if (!safeEqual(input.setupToken, expected)) throw new ApiError(403, "bad_setup_token", "Setup token is incorrect.");

  const problem = passwordProblem(input.password, input);
  if (problem) throw new ApiError(400, "weak_password", problem);
  const passwordHash = await hashPassword(input.password);

  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ft_initial_setup'))`);
    const done = await tx.select({ id: systemSetup.id }).from(systemSetup).limit(1);
    if (done.length) throw new ApiError(409, "setup_complete", "Setup has already been completed.");
    const admins = await tx.select({ id: users.id }).from(users).where(eq(users.role, "super_admin")).limit(1);
    if (admins.length) throw new ApiError(409, "setup_complete", "Setup has already been completed.");

    const [user] = await tx
      .insert(users)
      .values({ email: input.email, name: input.name, passwordHash, role: "super_admin" })
      .returning({ id: users.id });
    await tx.insert(systemSetup).values({ completedBy: user!.id });
    await audit({ action: "setup.completed", actorUserId: user!.id, targetUserId: user!.id, req }, tx);
    return { userId: user!.id };
  });
}
