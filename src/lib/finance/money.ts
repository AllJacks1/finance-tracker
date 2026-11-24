/**
 * Money utilities. ALL monetary values are integer centavos (1 PHP = 100 centavos).
 * Never use floating-point arithmetic on money: parsing is string-based and every
 * operation is checked to stay within JavaScript's safe-integer range.
 */
export type Centavos = number;

/** Upper bound for a single amount: ₱1 trillion. Keeps sums far inside the safe-integer range. */
export const MAX_AMOUNT: Centavos = 100_000_000_000_000;

export class MoneyError extends Error {}

export function assertCentavos(n: unknown, label = "amount"): asserts n is Centavos {
  if (typeof n !== "number" || !Number.isSafeInteger(n)) {
    throw new MoneyError(`${label} must be an integer number of centavos`);
  }
}

export function add(...values: Centavos[]): Centavos {
  let total = 0;
  for (const v of values) {
    assertCentavos(v);
    total += v;
    if (!Number.isSafeInteger(total)) throw new MoneyError("Amount overflow");
  }
  return total;
}

export function sub(a: Centavos, b: Centavos): Centavos {
  return add(a, -b);
}

export function sum<T>(items: readonly T[], pick: (item: T) => Centavos): Centavos {
  let total = 0;
  for (const it of items) total = add(total, pick(it));
  return total;
}

/**
 * Parse user input like "1,234.50", "₱ 99", "-12.5", "0.05" into centavos.
 * Returns null for anything that is not a valid amount with at most 2 decimal places.
 */
export function parseAmount(input: string, opts: { allowNegative?: boolean } = {}): Centavos | null {
  let s = input.trim().replace(/[₱\s,]/g, "").replace(/^PHP/i, "");
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (!/^(\d+)(\.\d{0,2})?$/.test(s) && !/^\.\d{1,2}$/.test(s)) return null;
  const [whole = "", frac = ""] = s.split(".");
  const pesos = whole === "" ? 0 : Number(whole);
  const cents = Number((frac + "00").slice(0, 2));
  if (!Number.isSafeInteger(pesos)) return null;
  const value = pesos * 100 + cents;
  if (!Number.isSafeInteger(value) || value > MAX_AMOUNT) return null;
  if (negative && !opts.allowNegative) return null;
  return negative ? -value : value;
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Format centavos as Philippine Peso, e.g. 123456 -> "₱1,234.56", -5 -> "-₱0.05". */
export function formatPHP(
  value: Centavos,
  opts: { sign?: "auto" | "always" | "never"; symbol?: boolean } = {},
): string {
  assertCentavos(value);
  const { sign = "auto", symbol = true } = opts;
  const abs = Math.abs(value);
  const pesos = Math.floor(abs / 100);
  const cents = abs % 100;
  const body = `${symbol ? "₱" : ""}${group(String(pesos))}.${String(cents).padStart(2, "0")}`;
  if (sign === "never" || value === 0) return body;
  if (value < 0) return `-${body}`;
  return sign === "always" ? `+${body}` : body;
}

/** Plain decimal string for inputs and CSV, e.g. 123456 -> "1234.56". */
export function toDecimalString(value: Centavos): string {
  assertCentavos(value);
  const abs = Math.abs(value);
  const str = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return value < 0 ? `-${str}` : str;
}

/** Integer percentage in basis points (1% = 100 bp) without floating-point money maths. */
export function ratioBasisPoints(part: Centavos, whole: Centavos): number {
  if (whole <= 0) return part > 0 ? 10_000 : 0;
  // part * 10000 stays exact for amounts below ~9e11 pesos; MAX_AMOUNT keeps us inside that.
  return Math.floor((part * 10_000) / whole);
}
