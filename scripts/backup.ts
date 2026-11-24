/**
 * Scheduled backup job (Railway cron service): snapshot → gzip → age-encrypt → upload → record.
 *
 * Env: MIGRATION_DATABASE_URL (privileged, to read past RLS), BACKUP_AGE_RECIPIENT (age1…),
 *      S3_* (object storage). Usage: npm run backup [-- --trigger manual]
 */
import { createHash } from "node:crypto";
import postgres from "postgres";
import { createBackup, encryptBackup } from "./lib/backup-core";
import { requireEnv } from "./lib/env";
import { deleteObject, listObjects, putObject, storageConfigured } from "../src/server/storage";

const trigger = process.argv.includes("--trigger") ? process.argv[process.argv.indexOf("--trigger") + 1] ?? "manual" : "scheduled";
const sql = postgres(requireEnv("MIGRATION_DATABASE_URL"), { max: 2, onnotice: () => {} });
const recipient = requireEnv("BACKUP_AGE_RECIPIENT");
if (!recipient.startsWith("age1")) {
  console.error("BACKUP_AGE_RECIPIENT must be an age public key (age1…). Generate one with: npm run backup:keygen");
  process.exit(1);
}

const [run] = await sql<{ id: string }[]>`insert into backup_runs (status, trigger) values ('running', ${trigger}) returning id`;
const started = Date.now();
try {
  if (!storageConfigured()) throw new Error("Object storage (S3_*) is not configured");
  const { gz, manifest } = await createBackup(sql);
  const encrypted = await encryptBackup(gz, recipient);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const key = `backups/${stamp.slice(0, 4)}/${stamp.slice(5, 7)}/ft-backup-${stamp}.json.gz.age`;
  const sha256 = createHash("sha256").update(encrypted).digest("hex");
  await putObject(key, encrypted, "application/octet-stream", { sha256, format: manifest.format });
  await sql`update backup_runs set status = 'succeeded', object_key = ${key}, size_bytes = ${encrypted.length},
            sha256 = ${sha256}, finished_at = now() where id = ${run!.id}`;
  console.log(JSON.stringify({ msg: "backup_succeeded", key, bytes: encrypted.length, tables: manifest.tables.length, ms: Date.now() - started }));

  // Retention: keep daily backups for N days, plus the first backup of each month for 12 months.
  const [setting] = await sql<{ value: number }[]>`select value from system_settings where key = 'backupRetentionDays'`;
  const days = Number(setting?.value ?? 30);
  const now = Date.now();
  const objects = await listObjects("backups/");
  const firstOfMonth = new Map<string, string>();
  for (const o of [...objects].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const m = o.key.match(/ft-backup-(\d{4})-(\d{2})/);
    if (m && !firstOfMonth.has(`${m[1]}-${m[2]}`)) firstOfMonth.set(`${m[1]}-${m[2]}`, o.key);
  }
  const monthly = new Set(firstOfMonth.values());
  let removed = 0;
  for (const o of objects) {
    const age = now - (o.lastModified?.getTime() ?? now);
    const keep = age < days * 86_400_000 || (monthly.has(o.key) && age < 366 * 86_400_000);
    if (!keep) {
      await deleteObject(o.key);
      removed++;
    }
  }
  if (removed) console.log(JSON.stringify({ msg: "backup_retention", removed }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await sql`update backup_runs set status = 'failed', error = ${message.slice(0, 500)}, finished_at = now() where id = ${run!.id}`;
  console.error(JSON.stringify({ msg: "backup_failed", error: message }));
  process.exitCode = 1;
} finally {
  await sql.end();
}
