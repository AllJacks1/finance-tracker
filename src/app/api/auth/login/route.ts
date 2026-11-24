import { json, readJson, route } from "@/server/http";
import { login, loginInput } from "@/server/auth/service";

export const POST = route(async (req) => {
  const input = await readJson(req, loginInput, 10_000);
  const { cookie, body } = await login(input, req);
  const res = json(body);
  res.headers.append("Set-Cookie", cookie);
  return res;
});
