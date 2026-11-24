import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { requireWorkspace } from "@/server/authz";
import { withContext } from "@/server/db";
import { attachments } from "@/server/db/schema";
import { notFound, route } from "@/server/http";
import { getObject } from "@/server/storage";

type Ctx = { params: Promise<{ id: string }> };

/** Stream a receipt. Only the owner can fetch it (RLS); never cached by browsers or the SW. */
export const GET = route<Ctx>(async (req, { params }) => {
  const auth = await requireWorkspace(req);
  const id = z.uuid().parse((await params).id);
  const att = await withContext({ userId: auth.user.id, workspaceId: auth.workspaceId }, async (tx) => {
    const [a] = await tx.select().from(attachments).where(and(eq(attachments.id, id), isNull(attachments.deletedAt)));
    return a;
  });
  if (!att) throw notFound();
  const obj = await getObject(att.objectKey);
  const safeName = att.filename.replace(/[^\w.\- ]/g, "_");
  return new Response(obj.body as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": att.mime,
      "Content-Disposition": `${new URL(req.url).searchParams.get("download") === "1" ? "attachment" : "inline"}; filename="${safeName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
});
