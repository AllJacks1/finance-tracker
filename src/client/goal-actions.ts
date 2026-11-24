"use client";
/**
 * Goals, emergency fund preferences, manual assets and net-worth snapshots.
 * Goal entries are EARMARKS — never ledger entries. If money also physically moves to the goal's
 * account, that is an ordinary TRANSFER (not spending), saved in the same atomic group.
 */
import type { Goal, GoalEntry, ManualAsset, Preferences, Transaction } from "@/lib/domain/types";
import { TXN_LINKS } from "@/lib/domain/types";
import { monthlySnapshotId } from "@/lib/domain/ids";
import { localDateOf, type ISODate } from "@/lib/finance/dates";
import type { Centavos } from "@/lib/finance/money";
import { netWorthAsOf, toSnapshot } from "@/lib/finance/networth";
import { entitySchemas } from "@/lib/sync/protocol";
import { ActionError, newId } from "./actions";
import { withPreferences } from "./settings";
import { vault } from "./vault";

function store() {
  if (!vault.store) throw new ActionError("Your data is locked.");
  return vault.store;
}
function check<T>(entity: keyof typeof entitySchemas, data: T): T {
  const r = entitySchemas[entity].safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new ActionError(i ? `${i.path.join(".") || "value"}: ${i.message}` : "Invalid data");
  }
  return r.data as T;
}
const settings = () => withPreferences(store().list("settings")[0]?.data);

export async function saveGoal(g: Goal) {
  const s = store();
  const cur = s.get("goal", g.id);
  await s.mutate("goal", g.id, cur ? "update" : "create", check("goal", g));
}

export async function deleteGoal(g: Goal) {
  await store().mutate("goal", g.id, "delete");
}

const entry = (goalId: string, amount: Centavos, date: ISODate, note: string | null, transactionId: string | null, groupId: string | null): GoalEntry =>
  check("goalEntry", { id: newId(), goalId, amount, entryDate: date, note, transactionId, groupId });

/** Contribute to a goal; optionally record the actual transfer into the goal's account. */
export async function contribute(goal: Goal, amount: Centavos, date: ISODate, note: string | null, transferFrom: string | null) {
  if (amount <= 0) throw new ActionError("Enter an amount.");
  if (!transferFrom || !goal.accountId) {
    const e = entry(goal.id, amount, date, note, null, null);
    await store().mutate("goalEntry", e.id, "create", e);
    return;
  }
  if (transferFrom === goal.accountId) throw new ActionError("Choose a different account to transfer from.");
  const t: Transaction = check("transaction", {
    ...TXN_LINKS,
    id: newId(),
    type: "transfer",
    amount,
    accountId: transferFrom,
    toAccountId: goal.accountId,
    adjustmentDirection: null,
    categoryId: null,
    occurredAt: `${date}T12:00:00+08:00`,
    localDate: localDateOf(`${date}T12:00:00+08:00`, settings().timezone),
    description: `Saving for ${goal.name}`,
    notes: note,
    tagIds: [],
    refundOfId: null,
  });
  const e = entry(goal.id, amount, date, note, t.id, null);
  await store().mutateGroup([
    { entity: "transaction", id: t.id, kind: "create", data: t },
    { entity: "goalEntry", id: e.id, kind: "create", data: e },
  ]);
}

export async function withdraw(goal: Goal, amount: Centavos, date: ISODate, note: string | null) {
  if (amount <= 0) throw new ActionError("Enter an amount.");
  const e = entry(goal.id, -amount, date, note, null, null);
  await store().mutate("goalEntry", e.id, "create", e);
}

/** Move earmarked money from one goal to another (atomic). */
export async function reallocate(from: Goal, to: Goal, amount: Centavos, date: ISODate) {
  if (amount <= 0) throw new ActionError("Enter an amount.");
  if (from.id === to.id) throw new ActionError("Choose a different goal.");
  const out = entry(from.id, -amount, date, `Moved to ${to.name}`, null, null);
  const inn = entry(to.id, amount, date, `Moved from ${from.name}`, null, null);
  await store().mutateGroup([
    { entity: "goalEntry", id: out.id, kind: "create", data: out },
    { entity: "goalEntry", id: inn.id, kind: "create", data: inn },
  ]);
}

export async function savePreferences(patch: Partial<Preferences>) {
  const s = store();
  const cur = settings();
  if (!cur.id || !s.get("settings", cur.id)) throw new ActionError("Settings haven't been downloaded yet. Sync once first.");
  const next = { ...cur, preferences: { ...cur.preferences, ...patch, notifications: { ...cur.preferences.notifications, ...(patch.notifications ?? {}) } } };
  await s.mutate("settings", cur.id, "update", check("settings", next));
}

// ----------------------------------------------------------------------------- net worth

export async function saveAsset(a: ManualAsset) {
  const s = store();
  const cur = s.get("manualAsset", a.id);
  await s.mutate("manualAsset", a.id, cur ? "update" : "create", check("manualAsset", a));
}

export async function deleteAsset(a: ManualAsset) {
  await store().mutate("manualAsset", a.id, "delete");
}

/**
 * Record a snapshot. Monthly automatic snapshots use a deterministic id per workspace and month,
 * so several devices can't create two; the first one recorded wins and is never rewritten.
 */
export async function takeSnapshot(kind: "auto" | "manual", date: ISODate) {
  const s = store();
  const live = <T,>(rs: { data: T; deletedAt: string | null }[]) => rs.map((r) => ({ ...r.data, deletedAt: r.deletedAt }));
  const nw = netWorthAsOf(
    live(s.list("account", { includeDeleted: true })),
    live(s.list("transaction", { includeDeleted: true })),
    live(s.list("manualAsset")),
    date,
  );
  const id = kind === "auto" ? monthlySnapshotId(settings().id, date) : newId();
  if (s.get("netWorthSnapshot", id)) return;
  await s.mutate("netWorthSnapshot", id, "create", check("netWorthSnapshot", toSnapshot(id, nw, kind, new Date().toISOString())));
}
