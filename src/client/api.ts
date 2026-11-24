/** Small fetch wrapper for the app's own API (same origin, cookie session). */
export class ApiCallError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
  get isNetwork() {
    return this.status === 0;
  }
}

export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (path, init) => fetch(path, init);
/** Tests inject a fetcher that calls route handlers directly. */
export function setFetcher(f: Fetcher) {
  fetcher = f;
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000) : null;
  let res: Response;
  try {
    res = await fetcher(path, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
      signal: ctrl?.signal,
    });
  } catch {
    throw new ApiCallError(0, "network", "Can't reach the server.");
  } finally {
    if (timer) clearTimeout(timer);
  }
  let body: unknown = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiCallError(res.status, err?.code ?? "http_error", err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return body as T;
}
