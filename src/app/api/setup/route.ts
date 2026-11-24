import { json, readJson, route, ApiError } from "@/server/http";
import { isSetupComplete, performSetup, setupInput } from "@/server/setup";

export const GET = route(async () => json({ setupComplete: await isSetupComplete() }));

export const POST = route(async (req) => {
  if (await isSetupComplete()) throw new ApiError(404, "not_found", "Not found");
  const input = await readJson(req, setupInput, 10_000);
  await performSetup(input, req);
  return json({ ok: true, next: "/login" }, { status: 201 });
});
