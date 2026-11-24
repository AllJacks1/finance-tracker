import { notFound } from "next/navigation";
import { connection } from "next/server";
import { isSetupComplete } from "@/server/setup";
import { SetupForm } from "./setup-form";

export const metadata = { title: "First-time setup" };

/**
 * One-time setup. Decided on the SERVER on every request: once a Super Admin exists this page is a
 * 404, and the API refuses too, so client-side tricks cannot reopen it.
 */
export default async function SetupPage() {
  await connection();
  if (await isSetupComplete()) notFound();
  return <SetupForm />;
}
