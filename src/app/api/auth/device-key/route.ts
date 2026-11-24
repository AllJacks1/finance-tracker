import { requireAuth } from "@/server/authz";
import { deviceKey, deviceKeyInput } from "@/server/auth/service";
import { json, readJson, route } from "@/server/http";

export const POST = route(async (req) => {
  const auth = await requireAuth(req);
  const input = await readJson(req, deviceKeyInput, 5_000);
  return json(await deviceKey(auth, input, req));
});
