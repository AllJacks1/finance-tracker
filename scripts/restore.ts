/**
 * Restore a backup into a NEW, EMPTY database.
 *
 *   npm run backup:restore -- --target <postgres-url> (--file <path> | --key <object-key>) [--identity-file <path>]
 *
 * The age private key comes from --identity-file or BACKUP_AGE_IDENTITY. The target database is
 * migrated first (same migrations as the app), then data is loaded and row counts verified.
 * See docs/RECOVERY.md for the full procedure.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import postgres from "postgres";
import { decryptBackup, restoreBackup } from "./lib/backup-core";
import "./lib/env";
import { getObject } from "../src/server/storage";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const target = arg("target");
const file = arg("file");
const key = arg("key");
const identity = arg("identity-file") ? readFileSync(arg("identity-file")!, "utf8").trim().split(/\r?\n/).find((l) => l.startsWith("AGE-SECRET-KEY")) : process.env.BACKUP_AGE_IDENTITY;
if (!target || (!file && !key) || !identity) {
  console.error("Usage: npm run backup:restore -- --target <url> (--file <path> | --key <s3 key>) [--identity-file <path>]");
  console.error("Provide the age private key via --identity-file or BACKUP_AGE_IDENTITY.");
  process.exit(1);
}

const encrypted = file ? new Uint8Array(readFileSync(file)) : (await getObject(key!)).body;
const gz = await decryptBackup(encrypted, identity);
console.log("Decrypted backup. Migrating target database…");
execSync(`npx tsx scripts/migrate.ts "${target}"`, { stdio: "inherit" });

const sql = postgres(target, { max: 1, onnotice: () => {} });
try {
  const { manifest, counts } = await restoreBackup(sql, gz);
  console.log(`Restored backup from ${manifest.createdAt} (Postgres ${manifest.serverVersion}).`);
  for (const [t, c] of Object.entries(counts)) if (c) console.log(`  ${t}: ${c} rows`);
  console.log("Next: create/refresh the ft_app role on this cluster (npm run db:roles) and point DATABASE_URL at it.");
} finally {
  await sql.end();
}
