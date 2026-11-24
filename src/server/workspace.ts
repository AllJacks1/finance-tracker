import "server-only";
import { eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { DEFAULT_CATEGORIES } from "@/lib/domain/types";
import { withContext, type Tx } from "./db";
import { categories, workspaces } from "./db/schema";

/** Next per-workspace change sequence number. Caller must hold the workspace row lock. */
export async function nextChangeSeq(tx: Tx, workspaceId: string): Promise<number> {
  const rows = await tx
    .update(workspaces)
    .set({ changeCounter: sql`${workspaces.changeCounter} + 1` })
    .where(eq(workspaces.id, workspaceId))
    .returning({ seq: workspaces.changeCounter });
  if (!rows[0]) throw new Error("Workspace not found");
  return rows[0].seq;
}

/**
 * Returns the user's workspace id, creating it (with default categories) on first use.
 * Runs in the user's own RLS context — admins never create or touch other users' workspaces.
 */
export async function ensureWorkspace(userId: string): Promise<string> {
  return withContext({ userId }, async (tx) => {
    const existing = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.ownerUserId, userId))
      .limit(1);
    if (existing[0]) return existing[0].id;

    const inserted = await tx
      .insert(workspaces)
      .values({ ownerUserId: userId })
      .onConflictDoNothing({ target: workspaces.ownerUserId })
      .returning({ id: workspaces.id });
    if (!inserted[0]) {
      const again = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.ownerUserId, userId));
      return again[0]!.id;
    }
    const workspaceId = inserted[0].id;
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    await tx.execute(sql`select 1 from workspaces where id = ${workspaceId} for update`);
    for (const c of DEFAULT_CATEGORIES) {
      const seq = await nextChangeSeq(tx, workspaceId);
      await tx.insert(categories).values({
        id: uuidv7(),
        workspaceId,
        changeSeq: seq,
        name: c.name,
        kind: c.kind,
        icon: c.icon,
        color: c.color,
        isEssential: !!c.essential,
      });
    }
    // The settings record itself is versioned by the workspaces row.
    const seq = await nextChangeSeq(tx, workspaceId);
    await tx.update(workspaces).set({ changeSeq: seq }).where(eq(workspaces.id, workspaceId));
    return workspaceId;
  });
}
