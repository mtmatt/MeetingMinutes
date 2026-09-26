import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

/** Repository root (backend/src/config.ts -> ../..). */
export const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/**
 * Load KEY=VALUE pairs from the repo-level .env without overriding variables
 * that are already present in the environment. Bun only auto-loads .env from
 * the current working directory, which is backend/ when started via scripts.
 */
function loadDotEnv(path: string) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

if (process.env.MM_SKIP_DOTENV !== "1") loadDotEnv(join(REPO_ROOT, ".env"));

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be an integer, got "${v}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function absPath(p: string): string {
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p);
}

function loadOrCreateSecret(path: string, envValue: string | undefined): string {
  if (envValue) return envValue;
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(dirname(path), { recursive: true });
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(path, secret + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return secret;
}

// Recordings, transcripts and the database are private: new files are readable
// by this OS user only, and the data directory is closed to other local users
// (GPU workstations are often shared).
process.umask(0o077);
const dataDir = absPath(str("DATA_DIR", "data"));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
try {
  chmodSync(dataDir, 0o700);
} catch {
  /* not ours to change (e.g. a mounted volume); left as configured */
}

const publicUrl = str("PUBLIC_URL", "").replace(/\/+$/, "");

/**
 * Built-in HTTPS for running without a reverse proxy. Both files or neither;
 * relative paths are resolved from the repository root.
 */
function tlsFiles(): { cert: string; key: string } | null {
  const cert = str("TLS_CERT_FILE", "");
  const key = str("TLS_KEY_FILE", "");
  if (!cert && !key) return null;
  if (!cert || !key) throw new Error("Set both TLS_CERT_FILE and TLS_KEY_FILE, or neither.");
  const files = { cert: absPath(cert), key: absPath(key) };
  for (const f of [files.cert, files.key]) {
    if (!existsSync(f)) throw new Error(`TLS file not found: ${f} (create one with scripts/make-cert.sh)`);
  }
  return files;
}
const tls = tlsFiles();

function resolveCodexBin(): string {
  const explicit = process.env.CODEX_BIN;
  if (explicit) return explicit;
  const candidates = [
    join(REPO_ROOT, "backend", "node_modules", ".bin", "codex"),
    join(REPO_ROOT, "node_modules", ".bin", "codex"),
  ];
  return candidates.find((c) => existsSync(c)) ?? "codex";
}

export const config = {
  host: str("HOST", "127.0.0.1"),
  port: int("PORT", 8787),
  dataDir,
  mediaDir: join(dataDir, "media"),
  dbPath: join(dataDir, "meetingminutes.sqlite"),
  /** Public base URL, e.g. https://minutes.example.com. Used for invite links and cookie security. */
  publicUrl,
  /** Serve HTTPS directly (no reverse proxy). */
  tls,
  /**
   * With built-in HTTPS, GPU workers on this machine connect over plain HTTP to
   * this loopback-only port, which serves nothing but the worker API.
   */
  internalPort: int("INTERNAL_PORT", 8788),
  /** Trust X-Forwarded-For / X-Forwarded-Proto (set when behind Caddy/nginx). */
  trustProxy: bool("TRUST_PROXY", false),
  /** Shown on the sign-in page to people without an account or who forgot their password. */
  adminContact: str("ADMIN_CONTACT", "").trim(),
  cookieSecure: bool("COOKIE_SECURE", tls !== null || publicUrl.startsWith("https://")),
  sessionTtlDays: int("SESSION_TTL_DAYS", 30),
  maxUploadBytes: int("MAX_UPLOAD_MB", 4096) * 1024 * 1024,
  uploadChunkBytes: int("UPLOAD_CHUNK_MB", 32) * 1024 * 1024,
  workerToken: loadOrCreateSecret(join(dataDir, "worker.token"), process.env.WORKER_TOKEN),
  jobStaleSeconds: int("JOB_STALE_SEC", 180),
  jobMaxAttempts: int("JOB_MAX_ATTEMPTS", 3),
  frontendDist: absPath(str("FRONTEND_DIST", "frontend/dist")),
  codex: {
    bin: resolveCodexBin(),
    home: process.env.CODEX_HOME || undefined,
    model: process.env.CODEX_MODEL || undefined,
    reasoningEffort: process.env.CODEX_REASONING_EFFORT || undefined,
    concurrency: Math.max(1, int("CODEX_CONCURRENCY", 1)),
    timeoutSeconds: int("CODEX_TIMEOUT_SEC", 1200),
    useUserConfig: bool("CODEX_USE_USER_CONFIG", false),
    /** Codex features to turn off so the summarizer is a pure text-in/text-out model call. */
    disableFeatures: str(
      "CODEX_DISABLE_FEATURES",
      [
        "shell_tool",
        "unified_exec",
        "apps",
        "browser_use",
        "browser_use_external",
        "computer_use",
        "image_generation",
        "multi_agent",
        "multi_agent_v2",
        "plugins",
        "remote_plugin",
        "memories",
        "view_image",
        "js_repl",
        "code_mode",
        "code_mode_host",
        "hooks",
        "skill_mcp_dependency_install",
        "tool_suggest",
        "workspace_dependencies",
        "in_app_browser",
        "realtime_conversation",
      ].join(","),
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  isTest: process.env.NODE_ENV === "test",
} as const;

export type Config = typeof config;
