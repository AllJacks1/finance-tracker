import { redirect } from "next/navigation";
import { connection } from "next/server";
import { isSetupComplete } from "@/server/setup";

/** Entry point: first-time setup if no Super Admin exists yet, otherwise the app. */
export default async function Home() {
  await connection();
  let complete = true;
  try {
    complete = await isSetupComplete();
  } catch {
    // Database unreachable: send to the app shell, which works from local data.
  }
  redirect(complete ? "/app" : "/setup");
}
