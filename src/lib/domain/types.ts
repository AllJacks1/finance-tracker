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
  /** Optional link to an obligation this transaction pays. */
  allocationId: string | null;
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
  transactionId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
}

export interface WorkspaceSettings {
  id: string; // workspace id
  currency: "PHP";
  timezone: string;
  weekStart: number;
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
];

/** Record with sync metadata, as stored locally and returned by the server. */
export type Synced<T> = T & SyncMeta;

export const DEFAULT_CATEGORIES: { name: string; kind: CategoryKind; icon: string; color: string }[] = [
  { name: "Food", kind: "expense", icon: "utensils", color: "#f97316" },
  { name: "Transportation", kind: "expense", icon: "bus", color: "#0ea5e9" },
  { name: "Utilities", kind: "expense", icon: "plug", color: "#eab308" },
  { name: "Shopping", kind: "expense", icon: "shopping-bag", color: "#ec4899" },
  { name: "Entertainment", kind: "expense", icon: "clapperboard", color: "#8b5cf6" },
  { name: "Health", kind: "expense", icon: "heart-pulse", color: "#ef4444" },
  { name: "Bills & Fees", kind: "expense", icon: "receipt", color: "#64748b" },
  { name: "Other Expense", kind: "expense", icon: "circle-ellipsis", color: "#78716c" },
  { name: "Salary", kind: "income", icon: "briefcase", color: "#16a34a" },
  { name: "Business", kind: "income", icon: "store", color: "#059669" },
  { name: "Gifts", kind: "income", icon: "gift", color: "#14b8a6" },
  { name: "Other Income", kind: "income", icon: "circle-plus", color: "#22c55e" },
];
