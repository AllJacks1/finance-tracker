import { z } from "zod";
import { requireWorkspace } from "@/server/authz";
import { json, route } from "@/server/http";
import { pullChanges } from "@/server/sync/pull";

export const GET = route(async (req) => {
  const auth = await requireWorkspace(req);
  const params = new URL(req.url).searchParams;
  const cursor = z.coerce.number().int().min(0).parse(params.get("cursor") ?? "0");
  const limit = z.coerce.number().int().min(1).max(1000).parse(params.get("limit") ?? "500");
  return json(await pullChanges({ userId: auth.user.id, workspaceId: auth.workspaceId }, cursor, limit));
});
