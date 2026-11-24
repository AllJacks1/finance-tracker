import { systemHealth } from "@/server/admin/system";
import { requirePermission } from "@/server/authz";
import { json, route } from "@/server/http";

export const GET = route(async (req) => {
  await requirePermission(req, "system.health");
  return json(await systemHealth());
});
