import { wakeSweep } from "./services/workerWake";
import { config } from "./config";
import { createApp } from "./app";
import { ensureSetupToken } from "./auth/setup";
import { purgeExpiredSessions } from "./auth/service";
import { purgeUnverifiedAccounts } from "./auth/accounts";
import { purgeSecurityEvents } from "./services/security";
import { enqueueCompactions } from "./services/mediaCompaction";
import { sweepMediaRetention } from "./services/mediaRetention";
import { sweepTransfers } from "./services/mediaTransfer";
import { purgeAbandonedUploads, reapStaleJobs } from "./services/meetings";
import { billingSettings } from "./services/billingSettings";
import { kick, recoverSummaries } from "./services/summarizer";
import { seedBuiltinTemplates } from "./services/templates";
import { bindHelp, handoffHandler, redirectHandler } from "./redirect";

seedBuiltinTemplates();
recoverSummaries();

const app = createApp();

if ((config.redirectPorts.length || config.httpRedirectPort) && !config.publicUrl) {
  console.error("REDIRECT_PORTS and HTTP_REDIRECT_PORT send people to PUBLIC_URL: set PUBLIC_URL (e.g. https://minutes.example.com).");
  process.exit(1);
}
if (config.redirectPorts.length && !config.tls) {
  console.error("REDIRECT_PORTS are HTTPS ports with the site's certificate: set TLS_CERT_FILE and TLS_KEY_FILE (or use HTTP_REDIRECT_PORT for plain HTTP).");
  process.exit(1);
}

/** Bun.serve, or a clear message and exit when the port cannot be opened. */
function listen<T extends Parameters<typeof Bun.serve>[0]>(port: number, options: T) {
  try {
    return Bun.serve(options);
  } catch (e) {
    console.error(bindHelp(port, e));
    process.exit(1);
  }
}

const server = listen(config.port, {
  hostname: config.host,
  port: config.port,
  fetch: (req, srv) => app.fetch(req, { server: srv }),
  // Uploads arrive in chunks of UPLOAD_CHUNK_MB; leave headroom for headers.
  maxRequestBodySize: config.uploadChunkBytes + 1024 * 1024,
  // SSE streams and slow chunk uploads must not be cut off by the idle timer.
  idleTimeout: 0,
  tls: config.tls ? { cert: Bun.file(config.tls.cert), key: Bun.file(config.tls.key) } : undefined,
});

// The site's earlier HTTPS address(es) and plain HTTP: they send people to PUBLIC_URL.
const tlsFiles = config.tls ? { cert: Bun.file(config.tls.cert), key: Bun.file(config.tls.key) } : undefined;
const redirects = [
  ...config.redirectPorts.map((port) =>
    listen(port, {
      hostname: config.host,
      port,
      tls: tlsFiles,
      // Handoff: the whole site, whose pages move to PUBLIC_URL themselves (after any
      // recordings left in this browser are uploaded). Redirect: pages get a 308, and
      // the worker API stays here for workers enrolled with this address.
      fetch: config.redirectMode === "handoff" ? handoffHandler({ app }) : redirectHandler({ serveWorkerApi: true, app }),
      maxRequestBodySize: Math.max(64 * 1024 * 1024, config.uploadChunkBytes + 1024 * 1024),
      idleTimeout: 0,
    }),
  ),
  ...(config.httpRedirectPort
    ? [listen(config.httpRedirectPort, { hostname: config.host, port: config.httpRedirectPort, fetch: redirectHandler({ serveWorkerApi: false, app }) })]
    : []),
];

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
// Workers started on demand (Modal): called when queued work waits for them (also right after a job is queued).
setInterval(() => {
  wakeSweep().catch((e) => console.error("[workers] wake-up check failed:", e));
}, 15_000);
setInterval(purgeExpiredSessions, 60 * 60 * 1000);
// Security events older than 90 days, and blocks that ended.
setInterval(() => {
  try {
    purgeSecurityEvents();
  } catch (e) {
    console.error("[security] could not purge old events:", e);
  }
}, 60 * 60 * 1000);
// Sign-ups whose address was never confirmed.
setInterval(() => {
  const n = purgeUnverifiedAccounts();
  if (n) console.log(`[auth] removed ${n} sign-up(s) never confirmed`);
}, 60 * 60 * 1000);
// Compactions become due as days pass; the admin page also starts them when saved.
const sweepCompactions = () => {
  try {
    const n = enqueueCompactions();
    if (n) console.log(`[media] queued ${n} original(s) for compaction to audio only`);
  } catch (e) {
    console.error("[media] could not queue compactions:", e);
  }
};
setInterval(sweepCompactions, 10 * 60 * 1000);
// Recordings past their retention period (the site's, or the shorter one their owner chose): the transcript stays.
const sweepRetention = () => {
  sweepMediaRetention()
    .then((n) => n && console.log(`[media] deleted ${n} recording(s) past their retention period`))
    .catch((e) => console.error("[media] could not delete recordings past their retention period:", e));
};
setInterval(sweepRetention, 10 * 60 * 1000);
setTimeout(sweepRetention, 30_000);
// Uploads left unfinished for a day: their partial files.
setInterval(() => {
  purgeAbandonedUploads()
    .then((n) => n && console.log(`[media] removed ${n} upload(s) left unfinished for a day`))
    .catch((e) => console.error("[media] could not remove unfinished uploads:", e));
}, 60 * 60 * 1000);
// Transfer copies a remote worker never came back for.
setInterval(() => {
  try {
    sweepTransfers();
  } catch (e) {
    console.error("[media] could not remove old transfer copies:", e);
  }
}, 30 * 60 * 1000);
sweepCompactions();
kick();

const scheme = config.tls ? "https" : "http";
const url = `${scheme}://${config.host === "0.0.0.0" ? "localhost" : config.host}:${server.port}`;
console.log(`MeetingMinutes backend listening on ${url}${config.publicUrl ? ` (public URL ${config.publicUrl})` : ""}`);
if (config.allowedHosts.length) {
  console.log(`Answering only to: ${config.allowedHosts.join(", ")} (and localhost from this machine); other hosts get 421`);
}
if (internal) console.log(`Worker API on http://127.0.0.1:${internal.port} (loopback only)`);
for (const r of redirects) {
  const handoff = r.port !== config.httpRedirectPort && config.redirectMode === "handoff";
  console.log(`Port ${r.port}: ${handoff ? "serves the site; its pages move to" : "sends people to"} ${config.publicUrl}`);
}
const loopback = ["127.0.0.1", "localhost", "::1"].includes(config.host);
if (config.ecpay.mode === "stage" && config.ecpay.testShop && billingSettings().enabled) {
  console.warn("");
  console.warn("  WARNING: points are on sale through ECPay's public test shop, whose keys are published: anyone with an");
  console.warn("  account can forge a payment notification and add points. Set ECPAY_MODE=production with your shop.");
  console.warn("");
}
if (config.tls && config.trustProxy) {
  console.warn("");
  console.warn("  WARNING: TRUST_PROXY=true while serving HTTPS directly. Without a proxy in front, clients can");
  console.warn("  set X-Forwarded-For themselves and slip past per-IP sign-in limits. Set TRUST_PROXY=false.");
  console.warn("");
}
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
