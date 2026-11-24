import { redirect } from "next/navigation";
import { getSettings } from "@/server/admin/system";
import { authFromCookies } from "@/server/authz";
import { SettingsForm } from "./settings-form";

export default async function AdminSettingsPage() {
  const auth = await authFromCookies();
  if (!auth || !auth.permissions.has("system.settings")) redirect("/admin");
  return <SettingsForm initial={await getSettings()} />;
}
