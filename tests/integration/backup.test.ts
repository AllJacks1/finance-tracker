import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { execSync } from "node:child_process";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { createBackup, decryptBackup, encryptBackup, restoreBackup } from "../../scripts/lib/backup-core";

/**
 * Backup → encrypt → decrypt → restore into a brand-new database, then compare.
 * Runs against whatever data the earlier integration test files left in finance_test.
 */
describe("backup and restore", () => {
  it("round-trips the whole database, encrypted with age", async () => {
    const source = postgres(process.env.TEST_MIGRATION_DATABASE_URL!, { max: 1, onnotice: () => {} });
    const admin = postgres(process.env.LOCAL_PG_SUPERUSER_URL!, { max: 1, onnotice: () => {} });
    const dbName = `finance_restore_${Date.now()}`;
    const targetUrl = new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
    targetUrl.pathname = `/${dbName}`;
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    try {
      const { gz, manifest } = await createBackup(source);
      // Phase 2 tables are part of every backup (the backup enumerates all tables).
      const names = manifest.tables.map((t) => t.name);
      for (const t of ["bills", "schedules", "schedule_exceptions", "card_profiles", "installment_plans", "debts", "goals", "goal_entries", "manual_assets", "net_worth_snapshots", "import_batches", "push_subscriptions", "notification_log"])
        expect(names, t).toContain(t);
      const identity = await generateX25519Identity();
      const encrypted = await encryptBackup(gz, await identityToRecipient(identity));
      // Ciphertext must not contain recognisable data.
      expect(Buffer.from(encrypted).toString("latin1")).not.toContain("example.test");
      await expect(decryptBackup(encrypted, await generateX25519Identity())).rejects.toThrow();

      const plain = await decryptBackup(encrypted, identity);
      execSync(`npx tsx scripts/migrate.ts "${targetUrl.toString()}"`, { stdio: "ignore" });
      const target = postgres(targetUrl.toString(), { max: 1, onnotice: () => {} });
      try {
        const { counts } = await restoreBackup(target, plain);
        for (const t of manifest.tables) expect(counts[t.name], t.name).toBe(t.rows);
        const q = (s: postgres.Sql) => s`select coalesce(sum(amount),0)::text as s, count(*)::int as n from transactions`;
        expect((await q(target))[0]).toEqual((await q(source))[0]);
        // Restoring twice into a non-empty database is refused.
        await expect(restoreBackup(target, plain)).rejects.toThrow(/not empty/);
        // Identity sequences continue after restored ids.
        await target`insert into audit_logs (action) values ('restore.check')`;
      } finally {
        await target.end();
      }
    } finally {
      await source.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
});
