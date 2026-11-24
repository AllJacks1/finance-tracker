"use client";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/finance/primitives";
import { api, ApiCallError } from "@/client/api";

export function SettingsForm({ initial }: { initial: { loginNotice: string; backupRetentionDays: number } }) {
  const [loginNotice, setNotice] = React.useState(initial.loginNotice);
  const [days, setDays] = React.useState(String(initial.backupRetentionDays));
  const save = async () => {
    try {
      await api("/api/admin/settings", { method: "PUT", body: { loginNotice, backupRetentionDays: Number(days) } });
      toast.success("Settings saved");
    } catch (e) {
      toast.error(e instanceof ApiCallError ? e.message : "Failed");
    }
  };
  return (
    <div className="grid max-w-lg gap-4">
      <h1 className="text-lg font-semibold">System settings</h1>
      <Field label="Sign-in page notice" htmlFor="ln" hint="Optional message shown to everyone on the sign-in page (e.g. planned maintenance).">
        <Textarea id="ln" rows={3} maxLength={300} value={loginNotice} onChange={(e) => setNotice(e.target.value)} />
      </Field>
      <Field label="Keep daily backups for (days)" htmlFor="rd" hint="Monthly backups (first of each month) are kept for 12 months.">
        <Input id="rd" type="number" min={7} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
      </Field>
      <Button className="justify-self-start" onClick={() => void save()}>Save</Button>
    </div>
  );
}
