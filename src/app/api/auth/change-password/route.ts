import { requireAuth } from "@/server/authz";
import { changePassword, changePasswordInput } from "@/server/auth/service";
import { json, readJson, route } from "@/server/http";

export const POST = route(async (req) => {
  const auth = await requireAuth(req, { allowPasswordChangeRequired: true });
  const input = await readJson(req, changePasswordInput, 5_000);
  await changePassword(auth, input, req);
  return json({ ok: true });
});
