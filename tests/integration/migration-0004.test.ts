import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Replays the Phase 2 data conversion on a database that holds Phase 1 data:
 * migrations 0000–0003 → insert Phase 1 rows → 0004 → check the result.
 */
function statements(file: string) {
  return readFileSync(`drizzle/${file}`, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("migration 0004: Phase 1 obligations/reserves → bills/goals", () => {
  it("converts data, relinks payments, tombstones allocations, and bumps change_seq", async () => {
    const admin = postgres(process.env.LOCAL_PG_SUPERUSER_URL!, { max: 1, onnotice: () => {} });
    const dbName = `finance_mig_${Date.now()}`;
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
    url.pathname = `/${dbName}`;
    const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      for (const f of ["0000_init.sql", "0001_security.sql", "0002_phase2_schema.sql", "0003_phase2_security.sql"]) {
        await sql.begin(async (tx) => {
          for (const st of statements(f)) await tx.unsafe(st);
        });
      }
      // ---- Phase 1 data
      const user = randomUUID();
      const ws = randomUUID();
      const bank = randomUUID();
      const food = randomUUID();
      const rent = randomUUID();
      const meralco = randomUUID();
      const reserve = randomUUID();
      const pay = randomUUID();
      await sql`insert into users (id, email, name, password_hash) values (${user}, 'p1@example.test', 'P1', 'x')`;
      await sql`insert into workspaces (id, owner_user_id, change_counter) values (${ws}, ${user}, 10)`;
      await sql`insert into accounts (id, workspace_id, change_seq, name, type, opening_date) values (${bank}, ${ws}, 1, 'Bank', 'bank', '2026-01-01')`;
      await sql`insert into categories (id, workspace_id, change_seq, name, kind) values (${food}, ${ws}, 2, 'Food', 'expense')`;
      await sql`insert into allocations (id, workspace_id, change_seq, kind, name, amount, due_date, account_id, status) values
        (${rent}, ${ws}, 3, 'obligation', 'Rent', 1500000, '2026-11-30', ${bank}, 'open'),
        (${meralco}, ${ws}, 4, 'obligation', 'Meralco', 300000, '2026-11-15', ${bank}, 'settled'),
        (${reserve}, ${ws}, 5, 'reserve', 'Buffer', 200000, null, ${bank}, 'open')`;
      await sql`insert into transactions (id, workspace_id, change_seq, type, amount, account_id, occurred_at, local_date, allocation_id)
        values (${pay}, ${ws}, 6, 'expense', 280000, ${bank}, now(), '2026-11-14', ${meralco})`;

      await sql.begin(async (tx) => {
        for (const st of statements("0004_phase2_data.sql")) await tx.unsafe(st);
      });

      const bills = await sql`select id, name, expected_amount::int as e, actual_amount::int as a, due_date::text as d, cancelled, change_seq::int as s from bills order by name`;
      expect(bills.map((b) => [b.id, b.name, b.e, b.a, b.d])).toEqual([
        [meralco, "Meralco", 300000, 280000, "2026-11-15"], // settled by hand: actual = what was paid
        [rent, "Rent", 1500000, null, "2026-11-30"],
      ]);
      const [t] = await sql`select bill_id, allocation_id, version from transactions where id = ${pay}`;
      expect([t!.bill_id, t!.allocation_id, t!.version]).toEqual([meralco, meralco, 2]);
      const goals = await sql`select id, status, target_amount::int as tgt from goals`;
      expect(goals.map((g) => [g.id, g.status, g.tgt])).toEqual([[reserve, "active", 200000]]);
      const [{ sum }] = await sql`select sum(amount)::int as sum from goal_entries where goal_id = ${reserve}`;
      expect(sum).toBe(200000);
      const alive = await sql`select count(*)::int as n from allocations where deleted_at is null`;
      expect(alive[0]!.n).toBe(0);
      const cats = await sql`select name, is_essential from categories where workspace_id = ${ws} order by name`;
      expect(cats.map((c) => [c.name, c.is_essential])).toEqual([["Food", true], ["Interest & Fees", false]]);
      // Every changed row has a unique, newer change_seq so devices pull it.
      const seqs = await sql`
        select change_seq::int as s from bills union all select change_seq::int from goals
        union all select change_seq::int from goal_entries union all select change_seq::int from allocations
        union all select change_seq::int from transactions union all select change_seq::int from categories`;
      const values = seqs.map((r) => r.s);
      expect(new Set(values).size).toBe(values.length);
      expect(Math.min(...values.filter((v) => v > 6))).toBeGreaterThan(10);
      // RLS is FORCEd again afterwards.
      const forced = await sql`select relname from pg_class where relforcerowsecurity and relname in ('bills','goals','transactions','workspaces')`;
      expect(forced).toHaveLength(4);
    } finally {
      await sql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    }
  }, 60_000);
});
