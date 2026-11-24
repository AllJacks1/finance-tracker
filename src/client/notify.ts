"use client";
/**
 * System notifications.
 *  - While the app is open: urgent in-app notifications are also shown as system notifications
 *    (once per item), if the user allowed notifications.
 *  - While the app is closed: only Web Push (server reminders) can notify. Browsers cannot
 *    schedule local notifications for a closed app; iOS delivers push only to Home-Screen apps.
 */
import { api } from "./api";

export type PushState = "unsupported" | "not_configured" | "denied" | "off" | "on";

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export async function pushState(): Promise<PushState> {
  if (!notificationsSupported() || !("PushManager" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const { configured } = await api<{ configured: boolean }>("/api/push/key").catch(() => ({ configured: false }));
  if (!configured) return "not_configured";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "off";
}

/** Must be called from a user gesture (tap). */
export async function enablePush(): Promise<PushState> {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "denied" : "off";
  const { publicKey } = await api<{ publicKey: string | null }>("/api/push/key");
  if (!publicKey) return "not_configured";
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) }));
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api("/api/push/subscribe", { body: { endpoint: json.endpoint, keys: json.keys } });
  return "on";
}

export async function disablePush(): Promise<PushState> {
  if (!notificationsSupported()) return "off";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api("/api/push/subscribe", { method: "DELETE", body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
  return "off";
}

const SHOWN_KEY = "ft_shown_notifications";

/** Show a system notification for each new urgent item while the app is open (once each). */
export async function showLocalNotifications(items: { key: string; title: string; body: string; href: string; severity: string }[]) {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  let shown: string[] = [];
  try {
    shown = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? "[]");
  } catch {
    shown = [];
  }
  const fresh = items.filter((i) => i.severity !== "info" && !shown.includes(i.key)).slice(0, 3);
  if (!fresh.length) return;
  const reg = await navigator.serviceWorker.getRegistration();
  for (const i of fresh) {
    if (reg) await reg.showNotification(i.title, { body: i.body, tag: i.key, icon: "/icons/icon-192.png", data: { url: i.href } });
    else new Notification(i.title, { body: i.body, tag: i.key });
  }
  try {
    localStorage.setItem(SHOWN_KEY, JSON.stringify([...shown, ...fresh.map((i) => i.key)].slice(-300)));
  } catch {
    /* storage unavailable */
  }
}
