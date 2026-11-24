/**
 * The unlocked user's local workspace: decrypted records in memory, persisted encrypted in
 * IndexedDB, plus the outbox of changes waiting to be synced.
 *
 * Every local change writes the record AND its outbox op in ONE IndexedDB transaction, so a
 * change is never visible without also being queued (and survives closing the app or a restart).
 */
import type { EntityMap, EntityName } from "@/lib/domain/types";
import type { OpKind, ServerRecord } from "@/lib/sync/protocol";
import { decryptJson, encryptJson } from "./crypto";
import type { ConflictEntry, OutboxEntry, RecordPayload, StoredRecord, UserDB } from "./local-db";

export interface LocalRecord<E extends EntityName = EntityName> {
  entity: E;
  id: string;
  /** Last server-confirmed version (0 = not yet on the server). */
  version: number;
  data: EntityMap[E];
  deletedAt: string | null;
  changeSeq: number;
  updatedAt: string | null;
  /** Has local changes not yet confirmed by the server. */
  pending: boolean;
  conflict: boolean;
  failed: string | null;
}

export interface ConflictInfo {
  entity: EntityName;
  entityId: string;
  opId: string;
  kind: OpKind;
  local: { data: Record<string, unknown> | null; deletedAt: string | null };
  server: ServerRecord;
  createdAt: string;
}

export interface OutboxSummary {
  pending: number;
  failed: number;
  conflicts: number;
  failedOps: { opId: string; entity: EntityName; entityId: string; kind: OpKind; error: string | null }[];
}

type Listener = () => void;

export class WorkspaceStore {
  private records = new Map<EntityName, Map<string, LocalRecord>>();
  private conflicts = new Map<string, ConflictInfo>();
  private outboxSummary: OutboxSummary = { pending: 0, failed: 0, conflicts: 0, failedOps: [] };
  private listeners = new Set<Listener>();
  private version = 0;
  private channel: BroadcastChannel | null = null;
  private closed = false;
  onLocalChange: (() => void) | null = null;

  constructor(
    readonly db: UserDB,
    /** Non-extractable data key; exists only while unlocked. */
    readonly dek: CryptoKey,
    readonly userId: string,
  ) {
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(`ft-changes-${db.name}`);
      // Another tab changed this user's data: reload (ignored once this store is closed/locked).
      this.channel.onmessage = () => {
        if (!this.closed) this.load().catch(() => {});
      };
    }
  }

  // ------------------------------------------------------------------ subscription
  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getVersion = () => this.version;
  private emit(broadcast = false) {
    this.version++;
    for (const l of this.listeners) l();
    if (broadcast && !this.closed) this.channel?.postMessage("changed");
  }

  get isClosed() {
    return this.closed;
  }

  close() {
    this.closed = true;
    this.onLocalChange = null;
    this.channel?.close();
    this.listeners.clear();
    this.records.clear();
    this.conflicts.clear();
  }

  // ------------------------------------------------------------------ loading
  async load() {
    if (this.closed) return;
    const [stored, outbox, conflicts] = await Promise.all([
      this.db.records.toArray(),
      this.db.outbox.toArray(),
      this.db.conflicts.toArray(),
    ]);
    const next = new Map<EntityName, Map<string, LocalRecord>>();
    const pendingIds = new Set(outbox.filter((o) => o.status === "pending" || o.status === "inflight").map((o) => o.entityId));
    const failedById = new Map(outbox.filter((o) => o.status === "failed").map((o) => [o.entityId, o.lastError ?? "Failed"]));
    const conflictIds = new Set(conflicts.map((c) => c.entityId));
    for (const s of stored) {
      const p = await decryptJson<RecordPayload>(this.dek, s);
      if (!next.has(s.entity)) next.set(s.entity, new Map());
      next.get(s.entity)!.set(s.id, {
        entity: s.entity,
        id: s.id,
        version: s.version,
        data: p.data as never,
        deletedAt: p.deletedAt,
        changeSeq: p.changeSeq,
        updatedAt: p.updatedAt,
        pending: pendingIds.has(s.id) || failedById.has(s.id) || conflictIds.has(s.id),
        conflict: conflictIds.has(s.id),
        failed: failedById.get(s.id) ?? null,
      });
    }
    const cmap = new Map<string, ConflictInfo>();
    for (const c of conflicts) cmap.set(c.entityId, await decryptJson<ConflictInfo>(this.dek, c));
    this.records = next;
    this.conflicts = cmap;
    this.outboxSummary = summarise(outbox);
    this.emit();
  }

  // ------------------------------------------------------------------ reads
  list<E extends EntityName>(entity: E, opts: { includeDeleted?: boolean } = {}): LocalRecord<E>[] {
    const m = this.records.get(entity);
    if (!m) return [];
    const out = [...m.values()] as LocalRecord<E>[];
    return opts.includeDeleted ? out : out.filter((r) => !r.deletedAt);
  }
  get<E extends EntityName>(entity: E, id: string): LocalRecord<E> | undefined {
    return this.records.get(entity)?.get(id) as LocalRecord<E> | undefined;
  }
  getConflicts(): ConflictInfo[] {
    return [...this.conflicts.values()];
  }
  getOutboxSummary(): OutboxSummary {
    return this.outboxSummary;
  }

  // ------------------------------------------------------------------ persistence helpers
  /**
   * Encrypt a record for storage. Always encrypt BEFORE opening an IndexedDB transaction:
   * awaiting WebCrypto inside a Dexie transaction would let it auto-commit early.
   */
  private async encodeRecord(r: LocalRecord): Promise<StoredRecord> {
    const payload: RecordPayload = { data: r.data as never, deletedAt: r.deletedAt, changeSeq: r.changeSeq, updatedAt: r.updatedAt };
    return { entity: r.entity, id: r.id, version: r.version, ...(await encryptJson(this.dek, payload)) };
  }
  private async writeRecord(r: LocalRecord) {
    await this.db.records.put(await this.encodeRecord(r));
  }
  private setMem(r: LocalRecord) {
    if (!this.records.has(r.entity)) this.records.set(r.entity, new Map());
    this.records.get(r.entity)!.set(r.id, r);
  }
  async refreshSummary() {
    this.outboxSummary = summarise(await this.db.outbox.toArray());
  }

  // ------------------------------------------------------------------ local mutations
  /**
   * Create/update/delete/restore a record locally and queue it for sync.
   * Pending (not yet sent) ops for the same record are coalesced so the server receives one
   * change based on the right version.
   */
  async mutate<E extends EntityName>(
    entity: E,
    id: string,
    kind: OpKind,
    data?: EntityMap[E],
  ): Promise<LocalRecord<E> | null> {
    const cur = this.get(entity, id);
    if (kind !== "create" && !cur) throw new Error("Record not found");
    if (kind === "create" && cur) throw new Error("Record already exists");
    const now = new Date().toISOString();

    let next: LocalRecord<E> | null;
    if (kind === "create")
      next = { entity, id, version: 0, data: data!, deletedAt: null, changeSeq: 0, updatedAt: now, pending: true, conflict: false, failed: null };
    else if (kind === "update") next = { ...(cur as LocalRecord<E>), data: data!, updatedAt: now, pending: true };
    else if (kind === "delete") next = { ...(cur as LocalRecord<E>), deletedAt: now, updatedAt: now, pending: true };
    else next = { ...(cur as LocalRecord<E>), deletedAt: null, updatedAt: now, pending: true };

    // Encrypt everything up front (see encodeRecord).
    const recDeleted = { ...next, pending: false } as LocalRecord;
    const [storedNext, storedNoPending, withData, withoutData] = await Promise.all([
      this.encodeRecord(next as LocalRecord),
      this.encodeRecord(recDeleted),
      encryptJson(this.dek, { data: next.data }),
      encryptJson(this.dek, { data: null }),
    ]);
    const makeOp = (k: OpKind, baseVersion: number | null): OutboxEntry => ({
      opId: crypto.randomUUID(),
      entity,
      entityId: id,
      kind: k,
      baseVersion,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      createdAt: now,
      ...(k === "create" || k === "update" ? withData : withoutData),
    });

    let removed = false;
    let settled = false;
    await this.db.transaction("rw", [this.db.records, this.db.outbox], async () => {
      const existing = (await this.db.outbox.where("entityId").equals(id).sortBy("seq")) as OutboxEntry[];
      // Never coalesce into an op that belongs to an atomic group.
      const allPending = existing.length > 0 && existing.every((o) => o.status === "pending" && !o.groupId);
      const first = existing[0];
      let replaceWith: { kind: OpKind; baseVersion: number | null } | null | "drop" = null;

      if (allPending && first) {
        const f = first.kind;
        if (f === "create" && kind === "update") replaceWith = { kind: "create", baseVersion: null };
        else if (f === "create" && kind === "delete") replaceWith = "drop";
        else if (f === "update" && (kind === "update" || kind === "delete")) replaceWith = { kind, baseVersion: first.baseVersion };
        else if (f === "delete" && kind === "restore" && existing.length === 1) replaceWith = "drop";
      }

      if (replaceWith === "drop") {
        await this.db.outbox.bulkDelete(existing.map((o) => o.seq!));
        if (first!.kind === "create") {
          await this.db.records.delete([entity, id]);
          removed = true; // never reached the server: remove entirely
          return;
        }
        settled = true;
        await this.db.records.put(storedNoPending);
        return;
      }
      if (replaceWith) {
        await this.db.outbox.bulkDelete(existing.map((o) => o.seq!));
        await this.db.outbox.add(makeOp(replaceWith.kind, replaceWith.baseVersion));
      } else {
        await this.db.outbox.add(makeOp(kind, kind === "create" ? null : cur!.version));
      }
      await this.db.records.put(storedNext);
    });
    if (removed) next = null;
    else if (settled) next = { ...next!, pending: false };

    if (next) this.setMem(next as LocalRecord);
    else this.records.get(entity)?.delete(id);
    await this.refreshSummary();
    this.emit(true);
    this.onLocalChange?.();
    return next;
  }

  /**
   * Several changes saved ATOMICALLY: all records and their outbox ops are written in one
   * IndexedDB transaction, and the ops share a groupId so the server applies them all-or-nothing
   * (e.g. a loan payment = principal transfer + interest expense).
   */
  async mutateGroup(changes: { entity: EntityName; id: string; kind: OpKind; data?: unknown }[]): Promise<void> {
    if (!changes.length) return;
    const groupId = crypto.randomUUID();
    const now = new Date().toISOString();
    const prepared: { rec: LocalRecord; stored: StoredRecord; op: OutboxEntry }[] = [];
    const seen = new Set<string>();
    for (const c of changes) {
      if (seen.has(c.id)) throw new Error("A record can appear only once in a group");
      seen.add(c.id);
      const cur = this.get(c.entity, c.id);
      if (c.kind !== "create" && !cur) throw new Error("Record not found");
      if (c.kind === "create" && cur) throw new Error("Record already exists");
      let rec: LocalRecord;
      if (c.kind === "create")
        rec = { entity: c.entity, id: c.id, version: 0, data: c.data as never, deletedAt: null, changeSeq: 0, updatedAt: now, pending: true, conflict: false, failed: null };
      else if (c.kind === "update") rec = { ...cur!, data: c.data as never, updatedAt: now, pending: true };
      else if (c.kind === "delete") rec = { ...cur!, deletedAt: now, updatedAt: now, pending: true };
      else rec = { ...cur!, deletedAt: null, updatedAt: now, pending: true };
      const payload = c.kind === "create" || c.kind === "update" ? { data: rec.data } : { data: null };
      const [stored, wrapped] = await Promise.all([this.encodeRecord(rec), encryptJson(this.dek, payload)]);
      prepared.push({
        rec,
        stored,
        op: {
          opId: crypto.randomUUID(),
          entity: c.entity,
          entityId: c.id,
          kind: c.kind,
          baseVersion: c.kind === "create" ? null : cur!.version,
          status: "pending",
          attempts: 0,
          nextAttemptAt: 0,
          lastError: null,
          createdAt: now,
          groupId,
          ...wrapped,
        },
      });
    }
    await this.db.transaction("rw", [this.db.records, this.db.outbox], async () => {
      for (const p of prepared) {
        await this.db.records.put(p.stored);
        await this.db.outbox.add(p.op);
      }
    });
    for (const p of prepared) this.setMem(p.rec);
    await this.refreshSummary();
    this.emit(true);
    this.onLocalChange?.();
  }

  /** Entity ids that share an atomic group with any op of `entityId`. */
  private async groupMates(entityId: string): Promise<{ groups: Set<string>; entityIds: Set<string> }> {
    const own = await this.db.outbox.where("entityId").equals(entityId).toArray();
    const groups = new Set(own.map((o) => o.groupId).filter((g): g is string => !!g));
    const entityIds = new Set<string>([entityId]);
    if (groups.size) {
      for (const o of await this.db.outbox.toArray()) if (o.groupId && groups.has(o.groupId)) entityIds.add(o.entityId);
    }
    return { groups, entityIds };
  }

  async decryptOpData(op: OutboxEntry): Promise<Record<string, unknown> | undefined> {
    const p = await decryptJson<{ data: Record<string, unknown> | null }>(this.dek, op);
    return p.data ?? undefined;
  }

  // ------------------------------------------------------------------ applying server state
  /** Store a server record unless the user has unsynced local changes to it. */
  async applyServerRecord(rec: ServerRecord, opts: { force?: boolean } = {}) {
    const cur = this.get(rec.entity, rec.id);
    if (cur && !opts.force && (cur.pending || cur.conflict)) {
      // Keep the local edit; the pending op will be checked against the server version on push.
      return;
    }
    const next: LocalRecord = {
      entity: rec.entity,
      id: rec.id,
      version: rec.version,
      data: rec.data as never,
      deletedAt: rec.deletedAt,
      changeSeq: rec.changeSeq,
      updatedAt: rec.updatedAt,
      pending: false,
      conflict: false,
      failed: null,
    };
    await this.writeRecord(next);
    this.setMem(next);
  }

  /** Result of a successfully applied (or duplicate) op. */
  async onOpApplied(op: OutboxEntry, rec: ServerRecord) {
    const cur = this.get(rec.entity, rec.id);
    const fresh: LocalRecord = {
      entity: rec.entity,
      id: rec.id,
      version: rec.version,
      data: rec.data as never,
      deletedAt: rec.deletedAt,
      changeSeq: rec.changeSeq,
      updatedAt: rec.updatedAt,
      pending: false,
      conflict: false,
      failed: null,
    };
    const rebased = cur ? { ...cur, version: rec.version, changeSeq: rec.changeSeq } : null;
    const [storedFresh, storedRebased] = await Promise.all([
      this.encodeRecord(fresh),
      rebased ? this.encodeRecord(rebased) : Promise.resolve(null),
    ]);
    let keptLocal = false;
    await this.db.transaction("rw", [this.db.records, this.db.outbox], async () => {
      await this.db.outbox.delete(op.seq!);
      const rest = await this.db.outbox.where("entityId").equals(op.entityId).toArray();
      if (rest.length && storedRebased) {
        // Later local edits were made on top of this one: rebase them on the new server version
        // and keep showing the local (newer) data.
        for (const o of rest) if (o.kind !== "create") await this.db.outbox.update(o.seq!, { baseVersion: rec.version });
        await this.db.records.put(storedRebased);
        keptLocal = true;
      } else {
        await this.db.records.put(storedFresh);
      }
    });
    this.setMem(keptLocal ? rebased! : fresh);
  }

  async onOpConflict(op: OutboxEntry, server: ServerRecord) {
    const cur = this.get(op.entity, op.entityId);
    const info: ConflictInfo = {
      entity: op.entity,
      entityId: op.entityId,
      opId: op.opId,
      kind: op.kind,
      local: { data: (cur?.data as unknown as Record<string, unknown>) ?? null, deletedAt: cur?.deletedAt ?? null },
      server,
      createdAt: new Date().toISOString(),
    };
    const entry: ConflictEntry = {
      entityId: op.entityId,
      entity: op.entity,
      opId: op.opId,
      createdAt: info.createdAt,
      ...(await encryptJson(this.dek, info)),
    };
    await this.db.transaction("rw", [this.db.outbox, this.db.conflicts], async () => {
      await this.db.outbox.update(op.seq!, { status: "conflict" });
      await this.db.conflicts.put(entry);
    });
    this.conflicts.set(op.entityId, info);
    if (cur) this.setMem({ ...cur, conflict: true, pending: true });
  }

  async onOpRejected(op: OutboxEntry, error: string) {
    await this.db.outbox.update(op.seq!, { status: "failed", lastError: error });
    const cur = this.get(op.entity, op.entityId);
    if (cur) this.setMem({ ...cur, failed: error, pending: true });
  }

  async finishBatch() {
    if (this.closed) return;
    await this.refreshSummary();
    this.emit(true);
  }

  // ------------------------------------------------------------------ conflict & failure handling
  /**
   * Resolve a conflict:
   *  - "server": discard local changes, keep the server version.
   *  - "mine":   re-apply the local version on top of the server version (explicit user choice).
   *  - edited:   save `data` (a manual merge) on top of the server version.
   */
  async resolveConflict(entityId: string, choice: "server" | "mine" | { data: Record<string, unknown> }) {
    const c = this.conflicts.get(entityId);
    if (!c) return;
    const ops = await this.db.outbox.where("entityId").equals(entityId).toArray();
    const serverRec: LocalRecord = {
      entity: c.server.entity,
      id: c.server.id,
      version: c.server.version,
      data: c.server.data as never,
      deletedAt: c.server.deletedAt,
      changeSeq: c.server.changeSeq,
      updatedAt: c.server.updatedAt,
      pending: false,
      conflict: false,
      failed: null,
    };
    const stored = await this.encodeRecord(serverRec);
    await this.db.transaction("rw", [this.db.records, this.db.outbox, this.db.conflicts], async () => {
      await this.db.outbox.bulkDelete(ops.map((o) => o.seq!));
      await this.db.conflicts.delete(entityId);
      await this.db.records.put(stored);
    });
    this.setMem(serverRec);
    this.conflicts.delete(entityId);

    if (choice !== "server") {
      const wantDeleted = choice === "mine" ? !!c.local.deletedAt : false;
      const data = (choice === "mine" ? c.local.data : choice.data) ?? c.server.data;
      const serverDeleted = !!c.server.deletedAt;
      if (serverDeleted && !wantDeleted) await this.mutate(c.entity, entityId, "restore");
      if (!wantDeleted) await this.mutate(c.entity, entityId, "update", data as never);
      else if (!serverDeleted) await this.mutate(c.entity, entityId, "delete");
    }
    await this.refreshSummary();
    this.emit(true);
    this.onLocalChange?.();
  }

  /** Retry failed ops (e.g. after fixing a referenced record) or discard them. */
  async retryFailed(entityId: string) {
    // A failed op that belongs to an atomic group is retried together with its group.
    const { entityIds } = await this.groupMates(entityId);
    for (const id of entityIds) {
      const ops = await this.db.outbox.where("entityId").equals(id).toArray();
      for (const o of ops) if (o.status === "failed") await this.db.outbox.update(o.seq!, { status: "pending", lastError: null, nextAttemptAt: 0 });
      const cur = [...this.records.values()].map((m) => m.get(id)).find(Boolean);
      if (cur) this.setMem({ ...cur, failed: null });
    }
    await this.refreshSummary();
    this.emit(true);
    this.onLocalChange?.();
  }

  /** Discard unsynced local changes to a record and restore the last server version (if any). */
  async discardLocal(entityId: string, _visited = new Set<string>()) {
    // Discarding part of an atomic group discards the whole group.
    _visited.add(entityId);
    const { entityIds } = await this.groupMates(entityId);
    for (const id of entityIds) if (!_visited.has(id)) await this.discardLocal(id, _visited);
    const ops = await this.db.outbox.where("entityId").equals(entityId).toArray();
    const cur = [...this.records.values()].map((m) => m.get(entityId)).find(Boolean);
    await this.db.transaction("rw", [this.db.records, this.db.outbox, this.db.conflicts], async () => {
      await this.db.outbox.bulkDelete(ops.map((o) => o.seq!));
      await this.db.conflicts.delete(entityId);
      if (cur && cur.version === 0) await this.db.records.delete([cur.entity, cur.id]);
    });
    if (cur && cur.version === 0) this.records.get(cur.entity)?.delete(entityId);
    else if (cur) {
      // Force a re-download of this record on next pull.
      await this.db.meta.put({ key: "cursor", value: 0 });
      this.setMem({ ...cur, pending: false, failed: null, conflict: false });
    }
    this.conflicts.delete(entityId);
    await this.refreshSummary();
    this.emit(true);
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await this.db.meta.get(key))?.value as T | undefined;
  }
  async setMeta(key: string, value: unknown) {
    await this.db.meta.put({ key, value });
  }
  notify() {
    this.emit();
  }
}

function summarise(outbox: OutboxEntry[]): OutboxSummary {
  return {
    pending: outbox.filter((o) => o.status === "pending" || o.status === "inflight").length,
    failed: outbox.filter((o) => o.status === "failed").length,
    conflicts: outbox.filter((o) => o.status === "conflict").length,
    failedOps: outbox
      .filter((o) => o.status === "failed")
      .map((o) => ({ opId: o.opId, entity: o.entity, entityId: o.entityId, kind: o.kind, error: o.lastError })),
  };
}
