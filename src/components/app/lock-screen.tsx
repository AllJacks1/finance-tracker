"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useVault } from "@/client/hooks";
import { vault } from "@/client/vault";

export function LockScreen() {
  const state = useVault();
  const router = useRouter();
  const [pin, setPin] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const wait = Math.max(0, Math.ceil((state.pinLockedUntil - now) / 1000));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin || wait > 0) return;
    setBusy(true);
    setError(null);
    const r = await vault.unlockWithPin(pin);
    setBusy(false);
    setPin("");
    if (!r.ok) setError(r.error ?? "Incorrect PIN.");
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6 pt-safe pb-safe">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Lock className="size-6" />
        </span>
        <h1 className="text-xl font-semibold">Welcome back{state.user?.name ? `, ${state.user.name.split(" ")[0]}` : ""}</h1>
        <p className="text-sm text-muted-foreground">Enter your PIN to open your data on this device. Works offline.</p>
      </div>
      <form onSubmit={submit} className="grid gap-3">
        <Input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          enterKeyHint="go"
          autoFocus
          aria-label="PIN"
          className="h-14 text-center text-2xl tracking-[0.5em]"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          disabled={busy || wait > 0}
        />
        {wait > 0 ? (
          <p className="text-center text-sm text-warning">Too many attempts. Try again in {wait}s.</p>
        ) : error ? (
          <p className="text-center text-sm text-destructive">{error}</p>
        ) : state.pinFailures > 0 ? (
          <p className="text-center text-xs text-muted-foreground">{state.pinFailures} failed attempt(s). After 10, the PIN is disabled.</p>
        ) : null}
        <Button size="lg" type="submit" disabled={busy || !pin || wait > 0}>
          {busy ? "Unlocking…" : "Unlock"}
        </Button>
      </form>
      <div className="grid gap-2 text-center text-sm">
        <Link href="/login?resume=1" className="text-primary underline-offset-4 hover:underline">
          Forgot PIN? Sign in with your password
        </Link>
        <button type="button" className="text-muted-foreground" onClick={() => void vault.logout({ removeLocalData: false }).then(() => router.replace("/login"))}>
          Use a different account
        </button>
      </div>
    </main>
  );
}
