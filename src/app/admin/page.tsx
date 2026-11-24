import { redirect } from "next/navigation";
import { CheckCircle2, CircleAlert, Database, HardDrive, RefreshCw, Users } from "lucide-react";
import { systemHealth } from "@/server/admin/system";
import { authFromCookies } from "@/server/authz";

export default async function AdminOverview() {
  const auth = await authFromCookies();
  if (!auth) redirect("/login");
  if (!auth.permissions.has("system.health")) redirect(auth.permissions.has("users.view") ? "/admin/users" : "/app");
  const h = await systemHealth();
  const backupOk = h.backups.recentSuccess;
  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card icon={<Database className="size-4" />} label="Database" value={`OK · ${h.database.latencyMs} ms`} ok />
        <Card icon={<Users className="size-4" />} label="Users" value={`${h.users.active} active / ${h.users.total}`} />
        <Card icon={<RefreshCw className="size-4" />} label="Sessions / devices" value={`${h.activeSessions} / ${h.activeDevices}`} />
        <Card icon={<HardDrive className="size-4" />} label="Last backup" value={h.backups.lastSuccess ? new Date(h.backups.lastSuccess.startedAt).toLocaleString("en-PH") : "Never"} ok={!!backupOk} warn={!backupOk} />
      </div>
      {!h.backups.storageConfigured ? (
        <p className="flex items-center gap-2 rounded-xl border border-warning/50 p-3 text-sm"><CircleAlert className="size-4 text-warning" /> Object storage isn&apos;t configured. Receipts and backups need S3_* environment variables.</p>
      ) : null}
      <section className="grid gap-2">
        <h2 className="font-semibold">Sync health (last 7 days)</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Card label="Push requests" value={String(h.sync7d.pushes)} />
          <Card label="Changes applied" value={String(h.sync7d.applied)} />
          <Card label="Conflicts" value={String(h.sync7d.conflicts)} warn={h.sync7d.conflicts > 0} />
          <Card label="Rejected" value={String(h.sync7d.rejected)} warn={h.sync7d.rejected > 0} />
          <Card label="Errors" value={String(h.sync7d.errors)} warn={h.sync7d.errors > 0} />
        </div>
        {h.sync7d.recentFailures.length ? (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-left text-xs text-muted-foreground"><tr><th className="p-2">When</th><th className="p-2">User</th><th className="p-2">Conflicts</th><th className="p-2">Rejected</th><th className="p-2">Error</th></tr></thead>
              <tbody>
                {h.sync7d.recentFailures.map((f, i) => (
                  <tr key={i} className="border-t"><td className="p-2">{new Date(f.at).toLocaleString("en-PH")}</td><td className="p-2">{f.userEmail}</td><td className="p-2">{f.conflicts}</td><td className="p-2">{f.rejected}</td><td className="p-2">{f.errorCode ?? "—"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">Only counts and error codes are recorded — never the content of anyone&apos;s changes.</p>
      </section>
      <p className="text-xs text-muted-foreground">Version {h.version}</p>
    </div>
  );
}

function Card({ icon, label, value, ok, warn }: { icon?: React.ReactNode; label: string; value: string; ok?: boolean; warn?: boolean }) {
  return (
    <div className="rounded-2xl border p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</div>
      <div className="mt-1 flex items-center gap-1.5 font-semibold">
        {ok ? <CheckCircle2 className="size-4 text-income" /> : warn ? <CircleAlert className="size-4 text-warning" /> : null}
        {value}
      </div>
    </div>
  );
}
