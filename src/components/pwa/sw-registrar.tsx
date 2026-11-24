"use client";
import * as React from "react";
import { toast } from "sonner";

/**
 * Registers the service worker (production only) and offers an in-app update when a new version
 * is waiting. The page is never reloaded automatically, so unsaved form input is never lost.
 */
export function ServiceWorkerRegistrar() {
  React.useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") {
      // Development: never run a cached production shell.
      void navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => void r.unregister()));
      return;
    }
    let reloading = false;
    const onControllerChange = () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    };
    const promptUpdate = (reg: ServiceWorkerRegistration) => {
      if (!reg.waiting) return;
      toast("A new version is available", {
        duration: Infinity,
        action: {
          label: "Update",
          onClick: () => {
            navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
            reg.waiting?.postMessage({ type: "SKIP_WAITING" });
          },
        },
      });
    };
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        promptUpdate(reg);
        reg.addEventListener("updatefound", () => {
          const w = reg.installing;
          w?.addEventListener("statechange", () => {
            if (w.state === "installed" && navigator.serviceWorker.controller) promptUpdate(reg);
          });
        });
      })
      .catch(() => {});
    // Ask the browser not to evict our offline data under storage pressure.
    void navigator.storage?.persist?.().catch(() => false);
  }, []);
  return null;
}
