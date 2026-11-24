"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/finance/primitives";
import { api, ApiCallError } from "@/client/api";

export function SetupForm() {
  const router = useRouter();
  const [form, setForm] = React.useState({ setupToken: "", name: "", email: "", password: "", confirm: "" });
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (form.password !== form.confirm) return setError("Passwords don't match.");
    setBusy(true);
    try {
      await api("/api/setup", { body: { setupToken: form.setupToken, name: form.name, email: form.email, password: form.password } });
      router.replace("/login?setup=1");
    } catch (err) {
      setError(err instanceof ApiCallError ? err.message : "Setup failed.");
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto grid min-h-dvh max-w-md content-center gap-6 px-6 py-10 pt-safe pb-safe">
      <div className="grid gap-2">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><ShieldCheck className="size-6" /></span>
        <h1 className="text-2xl font-semibold">Set up Finance Tracker</h1>
        <p className="text-sm text-muted-foreground">Create the Super Admin account. This page works only once. The Super Admin manages users but can&apos;t see anyone&apos;s financial records.</p>
      </div>
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Setup token" htmlFor="tok" hint="The SETUP_TOKEN value configured on the server.">
          <Input id="tok" type="password" autoComplete="off" required value={form.setupToken} onChange={set("setupToken")} />
        </Field>
        <Field label="Your name" htmlFor="nm"><Input id="nm" autoComplete="name" required value={form.name} onChange={set("name")} /></Field>
        <Field label="Email" htmlFor="em"><Input id="em" type="email" autoComplete="email" autoCapitalize="none" required value={form.email} onChange={set("email")} /></Field>
        <Field label="Password" htmlFor="pw" hint="At least 12 characters."><Input id="pw" type="password" autoComplete="new-password" required minLength={12} value={form.password} onChange={set("password")} /></Field>
        <Field label="Confirm password" htmlFor="pw2"><Input id="pw2" type="password" autoComplete="new-password" required value={form.confirm} onChange={set("confirm")} /></Field>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <Button size="lg" type="submit" disabled={busy}>{busy ? "Creating…" : "Create Super Admin"}</Button>
      </form>
    </main>
  );
}
