import "server-only";
import { NextResponse } from "next/server";
import { z, ZodError, type ZodType } from "zod";
import { env } from "./env";
import { log } from "./log";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public details?: unknown,
  ) {
    super(message ?? code);
  }
}

export const unauthorized = (code = "unauthorized") => new ApiError(401, code, "Please sign in");
export const forbidden = (code = "forbidden") => new ApiError(403, code, "Not allowed");
export const notFound = () => new ApiError(404, "not_found", "Not found");

export function json(data: unknown, init?: ResponseInit): NextResponse {
  const res = NextResponse.json(data, init);
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}

export function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip");
}

/**
 * CSRF defence for state-changing requests: the session cookie is SameSite=Lax, and in addition
 * the Origin header (or Referer) must match APP_URL.
 */
export function assertSameOrigin(req: Request) {
  if (req.method === "GET" || req.method === "HEAD") return;
  const allowed = new URL(env().APP_URL).origin;
  const origin = req.headers.get("origin");
  if (origin) {
    if (origin !== allowed) throw new ApiError(403, "bad_origin", "Cross-site request blocked");
    return;
  }
  const referer = req.headers.get("referer");
  if (referer && new URL(referer).origin === allowed) return;
  throw new ApiError(403, "bad_origin", "Cross-site request blocked");
}

export async function readJson<T>(req: Request, schema: ZodType<T>, maxBytes = 1_000_000): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new ApiError(413, "too_large", "Request too large");
  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > maxBytes) throw new ApiError(413, "too_large", "Request too large");
    body = text ? JSON.parse(text) : {};
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(400, "invalid_json", "Invalid JSON");
  }
  return schema.parse(body);
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/**
 * Wraps a route handler: origin check, consistent error responses, and no leaking of internals.
 * Production responses never include stack traces or SQL errors.
 */
export function route<C = unknown>(fn: Handler<C>, opts: { skipOriginCheck?: boolean } = {}) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      if (!opts.skipOriginCheck) assertSameOrigin(req);
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof ApiError) {
        return json({ error: { code: err.code, message: err.message, details: err.details } }, { status: err.status });
      }
      if (err instanceof ZodError) {
        return json(
          { error: { code: "validation", message: "Invalid request", details: z.flattenError(err) } },
          { status: 400 },
        );
      }
      log.error("unhandled_route_error", { path: new URL(req.url).pathname, err });
      return json({ error: { code: "internal", message: "Something went wrong" } }, { status: 500 });
    }
  };
}
