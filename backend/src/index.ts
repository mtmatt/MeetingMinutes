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
});

setInterval(reapStaleJobs, 30_000);
setInterval(purgeExpiredSessions, 60 * 60 * 1000);
kick();

const url = `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${server.port}`;
console.log(`MeetingMinutes backend listening on ${url}${config.publicUrl ? ` (public URL ${config.publicUrl})` : ""}`);
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
    process.exit(0);
  });
}
