import { config } from "./config";
import { createApp } from "./app";
import { ensureSetupToken } from "./auth/setup";
import { purgeExpiredSessions } from "./auth/service";
import { reapStaleJobs } from "./services/meetings";
import { kick, recoverSummaries } from "./services/summarizer";
import { seedBuiltinTemplates } from "./services/templates";

seedBuiltinTemplates();
recoverSummaries();

const app = createApp();

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: (req, srv) => app.fetch(req, { server: srv }),
  // Uploads arrive in chunks of UPLOAD_CHUNK_MB; leave headroom for headers.
  maxRequestBodySize: config.uploadChunkBytes + 1024 * 1024,
  // SSE streams and slow chunk uploads must not be cut off by the idle timer.
  idleTimeout: 0,
  tls: config.tls ? { cert: Bun.file(config.tls.cert), key: Bun.file(config.tls.key) } : undefined,
});

// With built-in HTTPS, local GPU workers use a loopback HTTP port that serves
// only the worker API (bearer-token authenticated), so they need no certificate.
const internal = config.tls
  ? Bun.serve({
      hostname: "127.0.0.1",
      port: config.internalPort,
      fetch: (req, srv) => {
        const path = new URL(req.url).pathname;
        if (!path.startsWith("/internal/") && path !== "/healthz") return new Response("Not found", { status: 404 });
        return app.fetch(req, { server: srv });
      },
      maxRequestBodySize: 64 * 1024 * 1024,
      idleTimeout: 0,
    })
  : null;

setInterval(reapStaleJobs, 30_000);
setInterval(purgeExpiredSessions, 60 * 60 * 1000);
kick();

const scheme = config.tls ? "https" : "http";
const url = `${scheme}://${config.host === "0.0.0.0" ? "localhost" : config.host}:${server.port}`;
console.log(`MeetingMinutes backend listening on ${url}${config.publicUrl ? ` (public URL ${config.publicUrl})` : ""}`);
if (internal) console.log(`Worker API on http://127.0.0.1:${internal.port} (loopback only)`);
const loopback = ["127.0.0.1", "localhost", "::1"].includes(config.host);
if (!config.tls && !loopback && !config.trustProxy) {
  console.warn("");
  console.warn(`  WARNING: serving plain HTTP on ${config.host}. Passwords would cross the network unencrypted,`);
  console.warn("  and browsers only allow recording on HTTPS pages. Set TLS_CERT_FILE / TLS_KEY_FILE");
  console.warn("  (scripts/make-cert.sh creates them) or put a TLS reverse proxy in front.");
  console.warn("");
}
console.log(`Data directory: ${config.dataDir}`);

const setupToken = ensureSetupToken();
if (setupToken) {
  console.log("");
  console.log("  No accounts exist yet. Open the web UI and create the administrator account");
  console.log(`  using this one-time setup token:  ${setupToken}`);
  console.log(`  (also stored in ${config.dataDir}/setup.token)`);
  console.log("");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop();
    internal?.stop();
    process.exit(0);
  });
}
