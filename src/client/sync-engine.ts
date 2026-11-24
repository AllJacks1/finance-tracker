/**
 * Sync engine: pushes the outbox, then pulls server changes.
 *
 * Automatic sync runs only when ConnectionPolicy positively identifies Wi-Fi/Ethernet, the app is
 * open and unlocked. Manual sync on an unverified connection requires the caller to have obtained
 * the user's explicit confirmation (data charges may apply).
 */
import { evaluateConnection, onConnectionChange, readConnection, type ConnectionDecision, type ConnectionInfo } from "@/lib/sync/connection-policy";
import type { OpResult, PullResponse, PushResponse, SyncOp } from "@/lib/sync/protocol";
import { api, ApiCallError } from "./api";
import type { OutboxEntry } from "./local-db";
import type { WorkspaceStore } from "./store";

export type SyncPhase =
  | "idle"
  | "syncing"
  | "error" // last attempt failed (network/server); will retry
  | "auth_required" // server session expired; sign in to resume
  | "device_revoked";

export interface SyncStatus {
  /** What to show the user. */
  label:
    | "Synced"
    | "Pending"
    | "Syncing"
    | "Failed"
    | "Conflict detected"
    | "Paused – Mobile data"
    | "Paused – Connection unknown"
    | "Paused – Data saver"
    | "Offline"
    | "Sign in to sync";
  connection: ConnectionDecision;
  phase: SyncPhase;
  pending: number;
  failed: number;
  conflicts: number;
  lastSyncAt: string | null;
  lastError: string | null;
}

const BATCH = 50;
const PULL_PAGE = 500;
const AUTO_INTERVAL_MS = 60_000;

export class SyncEngine {
  private phase: SyncPhase = "idle";
  private lastError: string | null = null;
  private lastSyncAt: string | null = null;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private unsubConn: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private status: SyncStatus;
  private backoffUntil = 0;
  private failures = 0;
  private stopped = false;

  constructor(
    private store: WorkspaceStore,
    private readConn: () => ConnectionInfo = readConnection,
    private onAuthLost?: (code: string) => void,
  ) {
    this.status = this.compute();
    store.onLocalChange = () => this.schedule(1500);
    // Manual runs are still allowed after stop() (tests call run() directly); timers are not.
  }

  // ------------------------------------------------------------------ status
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getStatus = () => this.status;
  private compute(): SyncStatus {
    const connection = evaluateConnection(this.readConn());
    const o = this.store.getOutboxSummary();
    let label: SyncStatus["label"];
    if (this.phase === "auth_required" || this.phase === "device_revoked") label = "Sign in to sync";
    else if (this.phase === "syncing") label = "Syncing";
    else if (o.conflicts > 0) label = "Conflict detected";
    else if (o.failed > 0 || this.phase === "error") label = "Failed";
    else if (o.pending === 0 && this.lastSyncAt) label = "Synced";
    else if (connection.status === "offline") label = "Offline";
    else if (connection.status === "cellular") label = "Paused – Mobile data";
    else if (connection.status === "data_saver") label = "Paused – Data saver";
    else if (connection.status === "unknown") label = o.pending > 0 ? "Paused – Connection unknown" : "Paused – Connection unknown";
    else label = o.pending > 0 ? "Pending" : "Synced";
    return {
      label,
      connection,
      phase: this.phase,
      pending: o.pending,
      failed: o.failed,
      conflicts: o.conflicts,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
    };
  }
  private emit() {
    this.status = this.compute();
    for (const l of this.listeners) l();
  }
  refresh() {
    this.emit();
  }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    this.stopped = false;
    this.lastSyncAt = (await this.store.getMeta<string>("lastSyncAt")) ?? null;
    // Ops left "inflight" by a crash or closed tab go back to pending; the server dedupes by opId.
    const inflight = await this.store.db.outbox.where("status").equals("inflight").toArray();
    for (const o of inflight) await this.store.db.outbox.update(o.seq!, { status: "pending" });
    await this.store.refreshSummary();
    this.unsubConn = onConnectionChange(() => {
      this.emit();
      this.schedule(500);
    });
    this.timer = setInterval(() => this.schedule(0), AUTO_INTERVAL_MS);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisible);
    this.emit();
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    this.unsubConn?.();
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisible);
    this.listeners.clear();
  }

  private onVisible = () => {
    if (document.visibilityState === "visible") this.schedule(0);
  };

  /** Schedule an AUTOMATIC sync (only runs on verified Wi-Fi/Ethernet). */
  schedule(delayMs: number) {
    if (this.stopped) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.run({ manual: false }), delayMs);
  }

  autoSyncAllowed(): boolean {
    return evaluateConnection(this.readConn()).autoSyncAllowed;
  }

  /**
   * Run a sync. `manual: true` means the user explicitly asked for it; when Wi-Fi can't be
   * verified the UI must have shown the data-charges warning and got confirmation first.
   */
  run(opts: { manual: boolean }): Promise<void> {
    if (this.running) return this.running;
    if (this.store.isClosed) return Promise.resolve();
    const conn = evaluateConnection(this.readConn());
    if (conn.status === "offline") {
      this.emit();
      return Promise.resolve();
    }
    if (!opts.manual && !conn.autoSyncAllowed) {
      this.emit();
      return Promise.resolve();
    }
    if (!opts.manual && Date.now() < this.backoffUntil) return Promise.resolve();
    if (this.phase === "device_revoked") return Promise.resolve();

    const work = async () => {
      this.phase = "syncing";
      this.emit();
      try {
        await this.pushAll(opts.manual);
        await this.pullAll(opts.manual);
        this.lastSyncAt = new Date().toISOString();
        await this.store.setMeta("lastSyncAt", this.lastSyncAt);
        this.phase = "idle";
        this.lastError = null;
        this.failures = 0;
        this.backoffUntil = 0;
      } catch (e) {
        if (e instanceof ApiCallError && e.status === 401) {
          this.phase = e.code === "device_revoked" ? "device_revoked" : "auth_required";
          this.onAuthLost?.(e.code);
        } else if (e instanceof PausedError) {
          this.phase = "idle";
        } else {
          this.phase = "error";
          this.failures++;
          const delay = Math.min(30_000 * 2 ** (this.failures - 1), 15 * 60_000);
          this.backoffUntil = Date.now() + delay * (0.8 + Math.random() * 0.4);
          this.lastError = e instanceof ApiCallError ? e.message : "Sync failed";
        }
      } finally {
        await this.store.finishBatch();
        this.emit();
      }
    };

    const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
    this.running = (locks ? locks.request(`ft-sync-${this.store.db.name}`, work) : work()).finally(() => {
      this.running = null;
    }) as Promise<void>;
    return this.running;
  }

  /** Re-check the network between batches; stop if automatic sync is no longer allowed. */
  private checkStillAllowed(manual: boolean) {
    const c = evaluateConnection(this.readConn());
    if (c.status === "offline" || (!manual && !c.autoSyncAllowed)) throw new PausedError();
  }

  // ------------------------------------------------------------------ push
  private async nextBatch(): Promise<OutboxEntry[]> {
    const all = await this.store.db.outbox.orderBy("seq").toArray();
    const stuck = new Set<string>(); // entities with an unresolved conflict/failure: keep order
    const batch: OutboxEntry[] = [];
    for (const o of all) {
      if (o.status === "conflict" || o.status === "failed") {
        stuck.add(o.entityId);
        continue;
      }
      if (o.status !== "pending" || stuck.has(o.entityId)) continue;
      batch.push(o);
      if (batch.length >= BATCH) break;
    }
    return batch;
  }

  private async pushAll(manual: boolean) {
    for (let round = 0; round < 1000; round++) {
      this.checkStillAllowed(manual);
      const batch = await this.nextBatch();
      if (!batch.length) return;
      const ops: SyncOp[] = [];
      for (const o of batch) {
        ops.push({
          opId: o.opId,
          entity: o.entity,
          entityId: o.entityId,
          kind: o.kind,
          baseVersion: o.baseVersion,
          data: await this.store.decryptOpData(o),
          clientCreatedAt: o.createdAt,
        });
      }
      await this.store.db.outbox.bulkUpdate(batch.map((o) => ({ key: o.seq!, changes: { status: "inflight" as const, attempts: o.attempts + 1 } })));
      let res: PushResponse;
      try {
        res = await api<PushResponse>("/api/sync/push", { body: { ops }, timeoutMs: 60_000 });
      } catch (e) {
        await this.store.db.outbox.bulkUpdate(batch.map((o) => ({ key: o.seq!, changes: { status: "pending" as const } })));
        throw e;
      }
      const bySeq = new Map(batch.map((o) => [o.opId, o]));
      let progressed = false;
      for (const r of res.results as OpResult[]) {
        const op = bySeq.get(r.opId);
        if (!op) continue;
        if ((r.status === "applied" || r.status === "duplicate") && r.record) {
          await this.store.onOpApplied(op, r.record);
          progressed = true;
        } else if (r.status === "conflict" && r.record) {
          await this.store.onOpConflict(op, r.record);
          progressed = true;
        } else if (r.status === "rejected") {
          await this.store.onOpRejected(op, r.error?.message ?? "Rejected by server");
          progressed = true;
        } else {
          await this.store.db.outbox.update(op.seq!, { status: "pending" });
        }
      }
      await this.store.finishBatch();
      this.emit();
      if (!progressed) return;
    }
  }

  // ------------------------------------------------------------------ pull
  private async pullAll(manual: boolean) {
    let cursor = (await this.store.getMeta<number>("cursor")) ?? 0;
    for (let page = 0; page < 10_000; page++) {
      this.checkStillAllowed(manual);
      const res = await api<PullResponse>(`/api/sync/pull?cursor=${cursor}&limit=${PULL_PAGE}`, { timeoutMs: 60_000 });
      for (const rec of res.records) await this.store.applyServerRecord(rec);
      cursor = res.cursor;
      await this.store.setMeta("cursor", cursor);
      this.store.notify();
      if (!res.hasMore) return;
    }
  }
}

class PausedError extends Error {}
