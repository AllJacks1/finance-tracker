import "server-only";
import { z } from "zod";

/**
 * Server environment, validated on first use (not at import, so `next build` works without
 * secrets). Never import this from client code; nothing here is exposed to the browser.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  APP_URL: z.string().url(),
  APP_ENCRYPTION_KEY: z
    .string()
    .refine((s) => Buffer.from(s, "base64").length === 32, "must be 32 bytes, base64-encoded"),
  SETUP_TOKEN: z.string().min(16).optional(),
  SESSION_IDLE_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  SESSION_ABSOLUTE_DAYS: z.coerce.number().int().min(1).max(365).default(60),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof schema>;
let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server environment: ${fields}`);
  }
  cached = parsed.data;
  return cached;
}

/** For tests that change process.env between suites. */
export function resetEnvCache() {
  cached = null;
}

export const isProduction = () => process.env.NODE_ENV === "production";
