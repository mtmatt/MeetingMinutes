import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { getConnInfo } from "hono/bun";
import { isIP } from "node:net";
import { config, normalizeHost } from "../config";
import { httpError, safeEqual } from "../lib/util";
import type { AppEnv } from "../types";
import { SESSION_COOKIE, resolveSession } from "./service";
import { workerKeyForToken } from "../services/workerKeys";

function peerAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address ?? undefined;
  } catch {
    return undefined;
  }
}

/** A connection from this machine (or a request handed to the app in-process, which only code here can do). */
function fromThisMachine(c: Context): boolean {
  try {
    return isLoopbackAddress(getConnInfo(c).remote.address);
  } catch {
    // No server behind the request: app.fetch called directly, as the tests do.
    return true;
  }
}

/** "::ffff:10.0.0.5" -> "10.0.0.5"; lower case. */
function plainAddress(addr: string): string {
  const a = addr.trim().toLowerCase();
  return a.startsWith("::ffff:") && isIP(a.slice(7)) === 4 ? a.slice(7) : a;
}

/** An address on this machine or a private network: where a reverse proxy normally is. */
export function isPrivateAddress(addr: string): boolean {
  const a = plainAddress(addr);
  if (isIP(a) === 4) {
    const [x, y] = a.split(".").map(Number) as [number, number];
    return x === 127 || x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
  }
  if (isIP(a) === 6) return a === "::1" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
  return false;
}

/** Whether the connection comes from the reverse proxy, so that its X-Forwarded-* headers may be believed. */
export function fromTrustedProxy(c: Context): boolean {
  if (!config.trustProxy) return false;
  const peer = peerAddress(c);
  if (!peer) return false;
  return isPrivateAddress(peer) || config.trustedProxies.includes(plainAddress(peer));
}

/**
 * The visitor's address. Behind a trusted proxy, the last X-Forwarded-For entry:
 * the one the proxy added. Earlier entries are whatever the client sent, and
 * would let anyone pick the address used for sign-in limits and blocking.
 */
export function clientIp(c: Context): string {
  const peer = peerAddress(c);
  if (fromTrustedProxy(c)) {
    const last = c.req.header("x-forwarded-for")?.split(",").pop()?.trim();
    if (last && isIP(plainAddress(last))) return plainAddress(last);
  }
  return peer ? plainAddress(peer) : "unknown";
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  return a === "::1" || /^(::ffff:)?127(\.\d{1,3}){3}$/.test(a);
}

/**
 * The host name a request names, or null. Only the Host header: Caddy and the
 * nginx example pass the visitor's Host through, and X-Forwarded-Host is not
 * set by them, so it would be whatever the client chose.
 */
function requestedHost(c: Context): string | null {
  const raw = c.req.header("host");
  if (!raw) return null;
  try {
    return normalizeHost(new URL(`http://${raw}`).hostname);
  } catch {
    return null;
  }
}

/**
 * Answer only to the site's own name (config.allowedHosts). Someone typing the
 * server's IP address, or a scanner sweeping addresses, gets a bare refusal
 * instead of the sign-in page. Programs on this machine (GPU workers, health
 * checks, the dev server) may still use localhost / 127.0.0.1.
 *
 * This keeps casual and automated visitors out; it is not access control: the
 * name is in the TLS certificate, and anyone who knows it can send it.
 */
export const hostGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const allowed = config.allowedHosts;
  if (allowed.length === 0) return next();
  const host = requestedHost(c);
  if (host && allowed.includes(host)) return next();
  if (host && LOOPBACK_NAMES.has(host) && isLoopbackAddress(peerAddress(c))) return next();
  return new Response("Misdirected request.\n", {
    status: 421,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", Connection: "close" },
  });
};

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
  const host = c.req.header("host");
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
/**
 * A worker: on this machine with the shared WORKER_TOKEN (it reads media from
 * disk), or elsewhere with its own token from enrollment (it downloads media
 * over HTTPS, and only for jobs it runs). Sets c.get("worker").
 */
export const requireWorker: MiddlewareHandler = async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (token && safeEqual(token, config.workerToken)) {
    // The shared token is for workers on this machine: refused from anywhere else, or through the
    // proxy (which adds X-Forwarded-For), so a copy of it is of no use outside the server.
    if (!fromThisMachine(c) || c.req.header("x-forwarded-for")) httpError(401, "Invalid worker token.", "unauthenticated");
    c.set("worker", { local: true, keyId: null });
    return next();
  }
  const key = token ? workerKeyForToken(token, clientIp(c)) : null;
  if (!key) httpError(401, "Invalid worker token.", "unauthenticated");
  c.set("worker", { local: false, keyId: key!.id });
  await next();
};
