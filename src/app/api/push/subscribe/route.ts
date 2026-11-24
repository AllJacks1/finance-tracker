import { z } from "zod";
import { requireAuth } from "@/server/authz";
import { json, readJson, route } from "@/server/http";
import { removeSubscription, saveSubscription } from "@/server/push";

const sub = z.object({
  endpoint: z.url().max(2000).refine((u) => u.startsWith("https://"), "Push endpoints use HTTPS"),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
});

/** Subscribe this device to push reminders (opt-in). */
export const POST = route(async (req) => {
  const auth = await requireAuth(req);
  const body = await readJson(req, sub, 5_000);
  await saveSubscription(auth.user.id, auth.deviceId, body);
  return json({ ok: true });
});

export const DELETE = route(async (req) => {
  const auth = await requireAuth(req);
  const { endpoint } = await readJson(req, z.object({ endpoint: z.string().max(2000) }), 5_000);
  await removeSubscription(auth.user.id, endpoint);
  return json({ ok: true });
});
