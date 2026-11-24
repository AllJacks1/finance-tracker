import { requireAuth } from "@/server/authz";
import { json, route } from "@/server/http";
import { pushConfigured, publicKey } from "@/server/push";

export const GET = route(async (req) => {
  await requireAuth(req);
  return json({ configured: pushConfigured(), publicKey: pushConfigured() ? publicKey() : null });
});
