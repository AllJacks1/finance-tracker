import { requireAuth } from "@/server/authz";
import { json, route } from "@/server/http";
import { ensureWorkspace } from "@/server/workspace";

/** Current user, device and admin permissions. Never returns financial data. */
export const GET = route(async (req) => {
  const auth = await requireAuth(req, { allowPasswordChangeRequired: true });
  const workspaceId = auth.user.mustChangePassword ? null : await ensureWorkspace(auth.user.id);
  return json({
    user: auth.user,
    deviceId: auth.deviceId,
    workspaceId,
    permissions: [...auth.permissions],
  });
});
