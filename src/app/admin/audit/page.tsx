import { redirect } from "next/navigation";
import { listAudit } from "@/server/admin/system";
import { authFromCookies } from "@/server/authz";

export default async function AuditPage() {
  const auth = await authFromCookies();
  if (!auth || !auth.permissions.has("audit.view")) redirect("/admin");
  const entries = await listAudit(200);
  return (
    <div className="grid gap-3">
      <h1 className="text-lg font-semibold">Audit log</h1>
      <p className="text-sm text-muted-foreground">Administrative and security events. Entries can&apos;t be edited or deleted by the app. No financial details are recorded.</p>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
            <tr><th className="p-2">When</th><th className="p-2">Event</th><th className="p-2">By</th><th className="p-2">Target</th><th className="p-2">Details</th><th className="p-2">IP</th></tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t align-top">
                <td className="whitespace-nowrap p-2">{new Date(e.createdAt).toLocaleString("en-PH")}</td>
                <td className="p-2 font-medium">{e.action}</td>
                <td className="p-2">{e.actorEmail ?? "—"}</td>
                <td className="p-2">{e.targetEmail ?? "—"}</td>
                <td className="max-w-64 truncate p-2 text-xs text-muted-foreground">{Object.keys(e.metadata as object).length ? JSON.stringify(e.metadata) : ""}</td>
                <td className="p-2 text-xs text-muted-foreground">{e.ip ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
