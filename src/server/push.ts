import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import webpush from "web-push";
import { db } from "./db";
import { pushSubscriptions } from "./db/schema";
import { ApiError } from "./errors";

/**
 * Web Push (VAPID). Optional: without VAPID_* env vars, push is simply unavailable and the app
 * relies on in-app notifications. Payloads are end-to-end encrypted to the device (RFC 8291) by
 * the web-push library; push services can't read them.
 */
export function pushConfigured(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
}

let ready = false;
function init() {
  if (!pushConfigured()) throw new ApiError(503, "push_not_configured", "Push notifications aren't set up on this server.");
  if (!ready) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT!, process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
    ready = true;
  }
}

export function publicKey(): string {
  init();
  return process.env.VAPID_PUBLIC_KEY!;
}

export async function saveSubscription(userId: string, deviceId: string | null, sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  await db()
    .insert(pushSubscriptions)
    .values({ userId, deviceId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId, deviceId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, revokedAt: null, failedCount: 0 },
    });
}

export async function removeSubscription(userId: string, endpoint: string) {
  await db()
    .update(pushSubscriptions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}

export async function activeSubscriptions(userId: string) {
  return db()
    .select()
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.revokedAt)));
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

/** Send to every active subscription of a user. Gone subscriptions (404/410) are revoked. */
export async function sendToUser(userId: string, payload: PushPayload): Promise<number> {
  init();
  let sent = 0;
  for (const s of await activeSubscriptions(userId)) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 60 * 60 * 12 });
      sent++;
      await db().update(pushSubscriptions).set({ lastSuccessAt: sql`now()`, failedCount: 0 }).where(eq(pushSubscriptions.id, s.id));
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      await db()
        .update(pushSubscriptions)
        .set(status === 404 || status === 410 ? { revokedAt: sql`now()` } : { failedCount: sql`${pushSubscriptions.failedCount} + 1` })
        .where(eq(pushSubscriptions.id, s.id));
    }
  }
  return sent;
}
