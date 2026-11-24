import "server-only";
import { eq, inArray, sql } from "drizzle-orm";
import type { EntityName } from "@/lib/domain/types";
import { entitySchemas, type OpResult, type ServerRecord, type SyncOp } from "@/lib/sync/protocol";
import { db, withContext, type Tx } from "../db";
import { devices, syncEvents, syncOps, workspaces } from "../db/schema";
import { log } from "../log";
import { ApiError } from "../errors";
import { nextChangeSeq } from "../workspace";
import { DomainError, ENTITIES, toEntityData, type EntityCtx } from "./entities";

/* eslint-disable @typescript-eslint/no-explicit-any */

class Conflict extends Error {
  constructor(public record: ServerRecord) {
    super("conflict");
  }
}

/** A create for a record that already exists with exactly the same data (e.g. the same
 *  scheduled occurrence confirmed on two devices). Treated as a successful duplicate. */
class IdenticalCreate extends Error {
  constructor(public record: ServerRecord) {
    super("identical");
  }
}

/** A failure inside an atomic group; the whole group is rolled back. */
class GroupFailure extends Error {
  constructor(
    public index: number,
    public cause: unknown,
  ) {
    super("group_failed");
  }
}

const IGNORED_IN_COMPARISON = new Set(["id", "localDate"]);

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;

/** Normalise values so client JSON and Postgres output compare equal (timestamps, nesting). */
function norm(v: unknown): unknown {
  if (typeof v === "string" && TIMESTAMP_RE.test(v)) {
    const t = new Date(v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
    return Number.isNaN(t.getTime()) ? v : t.toISOString();
  }
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) o[k] = norm((v as Record<string, unknown>)[k]);
    return o;
  }
  return v ?? null;
}

function sameData(fields: string[], a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const f of fields) {
    if (IGNORED_IN_COMPARISON.has(f)) continue;
    if (JSON.stringify(norm(a[f])) !== JSON.stringify(norm(b[f]))) return false;
  }
  return true;
}

export function toServerRecord(entity: EntityName, row: Record<string, any>): ServerRecord {
  const def = ENTITIES[entity];
  return {
    entity,
    id: row.id,
    version: row.version,
    changeSeq: Number(row.changeSeq),
    deletedAt: entity === "settings" ? null : (row.deletedAt ?? null),
    updatedAt: row.updatedAt,
    data: toEntityData(def, row),
  };
}

function pgCode(e: unknown): string | undefined {
  const any = e as { code?: string; cause?: { code?: string } };
  return any?.code ?? any?.cause?.code;
}

async function applyOp(op: SyncOp, ctx: EntityCtx, deviceId: string): Promise<ServerRecord> {
  const def = ENTITIES[op.entity];
  const table = def.table as any;
  const { tx, workspaceId } = ctx;

  const [current] = await tx.select().from(table).where(eq(table.id, op.entityId)).for("update");
  const seq = await nextChangeSeq(tx, workspaceId);
  const now = new Date().toISOString();

  if (op.kind === "create") {
    if (def.creatable === false) throw new DomainError("not_creatable", `${op.entity} cannot be created via sync`);
    const parsed = entitySchemas[op.entity].parse({ ...op.data, id: op.entityId });
    if (current) {
      const existing = toServerRecord(op.entity, current);
      if (!current.deletedAt && sameData(def.fields, parsed as Record<string, unknown>, existing.data)) throw new IdenticalCreate(existing);
      throw new Conflict(existing);
    }
    const data = def.prepare ? await def.prepare(parsed as any, ctx) : parsed;
    const [row] = await tx
      .insert(table)
      .values({
        ...data,
        id: op.entityId,
        workspaceId,
        version: 1,
        changeSeq: seq,
        createdByDeviceId: deviceId,
        updatedByDeviceId: deviceId,
      })
      .returning();
    await def.afterWrite?.(row, ctx);
    return toServerRecord(op.entity, row);
  }

  // update / delete / restore
  if (!current) throw new DomainError("not_found", "Record not found");
  if (op.baseVersion !== current.version) throw new Conflict(toServerRecord(op.entity, current));

  let patch: Record<string, any>;
  if (op.kind === "update") {
    if (def.immutable) throw new DomainError("immutable", "This record can't be changed once recorded");
    if (current.deletedAt) throw new Conflict(toServerRecord(op.entity, current));
    const parsed = entitySchemas[op.entity].parse({ ...op.data, id: op.entityId });
    patch = def.prepare ? await def.prepare(parsed as any, ctx) : parsed;
    delete patch.id;
  } else if (op.kind === "delete") {
    if (op.entity === "settings") throw new DomainError("not_deletable", "Settings cannot be deleted");
    if (current.deletedAt) return toServerRecord(op.entity, current); // already deleted: idempotent
    await def.beforeDelete?.(op.entityId, ctx);
    patch = { deletedAt: now };
  } else {
    if (!current.deletedAt) return toServerRecord(op.entity, current);
    // Re-validate references: restoring a transaction whose account was deleted must fail.
    if (def.prepare) await def.prepare(toEntityData(def, current) as any, ctx);
    patch = { deletedAt: null };
  }
  const [row] = await tx
    .update(table)
    .set({
      ...patch,
      version: sql`${table.version} + 1`,
      changeSeq: seq,
      updatedAt: now,
      ...(op.entity === "settings" ? {} : { updatedByDeviceId: deviceId }),
    })
    .where(eq(table.id, op.entityId))
    .returning();
  await def.afterWrite?.(row, ctx);
  return toServerRecord(op.entity, row);
}

/** Map an error from applying one op to a client-facing rejection (or rethrow if unexpected). */
function rejection(e: unknown): { code: string; message: string } {
  if (e instanceof DomainError) return { code: e.code, message: e.message };
  if ((e as { name?: string }).name === "ZodError") return { code: "validation", message: "Invalid data" };
  const code = pgCode(e);
  if (code === "23503") return { code: "reference_missing", message: "A referenced record does not exist" };
  if (code === "23505") {
    const constraint = String((e as { constraint_name?: string; cause?: { constraint_name?: string } }).constraint_name ?? (e as { cause?: { constraint_name?: string } }).cause?.constraint_name ?? "");
    if (constraint.includes("occurrence")) return { code: "duplicate_occurrence", message: "This occurrence was already recorded" };
    if (constraint.includes("import_fp")) return { code: "duplicate_import", message: "This row was already imported" };
    return { code: "id_conflict", message: "This record ID is already in use" };
  }
  if (code === "23514") return { code: "invalid", message: "Invalid change" };
  throw e; // unexpected: abort the batch, the client retries later
}

/** Split ops into units: consecutive ops sharing a groupId form one atomic unit. */
function toUnits(ops: SyncOp[]): SyncOp[][] {
  const units: SyncOp[][] = [];
  const closed = new Set<string>();
  for (const op of ops) {
    const last = units[units.length - 1];
    if (op.groupId && last && last[0]!.groupId === op.groupId) {
      last.push(op);
      continue;
    }
    if (op.groupId) {
      if (closed.has(op.groupId)) throw new ApiError(400, "invalid_group", "Ops of a group must be sent together");
      closed.add(op.groupId);
    }
    units.push([op]);
  }
  return units;
}

/**
 * Apply a batch of ops for the authenticated user's workspace.
 * - Writes to one workspace are serialised (row lock), so change_seq is strictly ordered.
 * - Each unit runs in its own SAVEPOINT: a standalone op, or a whole atomic GROUP (ops sharing a
 *   groupId). A failure rolls back only that unit; for a group, every op in it is refused.
 * - Applied (and standalone rejected) ops are recorded in sync_ops by opId, so retries are
 *   idempotent even if the previous response was lost after commit. Failed groups are not
 *   recorded, so they can be retried after the user resolves the cause.
 * - A create of an existing record with identical data is a "duplicate", not a conflict.
 * - After a conflict or rejection, later ops for the same entity in the batch are held back.
 */
export async function pushOps(
  auth: { userId: string; workspaceId: string; deviceId: string },
  ops: SyncOp[],
): Promise<OpResult[]> {
  const results: OpResult[] = [];
  let applied = 0;
  let conflicts = 0;
  let rejected = 0;
  const units = toUnits(ops);

  await withContext({ userId: auth.userId, workspaceId: auth.workspaceId }, async (tx: Tx) => {
    const [ws] = await tx
      .select({ id: workspaces.id, timezone: workspaces.timezone })
      .from(workspaces)
      .where(eq(workspaces.id, auth.workspaceId))
      .for("update");
    if (!ws) throw new DomainError("no_workspace", "Workspace not found");

    const seen = await tx
      .select()
      .from(syncOps)
      .where(inArray(syncOps.opId, ops.map((o) => o.opId)));
    const seenById = new Map(seen.map((r) => [r.opId, r]));
    const blocked = new Set<string>();
    const base = (op: SyncOp) => ({ opId: op.opId, entity: op.entity, entityId: op.entityId });

    const record = async (op: SyncOp, result: OpResult) => {
      await tx.insert(syncOps).values({
        opId: op.opId,
        workspaceId: auth.workspaceId,
        deviceId: auth.deviceId,
        entity: op.entity,
        entityId: op.entityId,
        status: result.status === "rejected" ? "rejected" : "applied",
        result: { ...result, status: result.status === "rejected" ? "rejected" : "applied" } as any,
      });
    };

    for (const unit of units) {
      // Replays of ops that were already applied.
      if (unit.every((op) => seenById.has(op.opId))) {
        for (const op of unit) {
          const r = seenById.get(op.opId)!.result as unknown as OpResult;
          results.push({ ...r, status: r.status === "applied" ? "duplicate" : r.status });
        }
        continue;
      }
      if (unit.some((op) => blocked.has(op.entityId) || seenById.has(op.opId))) {
        for (const op of unit) results.push({ ...base(op), status: "blocked" });
        continue;
      }

      const ctx = (sp: Tx) => ({ tx: sp, workspaceId: auth.workspaceId, timezone: ws.timezone });
      const isGroup = unit.length > 1 || !!unit[0]!.groupId;
      try {
        const out = await tx.transaction(async (sp) => {
          const res: OpResult[] = [];
          for (let i = 0; i < unit.length; i++) {
            const op = unit[i]!;
            try {
              const rec = await sp.transaction((inner) => applyOp(op, ctx(inner), auth.deviceId));
              res.push({ ...base(op), status: "applied", record: rec });
            } catch (e) {
              if (e instanceof IdenticalCreate) res.push({ ...base(op), status: "duplicate", record: e.record });
              else throw new GroupFailure(i, e);
            }
          }
          return res;
        });
        for (let i = 0; i < unit.length; i++) {
          const r = out[i]!;
          applied++;
          await record(unit[i]!, r);
          results.push(r);
        }
      } catch (e) {
        if (!(e instanceof GroupFailure)) throw e;
        const failing = unit[e.index]!;
        let failResult: OpResult;
        if (e.cause instanceof Conflict) {
          failResult = {
            ...base(failing),
            status: "conflict",
            record: e.cause.record,
            error: { code: "version_conflict", message: "This record was changed on another device" },
          };
          conflicts++;
        } else {
          failResult = { ...base(failing), status: "rejected", error: rejection(e.cause) };
          rejected++;
          if (!isGroup) await record(failing, failResult);
        }
        for (let i = 0; i < unit.length; i++) {
          const op = unit[i]!;
          blocked.add(op.entityId);
          if (i === e.index) results.push(failResult);
          else {
            rejected++;
            results.push({
              ...base(op),
              status: "rejected",
              error: { code: "group_failed", message: "Part of a change that couldn't be saved: " + (failResult.error?.message ?? "") },
            });
          }
        }
      }
    }
  });

  try {
    await db().insert(syncEvents).values({ userId: auth.userId, deviceId: auth.deviceId, kind: "push", applied, conflicts, rejected });
    await db().update(devices).set({ lastSyncAt: sql`now()` }).where(eq(devices.id, auth.deviceId));
  } catch (e) {
    log.warn("sync_event_log_failed", { err: e });
  }
  return results;
}
