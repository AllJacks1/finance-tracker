import { sql } from "drizzle-orm";
import { db } from "@/server/db";
import { json, route } from "@/server/http";

/** Liveness/readiness probe for Railway. Reveals nothing sensitive. */
export const GET = route(
  async () => {
    try {
      await db().execute(sql`select 1`);
      return json({ ok: true });
    } catch {
      return json({ ok: false }, { status: 503 });
    }
  },
  { skipOriginCheck: true },
);
