import { z } from "zod";
import { listDevices, userAction, userActionInput } from "@/server/admin/users";
import { requireAuth, requirePermission } from "@/server/authz";
import { forbidden, json, readJson, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (req, { params }) => {
  await requirePermission(req, "users.view");
  const id = z.uuid().parse((await params).id);
  return json({ devices: await listDevices(id) });
});

export const PATCH = route<Ctx>(async (req, { params }) => {
  const actor = await requireAuth(req);
  if (actor.permissions.size === 0) throw forbidden("missing_permission");
  const id = z.uuid().parse((await params).id);
  const input = await readJson(req, userActionInput, 5_000);
  return json(await userAction(actor, id, input, req));
});
