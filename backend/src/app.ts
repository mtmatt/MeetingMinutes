import { Hono } from "hono";
import { compress } from "hono/compress";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { config } from "./config";
import { csrfGuard, hostGuard, withClientIp } from "./auth/middleware";
import { securityWatch } from "./auth/securityWatch";
import { isProbe } from "./services/security";
import { adminRoutes } from "./routes/admin";
import { billingRoutes, ecpayRoutes } from "./routes/billing";
import { usageRoutes } from "./routes/usage";
import { announcementRoutes } from "./routes/announcements";
import { authRoutes, meRoutes } from "./routes/auth";
import { eventRoutes } from "./routes/events";
import { internalRoutes } from "./routes/internal";
import { meetingRoutes } from "./routes/meetings";
import { presetRoutes } from "./routes/presets";
import { templateRoutes } from "./routes/templates";
import { voiceRoutes } from "./routes/voices";
import type { AppEnv } from "./types";

/** Google Identity Services, which asks the person for a Drive token in a pop-up. */
const GOOGLE_SIGN_IN = "https://accounts.google.com/gsi/";
/** Drive's upload endpoint, which turns the exported HTML into a Google Doc. */
const GOOGLE_APIS = "https://www.googleapis.com";

/**
 * Site-wide security headers. Only same-origin scripts and connections are
 * allowed, except that with Google Docs export configured the page may also
 * load Google's sign-in script, talk to Drive, and keep a handle on the
 * sign-in pop-up (which reports the token back with postMessage).
 */
/** ECPay's checkout page, which the purchase form is posted to. */
const ECPAY_CHECKOUT = { stage: "https://payment-stage.ecpay.com.tw", production: "https://payment.ecpay.com.tw" } as const;

export function securityHeaders({ google }: { google: boolean }) {
  const extra = (...src: string[]) => (google ? src : []);
  return secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", ...extra(`${GOOGLE_SIGN_IN}client`)],
      styleSrc: ["'self'", "'unsafe-inline'", ...extra(`${GOOGLE_SIGN_IN}style`)],
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'", ...extra(GOOGLE_SIGN_IN, GOOGLE_APIS)],
      ...(google ? { frameSrc: ["'self'", GOOGLE_SIGN_IN] } : {}),
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      // Buying points posts a form to ECPay.
      formAction: ["'self'", ECPAY_CHECKOUT[config.ecpay.mode]],
      objectSrc: ["'none'"],
    },
    strictTransportSecurity: config.cookieSecure ? "max-age=31536000; includeSubDomains" : false,
    referrerPolicy: "same-origin",
    // Recording needs the microphone and tab sharing; nothing else is used.
    permissionsPolicy: {
      microphone: ["self"],
      displayCapture: ["self"],
      camera: [],
      geolocation: [],
      payment: [],
      usb: [],
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: google ? "same-origin-allow-popups" : "same-origin",
    crossOriginResourcePolicy: "same-origin",
  });
}

export function createApp() {
  const app = new Hono<AppEnv>();

  // Before anything: blocked addresses are refused, and every answer is watched for signs of an attack.
  app.use(securityWatch);
  // Then, so a request for another host learns nothing about the site.
  app.use(hostGuard);
  app.use(securityHeaders({ google: !!config.googleClientId }));
  app.use(withClientIp);

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      const cause = err.cause as { code?: string; extra?: Record<string, unknown> } | undefined;
      c.set("errorCode", cause?.code);
      return c.json({ ...(cause?.extra ?? {}), error: err.message, code: cause?.code ?? "error" }, err.status);
    }
    console.error("[http] unhandled error:", err);
    return c.json({ error: "Internal server error.", code: "internal" }, 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  // Worker API: bearer-token auth, no cookies, no CSRF concerns.
  app.route("/internal", internalRoutes);
  // ECPay's notifications and people coming back from its page: form posts that
  // carry no session or client header; their signature is checked instead.
  app.route("/api/billing/ecpay", ecpayRoutes);

  const api = new Hono<AppEnv>();
  // JSON (a meeting with its transcript is ~100 KB) shrinks about tenfold. Event
  // streams, partial (Range) responses and media are left as they are.
  api.use(compress());
  api.use(csrfGuard);
  api.use(async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
  });
  api.route("/auth", authRoutes);
  api.route("/me", meRoutes);
  api.route("/meetings", meetingRoutes);
  api.route("/templates", templateRoutes);
  api.route("/presets", presetRoutes);
  api.route("/billing", billingRoutes);
  api.route("/usage", usageRoutes);
  api.route("/announcements", announcementRoutes);
  api.route("/voices", voiceRoutes);
  api.route("/admin", adminRoutes);
  api.route("/events", eventRoutes);
  api.all("*", (c) => c.json({ error: "Not found.", code: "not_found" }, 404));
  app.route("/api", api);

  // Built frontend (single-page app) with history fallback.
  const dist = config.frontendDist;
  const indexHtml = join(dist, "index.html");
  app.get("*", (c) => {
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      // A malformed escape ("/%E0%A4%A"): a bad request, not a server error with a stack trace in the log.
      return c.text("Bad request.", 400);
    }
    // Scanners asking for WordPress, .env files and the like: a plain 404 (and the security monitor counts them).
    if (isProbe(urlPath)) return c.text("Not found.", 404);
    if (!existsSync(indexHtml)) {
      return c.text("Frontend not built. Run `bun run build` in the repository root, or use the Vite dev server.", 503);
    }
    const candidate = resolve(dist, "." + normalize(urlPath));
    if (candidate.startsWith(dist + "/") && existsSync(candidate) && statSync(candidate).isFile()) {
      const immutable = urlPath.startsWith("/assets/");
      return staticFile(candidate, c.req.header("Accept-Encoding"), immutable ? "public, max-age=31536000, immutable" : "no-cache");
    }
    return staticFile(indexHtml, c.req.header("Accept-Encoding"), "no-cache", "text/html; charset=utf-8");
  });

  return app;
}

/** Content codings the browser accepts (Accept-Encoding, without those it refuses with q=0). */
function acceptedEncodings(header: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (header ?? "").toLowerCase().split(",")) {
    const [name, ...params] = part.split(";").map((x) => x.trim());
    const q = params.find((p) => p.startsWith("q="));
    if (name && !(q && Number(q.slice(2)) === 0)) out.add(name);
  }
  return out;
}

/**
 * A built file, as the brotli or gzip copy made at build time (app.js.br) when
 * the browser takes it and the copy exists, else as it is.
 */
export function staticFile(path: string, acceptEncoding: string | undefined, cacheControl: string, type?: string): Response {
  const file = Bun.file(path);
  const headers: Record<string, string> = {
    "Content-Type": type ?? file.type,
    "Cache-Control": cacheControl,
    Vary: "Accept-Encoding",
  };
  const accepted = acceptedEncodings(acceptEncoding);
  for (const [coding, ext] of [["br", ".br"], ["gzip", ".gz"]] as const) {
    if (accepted.has(coding) && existsSync(path + ext)) {
      headers["Content-Encoding"] = coding;
      return new Response(Bun.file(path + ext), { headers });
    }
  }
  return new Response(file, { headers });
}
