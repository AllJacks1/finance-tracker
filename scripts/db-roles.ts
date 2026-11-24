/**
 * Creates (or updates) the restricted application role `ft_app`.
 * Run once per Postgres cluster with a privileged connection:
 *   MIGRATION_DATABASE_URL=<admin url> APP_DB_PASSWORD=<strong password> npm run db:roles
 * Then point the app's DATABASE_URL at ft_app with that password.
 */
import postgres from "postgres";
import { requireEnv } from "./lib/env";

const url = process.argv[2] ?? requireEnv("MIGRATION_DATABASE_URL");
const password = requireEnv("APP_DB_PASSWORD");
if (password.length < 24) {
  console.error("APP_DB_PASSWORD must be at least 24 characters.");
  process.exit(1);
}
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const [{ exists }] = await sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ft_app') AS exists`;
  const attrs = "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";
  if (exists) {
    await sql.unsafe(`ALTER ROLE ft_app ${attrs} PASSWORD ${lit(password)}`);
    console.log("Updated role ft_app.");
  } else {
    await sql.unsafe(`CREATE ROLE ft_app ${attrs} PASSWORD ${lit(password)}`);
    console.log("Created role ft_app.");
  }
  const [{ db }] = await sql`SELECT current_database() AS db`;
  await sql.unsafe(`GRANT CONNECT ON DATABASE "${db}" TO ft_app`);
  console.log(`Granted CONNECT on ${db}. Now run: npm run db:migrate`);
} finally {
  await sql.end();
}
