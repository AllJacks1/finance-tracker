/**
 * Local development helper. Using LOCAL_PG_SUPERUSER_URL from .env.local it:
 *  - creates databases finance_dev and finance_test (if missing)
 *  - creates/updates the restricted role ft_app with a random password
 *  - writes the resulting connection strings and dev secrets into .env.local
 *  - migrates both databases
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import postgres from "postgres";
import { requireEnv } from "./lib/env";

const superUrl = requireEnv("LOCAL_PG_SUPERUSER_URL");
const envPath = ".env.local";
const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const has = (k: string) => new RegExp(`^${k}=`, "m").test(current);
const get = (k: string) => current.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1];

const appPw = get("APP_DB_PASSWORD") ?? randomBytes(24).toString("base64url");
const u = new URL(superUrl);
const withDb = (db: string, user?: string, pw?: string) => {
  const x = new URL(superUrl);
  x.pathname = `/${db}`;
  if (user) x.username = user;
  if (pw) x.password = pw;
  return x.toString();
};

const admin = postgres(superUrl, { max: 1, onnotice: () => {} });
for (const db of ["finance_dev", "finance_test"]) {
  const [{ exists }] = await admin`SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${db}) AS exists`;
  if (!exists) {
    await admin.unsafe(`CREATE DATABASE ${db}`);
    console.log(`Created database ${db}`);
  }
}
await admin.end();

const vars: Record<string, string> = {
  APP_DB_PASSWORD: appPw,
  MIGRATION_DATABASE_URL: withDb("finance_dev"),
  DATABASE_URL: withDb("finance_dev", "ft_app", appPw),
  TEST_MIGRATION_DATABASE_URL: withDb("finance_test"),
  TEST_DATABASE_URL: withDb("finance_test", "ft_app", appPw),
  APP_URL: "http://localhost:3000",
  SETUP_TOKEN: get("SETUP_TOKEN") ?? randomBytes(18).toString("base64url"),
  APP_ENCRYPTION_KEY: get("APP_ENCRYPTION_KEY") ?? randomBytes(32).toString("base64"),
};
let out = current.trimEnd() + "\n";
for (const [k, v] of Object.entries(vars)) {
  if (has(k)) out = out.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`);
  else out += `${k}=${v}\n`;
}
writeFileSync(envPath, out);
void u;

const run = (cmd: string, env: Record<string, string>) =>
  execSync(cmd, { stdio: "inherit", env: { ...process.env, ...env } });
for (const db of ["finance_dev", "finance_test"]) {
  run(`npx tsx scripts/db-roles.ts ${withDb(db)}`, { APP_DB_PASSWORD: appPw });
  run(`npx tsx scripts/migrate.ts ${withDb(db)}`, {});
}
console.log("Local databases ready. Connection strings written to .env.local.");
