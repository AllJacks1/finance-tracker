import "server-only";
import { hash, verify } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";

/**
 * Argon2id with OWASP-recommended parameters (m=19 MiB, t=2, p=1) or stronger.
 * @node-rs/argon2 defaults to the Argon2id variant.
 */
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

// A real hash of a random value, used to keep timing similar when the email is unknown.
let dummy: Promise<string> | null = null;
export async function burnPasswordCheck(password: string) {
  dummy ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(await dummy, password);
}

const COMMON = new Set([
  "password",
  "password123",
  "password1234",
  "123456789012",
  "qwertyuiop12",
  "iloveyou1234",
  "adminadmin12",
  "welcome12345",
  "letmein12345",
  "changeme1234",
  "passwordpassword",
  "qwertyqwerty",
  "111111111111",
  "000000000000",
  "abcdefghijkl",
  "abc123abc123",
  "financetracker",
]);

/** Returns an error message, or null if the password is acceptable. */
export function passwordProblem(password: string, ctx: { email?: string; name?: string } = {}): string | null {
  if (password.length < 12) return "Use at least 12 characters.";
  if (password.length > 256) return "Use at most 256 characters.";
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return "This password is too common.";
  if (/^(.)\1+$/.test(password)) return "Do not repeat a single character.";
  const local = ctx.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return "Do not include your email name.";
  return null;
}

/** Readable temporary password for admin-created accounts and resets. */
export function generateTempPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(18);
  let out = "";
  for (let i = 0; i < 18; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
    if (i === 5 || i === 11) out += "-";
  }
  return out;
}
