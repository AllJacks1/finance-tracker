/**
 * Client-side encryption for local (IndexedDB) data.
 *
 * - DEK: random 256-bit data key per user per device. All local financial data, including the
 *   outbox, is AES-256-GCM encrypted with it. In memory it lives only as a NON-extractable
 *   CryptoKey while the app is unlocked.
 * - The raw DEK is stored only in wrapped (encrypted) form:
 *     wrap_recovery: AES-GCM(recoveryKey, DEK) — recoveryKey is held by the server per device and
 *                    released only on fresh password authentication (or while no PIN is set).
 *     wrap_pin:      AES-GCM(Argon2id(PIN, salt), DEK) — enables offline unlock.
 *
 * Limitation (documented in docs/SECURITY.md): a short PIN has little entropy. Attempt limits are
 * enforced by the app; someone who copies the browser's IndexedDB files can brute-force the PIN
 * offline, slowed only by Argon2id.
 */
import { argon2id } from "hash-wasm";

export interface Wrapped {
  iv: Uint8Array;
  ct: Uint8Array;
}

export interface PinWrap extends Wrapped {
  salt: Uint8Array;
  kdf: { alg: "argon2id"; memoryKiB: number; iterations: number; parallelism: number };
}

const subtle = () => globalThis.crypto.subtle;
const rand = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const buf = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;

export const PIN_KDF = { alg: "argon2id" as const, memoryKiB: 65_536, iterations: 3, parallelism: 1 };

export function newRawKey(): Uint8Array {
  return rand(32);
}

export async function importAesKey(raw: Uint8Array, usages: KeyUsage[] = ["encrypt", "decrypt"]) {
  return subtle().importKey("raw", buf(raw), { name: "AES-GCM" }, false, usages);
}

export async function encryptBytes(key: CryptoKey, plain: Uint8Array): Promise<Wrapped> {
  const iv = rand(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: buf(iv) }, key, buf(plain)));
  return { iv, ct };
}

export async function decryptBytes(key: CryptoKey, w: Wrapped): Promise<Uint8Array> {
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: buf(w.iv) }, key, buf(w.ct)));
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function encryptJson(key: CryptoKey, value: unknown): Promise<Wrapped> {
  return encryptBytes(key, enc.encode(JSON.stringify(value)));
}

export async function decryptJson<T>(key: CryptoKey, w: Wrapped): Promise<T> {
  return JSON.parse(dec.decode(await decryptBytes(key, w))) as T;
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function deriveKekFromPin(pin: string, salt: Uint8Array, kdf = PIN_KDF): Promise<CryptoKey> {
  const raw = await argon2id({
    password: pin,
    salt,
    parallelism: kdf.parallelism,
    iterations: kdf.iterations,
    memorySize: kdf.memoryKiB,
    hashLength: 32,
    outputType: "binary",
  });
  return importAesKey(raw);
}

export async function wrapWithPin(rawDek: Uint8Array, pin: string, kdf = PIN_KDF): Promise<PinWrap> {
  const salt = rand(16);
  const kek = await deriveKekFromPin(pin, salt, kdf);
  return { salt, kdf, ...(await encryptBytes(kek, rawDek)) };
}

/** Throws if the PIN is wrong (AES-GCM authentication fails). */
export async function unwrapWithPin(w: PinWrap, pin: string): Promise<Uint8Array> {
  const kek = await deriveKekFromPin(pin, w.salt, w.kdf);
  return decryptBytes(kek, w);
}

export async function wrapWithRecovery(rawDek: Uint8Array, recoveryKeyB64: string): Promise<Wrapped> {
  return encryptBytes(await importAesKey(b64ToBytes(recoveryKeyB64)), rawDek);
}

export async function unwrapWithRecovery(w: Wrapped, recoveryKeyB64: string): Promise<Uint8Array> {
  return decryptBytes(await importAesKey(b64ToBytes(recoveryKeyB64)), w);
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? enc.encode(input) : input;
  const h = new Uint8Array(await subtle().digest("SHA-256", buf(data)));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** PIN rules: at least 6 digits, or a longer passcode; reject trivially guessable PINs. */
export function pinProblem(pin: string): string | null {
  if (pin.length < 6) return "Use at least 6 characters.";
  if (pin.length > 64) return "Use at most 64 characters.";
  if (/^\d+$/.test(pin)) {
    if (/^(\d)\1+$/.test(pin)) return "Don't repeat one digit.";
    const asc = "01234567890123456789";
    const desc = "98765432109876543210";
    if (asc.includes(pin) || desc.includes(pin)) return "Don't use a simple sequence.";
    if (["123123", "121212", "112233", "696969", "131313"].includes(pin)) return "This PIN is too common.";
  }
  return null;
}

/** Delay before the next PIN attempt after `failures` consecutive failures (ms). */
export function pinLockoutMs(failures: number): number {
  if (failures < 5) return 0;
  const steps = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 15 * 60_000];
  return steps[Math.min(failures - 5, steps.length - 1)]!;
}

/** After this many consecutive failures the PIN wrap is erased; online sign-in is required. */
export const PIN_MAX_FAILURES = 10;
