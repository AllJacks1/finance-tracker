"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/finance/primitives";
import { api, ApiCallError } from "@/client/api";
import { useVault } from "@/client/hooks";
import { vault } from "@/client/vault";

export default function ChangePasswordPage() {
  const router = useRouter();
  const state = useVault();
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const forced = state.mustChangePassword;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== confirm) return setError("New passwords don't match.");
    setBusy(true);
    try {
      await api("/api/auth/change-password", { body: { currentPassword: current, newPassword: next } });
      toast.success("Password changed");
      if (forced && state.user?.email) {
        await vault.login(state.user.email, next);
      }
      router.replace("/app");
    } catch (err) {
      setError(err instanceof ApiCallError ? err.message : "Couldn't change password.");
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto grid min-h-dvh max-w-sm content-center gap-6 px-6 py-10 pt-safe pb-safe">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{forced ? "Choose your password" : "Change password"}</h1>
        <p className="text-sm text-muted-foreground">{forced ? "Your administrator gave you a temporary password. Replace it with your own (at least 12 characters)." : "Other devices will be signed out."}</p>
      </div>
      <form onSubmit={submit} className="grid gap-4">
        <Field label={forced ? "Temporary password" : "Current password"} htmlFor="cur"><Input id="cur" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label="New password" htmlFor="new"><Input id="new" type="password" autoComplete="new-password" required minLength={12} value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <Field label="Confirm new password" htmlFor="conf"><Input id="conf" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <Button size="lg" type="submit" disabled={busy}>{busy ? "Saving…" : "Save password"}</Button>
      </form>
    </main>
  );
}
