"use client";
/**
 * User actions on financial data. Every action writes to the local encrypted store and queues a
 * sync op; nothing here talks to the server directly, so all of it works offline.
 */
import { v7 as uuidv7 } from "uuid";
import type { Account, Allocation, Budget, Category, EntityMap, EntityName, Reconciliation, Tag, Template, Transaction, WorkspaceSettings } from "@/lib/domain/types";
import { localDateOf } from "@/lib/finance/dates";
import { validateTransaction } from "@/lib/finance/ledger";
import { entitySchemas } from "@/lib/sync/protocol";
import { vault } from "./vault";
import { withPreferences } from "./settings";

export class ActionError extends Error {}

function store() {
  if (!vault.store) throw new ActionError("Your data is locked.");
  return vault.store;
}

function settings(): WorkspaceSettings {
  return withPreferences(store().list("settings")[0]?.data as WorkspaceSettings | undefined);
}

async function save<E extends EntityName>(entity: E, data: EntityMap[E]) {
  const parsed = entitySchemas[entity].safeParse(data);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ActionError(first ? `${first.path.join(".") || "value"}: ${first.message}` : "Invalid data");
  }
  const exists = store().get(entity, data.id as string);
  return store().mutate(entity, data.id as string, exists ? "update" : "create", parsed.data as EntityMap[E]);
}

export const newId = () => uuidv7();

export async function saveTransaction(input: Omit<Transaction, "localDate"> & { localDate?: string }) {
  const t: Transaction = { ...input, localDate: localDateOf(input.occurredAt, settings().timezone) };
  const s = store();
  const issues = validateTransaction(t, {
    accounts: new Map(s.list("account").map((a) => [a.id, a.data])),
    categories: new Map(s.list("category").map((c) => [c.id, c.data])),
  });
  if (issues.length) throw new ActionError(issues[0]!.message);
  return save("transaction", t);
}

export async function duplicateTransaction(id: string, occurredAt = new Date().toISOString()) {
  const src = store().get("transaction", id);
  if (!src) throw new ActionError("Not found");
  return saveTransaction({ ...src.data, id: newId(), occurredAt, refundOfId: src.data.refundOfId });
}

export const saveAccount = (a: Account) => save("account", a);
export const saveCategory = (c: Category) => save("category", c);
export const saveTag = (t: Tag) => save("tag", t);
export const saveTemplate = (t: Template) => save("template", t);
export const saveAllocation = (a: Allocation) => save("allocation", a);
export const saveReconciliation = (r: Reconciliation) => save("reconciliation", r);
export const saveSettings = (s: WorkspaceSettings) => {
  if (!store().get("settings", s.id)) throw new ActionError("Settings haven't been downloaded yet. Sync once first.");
  return save("settings", s);
};

export async function saveBudget(b: Budget) {
  if ((b.scope === "category") !== !!b.categoryId) throw new ActionError("Choose a category for a category budget.");
  if (b.period === "custom" && (!b.endDate || b.endDate < b.startDate)) throw new ActionError("End date must be after the start date.");
  return save("budget", b);
}

export async function remove(entity: EntityName, id: string) {
  const s = store();
  if (entity === "account") {
    const used = s.list("transaction").some((t) => t.data.accountId === id || t.data.toAccountId === id);
    if (used) throw new ActionError("This account has transactions. Deactivate it instead.");
  }
  if (entity === "category") {
    const used = s.list("transaction").some((t) => t.data.categoryId === id) || s.list("budget").some((b) => b.data.categoryId === id);
    if (used) throw new ActionError("This category is in use. Archive it instead.");
  }
  return s.mutate(entity, id, "delete");
}

export async function restore(entity: EntityName, id: string) {
  return store().mutate(entity, id, "restore");
}
