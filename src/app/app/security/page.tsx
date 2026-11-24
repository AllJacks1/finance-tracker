"use client";
import * as React from "react";
import Link from "next/link";
import { KeyRound, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FormSheet, SectionTitle } from "@/components/finance/primitives";
import { api, ApiCallError } from "@/client/api";
import { useVault } from "@/client/hooks";
import { vault } from "@/client/vault";

interface Device { id: string; label: string; createdAt: string; lastSeenAt: string | null; lastSyncAt: string | null; offlineEnabled: boolean; revokedAt: string | null; current: boolean }

export default function SecurityPage() {
  const v = useVault();
  const [pinOpen, setPinOpen] = React.useState(false);
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const [devices, setDevices] = React.useState<Device[] | null>(null);
  const [devError, setDevError] = React.useState<string | null>(null);

  const loadDevices = React.useCallback(() => {
    api<{ devices: Device[] }>("/api/auth/devices")
      .then((r) => setDevices(r.devices))
      .catch((e) => setDevError(e instanceof ApiCallError && e.isNetwork ? "Connect to the internet to manage devices." : "Couldn't load devices."));
  }, []);
  React.useEffect(loadDevices, [loadDevices]);

  return (
    <>
      <PageHeader title="Security" back="/app/more" />
      <div className="grid gap-6">
        <section className="grid gap-2">
          <SectionTitle>Offline access</SectionTitle>
          <div className="grid gap-3 rounded-2xl border p-4">
            <div className="flex items-start gap-3">
              <KeyRound className="mt-0.5 size-5 text-primary" />
              <div className="grid gap-1 text-sm">
                <span className="font-medium">{v.hasPin ? "PIN is set on this device" : "No PIN on this device"}</span>
                <span className="text-muted-foreground">
                  A PIN lets you open your data on this device without internet. The app locks after 5 minutes of inactivity. After 10 wrong PINs, the PIN is disabled and you must sign in with your password.
                </span>
              </div>
            </div>
            <Button onClick={() => setPinOpen(true)}>{v.hasPin ? "Change PIN" : "Set up offline PIN"}</Button>
            {v.hasPin ? <Button variant="outline" onClick={() => setRemoveOpen(true)}>Turn off offline access</Button> : null}
            <p className="text-xs text-muted-foreground">
              Your data on this device is encrypted. A PIN is easier to guess than a password, so it protects against casual access, not against someone who copies the browser&apos;s files.
            </p>
          </div>
        </section>

        <section className="grid gap-2">
          <SectionTitle>Password</SectionTitle>
          <Button variant="outline" asChild><Link href="/change-password">Change password</Link></Button>
        </section>

        <section className="grid gap-2">
          <SectionTitle>Devices</SectionTitle>
          {devError ? <p className="text-sm text-muted-foreground">{devError}</p> : null}
          {devices?.map((d) => (
            <div key={d.id} className="flex items-center gap-3 rounded-2xl border p-3">
              <Smartphone className="size-5 text-muted-foreground" />
              <div className="grid flex-1 text-sm">
                <span className="font-medium">{d.label}{d.current ? " · this device" : ""}</span>
                <span className="text-xs text-muted-foreground">
                  {d.revokedAt ? "Signed out" : `Last seen ${d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleDateString("en-PH") : "—"}${d.offlineEnabled ? " · offline PIN" : ""}`}
                </span>
              </div>
              {!d.revokedAt && !d.current ? (
                <Button size="sm" variant="destructive" onClick={() => void api("/api/auth/devices", { body: { deviceId: d.id } }).then(() => { toast.success("Device signed out. Its local data is erased when it next connects."); loadDevices(); })}>
                  Sign out
                </Button>
              ) : null}
            </div>
          ))}
        </section>
      </div>
      <PinSheet open={pinOpen} onOpenChange={setPinOpen} />
      <RemovePinSheet open={removeOpen} onOpenChange={setRemoveOpen} />
    </>
  );
}

function PinSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [pin, setPin] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [needPw, setNeedPw] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const submit = async () => {
    setError(null);
    if (pin !== confirm) return setError("PINs don't match.");
    setBusy(true);
    const r = await vault.setPin(pin, needPw ? password : undefined);
    setBusy(false);
    if (r.ok) {
      toast.success("Offline PIN set");
      onOpenChange(false);
      setPin(""); setConfirm(""); setPassword("");
    } else if (r.error === "reauth_required") {
      setNeedPw(true);
      setError("Enter your account password to change the PIN.");
    } else setError(r.error ?? "Couldn't set PIN.");
  };
  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title="Offline PIN" description="At least 6 digits (or a longer passcode). Requires an internet connection to set." footer={<Button size="lg" disabled={busy} onClick={() => void submit()}>{busy ? "Securing…" : "Save PIN"}</Button>}>
      <Field label="New PIN" htmlFor="p1"><Input id="p1" type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value)} /></Field>
      <Field label="Confirm PIN" htmlFor="p2"><Input id="p2" type="password" inputMode="numeric" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
      {needPw ? <Field label="Account password" htmlFor="p3"><Input id="p3" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </FormSheet>
  );
}

function RemovePinSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title="Turn off offline access" description="You'll need to be online and signed in to open your data on this device." footer={
      <Button size="lg" variant="destructive" onClick={() => void vault.removePin(password).then((r) => (r.ok ? (toast.success("Offline access turned off"), onOpenChange(false)) : setError(r.error ?? "Failed")))}>Turn off</Button>
    }>
      <Field label="Account password" htmlFor="rp"><Input id="rp" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </FormSheet>
  );
}
