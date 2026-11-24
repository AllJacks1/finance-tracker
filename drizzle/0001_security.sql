-- Security migration: least-privilege grants for the application role and Row-Level Security.
--
-- Prerequisite: the restricted role `ft_app` must already exist. Create it once per cluster with
--   npm run db:roles
-- (see docs/MIGRATIONS.md). The running application connects ONLY as ft_app.
--
-- Guarantees enforced by the database itself:
--   * ft_app cannot DELETE financial rows (soft deletion only). DELETE is granted only on derived
--     ledger lines, sessions, rate-limit counters and permission grants.
--   * ft_app can only INSERT/SELECT audit logs (append-only).
--   * Financial tables are visible only for the workspace set in `app.workspace_id`
--     (set per transaction by the server after resolving the session). Requests with no workspace
--     context — e.g. every admin endpoint — see zero financial rows.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ft_app') THEN
    RAISE EXCEPTION 'Role ft_app does not exist. Run "npm run db:roles" before migrating.';
  END IF;
END $$;
--> statement-breakpoint

-- Helper functions reading the per-transaction context. Empty/missing setting => NULL => no rows.
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
-- The workspace setting only counts if that workspace is owned by the current user, so a wrong
-- `app.workspace_id` alone can never expose another user's rows.
CREATE OR REPLACE FUNCTION app_current_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT w.id FROM workspaces w
    WHERE w.id = nullif(current_setting('app.workspace_id', true), '')::uuid
      AND w.owner_user_id = app_current_user_id()
  $$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO ft_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_user_id(), app_current_workspace_id() TO ft_app;
--> statement-breakpoint

-- Identity / admin tables (no financial data)
GRANT SELECT, INSERT, UPDATE ON users, devices, sessions, system_setup, system_settings,
  rate_limits, backup_runs, admin_permission_grants TO ft_app;
--> statement-breakpoint
GRANT DELETE ON sessions, rate_limits, admin_permission_grants TO ft_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_logs, sync_events TO ft_app;
--> statement-breakpoint

-- Financial tables: no DELETE (soft delete only), except derived ledger lines.
GRANT SELECT, INSERT, UPDATE ON workspaces, accounts, categories, tags, allocations, transactions,
  transaction_entries, transaction_templates, budgets, account_reconciliations, attachments,
  sync_ops TO ft_app;
--> statement-breakpoint
GRANT DELETE ON transaction_entries TO ft_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ft_app;
--> statement-breakpoint

-- Row-Level Security --------------------------------------------------------------------------
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_owner ON workspaces
  USING (owner_user_id = app_current_user_id())
  WITH CHECK (owner_user_id = app_current_user_id());
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts','categories','tags','allocations','transactions',
    'transaction_entries','transaction_templates','budgets','account_reconciliations',
    'attachments','sync_ops']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON %I USING (workspace_id = (SELECT app_current_workspace_id())) '
      'WITH CHECK (workspace_id = (SELECT app_current_workspace_id()))', t);
  END LOOP;
END $$;
