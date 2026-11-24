import { and, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { requireWorkspace } from "@/server/authz";
import { withContext } from "@/server/db";
import { attachments, bills, transactions } from "@/server/db/schema";
import { ApiError, json, route } from "@/server/http";
import { putObject } from "@/server/storage";
import { toServerRecord } from "@/server/sync/push";
import { nextChangeSeq } from "@/server/workspace";
import { workspaces } from "@/server/db/schema";

const MAX = 5 * 1024 * 1024;
const TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const query = z.object({
  id: z.uuid(),
  transactionId: z.uuid().optional(),
  billId: z.uuid().optional(),
  filename: z.string().min(1).max(200),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * Upload a receipt for one of the caller's transactions. Idempotent by attachment id.
 * The file goes to object storage first, then the attachment row is created.
 */
export const POST = route(async (req) => {
  const auth = await requireWorkspace(req);
  const q = query.parse(Object.fromEntries(new URL(req.url).searchParams));
  const mime = (req.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (!TYPES.includes(mime)) throw new ApiError(415, "unsupported_type", "Use JPEG, PNG, WebP or PDF.");
  if (Number(req.headers.get("content-length") ?? 0) > MAX) throw new ApiError(413, "too_large", "Receipt is larger than 5 MB.");
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length === 0 || body.length > MAX) throw new ApiError(413, "too_large", "Receipt is larger than 5 MB.");
  const sha = createHash("sha256").update(body).digest("hex");
  if (sha !== q.sha256) throw new ApiError(400, "checksum_mismatch", "Upload was corrupted. It will retry.");

  const ctx = { userId: auth.user.id, workspaceId: auth.workspaceId };
  // Ownership: RLS only shows the caller's own transactions.
  const existing = await withContext(ctx, async (tx) => {
    if (!!q.transactionId === !!q.billId) throw new ApiError(400, "invalid_owner", "Attach to a transaction or a bill");
    if (q.transactionId) {
      const [t] = await tx.select({ id: transactions.id }).from(transactions).where(and(eq(transactions.id, q.transactionId), isNull(transactions.deletedAt)));
      if (!t) throw new ApiError(404, "not_found", "Transaction not found");
    } else {
      const [b] = await tx.select({ id: bills.id }).from(bills).where(and(eq(bills.id, q.billId!), isNull(bills.deletedAt)));
      if (!b) throw new ApiError(404, "not_found", "Bill not found");
    }
    const [a] = await tx.select().from(attachments).where(eq(attachments.id, q.id));
    return a;
  });
  if (existing) return json({ record: toServerRecord("attachment", existing) });

  const objectKey = `receipts/${auth.workspaceId}/${q.id}`;
  await putObject(objectKey, body, mime, { sha256: sha });
  const row = await withContext(ctx, async (tx) => {
    await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, auth.workspaceId)).for("update");
    const seq = await nextChangeSeq(tx, auth.workspaceId);
    const [r] = await tx
      .insert(attachments)
      .values({
        id: q.id,
        workspaceId: auth.workspaceId,
        changeSeq: seq,
        transactionId: q.transactionId ?? null,
        billId: q.billId ?? null,
        objectKey,
        filename: q.filename,
        mime,
        sizeBytes: body.length,
        sha256: sha,
        createdByDeviceId: auth.deviceId,
        updatedByDeviceId: auth.deviceId,
      })
      .onConflictDoNothing()
      .returning();
    if (r) return r;
    const [again] = await tx.select().from(attachments).where(eq(attachments.id, q.id));
    if (!again) throw new ApiError(409, "id_conflict", "Attachment id already in use");
    return again;
  });
  return json({ record: toServerRecord("attachment", row) }, { status: 201 });
});
