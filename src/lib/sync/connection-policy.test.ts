import { describe, expect, it } from "vitest";
import { evaluateConnection } from "./connection-policy";

describe("Wi-Fi-only sync policy", () => {
  const cases: [string, Parameters<typeof evaluateConnection>[0], string, boolean][] = [
    ["offline", { online: false, apiAvailable: true, type: "wifi" }, "offline", false],
    ["Android Chrome on Wi-Fi", { online: true, apiAvailable: true, type: "wifi" }, "wifi", true],
    ["ethernet", { online: true, apiAvailable: true, type: "ethernet" }, "ethernet", true],
    ["Android Chrome on mobile data", { online: true, apiAvailable: true, type: "cellular" }, "cellular", false],
    ["wimax counts as mobile", { online: true, apiAvailable: true, type: "wimax" }, "cellular", false],
    ["Wi-Fi but data saver", { online: true, apiAvailable: true, type: "wifi", saveData: true }, "data_saver", false],
    ["type unknown", { online: true, apiAvailable: true, type: "unknown" }, "unknown", false],
    ["type other", { online: true, apiAvailable: true, type: "other" }, "unknown", false],
    ["bluetooth tethering", { online: true, apiAvailable: true, type: "bluetooth" }, "unknown", false],
    ["desktop Chrome: API but no type", { online: true, apiAvailable: true }, "unknown", false],
    ["iOS Safari / Firefox: no API", { online: true, apiAvailable: false }, "unknown", false],
    ["no API even if a type is somehow passed", { online: true, apiAvailable: false, type: "wifi" }, "unknown", false],
  ];
  it.each(cases)("%s", (_name, info, status, allowed) => {
    const d = evaluateConnection(info);
    expect(d.status).toBe(status);
    expect(d.autoSyncAllowed).toBe(allowed);
  });

  it("navigator.onLine alone never enables automatic sync", () => {
    expect(evaluateConnection({ online: true, apiAvailable: false }).autoSyncAllowed).toBe(false);
  });
});
