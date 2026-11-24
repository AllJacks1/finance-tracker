"use client";
import * as React from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Field, NativeSelect, Segmented } from "@/components/finance/primitives";
import { ActionError, saveSettings } from "@/client/actions";
import { useRecords, useSettings } from "@/client/hooks";

const ZONES = ["Asia/Manila", "Asia/Singapore", "Asia/Hong_Kong", "Asia/Tokyo", "Asia/Dubai", "Europe/London", "America/Los_Angeles", "America/New_York", "Australia/Sydney", "UTC"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function SettingsPage() {
  const s = useSettings();
  const has = useRecords("settings").length > 0;
  const { theme, setTheme } = useTheme();
  const [tz, setTz] = React.useState(s.timezone);
  const [week, setWeek] = React.useState(s.weekStart);
  React.useEffect(() => { setTz(s.timezone); setWeek(s.weekStart); }, [s.timezone, s.weekStart]);

  const save = async () => {
    try {
      await saveSettings({ ...s, timezone: tz, weekStart: week });
      toast.success("Settings saved");
    } catch (e) {
      toast.error(e instanceof ActionError ? e.message : "Couldn't save.");
    }
  };

  return (
    <>
      <PageHeader title="Settings" back="/app/more" />
      <div className="grid gap-5">
        <Field label="Currency"><div className="rounded-lg border px-3 py-2.5 text-muted-foreground">Philippine Peso (₱ PHP)</div></Field>
        <Field label="Timezone" htmlFor="tz" hint="Decides which day a transaction falls on for budgets and reports.">
          <NativeSelect id="tz" value={tz} onChange={(e) => setTz(e.target.value)} disabled={!has}>
            {[...new Set([s.timezone, ...ZONES])].map((z) => <option key={z} value={z}>{z}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Week starts on" htmlFor="ws">
          <NativeSelect id="ws" value={week} onChange={(e) => setWeek(Number(e.target.value))} disabled={!has}>
            {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </NativeSelect>
        </Field>
        <Button onClick={() => void save()} disabled={!has}>Save</Button>
        {!has ? <p className="text-xs text-muted-foreground">Sync once to download your settings.</p> : null}
        <Field label="Appearance">
          <Segmented value={(theme as "system" | "light" | "dark") ?? "system"} onChange={setTheme} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        </Field>
      </div>
    </>
  );
}
