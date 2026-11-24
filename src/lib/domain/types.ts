/**
 * Domain entity shapes shared by the server, the sync protocol and the offline client.
 * Field names are camelCase; the server maps them to snake_case columns.
 * All money fields are integer centavos.
 */
import type { Centavos } from "../finance/money";
import type { ISODate } from "../finance/dates";

export const ACCOUNT_TYPES = [
  "cash",
  "bank",
  "ewallet",
  "savings",
  "credit_card",
  "loan",
  "other",
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const LIABILITY_TYPES: readonly AccountType[] = ["credit_card", "loan"];
export const isLiabilityType = (t: AccountType) => LIABILITY_TYPES.includes(t);
/** Default "counts toward Safe-to-Spend" by account type. Savings and liabilities are excluded. */
export const defaultSpendable = (t: AccountType) => t === "cash" || t === "bank" || t === "ewallet";

export const TXN_TYPES = ["income", "expense", "transfer", "refund", "adjustment"] as const;
export type TxnType = (typeof TXN_TYPES)[number];

export type CategoryKind = "income" | "expense";
export type BudgetScope = "overall" | "category";
export type BudgetPeriod = "daily" | "weekly" | "monthly" | "custom";
export type AllocationKind = "reserve" | "obligation";
export type AllocationStatus = "open" | "settled" | "cancelled";

/** Sync metadata present on every synced record. */
export interface SyncMeta {
  version: number;
  deletedAt: string | null;
  updatedAt?: string;
}

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  openingBalance: Centavos;
  openingDate: ISODate;
  color: string | null;
  icon: string | null;
  description: string | null;
  isActive: boolean;
  countsAsSpendable: boolean;
}

export interface Category {
  id: string;
  name: string;
  kind: CategoryKind;
  icon: string | null;
  color: string | null;
  isArchived: boolean;
  /** Phase 2: counts toward essential monthly expenses (emergency fund). */
  isEssential: boolean;
}

export interface Tag {
  id: string;
  name: string;
}

export interface Transaction {
  id: string;
  type: TxnType;
  /** Always positive; direction comes from `type` (and `adjustmentDirection`). */
  amount: Centavos;
  accountId: string;
  /** Transfers only: destination account. */
  toAccountId: string | null;
  /** Adjustments only. */
  adjustmentDirection: "increase" | "decrease" | null;
  categoryId: string | null;
  occurredAt: string; // ISO instant
  localDate: ISODate;
  description: string | null;
  notes: string | null;
  tagIds: string[];
  /** Refunds: optional link to the original expense. */
  refundOfId: string | null;
  /** Deprecated (Phase 1 obligations became bills). Kept for existing rows. */
  allocationId: string | null;
  // ---- Phase 2 links (all optional) ----
  /** Payment toward a bill (expense, or transfer for card/loan bills). */
  billId: string | null;
  /** Confirmed occurrence of a schedule: (scheduleId, occurrenceDate) is unique. */
  scheduleId: string | null;
  occurrenceDate: ISODate | null;
  /** Loan payment part (principal transfer or interest expense). */
  debtId: string | null;
  /** Card installment purchase. */
  installmentPlanId: string | null;
  /** Records created together atomically (e.g. principal + interest). */
  groupId: string | null;
  importBatchId: string | null;
  importFingerprint: string | null;
}

/** Phase 2 link fields of a transaction, all empty. Spread into new transactions. */
export const TXN_LINKS = {
  allocationId: null,
  billId: null,
  scheduleId: null,
  occurrenceDate: null,
  debtId: null,
  installmentPlanId: null,
  groupId: null,
  importBatchId: null,
  importFingerprint: null,
} as const satisfies Partial<Transaction>;

export type TxnLinks = { -readonly [K in keyof typeof TXN_LINKS]: Transaction[K] };

/** Copy the link fields from an existing transaction (so edits never drop them). */
export function pickTxnLinks(t: Partial<Transaction> | undefined): TxnLinks {
  const out = { ...TXN_LINKS } as TxnLinks;
  if (!t) return out;
  for (const k of Object.keys(TXN_LINKS) as (keyof TxnLinks)[]) {
    const v = t[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export interface Template {
  id: string;
  name: string;
  type: TxnType;
  amount: Centavos | null;
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  description: string | null;
  notes: string | null;
  tagIds: string[];
}

export interface AmountRevision {
  effectiveFrom: ISODate;
  amount: Centavos;
}

export interface Budget {
  id: string;
  name: string;
  scope: BudgetScope;
  categoryId: string | null;
  period: BudgetPeriod;
  startDate: ISODate;
  endDate: ISODate | null;
  amountRevisions: AmountRevision[];
  warnAtPct: number;
  rollover: boolean;
  isActive: boolean;
}

export interface Allocation {
  id: string;
  kind: AllocationKind;
  name: string;
  amount: Centavos;
  dueDate: ISODate | null;
  accountId: string | null;
  status: AllocationStatus;
  notes: string | null;
}

export interface Reconciliation {
  id: string;
  accountId: string;
  statementDate: ISODate;
  statementBalance: Centavos;
  computedBalance: Centavos;
  adjustmentTransactionId: string | null;
  note: string | null;
}

export interface Attachment {
  id: string;
  /** Exactly one of transactionId / billId. */
  transactionId: string | null;
  billId: string | null;
  filename: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
}

export type CoverageMonths = 3 | 6 | 9 | 12;

export interface Preferences {
  /** Safe-to-Spend horizon. */
  stsHorizon: "end_of_month" | "next_income";
  /** Emergency fund target = N months of essential expenses. */
  emergencyTargetMonths: CoverageMonths;
  /** Essential monthly expenses = average over the last N full months. */
  essentialsLookbackMonths: CoverageMonths;
  /** Manual override for essential monthly expenses (centavos), or null. */
  essentialsOverride: Centavos | null;
  notifications: {
    bills: boolean;
    billDaysBefore: number; // 0 | 1 | 3 | 7
    scheduled: boolean;
    cards: boolean;
    loans: boolean;
    budgets: boolean;
    goals: boolean;
    /** Include amounts in push notifications (lock screen). Off by default. */
    pushShowAmounts: boolean;
  };
}

export const DEFAULT_PREFERENCES: Preferences = {
  stsHorizon: "end_of_month",
  emergencyTargetMonths: 6,
  essentialsLookbackMonths: 3,
  essentialsOverride: null,
  notifications: {
    bills: true,
    billDaysBefore: 3,
    scheduled: true,
    cards: true,
    loans: true,
    budgets: true,
    goals: true,
    pushShowAmounts: false,
  },
};

export interface WorkspaceSettings {
  id: string; // workspace id
  currency: "PHP";
  timezone: string;
  weekStart: number;
  preferences: Preferences;
}

// ------------------------------------------------------------------------------------------------
// Phase 2 entities
// ------------------------------------------------------------------------------------------------
export type Frequency = "once" | "daily" | "weekly" | "monthly" | "yearly";

/** Recurrence rule. Biweekly = weekly with interval 2; custom = any interval. */
export interface RecurrenceRule {
  freq: Frequency;
  interval: number;
  startDate: ISODate;
  endDate: ISODate | null;
  count: number | null;
}

export interface PauseWindow {
  from: ISODate;
  to: ISODate | null; // null = still paused
}

export type BillKind = "general" | "card_payment" | "loan_installment";

export interface Schedule {
  id: string;
  /** "transaction": planned income/expense/transfer; "bill": recurring bill instances. */
  kind: "transaction" | "bill";
  name: string;
  txnType: "income" | "expense" | "transfer";
  amount: Centavos;
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  description: string | null;
  notes: string | null;
  tagIds: string[];
  rule: RecurrenceRule;
  pauses: PauseWindow[];
  status: "active" | "paused" | "cancelled";
  billKind: BillKind | null;
  cardAccountId: string | null;
  debtId: string | null;
  /** A planned transfer that pays this bill schedule: counted once (via the bill). */
  paysBillScheduleId: string | null;
  reminderDays: number | null;
  previousScheduleId: string | null;
}

export interface ScheduleException {
  id: string;
  scheduleId: string;
  occurrenceDate: ISODate;
  action: "skip" | "override";
  overrideDate: ISODate | null;
  overrideAmount: Centavos | null;
}

export interface Bill {
  id: string;
  name: string;
  kind: BillKind;
  categoryId: string | null;
  expectedAmount: Centavos;
  actualAmount: Centavos | null;
  minimumAmount: Centavos | null;
  dueDate: ISODate;
  accountId: string | null;
  notes: string | null;
  scheduleId: string | null;
  occurrenceDate: ISODate | null;
  cardAccountId: string | null;
  debtId: string | null;
  statementClosingDate: ISODate | null;
  cancelled: boolean;
}

export interface CardProfile {
  id: string;
  accountId: string;
  creditLimit: Centavos;
  statementDay: number;
  dueDaysAfterStatement: number;
  minPaymentPctBp: number;
  minPaymentFloor: Centavos;
  aprBp: number;
  autoBills: boolean;
}

export interface InstallmentPlan {
  id: string;
  cardAccountId: string;
  transactionId: string | null;
  description: string;
  principal: Centavos;
  months: number;
  monthlyAmount: Centavos;
  /** Statement closing date of the first billed installment. */
  firstBillingDate: ISODate;
  feeAmount: Centavos;
  status: "active" | "cancelled";
}

export type InterestMethod = "diminishing" | "add_on" | "none";

export interface Debt {
  id: string;
  accountId: string;
  creditor: string;
  kind: "personal" | "bank" | "installment" | "other";
  originalPrincipal: Centavos;
  startDate: ISODate;
  aprBp: number;
  interestMethod: InterestMethod;
  frequency: "weekly" | "biweekly" | "monthly";
  minimumPayment: Centavos;
  dueDay: number | null;
  termMonths: number | null;
  status: "active" | "paid_off" | "archived";
  notes: string | null;
}

export type GoalKind = "emergency" | "travel" | "education" | "home" | "vehicle" | "purchase" | "general";

export interface Goal {
  id: string;
  name: string;
  kind: GoalKind;
  targetAmount: Centavos;
  targetDate: ISODate | null;
  accountId: string | null;
  description: string | null;
  status: "active" | "completed" | "archived";
  completedAt: ISODate | null;
}

export interface GoalEntry {
  id: string;
  goalId: string;
  /** + contribution, - withdrawal/reallocation. Earmark only. */
  amount: Centavos;
  entryDate: ISODate;
  note: string | null;
  transactionId: string | null;
  groupId: string | null;
}

export interface Valuation {
  date: ISODate;
  value: Centavos;
}

export interface ManualAsset {
  id: string;
  name: string;
  kind: "investment" | "property" | "vehicle" | "other";
  valuations: Valuation[];
  isActive: boolean;
  notes: string | null;
}

export interface SnapshotLine {
  kind: "account" | "asset";
  id: string;
  name: string;
  liability: boolean;
  value: Centavos;
}

export interface NetWorthSnapshot {
  id: string;
  snapshotDate: ISODate;
  kind: "auto" | "manual";
  assets: Centavos;
  liabilities: Centavos;
  netWorth: Centavos;
  breakdown: SnapshotLine[];
  recordedAt: string;
}

export interface ImportBatch {
  id: string;
  accountId: string;
  filename: string;
  fileSha256: string;
  rowCount: number;
  importedCount: number;
  skippedCount: number;
}

export type EntityMap = {
  account: Account;
  category: Category;
  tag: Tag;
  transaction: Transaction;
  template: Template;
  budget: Budget;
  allocation: Allocation;
  reconciliation: Reconciliation;
  attachment: Attachment;
  settings: WorkspaceSettings;
  schedule: Schedule;
  scheduleException: ScheduleException;
  bill: Bill;
  cardProfile: CardProfile;
  installmentPlan: InstallmentPlan;
  debt: Debt;
  goal: Goal;
  goalEntry: GoalEntry;
  manualAsset: ManualAsset;
  netWorthSnapshot: NetWorthSnapshot;
  importBatch: ImportBatch;
};
export type EntityName = keyof EntityMap;
export const ENTITY_NAMES: EntityName[] = [
  "settings",
  "account",
  "category",
  "tag",
  "allocation",
  "transaction",
  "template",
  "budget",
  "reconciliation",
  "attachment",
  "debt",
  "schedule",
  "scheduleException",
  "bill",
  "cardProfile",
  "installmentPlan",
  "importBatch",
  "goal",
  "goalEntry",
  "manualAsset",
  "netWorthSnapshot",
];

/** Record with sync metadata, as stored locally and returned by the server. */
export type Synced<T> = T & SyncMeta;

export const DEFAULT_CATEGORIES: { name: string; kind: CategoryKind; icon: string; color: string; essential?: boolean }[] = [
  { name: "Food", kind: "expense", icon: "utensils", color: "#f97316" , essential: true },
  { name: "Transportation", kind: "expense", icon: "bus", color: "#0ea5e9" , essential: true },
  { name: "Utilities", kind: "expense", icon: "plug", color: "#eab308" , essential: true },
  { name: "Shopping", kind: "expense", icon: "shopping-bag", color: "#ec4899" },
  { name: "Entertainment", kind: "expense", icon: "clapperboard", color: "#8b5cf6" },
  { name: "Health", kind: "expense", icon: "heart-pulse", color: "#ef4444" , essential: true },
  { name: "Bills & Fees", kind: "expense", icon: "receipt", color: "#64748b" , essential: true },
  { name: "Interest & Fees", kind: "expense", icon: "percent", color: "#dc2626" },
  { name: "Other Expense", kind: "expense", icon: "circle-ellipsis", color: "#78716c" },
  { name: "Salary", kind: "income", icon: "briefcase", color: "#16a34a" },
  { name: "Business", kind: "income", icon: "store", color: "#059669" },
  { name: "Gifts", kind: "income", icon: "gift", color: "#14b8a6" },
  { name: "Other Income", kind: "income", icon: "circle-plus", color: "#22c55e" },
];
