import "server-only";
import { sql } from "drizzle-orm";
import { db } from "../db";

/**
 * Fixed-window rate limiter stored in Postgres (works across multiple app replicas).
 * Returns whether the call is allowed and, if not, how many seconds to wait.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; retryAfter: number }> {
  const rows = await db().execute<{ count: number; window_started_at: string }>(sql`
    INSERT INTO rate_limits (key, count, window_started_at)
    VALUES (${key}, 1, now())
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_started_at < now() - make_interval(secs => ${windowSeconds})
                   THEN 1 ELSE rate_limits.count + 1 END,
      window_started_at = CASE WHEN rate_limits.window_started_at < now() - make_interval(secs => ${windowSeconds})
                   THEN now() ELSE rate_limits.window_started_at END
    RETURNING count, window_started_at
  `);
  const row = rows[0]!;
  if (row.count <= limit) return { allowed: true, retryAfter: 0 };
  const started = new Date(row.window_started_at).getTime();
  const retryAfter = Math.max(1, Math.ceil((started + windowSeconds * 1000 - Date.now()) / 1000));
  return { allowed: false, retryAfter };
}

/** Progressive account lockout after repeated failed logins: 5 → 1 min, 6 → 2 min … max 60 min. */
export function lockoutSeconds(failedCount: number): number {
  if (failedCount < 5) return 0;
  return Math.min(60 * 2 ** (failedCount - 5), 3600);
}
