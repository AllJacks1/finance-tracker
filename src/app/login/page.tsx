"use client";
import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Wallet, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/finance/primitives";
import { api, ApiCallError } from "@/client/api";
import { useOnline, useVault } from "@/client/hooks";
import { vault } from "@/client/vault";

export default function LoginPage() {
  return (
    <React.Suspense>
      <Login />
    </React.Suspense>
  );
}

function Login() {
  const router = useRouter();
  const params = useSearchParams();
  const state = useVault();
  const [email, setEmail] = React.useState(state.user?.email ?? "");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  const online = useOnline();

  React.useEffect(() => {
    api<{ setupComplete: boolean; loginNotice: string }>("/api/setup", { timeoutMs: 5000 })
      .then((r) => {
        if (!r.setupComplete) router.replace("/setup");
        setNotice(r.loginNotice);
      })
      .catch(() => {});
    if (!params.get("resume")) {
      void vault.init().then(() => {
        const s = vault.getState();
        if (s.phase === "unlocked" || s.phase === "locked") router.replace("/app");
      });
    }
  }, [router, params]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await vault.login(email.trim(), password);
      if (r.mustChangePassword) router.replace("/change-password");
      else router.replace("/app");
    } catch (err) {
      setError(
        err instanceof ApiCallError
          ? err.isNetwork
            ? "You're offline. Sign in needs the internet the first time on each device. If you set an offline PIN before, open the app to unlock with it."
            : err.message
          : "Sign in failed.",
      );
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto grid min-h-dvh max-w-sm content-center gap-6 px-6 py-10 pt-safe pb-safe">
      <div className="grid gap-2">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground"><Wallet className="size-6" /></span>
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="text-sm text-muted-foreground">
          {params.get("setup") ? "Setup complete. Sign in with your new Super Admin account." : params.get("resume") ? "Enter your password to unlock and resume syncing." : "Accounts are created by your administrator."}
        </p>
      </div>
      {notice ? <p className="rounded-xl bg-muted p-3 text-sm">{notice}</p> : null}
      {!online ? <p className="flex items-center gap-2 rounded-xl bg-warning/15 p-3 text-sm"><WifiOff className="size-4" /> You&apos;re offline.</p> : null}
      {state.message && !error ? <p className="rounded-xl bg-muted p-3 text-sm">{state.message}</p> : null}
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="username" autoCapitalize="none" autoCorrect="off" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <Button size="lg" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
      <p className="text-center text-xs text-muted-foreground">Forgot your password? Ask your administrator to reset it.</p>
    </main>
  );
}
