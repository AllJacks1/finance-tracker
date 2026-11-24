import postgres from "postgres";
import { config } from "dotenv";

/** Start every E2E run from an empty test database. */
export default async function globalSetup() {
  config({ path: ".env.local", quiet: true });
  const sql = postgres(process.env.TEST_MIGRATION_DATABASE_URL!, { max: 1, onnotice: () => {} });
  const tables = await sql<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public'`;
  await sql.unsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await sql.end();
}
