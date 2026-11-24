import { redirect } from "next/navigation";
import { desc } from "drizzle-orm";
import { authFromCookies } from "@/server/authz";
import { db } from "@/server/db";
import { backupRuns } from "@/server/db/schema";
import { storageConfigured } from "@/server/storage";

export default async function BackupsPage() {
  const auth = await authFromCookies();
  if (!auth || !auth.permissions.has("backups.view")) redirect("/admin");
  const runs = await db().select().from(backupRuns).orderBy(desc(backupRuns.startedAt)).limit(60);
  return (
    <div className="grid gap-4">
      <h1 className="text-lg font-semibold">Backups</h1>
      <div className="grid gap-1 rounded-xl bg-muted/60 p-3 text-sm text-muted-foreground">
        <p>A scheduled job (the Railway <code>backup</code> service) makes an encrypted backup of the whole database every day and uploads it to object storage. Backups are encrypted with a public key; only the holder of the private key can restore them.</p>
        <p>To run one now: in Railway, open the <code>backup</code> service and click <b>Run now</b>, or run <code>railway run npm run backup</code>. Restore steps are in <code>docs/RECOVERY.md</code>.</p>
        {!storageConfigured() ? <p className="text-warning">Object storage is not configured on the web service (that's fine if only the backup service has it).</p> : null}
      </div>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-muted-foreground"><tr><th className="p-2">Started</th><th className="p-2">Status</th><th className="p-2">Trigger</th><th className="p-2">Size</th><th className="p-2">Duration</th><th className="p-2">Details</th></tr></thead>
          <tbody>
            {runs.length === 0 ? <tr><td className="p-3 text-muted-foreground" colSpan={6}>No backups have run yet.</td></tr> : null}
            {runs.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="whitespace-nowrap p-2">{new Date(r.startedAt).toLocaleString("en-PH")}</td>
                <td className={r.status === "succeeded" ? "p-2 text-income" : r.status === "failed" ? "p-2 text-expense" : "p-2"}>{r.status}</td>
                <td className="p-2">{r.trigger}</td>
                <td className="p-2">{r.sizeBytes ? `${(r.sizeBytes / 1024).toFixed(0)} KB` : "—"}</td>
                <td className="p-2">{r.finishedAt ? `${Math.round((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000)} s` : "—"}</td>
                <td className="max-w-72 truncate p-2 text-xs text-muted-foreground">{r.error ?? r.objectKey ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
