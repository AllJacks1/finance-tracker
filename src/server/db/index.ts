import "server-only";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

export type DB = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

type Holder = { client: postgres.Sql; db: DB; url: string };
const g = globalThis as unknown as { __ftDb?: Holder };

/**
 * Database handle. The app ALWAYS connects as the restricted `ft_app` role (DATABASE_URL), which
 * is subject to Row-Level Security and has no DELETE on financial tables.
 */
export function db(): DB {
  const url = env().DATABASE_URL;
  if (!g.__ftDb || g.__ftDb.url !== url) {
    const client = postgres(url, {
      max: Number(process.env.DB_POOL_MAX ?? 10),
      idle_timeout: 30,
      connect_timeout: 10,
      onnotice: () => {},
      // TLS: Railway's private network does not require TLS; public URLs use sslmode in the URL.
    });
    g.__ftDb = { client, db: drizzle(client, { schema }), url };
  }
  return g.__ftDb.db;
}

export async function closeDb() {
  if (g.__ftDb) {
    await g.__ftDb.client.end({ timeout: 5 });
    g.__ftDb = undefined;
  }
}

/**
 * Run `fn` in a transaction with the RLS context set:
 *  - app.user_id       — the authenticated user (lets RLS show that user's own workspace row)
 *  - app.workspace_id  — the user's workspace (only honoured if owned by app.user_id)
 * Without these settings, every financial table returns zero rows.
 */
export async function withContext<T>(
  ctx: { userId: string; workspaceId?: string | null },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${ctx.userId}, true)`);
    if (ctx.workspaceId) {
      await tx.execute(sql`select set_config('app.workspace_id', ${ctx.workspaceId}, true)`);
    }
    return fn(tx);
  });
}

export { schema };
