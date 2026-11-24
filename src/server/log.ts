import "server-only";

/**
 * Minimal structured logger (JSON lines → Railway logs).
 * Never pass request bodies, financial payloads, passwords, tokens or PINs to it.
 */
type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  const min = (process.env.LOG_LEVEL as Level) ?? "info";
  if (order[level] < (order[min] ?? 20)) return;
  const f: Record<string, unknown> = { ...fields };
  if (f.err instanceof Error) {
    f.err = { name: f.err.name, message: f.err.message, stack: process.env.NODE_ENV === "production" ? undefined : f.err.stack };
  }
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...f });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};
