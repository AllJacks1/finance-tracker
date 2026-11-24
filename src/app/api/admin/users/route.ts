import { createUser, createUserInput, listUsers } from "@/server/admin/users";
import { requirePermission } from "@/server/authz";
import { json, readJson, route } from "@/server/http";

export const GET = route(async (req) => {
  await requirePermission(req, "users.view");
  return json({ users: await listUsers() });
});

export const POST = route(async (req) => {
  const actor = await requirePermission(req, "users.create");
  const input = await readJson(req, createUserInput, 5_000);
  const created = await createUser(actor, input, req);
  // The temporary password is shown once to the administrator and never stored in plaintext.
  return json(created, { status: 201 });
});
