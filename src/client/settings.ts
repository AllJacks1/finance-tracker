import { DEFAULT_PREFERENCES, type WorkspaceSettings } from "@/lib/domain/types";
import { preferencesSchema } from "@/lib/sync/protocol";

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  id: "",
  currency: "PHP",
  timezone: "Asia/Manila",
  weekStart: 1,
  preferences: DEFAULT_PREFERENCES,
};

/** Settings record with every preference filled in (older records have none). */
export function withPreferences(s: WorkspaceSettings | undefined): WorkspaceSettings {
  if (!s) return DEFAULT_SETTINGS;
  const parsed = preferencesSchema.safeParse(s.preferences ?? {});
  return { ...s, preferences: parsed.success ? parsed.data : DEFAULT_PREFERENCES };
}
