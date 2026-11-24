/**
 * Vault: who is signed in on this device, and whether their local data is unlocked.
 *
 * Phases
 *  - "init"        starting up
 *  - "signed_out"  no usable local session (online sign-in required)
 *  - "locked"      local data exists and is encrypted; PIN (offline) or password (online) needed
 *  - "unlocked"    data key in memory; store + sync engine running
 */
import type { Role } from "@/lib/permissions";
import { api, ApiCallError } from "./api";
import {
  importAesKey,
  newRawKey,
  PIN_MAX_FAILURES,
  pinLockoutMs,
  pinProblem,
  unwrapWithPin,
  unwrapWithRecovery,
  wrapWithPin,
  wrapWithRecovery,
} from "./crypto";
import { deleteUserDb, getDeviceDb, getInstallId, UserDB, userDbName, type KeyWraps } from "./local-db";
import { WorkspaceStore } from "./store";
import { SyncEngine } from "./sync-engine";
import type { ConnectionInfo } from "@/lib/sync/connection-policy";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  mustChangePassword: boolean;
}

export interface VaultState {
  phase: "init" | "signed_out" | "locked" | "unlocked";
  user: { id: string; name: string; email?: string; role?: Role } | null;
  /** Server session is valid right now (false when offline or expired). */
  online: boolean;
  hasPin: boolean;
  pinFailures: number;
  pinLockedUntil: number;
  permissions: string[];
  mustChangePassword: boolean;
  message: string | null;
}

interface MeResponse {
  user: SessionUser;
  deviceId: string;
  workspaceId: string | null;
  permissions: string[];
}

const initial: VaultState = {
  phase: "init",
  user: null,
  online: false,
  hasPin: false,
  pinFailures: 0,
  pinLockedUntil: 0,
  permissions: [],
  mustChangePassword: false,
  message: null,
};

class Vault {
  private state: VaultState = initial;
  private listeners = new Set<() => void>();
  store: WorkspaceStore | null = null;
  engine: SyncEngine | null = null;
  private db: UserDB | null = null;
  private autoLockTimer: ReturnType<typeof setTimeout> | null = null;
  autoLockMs = 5 * 60_000;
  /** Overridable for tests; defaults to the browser's Network Information API. */
  readConnection: (() => ConnectionInfo) | undefined = undefined;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getState = () => this.state;
  private set(patch: Partial<VaultState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  // ------------------------------------------------------------------ startup
  private initPromise: Promise<void> | null = null;
  init(): Promise<void> {
    this.initPromise ??= this.doInit().catch((e) => {
      // Never leave the app on a spinner: fall back to the sign-in screen.
      console.error("vault init failed", e);
      this.initPromise = null;
      this.set({ phase: "signed_out", user: null, message: "Couldn't open local data on this device. Please sign in again." });
    });
    return this.initPromise;
  }

  private async doInit() {
    const known = await getDeviceDb().users.orderBy("lastUsedAt").reverse().toArray();
    const last = known[0];
    let me: MeResponse | null = null;
    let offline = false;
    try {
      me = await api<MeResponse>("/api/auth/me", { timeoutMs: 8_000 });
    } catch (e) {
      if (e instanceof ApiCallError && e.status === 401) {
        if (e.code === "device_revoked" && last) await this.wipe(last.userId);
      } else if (e instanceof ApiCallError && e.isNetwork) {
        offline = true;
      }
    }

    if (me) {
      this.set({ permissions: me.permissions, mustChangePassword: me.user.mustChangePassword, online: true });
      if (me.user.mustChangePassword) {
        this.set({ phase: "signed_out", user: { ...me.user } });
        return;
      }
      const db = await this.openDb(me.user.id);
      const wraps = (await db.meta.get("keyWraps"))?.value as KeyWraps | undefined;
      if (wraps?.pin) {
        // PIN set: require it even online (cookie alone can't bypass the lock).
        await this.toLocked({ id: me.user.id, name: me.user.name, email: me.user.email, role: me.user.role }, db);
        return;
      }
      try {
        const { recoveryKey } = await api<{ recoveryKey: string }>("/api/auth/device-key", { body: {} });
        await this.unlockWithRecovery(me.user, recoveryKey);
      } catch {
        this.set({ phase: "signed_out", user: null, message: "Please sign in again." });
      }
      return;
    }

    // No valid server session (signed out, expired, or offline).
    if (last) {
      const db = await this.openDb(last.userId);
      const wraps = (await db.meta.get("keyWraps"))?.value as KeyWraps | undefined;
      if (wraps?.pin) {
        await this.toLocked({ id: last.userId, name: last.name }, db);
        this.set({ online: false });
        return;
      }
    }
    this.set({
      phase: "signed_out",
      user: null,
      online: false,
      message: offline ? "You're offline. Offline access needs a PIN set up while online." : null,
    });
  }

  private async openDb(userId: string): Promise<UserDB> {
    if (this.db && this.db.name === (await userDbName(userId))) return this.db;
    this.db?.close();
    this.db = new UserDB(await userDbName(userId));
    await this.db.open();
    return this.db;
  }

  private async toLocked(user: VaultState["user"], db: UserDB) {
    const failures = ((await db.meta.get("pinFailures"))?.value as number) ?? 0;
    const lockedUntil = ((await db.meta.get("pinLockedUntil"))?.value as number) ?? 0;
    this.set({ phase: "locked", user, hasPin: true, pinFailures: failures, pinLockedUntil: lockedUntil, message: null });
  }

  // ------------------------------------------------------------------ sign in
  async login(email: string, password: string): Promise<{ mustChangePassword: boolean }> {
    const installId = await getInstallId();
    const res = await api<{ user: SessionUser; deviceId: string; deviceReset: boolean; recoveryKey: string }>(
      "/api/auth/login",
      { body: { email, password, installId, deviceLabel: deviceLabel() } },
    );
    if (res.deviceReset) await this.wipe(res.user.id); // this device was revoked earlier
    this.set({ online: true, mustChangePassword: res.user.mustChangePassword });
    if (res.user.mustChangePassword) {
      this.set({ phase: "signed_out", user: { ...res.user } });
      return { mustChangePassword: true };
    }
    const me = await api<MeResponse>("/api/auth/me");
    this.set({ permissions: me.permissions });
    await this.unlockWithRecovery(res.user, res.recoveryKey);
    return { mustChangePassword: false };
  }

  /** Unlock (or initialise) local data with the server-held device recovery key. */
  private async unlockWithRecovery(user: SessionUser, recoveryKey: string): Promise<void> {
    const db = await this.openDb(user.id);
    let wraps = (await db.meta.get("keyWraps"))?.value as KeyWraps | undefined;
    let raw: Uint8Array;
    if (wraps) {
      try {
        raw = await unwrapWithRecovery(wraps.recovery, recoveryKey);
      } catch {
        // Recovery key changed (device was revoked and re-registered): old local data is unreadable.
        await this.wipe(user.id);
        return this.unlockWithRecovery(user, recoveryKey);
      }
    } else {
      raw = newRawKey();
      wraps = { recovery: await wrapWithRecovery(raw, recoveryKey), pin: null };
      await db.meta.put({ key: "keyWraps", value: wraps });
    }
    await getDeviceDb().users.put({ userId: user.id, name: user.name, dbName: db.name, lastUsedAt: new Date().toISOString() });
    await db.meta.bulkPut([
      { key: "pinFailures", value: 0 },
      { key: "pinLockedUntil", value: 0 },
    ]);
    this.set({ user: { id: user.id, name: user.name, email: user.email, role: user.role }, hasPin: !!wraps.pin, pinFailures: 0, pinLockedUntil: 0 });
    await this.openStore(user.id, db, raw);
  }

  private async openStore(userId: string, db: UserDB, raw: Uint8Array) {
    const dek = await importAesKey(raw);
    raw.fill(0);
    this.store?.close();
    this.engine?.stop();
    this.store = new WorkspaceStore(db, dek, userId);
    await this.store.load();
    this.engine = new SyncEngine(this.store, this.readConnection, (code) => {
      if (code === "device_revoked") void this.handleRevoked();
      else this.set({ online: false });
    });
    await this.engine.start();
    this.set({ phase: "unlocked", message: null });
    this.armAutoLock();
  }

  // ------------------------------------------------------------------ PIN
  async unlockWithPin(pin: string): Promise<{ ok: boolean; error?: string }> {
    const user = this.state.user;
    if (!user) return { ok: false, error: "No user" };
    const db = await this.openDb(user.id);
    const lockedUntil = ((await db.meta.get("pinLockedUntil"))?.value as number) ?? 0;
    if (Date.now() < lockedUntil) return { ok: false, error: "Too many attempts. Wait and try again." };
    const wraps = (await db.meta.get("keyWraps"))?.value as KeyWraps | undefined;
    if (!wraps?.pin) return { ok: false, error: "PIN is not set on this device. Sign in online." };
    try {
      const raw = await unwrapWithPin(wraps.pin, pin);
      await db.meta.bulkPut([
        { key: "pinFailures", value: 0 },
        { key: "pinLockedUntil", value: 0 },
      ]);
      await getDeviceDb().users.update(user.id, { lastUsedAt: new Date().toISOString() });
      this.set({ pinFailures: 0, pinLockedUntil: 0 });
      await this.openStore(user.id, db, raw);
      return { ok: true };
    } catch {
      const failures = (((await db.meta.get("pinFailures"))?.value as number) ?? 0) + 1;
      const until = Date.now() + pinLockoutMs(failures);
      await db.meta.bulkPut([
        { key: "pinFailures", value: failures },
        { key: "pinLockedUntil", value: until },
      ]);
      if (failures >= PIN_MAX_FAILURES) {
        await db.meta.put({ key: "keyWraps", value: { ...wraps, pin: null } satisfies KeyWraps });
        this.set({ phase: "signed_out", hasPin: false, message: "Too many wrong PINs. Sign in with your password to unlock." });
        return { ok: false, error: "PIN disabled after too many attempts. Sign in online." };
      }
      this.set({ pinFailures: failures, pinLockedUntil: until });
      return { ok: false, error: "Incorrect PIN." };
    }
  }

  /**
   * Set or change the offline PIN. Needs the device recovery key, which the server releases
   * only after password re-entry once offline access is enabled.
   */
  async setPin(pin: string, password?: string): Promise<{ ok: boolean; error?: string }> {
    const problem = pinProblem(pin);
    if (problem) return { ok: false, error: problem };
    const user = this.state.user;
    if (!user || this.state.phase !== "unlocked") return { ok: false, error: "Unlock first." };
    let recoveryKey: string;
    try {
      ({ recoveryKey } = await api<{ recoveryKey: string }>("/api/auth/device-key", {
        body: { password, setOfflineEnabled: true },
      }));
    } catch (e) {
      if (e instanceof ApiCallError && e.code === "reauth_required") return { ok: false, error: "reauth_required" };
      return { ok: false, error: e instanceof ApiCallError ? e.message : "Couldn't set PIN" };
    }
    const db = await this.openDb(user.id);
    const wraps = (await db.meta.get("keyWraps"))!.value as KeyWraps;
    const raw = await unwrapWithRecovery(wraps.recovery, recoveryKey);
    const pinWrap = await wrapWithPin(raw, pin);
    raw.fill(0);
    await db.meta.put({ key: "keyWraps", value: { ...wraps, pin: pinWrap } satisfies KeyWraps });
    await db.meta.bulkPut([
      { key: "pinFailures", value: 0 },
      { key: "pinLockedUntil", value: 0 },
    ]);
    this.set({ hasPin: true });
    return { ok: true };
  }

  async removePin(password: string): Promise<{ ok: boolean; error?: string }> {
    const user = this.state.user;
    if (!user) return { ok: false };
    try {
      await api("/api/auth/device-key", { body: { password, setOfflineEnabled: false } });
    } catch (e) {
      return { ok: false, error: e instanceof ApiCallError ? e.message : "Failed" };
    }
    const db = await this.openDb(user.id);
    const wraps = (await db.meta.get("keyWraps"))!.value as KeyWraps;
    await db.meta.put({ key: "keyWraps", value: { ...wraps, pin: null } satisfies KeyWraps });
    this.set({ hasPin: false });
    return { ok: true };
  }

  /** Forgot PIN / unlock while online: re-enter password; server releases the recovery key. */
  async unlockWithPassword(password: string): Promise<{ ok: boolean; error?: string }> {
    const user = this.state.user;
    if (!user?.email) {
      return { ok: false, error: "Sign in with your email and password." };
    }
    try {
      await this.login(user.email, password);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof ApiCallError ? e.message : "Couldn't sign in" };
    }
  }

  // ------------------------------------------------------------------ lock / logout
  /** Drop all decrypted data and the key from memory. */
  lock() {
    if (this.state.phase !== "unlocked") return;
    this.engine?.stop();
    this.store?.close();
    this.engine = null;
    this.store = null;
    if (this.state.hasPin) this.set({ phase: "locked" });
    else this.set({ phase: "signed_out", message: "Locked. Sign in to continue." });
  }

  /** Reset the inactivity auto-lock timer (only meaningful when a PIN is set). */
  armAutoLock() {
    if (this.autoLockTimer) clearTimeout(this.autoLockTimer);
    if (this.state.phase !== "unlocked" || !this.state.hasPin) return;
    this.autoLockTimer = setTimeout(() => this.lock(), this.autoLockMs);
  }

  async logout(opts: { removeLocalData: boolean }) {
    const userId = this.state.user?.id;
    try {
      await api("/api/auth/logout", { body: {} });
    } catch {
      /* offline: the cookie stays until it expires; local data is still locked/wiped below */
    }
    this.engine?.stop();
    this.store?.close();
    this.engine = null;
    this.store = null;
    this.db?.close();
    this.db = null;
    if (opts.removeLocalData && userId) await this.wipe(userId);
    this.initPromise = null;
    this.state = { ...initial, phase: "signed_out" };
    for (const l of this.listeners) l();
  }

  private async handleRevoked() {
    const userId = this.state.user?.id;
    this.engine?.stop();
    this.store?.close();
    this.engine = null;
    this.store = null;
    if (userId) await this.wipe(userId);
    this.set({ ...initial, phase: "signed_out", message: "This device was signed out by an administrator. Local data was removed." });
  }

  private async wipe(userId: string) {
    if (this.db && this.db.name === (await userDbName(userId))) {
      this.db.close();
      this.db = null;
    }
    await deleteUserDb(userId);
  }

  async pendingCount(): Promise<number> {
    if (!this.store) return 0;
    return this.store.getOutboxSummary().pending + this.store.getOutboxSummary().failed + this.store.getOutboxSummary().conflicts;
  }
}

function deviceLabel(): string {
  if (typeof navigator === "undefined") return "Browser";
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Device";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "Browser";
  const standalone = typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)").matches;
  return `${br} on ${os}${standalone ? " (app)" : ""}`;
}

export const vault = new Vault();
export type { Vault };
