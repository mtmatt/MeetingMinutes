import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { getConnInfo } from "hono/bun";
import { config } from "../config";
import { httpError, safeEqual } from "../lib/util";
import type { AppEnv } from "../types";
import { SESSION_COOKIE, resolveSession } from "./service";

export function clientIp(c: Context): string {
  if (config.trustProxy) {
    const fwd = c.req.header("x-forwarded-for");
    if (fwd) return fwd.split(",")[0]!.trim();
    const real = c.req.header("x-real-ip");
    if (real) return real.trim();
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const withClientIp: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("clientIp", clientIp(c));
  await next();
};

/**
 * CSRF defence for cookie-authenticated API calls. State-changing requests must
 * carry the custom X-MM-Client header, which a cross-site form cannot set and a
 * cross-origin fetch cannot send without a CORS preflight (which we never grant).
 * The session cookie is additionally SameSite=Lax.
 */
export const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    if (c.req.header("x-mm-client") !== "1") httpError(403, "Missing client header.", "csrf");
    const origin = c.req.header("origin");
    if (origin && !isAllowedOrigin(c, origin)) httpError(403, "Cross-origin request rejected.", "csrf");
  }
  await next();
};

function isAllowedOrigin(c: Context, origin: string): boolean {
  if (config.publicUrl && origin === config.publicUrl) return true;
  const host = c.req.header("x-forwarded-host") && config.trustProxy ? c.req.header("x-forwarded-host") : c.req.header("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const resolved = token ? resolveSession(token) : null;
  if (!resolved) httpError(401, "Not signed in.", "unauthenticated");
  c.set("user", resolved.user);
  c.set("session", resolved.session);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("user")?.role !== "admin") httpError(403, "Administrator access required.", "forbidden");
  await next();
};

/** Bearer-token auth for GPU workers calling /internal. */
export const requireWorker: MiddlewareHandler = async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || !safeEqual(token, config.workerToken)) httpError(401, "Invalid worker token.", "unauthenticated");
  await next();
};
