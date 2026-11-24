/**
 * Database schema (Drizzle ORM).
 *
 * Conventions
 * - Money is always integer centavos stored as BIGINT (`mode: "number"`, guarded by finance/money.ts).
 * - Every financial table carries `workspace_id`. Cross-table references use COMPOSITE foreign keys
 *   `(workspace_id, x_id) -> other(workspace_id, id)` so the database itself refuses links between
 *   different users' workspaces, even if application code were tricked with a foreign ID.
 * - Synced tables share: version, change_seq, created_at, updated_at, deleted_at (tombstone),
 *   created_by_device_id, updated_by_device_id. Financial rows are never hard-deleted.
 * - Row-Level Security, roles and grants are defined in the hand-written SQL migration
 *   `drizzle/0001_security.sql` (Drizzle does not model them).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });
const money = (name: string) => bigint(name, { mode: "number" });

// ---------------------------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------------------------
export const userRole = pgEnum("user_role", ["super_admin", "manager", "user"]);
export const userStatus = pgEnum("user_status", ["active", "deactivated"]);
export const accountType = pgEnum("account_type", [
  "cash",
  "bank",
  "ewallet",
  "savings",
  "credit_card",
  "loan",
  "other",
]);
export const categoryKind = pgEnum("category_kind", ["income", "expense"]);
export const txnType = pgEnum("txn_type", ["income", "expense", "transfer", "refund", "adjustment"]);
export const adjustmentDirection = pgEnum("adjustment_direction", ["increase", "decrease"]);
export const budgetScope = pgEnum("budget_scope", ["overall", "category"]);
export const budgetPeriod = pgEnum("budget_period", ["daily", "weekly", "monthly", "custom"]);
export const allocationKind = pgEnum("allocation_kind", ["reserve", "obligation"]);
export const allocationStatus = pgEnum("allocation_status", ["open", "settled", "cancelled"]);
export const backupStatus = pgEnum("backup_status", ["running", "succeeded", "failed"]);

// ---------------------------------------------------------------------------------------------
// Identity & administration (no financial data in any of these tables)
// ---------------------------------------------------------------------------------------------
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(), // stored lower-cased
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRole("role").notNull().default("user"),
    status: userStatus("status").notNull().default("active"),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: ts("locked_until"),
    lastLoginAt: ts("last_login_at"),
    createdBy: uuid("created_by"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_email_uq").on(t.email),
    check("users_email_lower", sql`${t.email} = lower(${t.email})`),
  ],
);

export const adminPermissionGrants = pgTable(
  "admin_permission_grants",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    permission: text("permission").notNull(),
    grantedBy: uuid("granted_by").references(() => users.id),
    grantedAt: ts("granted_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.permission] })],
);

export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    installId: uuid("install_id").notNull(),
    label: text("label").notNull(),
    userAgent: text("user_agent"),
    /** Per-device key used to wrap the local data key; encrypted with APP_ENCRYPTION_KEY. */
    recoveryKeyEnc: text("recovery_key_enc"),
    offlineEnabled: boolean("offline_enabled").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastSeenAt: ts("last_seen_at"),
    lastSyncAt: ts("last_sync_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [unique("devices_user_install_uq").on(t.userId, t.installId)],
);

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 hex of the opaque session token. The token itself is never stored. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    deviceId: uuid("device_id").references(() => devices.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    idleExpiresAt: ts("idle_expires_at").notNull(),
    absoluteExpiresAt: ts("absolute_expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** Singleton row. Its existence means first-time setup has been completed. */
export const systemSetup = pgTable(
  "system_setup",
  {
    id: boolean("id").primaryKey().default(true),
    completedAt: ts("completed_at").notNull().defaultNow(),
    completedBy: uuid("completed_by").references(() => users.id),
  },
  (t) => [check("system_setup_singleton", sql`${t.id}`)],
);

export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Append-only for the application role (INSERT/SELECT only). Never contains financial data. */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    actorUserId: uuid("actor_user_id"),
    action: text("action").notNull(),
    targetUserId: uuid("target_user_id"),
    metadata: jsonb("metadata").notNull().default({}),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("audit_logs_created_idx").on(t.createdAt)],
);

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  windowStartedAt: ts("window_started_at").notNull().defaultNow(),
  blockedUntil: ts("blocked_until"),
});

export const backupRuns = pgTable("backup_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: backupStatus("status").notNull(),
  trigger: text("trigger").notNull(), // "scheduled" | "manual"
  objectKey: text("object_key"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  sha256: text("sha256"),
  error: text("error"),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
});

/** Sync health telemetry for admins. Codes and counts only — never payloads. */
export const syncEvents = pgTable(
  "sync_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid("user_id").notNull(),
    deviceId: uuid("device_id"),
    kind: text("kind").notNull(), // "push" | "pull"
    applied: integer("applied").notNull().default(0),
    conflicts: integer("conflicts").notNull().default(0),
    rejected: integer("rejected").notNull().default(0),
    errorCode: text("error_code"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("sync_events_created_idx").on(t.createdAt)],
);

// ---------------------------------------------------------------------------------------------
// Financial workspace (RLS-protected)
// ---------------------------------------------------------------------------------------------
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .unique()
    .references(() => users.id),
  currency: text("currency").notNull().default("PHP"),
  timezone: text("timezone").notNull().default("Asia/Manila"),
  weekStart: integer("week_start").notNull().default(1), // 0 = Sunday, 1 = Monday
  /** Monotonic per-workspace change counter; source of `change_seq` for every synced row. */
  changeCounter: bigint("change_counter", { mode: "number" }).notNull().default(0),
  version: integer("version").notNull().default(1),
  changeSeq: bigint("change_seq", { mode: "number" }).notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Columns shared by every synced, workspace-owned table. */
const synced = () => ({
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  version: integer("version").notNull().default(1),
  changeSeq: bigint("change_seq", { mode: "number" }).notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
  createdByDeviceId: uuid("created_by_device_id"),
  updatedByDeviceId: uuid("updated_by_device_id"),
});

export const accounts = pgTable(
  "accounts",
  {
    ...synced(),
    name: text("name").notNull(),
    type: accountType("type").notNull(),
    openingBalance: money("opening_balance").notNull().default(0),
    openingDate: date("opening_date", { mode: "string" }).notNull(),
    color: text("color"),
    icon: text("icon"),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    countsAsSpendable: boolean("counts_as_spendable").notNull().default(true),
  },
  (t) => [
    unique("accounts_ws_id_uq").on(t.workspaceId, t.id),
    index("accounts_ws_seq_idx").on(t.workspaceId, t.changeSeq),
  ],
);

export const categories = pgTable(
  "categories",
  {
    ...synced(),
    name: text("name").notNull(),
    kind: categoryKind("kind").notNull(),
    icon: text("icon"),
    color: text("color"),
    isArchived: boolean("is_archived").notNull().default(false),
    parentId: uuid("parent_id"), // reserved for Phase 2 sub-categories
  },
  (t) => [
    unique("categories_ws_id_uq").on(t.workspaceId, t.id),
    index("categories_ws_seq_idx").on(t.workspaceId, t.changeSeq),
  ],
);

export const tags = pgTable(
  "tags",
  {
    ...synced(),
    name: text("name").notNull(),
  },
  (t) => [
    unique("tags_ws_id_uq").on(t.workspaceId, t.id),
    index("tags_ws_seq_idx").on(t.workspaceId, t.changeSeq),
  ],
);

export const allocations = pgTable(
  "allocations",
  {
    ...synced(),
    kind: allocationKind("kind").notNull(),
    name: text("name").notNull(),
    amount: money("amount").notNull(),
    dueDate: date("due_date", { mode: "string" }),
    accountId: uuid("account_id"),
    status: allocationStatus("status").notNull().default("open"),
    notes: text("notes"),
  },
  (t) => [
    unique("allocations_ws_id_uq").on(t.workspaceId, t.id),
    index("allocations_ws_seq_idx").on(t.workspaceId, t.changeSeq),
    foreignKey({
      name: "allocations_account_fk",
      columns: [t.workspaceId, t.accountId],
      foreignColumns: [accounts.workspaceId, accounts.id],
    }),
    check("allocations_amount_positive", sql`${t.amount} > 0`),
  ],
);

export const transactions = pgTable(
  "transactions",
  {
    ...synced(),
    type: txnType("type").notNull(),
    amount: money("amount").notNull(),
    accountId: uuid("account_id").notNull(),
    toAccountId: uuid("to_account_id"),
    adjustmentDirection: adjustmentDirection("adjustment_direction"),
    categoryId: uuid("category_id"),
    occurredAt: ts("occurred_at").notNull(),
    /** Calendar date in the workspace timezone; all period maths uses this. */
    localDate: date("local_date", { mode: "string" }).notNull(),
    description: text("description"),
    notes: text("notes"),
    tagIds: uuid("tag_ids").array().notNull().default(sql`'{}'::uuid[]`),
    refundOfId: uuid("refund_of_id"),
    allocationId: uuid("allocation_id"),
  },
  (t) => [
    unique("transactions_ws_id_uq").on(t.workspaceId, t.id),
    index("transactions_ws_seq_idx").on(t.workspaceId, t.changeSeq),
    index("transactions_ws_date_idx").on(t.workspaceId, t.localDate),
    foreignKey({
      name: "transactions_account_fk",
      columns: [t.workspaceId, t.accountId],
      foreignColumns: [accounts.workspaceId, accounts.id],
    }),
    foreignKey({
      name: "transactions_to_account_fk",
      columns: [t.workspaceId, t.toAccountId],
      foreignColumns: [accounts.workspaceId, accounts.id],
    }),
    foreignKey({
      name: "transactions_category_fk",
      columns: [t.workspaceId, t.categoryId],
      foreignColumns: [categories.workspaceId, categories.id],
    }),
    foreignKey({
      name: "transactions_allocation_fk",
      columns: [t.workspaceId, t.allocationId],
      foreignColumns: [allocations.workspaceId, allocations.id],
    }),
    check("transactions_amount_positive", sql`${t.amount} > 0`),
    check(
      "transactions_transfer_shape",
      sql`(${t.type} = 'transfer') = (${t.toAccountId} IS NOT NULL) AND (${t.toAccountId} IS NULL OR ${t.toAccountId} <> ${t.accountId})`,
    ),
    check(
      "transactions_adjustment_shape",
      sql`(${t.type} = 'adjustment') = (${t.adjustmentDirection} IS NOT NULL)`,
    ),
  ],
);

/**
 * Derived ledger lines, rebuilt from the transaction header on every write (same DB transaction).
 * Signed amounts: positive increases the account balance. Transfers have two lines summing to 0.
 */
export const transactionEntries = pgTable(
  "transaction_entries",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    transactionId: uuid("transaction_id").notNull(),
    lineNo: integer("line_no").notNull(),
    accountId: uuid("account_id").notNull(),
    amount: money("amount").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.transactionId, t.lineNo] }),
    index("entries_ws_account_idx").on(t.workspaceId, t.accountId),
    foreignKey({
      name: "entries_transaction_fk",
      columns: [t.workspaceId, t.transactionId],
      foreignColumns: [transactions.workspaceId, transactions.id],
    }),
    foreignKey({
      name: "entries_account_fk",
      columns: [t.workspaceId, t.accountId],
      foreignColumns: [accounts.workspaceId, accounts.id],
    }),
    check("entries_amount_nonzero", sql`${t.amount} <> 0`),
  ],
);

export const transactionTemplates = pgTable(
  "transaction_templates",
  {
    ...synced(),
    name: text("name").notNull(),
    type: txnType("type").notNull(),
    amount: money("amount"),
    accountId: uuid("account_id"),
    toAccountId: uuid("to_account_id"),
    categoryId: uuid("category_id"),
    description: text("description"),
    notes: text("notes"),
    tagIds: uuid("tag_ids").array().notNull().default(sql`'{}'::uuid[]`),
  },
  (t) => [
    unique("templates_ws_id_uq").on(t.workspaceId, t.id),
    index("templates_ws_seq_idx").on(t.workspaceId, t.changeSeq),
    foreignKey({
      name: "templates_account_fk",
      columns: [t.workspaceId, t.accountId],
      foreignColumns: [accounts.workspaceId, accounts.id],
    }),
    foreignKey({
      name: "templates_to_account_fk",
      columns: [t.workspaceId, t.toAccountId],
      foreignColumns: [accounts.workspaceId, accounts.id],
    }),
    foreignKey({
      name: "templates_category_fk",
      columns: [t.workspaceId, t.categoryId],
      foreignColumns: [categories.workspaceId, categories.id],
    }),
  ],
);

export const budgets = pgTable(
  "budgets",
  {
    ...synced(),
    name: text("name").notNull(),
    scope: budgetScope("scope").notNull(),
    categoryId: uuid("category_id"),
    period: budgetPeriod("period").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }),
    /** [{ effectiveFrom: "YYYY-MM-DD", amount: centavos }] ascending; keeps budget history exact. */
    amountRevisions: jsonb("amount_revisions").notNull(),
    warnAtPct: integer("warn_at_pct").notNull().default(80),
    rollover: boolean("rollover").notNull().default(false), // reserved; not used in Phase 1
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [
    unique("budgets_ws_id_uq").on(t.workspaceId, t.id),
    index("budgets_ws_seq_idx").on(t.workspaceId, t.changeSeq),
    foreignKey({
      name: "budgets_category_fk",
      columns: [t.workspaceId, t.categoryId],
      foreignColumns: [categories.workspaceId, categories.id],
    }),
    check("budgets_scope_shape", sql`(${t.scope} = 'category') = (${t.categoryId} IS NOT NULL)`),
    check(
      "budgets_custom_dates",
      sql`${t.period} <> 'custom' OR (${t.endDate} IS NOT NULL AND ${t.endDate} >= ${t.startDate})`,
    ),
  ],
);

export const accountReconciliations = pgTable(
  "account_reconciliations",
  {
    ...synced(),
    accountId: uuid("account_id").notNull(),
    statementDate: date("statement_date", { mode: "string" }).notNull(),
    statementBalance: money("statement_balance").notNull(),
    computedBalance: money("computed_balance").notNull(),
    adjustmentTransactionId: uuid("adjustment_transaction_id"),
    note: text("note"),
  },
  (t) => [
    unique("reconciliations_ws_id_uq").on(t.workspaceId, t.id),
    index("reconciliations_ws_seq_idx").on(t.workspaceId, t.changeSeq),
    foreignKey({
      name: "reconciliations_account_fk",
      columns: [t.workspaceId, t.accountId],
      foreignColumns: [accounts.workspaceId, accounts.id],
    }),
    foreignKey({
      name: "reconciliations_adjustment_fk",
      columns: [t.workspaceId, t.adjustmentTransactionId],
      foreignColumns: [transactions.workspaceId, transactions.id],
    }),
  ],
);

export const attachments = pgTable(
  "attachments",
  {
    ...synced(),
    transactionId: uuid("transaction_id").notNull(),
    objectKey: text("object_key").notNull(),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
  },
  (t) => [
    unique("attachments_ws_id_uq").on(t.workspaceId, t.id),
    index("attachments_ws_seq_idx").on(t.workspaceId, t.changeSeq),
    foreignKey({
      name: "attachments_transaction_fk",
      columns: [t.workspaceId, t.transactionId],
      foreignColumns: [transactions.workspaceId, transactions.id],
    }),
  ],
);

/** Idempotency ledger: every applied sync op is recorded with its result. */
export const syncOps = pgTable(
  "sync_ops",
  {
    opId: uuid("op_id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    deviceId: uuid("device_id"),
    entity: text("entity").notNull(),
    entityId: uuid("entity_id").notNull(),
    status: text("status").notNull(),
    result: jsonb("result").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [index("sync_ops_ws_idx").on(t.workspaceId)],
);
