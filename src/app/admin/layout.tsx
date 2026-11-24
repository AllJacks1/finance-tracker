import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { authFromCookies } from "@/server/authz";
import type { AdminPermission } from "@/lib/permissions";

export const metadata = { title: "Administration" };

const LINKS: { href: string; label: string; perm: AdminPermission }[] = [
  { href: "/admin", label: "Overview", perm: "system.health" },
  { href: "/admin/users", label: "Users", perm: "users.view" },
  { href: "/admin/audit", label: "Audit log", perm: "audit.view" },
  { href: "/admin/backups", label: "Backups", perm: "backups.view" },
  { href: "/admin/settings", label: "Settings", perm: "system.settings" },
];

/**
 * Administration is server-rendered and online-only. It reads identity/system tables only; it
 * runs with no workspace context, so Row-Level Security hides every financial table.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const auth = await authFromCookies();
  if (!auth) redirect("/login");
  if (auth.user.mustChangePassword) redirect("/change-password");
  if (auth.permissions.size === 0) redirect("/app");
  const links = LINKS.filter((l) => auth.permissions.has(l.perm));
  return (
    <div className="mx-auto min-h-dvh max-w-4xl px-4 pb-16 pt-safe">
      <header className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-primary" />
          <span className="font-semibold">Administration</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{auth.user.role === "super_admin" ? "Super Admin" : "Manager"}</span>
        </div>
        <Link href="/app" className="flex items-center gap-1 text-sm text-primary"><ArrowLeft className="size-4" /> My finances</Link>
      </header>
      <nav className="-mx-4 mb-6 flex gap-1 overflow-x-auto border-b px-4">
        {links.map((l) => (
          <Link key={l.href} href={l.href} className="whitespace-nowrap px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground">{l.label}</Link>
        ))}
      </nav>
      <p className="mb-6 rounded-xl bg-muted/60 p-3 text-xs text-muted-foreground">
        Administrators can manage accounts and the system but can&apos;t view anyone&apos;s financial records through this app.
      </p>
      {children}
    </div>
  );
}
