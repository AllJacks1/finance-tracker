/**
 * Logical backup/restore of the whole database.
 *
 * Format "ft-backup-v1": gzip(JSON{ manifest, tables: { name: CSV } }) encrypted with age to a
 * public key (BACKUP_AGE_RECIPIENT). The server can create backups but cannot read them; restoring
 * needs the private key (AGE-SECRET-KEY-…) which the owner keeps offline.
 *
 * Uses Postgres COPY, so no pg_dump binary (or version matching) is needed. Schema is recreated
 * by running the same version-controlled migrations before loading data.
 */
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { Decrypter, Encrypter } from "age-encryption";
import type postgres from "postgres";

export interface BackupManifest {
  format: "ft-backup-v1";
  createdAt: string;
  serverVersion: string;
  migrations: string[];
  tables: { name: string; rows: number; sha256: string }[];
}

async function copyOut(sql: postgres.Sql, table: string): Promise<string> {
  const stream = await sql.unsafe(`COPY "${table}" TO STDOUT WITH (FORMAT csv, HEADER)`).readable();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

export async function listTables(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public' order by tablename`;
  return rows.map((r) => r.tablename);
}

async function appliedMigrations(sql: postgres.Sql): Promise<string[]> {
  try {
    const rows = await sql<{ hash: string }[]>`select hash from drizzle.__drizzle_migrations order by id`;
    return rows.map((r) => r.hash);
  } catch {
    return [];
  }
}

/** Consistent snapshot of every public table (REPEATABLE READ, read-only transaction). */
export async function createBackup(sql: postgres.Sql): Promise<{ gz: Buffer; manifest: BackupManifest }> {
  const result = await sql.begin("isolation level repeatable read read only", async (tx) => {
    const [{ server_version }] = await tx<{ server_version: string }[]>`show server_version`;
    const tables = await listTables(tx as unknown as postgres.Sql);
    const data: Record<string, string> = {};
    const meta: BackupManifest["tables"] = [];
    for (const t of tables) {
      const csv = await copyOut(tx as unknown as postgres.Sql, t);
      data[t] = csv;
      meta.push({ name: t, rows: Math.max(0, csv.split("\n").filter(Boolean).length - 1), sha256: createHash("sha256").update(csv).digest("hex") });
    }
    const manifest: BackupManifest = {
      format: "ft-backup-v1",
      createdAt: new Date().toISOString(),
      serverVersion: server_version,
      migrations: await appliedMigrations(tx as unknown as postgres.Sql),
      tables: meta,
    };
    return { manifest, data };
  });
  const gz = gzipSync(Buffer.from(JSON.stringify({ manifest: result.manifest, tables: result.data })), { level: 9 });
  return { gz, manifest: result.manifest };
}

export async function encryptBackup(gz: Buffer, recipient: string): Promise<Uint8Array> {
  const e = new Encrypter();
  e.addRecipient(recipient);
  return e.encrypt(new Uint8Array(gz));
}

export async function decryptBackup(encrypted: Uint8Array, identity: string): Promise<Buffer> {
  const d = new Decrypter();
  d.addIdentity(identity);
  return Buffer.from(await d.decrypt(encrypted, "uint8array"));
}

export function parseBackup(gz: Buffer): { manifest: BackupManifest; tables: Record<string, string> } {
  const parsed = JSON.parse(gunzipSync(gz).toString("utf8"));
  if (parsed?.manifest?.format !== "ft-backup-v1") throw new Error("Not a Finance Tracker backup");
  for (const t of parsed.manifest.tables as BackupManifest["tables"]) {
    const sha = createHash("sha256").update(parsed.tables[t.name] ?? "").digest("hex");
    if (sha !== t.sha256) throw new Error(`Checksum mismatch for table ${t.name}`);
  }
  return parsed;
}

/**
 * Load a backup into an EMPTY database that has been migrated to the same schema.
 * Runs as a privileged user (session_replication_role=replica skips FK triggers during load).
 */
export async function restoreBackup(sql: postgres.Sql, gz: Buffer, opts: { allowMigrationMismatch?: boolean } = {}) {
  const { manifest, tables } = parseBackup(gz);
  const current = await appliedMigrations(sql);
  const same = current.length === manifest.migrations.length && current.every((h, i) => h === manifest.migrations[i]);
  if (!same && !opts.allowMigrationMismatch) {
    throw new Error(
      `Schema mismatch: backup has ${manifest.migrations.length} migrations, target has ${current.length}. ` +
        "Check out the app version that made the backup (or migrate the target to it) before restoring.",
    );
  }
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from users`;
  if (n > 0) throw new Error("Target database is not empty (users table has rows). Restore into a fresh database.");

  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    for (const t of manifest.tables) {
      const csv = tables[t.name] ?? "";
      if (t.rows === 0) continue;
      const writable = await tx.unsafe(`COPY "${t.name}" FROM STDIN WITH (FORMAT csv, HEADER)`).writable();
      await new Promise<void>((resolve, reject) => {
        writable.on("error", reject);
        writable.on("finish", () => resolve());
        writable.end(Buffer.from(csv, "utf8"));
      });
    }
    // Move identity sequences past restored ids.
    const ids = await tx<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and is_identity = 'YES'`;
    for (const { table_name, column_name } of ids) {
      await tx.unsafe(
        `select setval(pg_get_serial_sequence('"${table_name}"', '${column_name}'), coalesce((select max("${column_name}") from "${table_name}"), 1))`,
      );
    }
  });

  const counts: Record<string, number> = {};
  for (const t of manifest.tables) {
    const [{ c }] = await sql.unsafe(`select count(*)::int as c from "${t.name}"`);
    counts[t.name] = c as number;
    if (c !== t.rows) throw new Error(`Row count mismatch for ${t.name}: expected ${t.rows}, got ${c}`);
  }
  return { manifest, counts };
}
