-- Phase 2 data conversion (approved decision Q1). Additive: nothing is hard-deleted.
--
--  1. Phase 1 obligations (allocations.kind = 'obligation') become BILLS with the same id;
--     payments linked via transactions.allocation_id are re-linked via bill_id.
--  2. Phase 1 reserves (allocations.kind = 'reserve') become SAVINGS GOALS with the same id and
--     one opening contribution (an earmark, not a ledger entry).
--  3. Converted allocations are soft-deleted (tombstoned) so nothing is counted twice.
--  4. Default essential categories are marked; "Interest & Fees" is added where missing.
-- Every changed row gets a new change_seq (and version) so devices pull the new state.
--
-- RLS is FORCEd on these tables; the migration owner temporarily lifts FORCE so it can see all
-- workspaces even if it is not a superuser, and restores it at the end.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspaces','categories','allocations','bills','goals','goal_entries','transactions']
  LOOP
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION pg_temp.ft_next_seq(ws uuid) RETURNS bigint
  LANGUAGE sql AS $$
    UPDATE workspaces SET change_counter = change_counter + 1 WHERE id = ws RETURNING change_counter
  $$;
--> statement-breakpoint

-- 1. Obligations -> bills ---------------------------------------------------------------------
INSERT INTO bills (id, workspace_id, version, change_seq, created_at, updated_at, deleted_at,
                   name, kind, category_id, expected_amount, actual_amount, minimum_amount, due_date,
                   account_id, notes, cancelled)
SELECT a.id, a.workspace_id, 1, pg_temp.ft_next_seq(a.workspace_id), a.created_at, now(), NULL,
       a.name, 'general', NULL, a.amount,
       -- A Phase 1 obligation marked "settled" by hand counts as fully paid: fix its amount to
       -- what was actually paid so the derived status shows Paid.
       CASE WHEN a.status = 'settled'
            THEN LEAST(a.amount, COALESCE((SELECT sum(t.amount) FROM transactions t
                   WHERE t.allocation_id = a.id AND t.deleted_at IS NULL AND t.type IN ('expense','transfer')), 0))
            ELSE NULL END,
       NULL, COALESCE(a.due_date, a.created_at::date), a.account_id, a.notes, a.status = 'cancelled'
FROM allocations a
WHERE a.kind = 'obligation' AND a.deleted_at IS NULL
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

UPDATE transactions t
SET bill_id = t.allocation_id,
    version = t.version + 1,
    change_seq = pg_temp.ft_next_seq(t.workspace_id),
    updated_at = now()
FROM allocations a
WHERE t.allocation_id = a.id AND a.kind = 'obligation' AND a.deleted_at IS NULL AND t.bill_id IS NULL
  AND t.type IN ('expense','transfer');
--> statement-breakpoint

-- 2. Reserves -> goals --------------------------------------------------------------------------
INSERT INTO goals (id, workspace_id, version, change_seq, created_at, updated_at, deleted_at,
                   name, kind, target_amount, target_date, account_id, description, status, completed_at)
SELECT a.id, a.workspace_id, 1, pg_temp.ft_next_seq(a.workspace_id), a.created_at, now(), NULL,
       a.name, 'general', a.amount, a.due_date, a.account_id, a.notes,
       CASE a.status WHEN 'open' THEN 'active' WHEN 'settled' THEN 'completed' ELSE 'archived' END,
       CASE WHEN a.status = 'settled' THEN now()::date ELSE NULL END
FROM allocations a
WHERE a.kind = 'reserve' AND a.deleted_at IS NULL
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

INSERT INTO goal_entries (id, workspace_id, version, change_seq, created_at, updated_at,
                          goal_id, amount, entry_date, note)
SELECT gen_random_uuid(), a.workspace_id, 1, pg_temp.ft_next_seq(a.workspace_id), now(), now(),
       a.id, a.amount, a.created_at::date, 'Converted from a Phase 1 reserve'
FROM allocations a
WHERE a.kind = 'reserve' AND a.deleted_at IS NULL AND a.status = 'open'
  AND NOT EXISTS (SELECT 1 FROM goal_entries e WHERE e.goal_id = a.id);
--> statement-breakpoint

-- 3. Tombstone converted allocations -------------------------------------------------------------
UPDATE allocations a
SET deleted_at = now(), version = a.version + 1,
    change_seq = pg_temp.ft_next_seq(a.workspace_id), updated_at = now()
WHERE a.deleted_at IS NULL;
--> statement-breakpoint

-- 4. Categories -----------------------------------------------------------------------------------
UPDATE categories c
SET is_essential = true, version = c.version + 1,
    change_seq = pg_temp.ft_next_seq(c.workspace_id), updated_at = now()
WHERE c.deleted_at IS NULL AND c.kind = 'expense' AND c.is_essential = false
  AND c.name IN ('Food', 'Transportation', 'Utilities', 'Health', 'Bills & Fees');
--> statement-breakpoint

INSERT INTO categories (id, workspace_id, version, change_seq, created_at, updated_at,
                        name, kind, icon, color, is_archived, is_essential)
SELECT gen_random_uuid(), w.id, 1, pg_temp.ft_next_seq(w.id), now(), now(),
       'Interest & Fees', 'expense', 'percent', '#dc2626', false, false
FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM categories c WHERE c.workspace_id = w.id AND c.name = 'Interest & Fees' AND c.deleted_at IS NULL);
--> statement-breakpoint

-- Settings records changed shape (preferences): bump so devices pull them.
UPDATE workspaces SET change_counter = change_counter + 1, change_seq = change_counter + 1, version = version + 1, updated_at = now();
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspaces','categories','allocations','bills','goals','goal_entries','transactions']
  LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
