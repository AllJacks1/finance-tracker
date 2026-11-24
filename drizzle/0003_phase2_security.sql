-- Phase 2 security: same three layers as Phase 1 for every new financial table.
--   * ft_app gets SELECT/INSERT/UPDATE (no DELETE: soft deletion only)
--   * FORCE ROW LEVEL SECURITY with the workspace-ownership policy
--   * composite FKs (defined in 0002)

GRANT SELECT, INSERT, UPDATE ON debts, schedules, bills, installment_plans, import_batches,
  schedule_exceptions, card_profiles, goals, goal_entries, manual_assets, net_worth_snapshots TO ft_app;
--> statement-breakpoint

-- Notification tables are user-scoped (no financial data). DELETE allowed for unsubscribe/cleanup.
GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions, notification_log TO ft_app;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['debts','schedules','bills','installment_plans','import_batches',
    'schedule_exceptions','card_profiles','goals','goal_entries','manual_assets','net_worth_snapshots']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON %I USING (workspace_id = (SELECT app_current_workspace_id())) '
      'WITH CHECK (workspace_id = (SELECT app_current_workspace_id()))', t);
  END LOOP;
END $$;
