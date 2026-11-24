import { getSettings, SETTINGS_SCHEMA, updateSettings } from "@/server/admin/system";
import { requirePermission } from "@/server/authz";
import { json, readJson, route } from "@/server/http";

export const GET = route(async (req) => {
  await requirePermission(req, "system.settings");
  return json({ settings: await getSettings() });
});

export const PUT = route(async (req) => {
  const actor = await requirePermission(req, "system.settings");
  const input = await readJson(req, SETTINGS_SCHEMA.partial(), 5_000);
  return json({ settings: await updateSettings(actor, input, req) });
});
