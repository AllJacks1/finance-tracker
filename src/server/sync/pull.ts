import "server-only";
import { asc, gt } from "drizzle-orm";
import type { EntityName } from "@/lib/domain/types";
import type { PullResponse, ServerRecord } from "@/lib/sync/protocol";
import { withContext } from "../db";
import { ENTITIES } from "./entities";
import { toServerRecord } from "./push";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Records (including tombstones) changed after `cursor`, oldest first. Each table is queried with
 * the same limit and the results merged, so pagination by change_seq is exact. RLS restricts every
 * query to the caller's workspace.
 */
export async function pullChanges(
  auth: { userId: string; workspaceId: string },
  cursor: number,
  limit = 500,
): Promise<PullResponse> {
  return withContext(auth, async (tx) => {
    const all: ServerRecord[] = [];
    for (const [entity, def] of Object.entries(ENTITIES) as [EntityName, (typeof ENTITIES)[EntityName]][]) {
      const t = def.table as any;
      const rows = await tx.select().from(t).where(gt(t.changeSeq, cursor)).orderBy(asc(t.changeSeq)).limit(limit + 1);
      for (const r of rows) all.push(toServerRecord(entity, r));
    }
    all.sort((a, b) => a.changeSeq - b.changeSeq);
    const records = all.slice(0, limit);
    const hasMore = all.length > limit;
    const next = records.length ? records[records.length - 1]!.changeSeq : cursor;
    return { records, cursor: next, hasMore };
  });
}
