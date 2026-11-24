/**
 * Applies version-controlled SQL migrations from ./drizzle using the privileged migration URL.
 * Used by Railway's pre-deploy command. Safe to run repeatedly (already-applied files are skipped).
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { requireEnv } from "./lib/env";

const url = process.argv[2] ?? requireEnv("MIGRATION_DATABASE_URL");
const client = postgres(url, { max: 1, onnotice: () => {} });
try {
  await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  console.log("Migrations applied.");
} catch (err) {
  console.error("Migration failed:", err);
  process.exitCode = 1;
} finally {
  await client.end();
}
