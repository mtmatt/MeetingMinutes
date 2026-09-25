import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { config } from "./config";
import { csrfGuard, withClientIp } from "./auth/middleware";
import { adminRoutes } from "./routes/admin";
import { authRoutes, meRoutes } from "./routes/auth";
import { eventRoutes } from "./routes/events";
import { internalRoutes } from "./routes/internal";
import { meetingRoutes } from "./routes/meetings";
import { templateRoutes } from "./routes/templates";
import type { AppEnv } from "./types";

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        mediaSrc: ["'self'", "blob:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
      },
      strictTransportSecurity: config.cookieSecure ? "max-age=31536000; includeSubDomains" : false,
      referrerPolicy: "same-origin",
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: "same-origin",
    }),
  );
  app.use(withClientIp);

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      const code = (err.cause as { code?: string } | undefined)?.code ?? "error";
      return c.json({ error: err.message, code }, err.status);
    }
    console.error("[http] unhandled error:", err);
    return c.json({ error: "Internal server error.", code: "internal" }, 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  // Worker API: bearer-token auth, no cookies, no CSRF concerns.
  app.route("/internal", internalRoutes);

  const api = new Hono<AppEnv>();
  api.use(csrfGuard);
  api.use(async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
  });
  api.route("/auth", authRoutes);
  api.route("/me", meRoutes);
  api.route("/meetings", meetingRoutes);
  api.route("/templates", templateRoutes);
  api.route("/admin", adminRoutes);
  api.route("/events", eventRoutes);
  api.all("*", (c) => c.json({ error: "Not found.", code: "not_found" }, 404));
  app.route("/api", api);

  // Built frontend (single-page app) with history fallback.
  const dist = config.frontendDist;
  const indexHtml = join(dist, "index.html");
  app.get("*", (c) => {
    if (!existsSync(indexHtml)) {
      return c.text("Frontend not built. Run `bun run build` in the repository root, or use the Vite dev server.", 503);
    }
    const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    const candidate = resolve(dist, "." + normalize(urlPath));
    if (candidate.startsWith(dist + "/") && existsSync(candidate) && statSync(candidate).isFile()) {
      const immutable = urlPath.startsWith("/assets/");
      return new Response(Bun.file(candidate), {
        headers: { "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
      });
    }
    return new Response(Bun.file(indexHtml), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
    });
  });

  return app;
}
