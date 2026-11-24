import { pushRequestSchema } from "@/lib/sync/protocol";
import { requireWorkspace } from "@/server/authz";
import { json, readJson, route } from "@/server/http";
import { pushOps } from "@/server/sync/push";

export const POST = route(async (req) => {
  const auth = await requireWorkspace(req);
  const { ops } = await readJson(req, pushRequestSchema, 2_000_000);
  const results = await pushOps(
    { userId: auth.user.id, workspaceId: auth.workspaceId, deviceId: auth.deviceId! },
    ops,
  );
  return json({ results });
});
