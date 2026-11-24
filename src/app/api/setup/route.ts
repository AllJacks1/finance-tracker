import { getSettings } from "@/server/admin/system";
import { ApiError, json, route } from "@/server/http";
import { isSetupComplete, performSetup, setupInput } from "@/server/setup";
import { readJson } from "@/server/http";

/** Public: whether setup is done, plus the optional admin notice shown on the sign-in page. */
export const GET = route(async () => {
  const setupComplete = await isSetupComplete();
  const loginNotice = setupComplete ? (await getSettings()).loginNotice : "";
  return json({ setupComplete, loginNotice });
});

export const POST = route(async (req) => {
  if (await isSetupComplete()) throw new ApiError(404, "not_found", "Not found");
  const input = await readJson(req, setupInput, 10_000);
  await performSetup(input, req);
  return json({ ok: true, next: "/login" }, { status: 201 });
});
