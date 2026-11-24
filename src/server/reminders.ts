import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Account, Bill, CardProfile, InstallmentPlan, Schedule, ScheduleException, Transaction } from "@/lib/domain/types";
import { buildBillViews } from "@/lib/finance/bills";
import { addDays, todayIn } from "@/lib/finance/dates";
import { formatPHP } from "@/lib/finance/money";
import { pendingConfirmations } from "@/lib/finance/schedules";
import { preferencesSchema } from "@/lib/sync/protocol";
import { db, withContext } from "./db";
import * as s from "./db/schema";
import { log } from "./log";
import type { PushPayload } from "./push";

/**
 * Daily reminders (Web Push). Runs per user INSIDE that user's own RLS context (ft_app role):
 * it can only read that user's workspace, like the user's own session. It reads bill due dates,
 * payments and schedules to decide what is due; nothing is stored except dedupe keys.
 *
 * Payload text is generic by default ("2 bills are due soon"); names and amounts are included
 * only if the user turned on "show amounts in push notifications".
 */
export interface Reminder {
  key: string;
  line: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function collectReminders(userId: string, now = new Date()): Promise<{ reminders: Reminder[]; showAmounts: boolean }> {
  const [ws] = await withContext({ userId }, (tx) => tx.select().from(s.workspaces).where(eq(s.workspaces.ownerUserId, userId)).limit(1));
  if (!ws) return { reminders: [], showAmounts: false };
  const prefs = preferencesSchema.parse(ws.preferences ?? {});
  const n = prefs.notifications;
  const today = todayIn(ws.timezone, now);

  return withContext({ userId, workspaceId: ws.id }, async (tx) => {
    const sel = (t: any) => tx.select().from(t).where(isNull(t.deletedAt));
    const [accounts, txns, bills, schedules, exceptions, cardProfiles, plans] = await Promise.all([
      sel(s.accounts),
      tx.select().from(s.transactions).where(and(isNull(s.transactions.deletedAt), sql`${s.transactions.localDate} >= ${addDays(today, -400)}`)),
      sel(s.bills),
      sel(s.schedules),
      sel(s.scheduleExceptions),
      sel(s.cardProfiles),
      sel(s.installmentPlans),
    ]);
    const out: Reminder[] = [];
    const show = (name: string, amount: number) => (prefs.notifications.pushShowAmounts ? `${name} ${formatPHP(amount)}` : name);

    const views = buildBillViews(
      {
        bills: bills as unknown as (Bill & { deletedAt: string | null })[],
        schedules: schedules as unknown as (Schedule & { deletedAt: string | null })[],
        exceptions: exceptions as unknown as (ScheduleException & { deletedAt: string | null })[],
        cardProfiles: cardProfiles as unknown as CardProfile[],
        plans: plans as unknown as InstallmentPlan[],
        accounts: accounts as unknown as (Account & { deletedAt: string | null })[],
        txns: txns as unknown as (Transaction & { deletedAt: string | null })[],
        today,
      },
      addDays(today, -60),
      addDays(today, n.billDaysBefore),
    );
    for (const b of views) {
      if (b.cancelled || b.outstanding === 0) continue;
      const kind = b.kind === "card_payment" ? n.cards : b.kind === "loan_installment" ? n.loans : n.bills;
      if (!kind) continue;
      const stage = b.status === "overdue" ? "overdue" : b.status === "due_today" ? "today" : "soon";
      out.push({ key: `bill:${b.id}:${stage}`, line: `${stage === "overdue" ? "Overdue" : stage === "today" ? "Due today" : `Due ${b.dueDate}`}: ${show(b.name, b.outstanding)}` });
    }
    if (n.scheduled) {
      for (const o of pendingConfirmations(schedules as unknown as Schedule[], { today, exceptions: exceptions as unknown as ScheduleException[], txns: txns as unknown as Transaction[] })) {
        out.push({ key: `occ:${o.key}`, line: `Confirm: ${show(o.schedule.name, o.amount)}` });
      }
    }
    return { reminders: out, showAmounts: prefs.notifications.pushShowAmounts };
  });
}

/** Build one push for the NEW reminders of a user (dedupe via notification_log). */
export async function newRemindersFor(userId: string, now = new Date()): Promise<{ payload: PushPayload | null; keys: string[] }> {
  const { reminders, showAmounts } = await collectReminders(userId, now);
  if (!reminders.length) return { payload: null, keys: [] };
  const seen = await db()
    .select({ key: s.notificationLog.key })
    .from(s.notificationLog)
    .where(and(eq(s.notificationLog.userId, userId), inArray(s.notificationLog.key, reminders.map((r) => r.key))));
  const seenKeys = new Set(seen.map((r) => r.key));
  const fresh = reminders.filter((r) => !seenKeys.has(r.key));
  if (!fresh.length) return { payload: null, keys: [] };
  const overdue = fresh.filter((r) => r.key.endsWith(":overdue")).length;
  const today = fresh.filter((r) => r.key.endsWith(":today")).length;
  const confirm = fresh.filter((r) => r.key.startsWith("occ:")).length;
  const soon = fresh.length - overdue - today - confirm;
  const parts = [
    overdue ? `${overdue} overdue` : null,
    today ? `${today} due today` : null,
    soon ? `${soon} due soon` : null,
    confirm ? `${confirm} to confirm` : null,
  ].filter(Boolean);
  const body = showAmounts ? fresh.slice(0, 4).map((r) => r.line).join("\n") + (fresh.length > 4 ? `\n+${fresh.length - 4} more` : "") : `You have ${parts.join(", ")}.`;
  return {
    payload: { title: "Finance Tracker reminders", body, url: overdue || today ? "/app/bills" : "/app/calendar", tag: "ft-reminders" },
    keys: fresh.map((r) => r.key),
  };
}

export async function markSent(userId: string, keys: string[]) {
  if (!keys.length) return;
  await db()
    .insert(s.notificationLog)
    .values(keys.map((key) => ({ userId, key })))
    .onConflictDoNothing();
}

/** Users who have at least one active push subscription and are active. */
export async function usersWithPush(): Promise<string[]> {
  const rows = await db()
    .selectDistinct({ userId: s.pushSubscriptions.userId })
    .from(s.pushSubscriptions)
    .innerJoin(s.users, eq(s.users.id, s.pushSubscriptions.userId))
    .where(and(isNull(s.pushSubscriptions.revokedAt), eq(s.users.status, "active")));
  return rows.map((r) => r.userId);
}

export async function runReminders(send: (userId: string, p: PushPayload) => Promise<number>, now = new Date()) {
  let users = 0;
  let pushed = 0;
  for (const userId of await usersWithPush()) {
    try {
      const { payload, keys } = await newRemindersFor(userId, now);
      if (!payload) continue;
      users++;
      if ((await send(userId, payload)) > 0) {
        pushed++;
        await markSent(userId, keys);
      }
    } catch (e) {
      log.error("reminders_user_failed", { err: e }); // never log the user's data
    }
  }
  return { users, pushed };
}
