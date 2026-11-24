"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Copy, Plus, UserCog } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FormSheet, NativeSelect } from "@/components/finance/primitives";
import { api, ApiCallError } from "@/client/api";
import { canActOn, type AdminPermission, type Role, type TargetAction } from "@/lib/permissions";
import type { AdminUserRow } from "@/server/admin/users";
import { cn } from "@/lib/utils";

const ROLE_LABEL: Record<Role, string> = { super_admin: "Super Admin", manager: "Manager", user: "User" };

interface Me { id: string; role: Role; permissions: string[] }

export function UsersClient({ users, me, creatableRoles, grantable }: { users: AdminUserRow[]; me: Me; creatableRoles: Role[]; grantable: { key: string; label: string }[] }) {
  const router = useRouter();
  const [creating, setCreating] = React.useState(false);
  const [selected, setSelected] = React.useState<AdminUserRow | null>(null);
  const [secret, setSecret] = React.useState<{ email: string; password: string } | null>(null);
  const actor = { id: me.id, role: me.role, permissions: new Set(me.permissions as AdminPermission[]) };
  const can = (u: AdminUserRow, a: TargetAction) => canActOn(actor, u, a);

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Users</h1>
        {me.permissions.includes("users.create") ? <Button onClick={() => setCreating(true)}><Plus className="size-4" /> New user</Button> : null}
      </div>
      {secret ? (
        <div className="grid gap-2 rounded-2xl border border-primary/40 bg-primary/5 p-4 text-sm">
          <p className="font-medium">Temporary password for {secret.email}</p>
          <div className="flex items-center gap-2">
            <code className="rounded bg-background px-2 py-1 text-base">{secret.password}</code>
            <Button size="icon-sm" variant="ghost" aria-label="Copy" onClick={() => void navigator.clipboard.writeText(secret.password).then(() => toast.success("Copied"))}><Copy className="size-4" /></Button>
          </div>
          <p className="text-muted-foreground">Shown once. Share it privately; the user must choose a new password at first sign-in.</p>
          <Button size="sm" variant="outline" className="justify-self-start" onClick={() => setSecret(null)}>Done</Button>
        </div>
      ) : null}
      <div className="grid gap-2">
        {users.map((u) => (
          <button key={u.id} type="button" onClick={() => setSelected(u)} className={cn("press flex items-center gap-3 rounded-2xl border p-3 text-left", u.status !== "active" && "opacity-60")}>
            <UserCog className="size-5 text-muted-foreground" />
            <span className="grid min-w-0 flex-1">
              <span className="truncate font-medium">{u.name}{u.id === me.id ? " (you)" : ""}</span>
              <span className="truncate text-xs text-muted-foreground">{u.email}</span>
            </span>
            <span className="text-right text-xs">
              <span className="block font-medium">{ROLE_LABEL[u.role]}</span>
              <span className="text-muted-foreground">{u.status === "active" ? (u.lastLoginAt ? `seen ${new Date(u.lastLoginAt).toLocaleDateString("en-PH")}` : "never signed in") : "deactivated"}</span>
            </span>
          </button>
        ))}
      </div>

      <CreateUserSheet open={creating} onOpenChange={setCreating} roles={creatableRoles} onCreated={(email, password) => { setSecret({ email, password }); router.refresh(); }} />
      {selected ? (
        <UserSheet
          key={selected.id}
          user={selected}
          can={(a) => can(selected, a)}
          grantable={grantable}
          onClose={() => setSelected(null)}
          onDone={(msg, temp) => {
            toast.success(msg);
            if (temp) setSecret({ email: selected.email, password: temp });
            setSelected(null);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function CreateUserSheet({ open, onOpenChange, roles, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; roles: Role[]; onCreated: (email: string, pw: string) => void }) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<Role>("user");
  const [error, setError] = React.useState<string | null>(null);
  const submit = async () => {
    setError(null);
    try {
      const r = await api<{ tempPassword: string }>("/api/admin/users", { body: { name, email, role } });
      onOpenChange(false);
      onCreated(email.toLowerCase(), r.tempPassword);
      setName(""); setEmail(""); setRole("user");
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : "Failed");
    }
  };
  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title="New user" description="There is no public sign-up. You'll get a temporary password to share." footer={<Button size="lg" onClick={() => void submit()}>Create user</Button>}>
      <Field label="Name" htmlFor="un"><Input id="un" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Email" htmlFor="ue"><Input id="ue" type="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="Role" htmlFor="ur" hint="Every user gets their own private finance workspace. Admin roles never grant access to other users' finances.">
        <NativeSelect id="ur" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </NativeSelect>
      </Field>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </FormSheet>
  );
}

function UserSheet({ user, can, grantable, onClose, onDone }: {
  user: AdminUserRow;
  can: (a: TargetAction) => boolean;
  grantable: { key: string; label: string }[];
  onClose: () => void;
  onDone: (msg: string, temp?: string) => void;
}) {
  const [role, setRole] = React.useState<Role>(user.role);
  const [perms, setPerms] = React.useState<string[]>(user.permissions);
  const [error, setError] = React.useState<string | null>(null);
  const act = async (body: Record<string, unknown>, msg: string) => {
    setError(null);
    try {
      const r = await api<{ tempPassword?: string }>(`/api/admin/users/${user.id}`, { method: "PATCH", body });
      onDone(msg, r.tempPassword);
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : "Failed");
    }
  };
  return (
    <FormSheet open onOpenChange={(o) => !o && onClose()} title={user.name} description={`${user.email} · ${user.activeDevices} active device(s)`}>
      {can("set_role") ? (
        <Field label="Role" htmlFor="role">
          <div className="flex gap-2">
            <NativeSelect id="role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {(["user", "manager", "super_admin"] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </NativeSelect>
            <Button variant="outline" disabled={role === user.role} onClick={() => void act({ action: "set_role", role }, "Role updated")}>Save</Button>
          </div>
        </Field>
      ) : null}
      {user.role === "manager" && can("set_permissions") ? (
        <Field label="Manager permissions">
          <div className="grid gap-2 rounded-xl border p-3">
            {grantable.map((g) => (
              <label key={g.key} className="flex items-center gap-2 text-sm">
                <Checkbox checked={perms.includes(g.key)} onCheckedChange={(v) => setPerms((p) => (v ? [...p, g.key] : p.filter((x) => x !== g.key)))} />
                {g.label}
              </label>
            ))}
            <Button size="sm" variant="outline" className="justify-self-start" onClick={() => void act({ action: "set_permissions", permissions: perms }, "Permissions updated")}>Save permissions</Button>
          </div>
        </Field>
      ) : null}
      <div className="grid gap-2">
        {can("reset_password") ? <Button variant="outline" onClick={() => void act({ action: "reset_password" }, "Password reset")}>Reset password</Button> : null}
        {can("revoke_devices") ? <Button variant="outline" onClick={() => void act({ action: "revoke_devices" }, "All devices signed out")}>Sign out all devices (erases their local data)</Button> : null}
        {user.status === "active" && can("deactivate") ? <Button variant="destructive" onClick={() => void act({ action: "deactivate" }, "User deactivated")}>Deactivate</Button> : null}
        {user.status !== "active" && can("reactivate") ? <Button onClick={() => void act({ action: "reactivate" }, "User reactivated")}>Reactivate</Button> : null}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </FormSheet>
  );
}
