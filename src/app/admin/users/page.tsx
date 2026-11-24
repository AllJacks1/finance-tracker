import { redirect } from "next/navigation";
import { listUsers } from "@/server/admin/users";
import { authFromCookies } from "@/server/authz";
import { creatableRoles, MANAGER_GRANTABLE, PERMISSION_LABELS } from "@/lib/permissions";
import { UsersClient } from "./users-client";

export default async function AdminUsers() {
  const auth = await authFromCookies();
  if (!auth || !auth.permissions.has("users.view")) redirect("/admin");
  const users = await listUsers();
  return (
    <UsersClient
      users={users}
      me={{ id: auth.user.id, role: auth.user.role, permissions: [...auth.permissions] }}
      creatableRoles={creatableRoles(auth.permissions)}
      grantable={MANAGER_GRANTABLE.map((p) => ({ key: p, label: PERMISSION_LABELS[p] }))}
    />
  );
}
