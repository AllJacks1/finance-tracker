import { AppShell } from "@/components/app/app-shell";

/**
 * The finance app. Every page under /app is a static client shell that reads only from the
 * encrypted local store, so it is precached by the service worker and works offline.
 */
export default function FinanceLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
