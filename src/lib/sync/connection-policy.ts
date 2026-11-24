/**
 * Wi-Fi-only automatic sync policy.
 *
 * Automatic sync is allowed ONLY when the browser positively reports Wi-Fi (or Ethernet).
 * Anything else — cellular, data saver, an unknown type, or a browser without the Network
 * Information API (iOS Safari, desktop Chrome/Edge, Firefox) — pauses automatic sync.
 * `navigator.onLine` only tells us we're offline; it never identifies Wi-Fi.
 */
export interface ConnectionInfo {
  online: boolean;
  /** navigator.connection is present at all */
  apiAvailable: boolean;
  /** navigator.connection.type, if exposed */
  type?: string;
  saveData?: boolean;
}

export type ConnectionStatus =
  | "offline"
  | "wifi"
  | "ethernet"
  | "cellular"
  | "data_saver"
  | "unknown";

export interface ConnectionDecision {
  status: ConnectionStatus;
  autoSyncAllowed: boolean;
  /** Human explanation for the status UI. */
  reason: string;
}

export function evaluateConnection(info: ConnectionInfo): ConnectionDecision {
  if (!info.online) return { status: "offline", autoSyncAllowed: false, reason: "You're offline." };
  if (info.saveData)
    return { status: "data_saver", autoSyncAllowed: false, reason: "Data Saver is on, so automatic sync is paused." };
  switch (info.apiAvailable ? info.type : undefined) {
    case "wifi":
      return { status: "wifi", autoSyncAllowed: true, reason: "Connected to Wi-Fi." };
    case "ethernet":
      return { status: "ethernet", autoSyncAllowed: true, reason: "Connected by cable (not mobile data)." };
    case "cellular":
    case "wimax":
      return {
        status: "cellular",
        autoSyncAllowed: false,
        reason: "You're on mobile data. Automatic sync waits for Wi-Fi.",
      };
    default:
      return {
        status: "unknown",
        autoSyncAllowed: false,
        reason: "This browser doesn't say whether you're on Wi-Fi or mobile data, so automatic sync is paused.",
      };
  }
}

/** Read the current connection from the browser (client only). */
export function readConnection(): ConnectionInfo {
  if (typeof navigator === "undefined") return { online: false, apiAvailable: false };
  const c = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection;
  return {
    online: navigator.onLine,
    apiAvailable: !!c,
    type: c?.type,
    saveData: c?.saveData,
  };
}

/** Subscribe to connection changes (online/offline and Network Information API changes). */
export function onConnectionChange(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const c = (navigator as Navigator & { connection?: EventTarget }).connection;
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  c?.addEventListener?.("change", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
    c?.removeEventListener?.("change", cb);
  };
}
