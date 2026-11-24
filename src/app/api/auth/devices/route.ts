import { z } from "zod";
import { listDevices, revokeOwnDevice } from "@/server/admin/users";
import { requireAuth } from "@/server/authz";
import { json, readJson, route } from "@/server/http";

/** The signed-in user's own devices. */
export const GET = route(async (req) => {
  const auth = await requireAuth(req);
  const list = await listDevices(auth.user.id);
  return json({ devices: list.map((d) => ({ ...d, current: d.id === auth.deviceId })) });
});

export const POST = route(async (req) => {
  const auth = await requireAuth(req);
  const { deviceId } = await readJson(req, z.object({ deviceId: z.uuid() }), 2_000);
  await revokeOwnDevice(auth.user.id, deviceId, req);
  return json({ ok: true });
});
