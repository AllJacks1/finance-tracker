"use client";
import * as React from "react";
import { BellRing } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Field, NativeSelect, SectionTitle } from "@/components/finance/primitives";
import { ActionError } from "@/client/actions";
import { savePreferences } from "@/client/goal-actions";
import { useFinance } from "@/client/hooks";
import { disablePush, enablePush, pushState, type PushState } from "@/client/notify";
import type { Preferences } from "@/lib/domain/types";

type N = Preferences["notifications"];
const TOGGLES: { key: keyof N; label: string; desc: string }[] = [
  { key: "bills", label: "Bills", desc: "Upcoming, due today and overdue" },
  { key: "scheduled", label: "Scheduled items", desc: "Income, expenses and transfers to confirm" },
  { key: "cards", label: "Credit card due dates", desc: "Statement payment reminders" },
  { key: "loans", label: "Loan installments", desc: "Upcoming and overdue installments" },
  { key: "budgets", label: "Budget warnings", desc: "When you approach or exceed a budget" },
  { key: "goals", label: "Savings milestones", desc: "25%, 50%, 75% and goal reached" },
];

export default function NotificationsPage() {
  const f = useFinance();
  const n = f.settings.preferences.notifications;
  const [state, setState] = React.useState<PushState | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    void pushState().then(setState);
  }, []);

  const set = (patch: Partial<N>) =>
    void savePreferences({ notifications: { ...n, ...patch } }).catch((e) => toast.error(e instanceof ActionError ? e.message : "Couldn't save."));

  const toggleSystem = async () => {
    setBusy(true);
    try {
      setState(state === "on" ? await disablePush() : await enablePush());
    } catch {
      toast.error("Couldn't change notifications on this device.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Notifications" back="/app/more" />
      <div className="grid gap-5">
        <section className="grid gap-2">
          <SectionTitle>Remind me about</SectionTitle>
          {TOGGLES.map((t) => (
            <label key={t.key} className="flex items-center justify-between gap-3 rounded-xl border p-3 text-sm">
              <span className="grid"><span className="font-medium">{t.label}</span><span className="text-xs text-muted-foreground">{t.desc}</span></span>
              <Switch checked={n[t.key] as boolean} onCheckedChange={(v) => set({ [t.key]: v } as Partial<N>)} />
            </label>
          ))}
          <Field label="Remind me about bills" htmlFor="bd">
            <NativeSelect id="bd" value={n.billDaysBefore} onChange={(e) => set({ billDaysBefore: Number(e.target.value) })}>
              <option value={0}>On the due date</option>
              <option value={1}>1 day before</option>
              <option value={3}>3 days before</option>
              <option value={7}>7 days before</option>
            </NativeSelect>
          </Field>
        </section>

        <section className="grid gap-3 rounded-2xl border p-4">
          <div className="flex items-center gap-2 font-semibold"><BellRing className="size-5 text-primary" /> Notifications on this device</div>
          <p className="text-sm text-muted-foreground">
            In-app reminders (the bell on Home) always work, even offline. To also get reminders when the app is closed, turn on push for this device. A daily reminder is sent around 8:00 AM, based on what has synced to the server.
          </p>
          {state === "unsupported" ? <p className="text-sm text-warning">This browser doesn&apos;t support push notifications. On iPhone/iPad, add the app to your Home Screen first (iOS 16.4 or later), then open it from there.</p> : null}
          {state === "not_configured" ? <p className="text-sm text-muted-foreground">Push notifications aren&apos;t set up on this server yet.</p> : null}
          {state === "denied" ? <p className="text-sm text-warning">Notifications are blocked for this app. Allow them in your browser or phone settings.</p> : null}
          {state === "on" || state === "off" ? (
            <Button variant={state === "on" ? "outline" : "default"} disabled={busy} onClick={() => void toggleSystem()}>
              {state === "on" ? "Turn off push on this device" : "Turn on push on this device"}
            </Button>
          ) : null}
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="grid"><span className="font-medium">Show names and amounts</span><span className="text-xs text-muted-foreground">Off: notifications only say how many items are due, so nothing private shows on your lock screen.</span></span>
            <Switch checked={n.pushShowAmounts} onCheckedChange={(v) => set({ pushShowAmounts: v })} />
          </label>
          <p className="text-xs text-muted-foreground">
            Phones may delay or batch notifications, and no browser can schedule reminders on its own while the app is closed. Push is the only way to be reminded then.
          </p>
        </section>
      </div>
    </>
  );
}
