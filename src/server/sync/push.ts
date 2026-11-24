import "server-only";
import { eq, inArray, sql } from "drizzle-orm";
import type { EntityName } from "@/lib/domain/types";
import { entitySchemas, type OpResult, type ServerRecord, type SyncOp } from "@/lib/sync/protocol";
import { db, withContext, type Tx } from "../db";
import { devices, syncEvents, syncOps, workspaces } from "../db/schema";
import { log } from "../log";
import { nextChangeSeq } from "../workspace";
import { DomainError, ENTITIES, toEntityData, type EntityCtx } from "./entities";

/* eslint-disable @typescript-eslint/no-explicit-any */

class Conflict extends Error {
  constructor(public record: ServerRecord) {
    super("conflict");
  }
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
    if (current) throw new Conflict(toServerRecord(op.entity, current));
    const parsed = entitySchemas[op.entity].parse({ ...op.data, id: op.entityId });
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

/**
 * Apply a batch of ops for the authenticated user's workspace.
 * - Writes to one workspace are serialised (row lock), so change_seq is strictly ordered.
 * - Each op runs in its own SAVEPOINT: a conflicting/invalid op does not undo the others.
 * - Applied/rejected ops are recorded in sync_ops by opId, so retries are idempotent even if the
 *   previous response was lost after commit.
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

    for (const op of ops) {
      const prior = seenById.get(op.opId);
      if (prior) {
        const r = prior.result as unknown as OpResult;
        results.push({ ...r, status: r.status === "applied" ? "duplicate" : r.status });
        continue;
      }
      if (blocked.has(op.entityId)) {
        results.push({ opId: op.opId, entity: op.entity, entityId: op.entityId, status: "blocked" });
        continue;
      }
      let result: OpResult;
      try {
        const record = await tx.transaction(async (sp) =>
          applyOp(op, { tx: sp, workspaceId: auth.workspaceId, timezone: ws.timezone }, auth.deviceId),
        );
        result = { opId: op.opId, entity: op.entity, entityId: op.entityId, status: "applied", record };
        applied++;
      } catch (e) {
        if (e instanceof Conflict) {
          result = {
            opId: op.opId,
            entity: op.entity,
            entityId: op.entityId,
            status: "conflict",
            record: e.record,
            error: { code: "version_conflict", message: "This record was changed on another device" },
          };
          conflicts++;
        } else {
          let code = "invalid";
          let message = "Invalid change";
          if (e instanceof DomainError) {
            code = e.code;
            message = e.message;
          } else if ((e as { name?: string }).name === "ZodError") {
            code = "validation";
            message = "Invalid data";
          } else if (pgCode(e) === "23503") {
            code = "reference_missing";
            message = "A referenced record does not exist";
          } else if (pgCode(e) === "23505") {
            code = "id_conflict";
            message = "This record ID is already in use";
          } else if (pgCode(e) === "23514") {
            code = "invalid";
            message = "Invalid change";
          } else {
            throw e; // unexpected: abort the batch, client retries later
          }
          result = { opId: op.opId, entity: op.entity, entityId: op.entityId, status: "rejected", error: { code, message } };
          rejected++;
        }
        blocked.add(op.entityId);
      }
      if (result.status === "applied" || result.status === "rejected") {
        await tx.insert(syncOps).values({
          opId: op.opId,
          workspaceId: auth.workspaceId,
          deviceId: auth.deviceId,
          entity: op.entity,
          entityId: op.entityId,
          status: result.status,
          result: result as any,
        });
      }
      results.push(result);
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
