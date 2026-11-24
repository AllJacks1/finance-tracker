/**
 * Daily reminders (Railway cron "reminders"): sends one Web Push per user with NEW reminders.
 * Runs as the restricted app role (DATABASE_URL = ft_app) and reads each user's data only inside
 * that user's RLS context. Needs VAPID_* env vars; without them it exits quietly.
 *
 * Run: npm run reminders   (uses --conditions=react-server so server modules load outside Next)
 */
import "./lib/env";
import { closeDb } from "../src/server/db";
import { pushConfigured, sendToUser } from "../src/server/push";
import { runReminders } from "../src/server/reminders";

if (!pushConfigured()) {
  console.log(JSON.stringify({ msg: "reminders_skipped", reason: "VAPID keys not configured" }));
} else {
  const r = await runReminders(sendToUser);
  console.log(JSON.stringify({ msg: "reminders_done", ...r }));
}
await closeDb();
