import { listAudit } from "@/server/admin/system";
import { requirePermission } from "@/server/authz";
import { json, route } from "@/server/http";

export const GET = route(async (req) => {
  await requirePermission(req, "audit.view");
  const before = Number(new URL(req.url).searchParams.get("before")) || undefined;
  return json({ entries: await listAudit(100, before) });
});
