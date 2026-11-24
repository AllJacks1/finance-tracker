CREATE TABLE "bills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by_device_id" uuid,
	"updated_by_device_id" uuid,
	"name" text NOT NULL,
	"kind" text DEFAULT 'general' NOT NULL,
	"category_id" uuid,
	"expected_amount" bigint NOT NULL,
	"actual_amount" bigint,
	"minimum_amount" bigint,
	"due_date" date NOT NULL,
	"account_id" uuid,
	"notes" text,
	"schedule_id" uuid,
	"occurrence_date" date,
	"card_account_id" uuid,
	"debt_id" uuid,
	"statement_closing_date" date,
	"cancelled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "bills_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "bills_expected_nonneg" CHECK ("bills"."expected_amount" >= 0),
	CONSTRAINT "bills_actual_nonneg" CHECK ("bills"."actual_amount" IS NULL OR "bills"."actual_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "card_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by_device_id" uuid,
	"updated_by_device_id" uuid,
	"account_id" uuid NOT NULL,
	"credit_limit" bigint NOT NULL,
	"statement_day" integer NOT NULL,
	"due_days_after_statement" integer DEFAULT 21 NOT NULL,
	"min_payment_pct_bp" integer DEFAULT 300 NOT NULL,
	"min_payment_floor" bigint DEFAULT 50000 NOT NULL,
	"apr_bp" integer DEFAULT 0 NOT NULL,
	"auto_bills" boolean DEFAULT true NOT NULL,
	CONSTRAINT "cards_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "cards_statement_day" CHECK ("card_profiles"."statement_day" BETWEEN 1 AND 31)
);
--> statement-breakpoint
CREATE TABLE "debts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by_device_id" uuid,
	"updated_by_device_id" uuid,
	"account_id" uuid NOT NULL,
	"creditor" text NOT NULL,
	"kind" text NOT NULL,
	"original_principal" bigint NOT NULL,
	"start_date" date NOT NULL,
	"apr_bp" integer DEFAULT 0 NOT NULL,
	"interest_method" text DEFAULT 'diminishing' NOT NULL,
	"frequency" text DEFAULT 'monthly' NOT NULL,
	"minimum_payment" bigint DEFAULT 0 NOT NULL,
	"due_day" integer,
	"term_months" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	CONSTRAINT "debts_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "debts_principal_nonneg" CHECK ("debts"."original_principal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "goal_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by_device_id" uuid,
	"updated_by_device_id" uuid,
	"goal_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"entry_date" date NOT NULL,
	"note" text,
	"transaction_id" uuid,
	"group_id" uuid,
	CONSTRAINT "goal_entries_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "goal_entries_nonzero" CHECK ("goal_entries"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by_device_id" uuid,
	"updated_by_device_id" uuid,
	"name" text NOT NULL,
	"kind" text DEFAULT 'general' NOT NULL,
	"target_amount" bigint NOT NULL,
	"target_date" date,
	"account_id" uuid,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"completed_at" date,
	CONSTRAINT "goals_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "goals_target_nonneg" CHECK ("goals"."target_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by_device_id" uuid,
	"updated_by_device_id" uuid,
	"account_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"file_sha256" text NOT NULL,
	"row_count" integer NOT NULL,
	"imported_count" integer NOT NULL,
	"skipped_count" integer NOT NULL,
	CONSTRAINT "imports_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "installment_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by_device_id" uuid,
	"updated_by_device_id" uuid,
	"card_account_id" uuid NOT NULL,
	"transaction_id" uuid,
	"description" text NOT NULL,
	"principal" bigint NOT NULL,
	"months" integer NOT NULL,
	"monthly_amount" bigint NOT NULL,
	"first_billing_date" date NOT NULL,
	"fee_amount" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "installments_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "installments_positive" CHECK ("installment_plans"."principal" > 0 AND "installment_plans"."months" > 0 AND "installment_plans"."monthly_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "manual_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by_device_id" uuid,
	"updated_by_device_id" uuid,
	"name" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"valuations" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	CONSTRAINT "assets_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "net_worth_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by_device_id" uuid,
	"updated_by_device_id" uuid,
	"snapshot_date" date NOT NULL,
	"kind" text NOT NULL,
	"assets" bigint NOT NULL,
	"liabilities" bigint NOT NULL,
	"net_worth" bigint NOT NULL,
	"breakdown" jsonb NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "snapshots_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "notification_log" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_log_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "schedule_exceptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by_device_id" uuid,
	"updated_by_device_id" uuid,
	"schedule_id" uuid NOT NULL,
	"occurrence_date" date NOT NULL,
	"action" text NOT NULL,
	"override_date" date,
	"override_amount" bigint,
	CONSTRAINT "sched_exc_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by_device_id" uuid,
	"updated_by_device_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"txn_type" text NOT NULL,
	"amount" bigint NOT NULL,
	"account_id" uuid,
	"to_account_id" uuid,
	"category_id" uuid,
	"description" text,
	"notes" text,
	"tag_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"rule" jsonb NOT NULL,
	"pauses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"bill_kind" text,
	"card_account_id" uuid,
	"debt_id" uuid,
	"pays_bill_schedule_id" uuid,
	"reminder_days" integer,
	"previous_schedule_id" uuid,
	CONSTRAINT "schedules_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "schedules_amount_positive" CHECK ("schedules"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "transaction_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "bill_id" uuid;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "is_essential" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "bill_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "occurrence_date" date;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "debt_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "installment_plan_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "import_fingerprint" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "preferences" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_category_fk" FOREIGN KEY ("workspace_id","category_id") REFERENCES "public"."categories"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_card_fk" FOREIGN KEY ("workspace_id","card_account_id") REFERENCES "public"."accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_schedule_fk" FOREIGN KEY ("workspace_id","schedule_id") REFERENCES "public"."schedules"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_debt_fk" FOREIGN KEY ("workspace_id","debt_id") REFERENCES "public"."debts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_profiles" ADD CONSTRAINT "card_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_profiles" ADD CONSTRAINT "cards_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debts" ADD CONSTRAINT "debts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debts" ADD CONSTRAINT "debts_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_entries" ADD CONSTRAINT "goal_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_entries" ADD CONSTRAINT "goal_entries_goal_fk" FOREIGN KEY ("workspace_id","goal_id") REFERENCES "public"."goals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_entries" ADD CONSTRAINT "goal_entries_txn_fk" FOREIGN KEY ("workspace_id","transaction_id") REFERENCES "public"."transactions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "imports_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_plans" ADD CONSTRAINT "installment_plans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_plans" ADD CONSTRAINT "installments_card_fk" FOREIGN KEY ("workspace_id","card_account_id") REFERENCES "public"."accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_assets" ADD CONSTRAINT "manual_assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "net_worth_snapshots" ADD CONSTRAINT "net_worth_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_exceptions" ADD CONSTRAINT "sched_exc_schedule_fk" FOREIGN KEY ("workspace_id","schedule_id") REFERENCES "public"."schedules"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_to_account_fk" FOREIGN KEY ("workspace_id","to_account_id") REFERENCES "public"."accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_card_fk" FOREIGN KEY ("workspace_id","card_account_id") REFERENCES "public"."accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_category_fk" FOREIGN KEY ("workspace_id","category_id") REFERENCES "public"."categories"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_debt_fk" FOREIGN KEY ("workspace_id","debt_id") REFERENCES "public"."debts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bills_ws_seq_idx" ON "bills" USING btree ("workspace_id","change_seq");--> statement-breakpoint
CREATE INDEX "bills_ws_due_idx" ON "bills" USING btree ("workspace_id","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "bills_occurrence_uq" ON "bills" USING btree ("workspace_id","schedule_id","occurrence_date") WHERE schedule_id is not null;--> statement-breakpoint
CREATE INDEX "cards_ws_seq_idx" ON "card_profiles" USING btree ("workspace_id","change_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "cards_account_uq" ON "card_profiles" USING btree ("workspace_id","account_id") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "debts_ws_seq_idx" ON "debts" USING btree ("workspace_id","change_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "debts_account_uq" ON "debts" USING btree ("workspace_id","account_id") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "goal_entries_ws_seq_idx" ON "goal_entries" USING btree ("workspace_id","change_seq");--> statement-breakpoint
CREATE INDEX "goals_ws_seq_idx" ON "goals" USING btree ("workspace_id","change_seq");--> statement-breakpoint
CREATE INDEX "imports_ws_seq_idx" ON "import_batches" USING btree ("workspace_id","change_seq");--> statement-breakpoint
CREATE INDEX "installments_ws_seq_idx" ON "installment_plans" USING btree ("workspace_id","change_seq");--> statement-breakpoint
CREATE INDEX "assets_ws_seq_idx" ON "manual_assets" USING btree ("workspace_id","change_seq");--> statement-breakpoint
CREATE INDEX "snapshots_ws_seq_idx" ON "net_worth_snapshots" USING btree ("workspace_id","change_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "push_endpoint_uq" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sched_exc_ws_seq_idx" ON "schedule_exceptions" USING btree ("workspace_id","change_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "sched_exc_occurrence_uq" ON "schedule_exceptions" USING btree ("workspace_id","schedule_id","occurrence_date");--> statement-breakpoint
CREATE INDEX "schedules_ws_seq_idx" ON "schedules" USING btree ("workspace_id","change_seq");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_bill_fk" FOREIGN KEY ("workspace_id","bill_id") REFERENCES "public"."bills"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_bill_fk" FOREIGN KEY ("workspace_id","bill_id") REFERENCES "public"."bills"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_schedule_fk" FOREIGN KEY ("workspace_id","schedule_id") REFERENCES "public"."schedules"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_debt_fk" FOREIGN KEY ("workspace_id","debt_id") REFERENCES "public"."debts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_installment_fk" FOREIGN KEY ("workspace_id","installment_plan_id") REFERENCES "public"."installment_plans"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_import_fk" FOREIGN KEY ("workspace_id","import_batch_id") REFERENCES "public"."import_batches"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_occurrence_uq" ON "transactions" USING btree ("workspace_id","schedule_id","occurrence_date") WHERE schedule_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_import_fp_uq" ON "transactions" USING btree ("workspace_id","account_id","import_fingerprint") WHERE import_fingerprint is not null;--> statement-breakpoint
CREATE INDEX "transactions_ws_bill_idx" ON "transactions" USING btree ("workspace_id","bill_id");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_one_owner" CHECK (("attachments"."transaction_id" IS NULL) <> ("attachments"."bill_id" IS NULL));