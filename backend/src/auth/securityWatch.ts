import type { Context, MiddlewareHandler } from "hono";
import { isBlocked, isProbe, recordEvent, type EventKind } from "../services/security";
import type { AppEnv } from "../types";
import { clientIp } from "./middleware";

/** Error codes that mean a link or code that does not exist was tried. */
const BAD_TOKEN = new Set(["invalid_invite", "bad_setup_token", "invalid_link", "bad_enroll_code"]);

/** What a finished request says about the client, if anything suspicious. */
function classify(c: Context<AppEnv>, path: string): EventKind | null {
  const status = c.res.status;
  const code = c.get("errorCode");
  if (status === 421) return "wrong_host";
  if (status === 429) return "rate_limited";
  if (path.startsWith("/api/billing/ecpay/") && status === 400) return "payment_signature";
  if (code === "bad_credentials" && path === "/api/auth/login") return "login_failed";
  if (code === "csrf") return "csrf";
  if (code && BAD_TOKEN.has(code)) return "bad_token";
  if (path.startsWith("/internal/") && status === 401) return "worker_auth";
  if (status === 404 && isProbe(path)) return "probe";
  return null;
}

/**
 * First in the chain: refuses blocked addresses, and records what the response
 * to each request says about its client (see services/security.ts). Runs
 * before the host check, so requests naming another host are seen too.
 */
export const securityWatch: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ip = clientIp(c);
  let path: string;
  try {
    path = new URL(c.req.url).pathname;
  } catch {
    path = "";
  }
  if (isBlocked(ip)) {
    recordEvent("blocked", { ip, detail: `${c.req.method} ${path}` });
    return new Response("Forbidden.\n", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", Connection: "close" },
    });
  }
  await next();
  const kind = classify(c, path);
  if (kind) {
    const detail = kind === "wrong_host" ? `Host: ${(c.req.header("host") ?? "").slice(0, 100)}` : `${c.req.method} ${path}`;
    // A sign-in's account, also when it was refused for too many attempts.
    recordEvent(kind, { ip, username: path === "/api/auth/login" ? (c.get("attemptedUser") ?? null) : null, detail });
  }
};
