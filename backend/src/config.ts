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

function num(name: string, fallback: number, min: number, max: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Environment variable ${name} must be a number from ${min} to ${max}, got "${v}"`);
  return n;
}

function oneOf<const T extends readonly string[]>(name: string, allowed: T, fallback: T[number]): T[number] {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  if (!allowed.includes(v)) throw new Error(`Environment variable ${name} must be one of ${allowed.join(", ")}, got "${v}"`);
  return v;
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

/**
 * Host names the site answers to. A request naming any other host (the bare IP
 * address, a scanner's guess) is refused, so the site is only reachable by its
 * name. ALLOWED_HOSTS lists them; otherwise it is PUBLIC_URL's host name, and
 * with neither every host is accepted.
 */
function allowedHosts(): string[] {
  const raw = str("ALLOWED_HOSTS", "").trim();
  const names = raw ? raw.split(/[\s,]+/).filter(Boolean) : publicUrl ? [publicUrl] : [];
  return names.map((n) => {
    let host: string;
    try {
      host = new URL(n.includes("://") ? n : `http://${n}`).hostname;
    } catch {
      throw new Error(`ALLOWED_HOSTS entries must be host names such as minutes.example.com, got "${n}"`);
    }
    return normalizeHost(host);
  });
}

/** Lower case, no IPv6 brackets, no trailing dot: "Minutes.Example.com." and "minutes.example.com" are one host. */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/**
 * OAuth client ID for exporting summaries straight into Google Docs: a "Web
 * application" client from Google Cloud whose authorised JavaScript origin is
 * this site. Only the public ID is needed; Google gives the access token to the
 * browser, so the server never holds a client secret or anyone's Google token.
 */
function googleClientId(): string {
  const id = str("GOOGLE_CLIENT_ID", "").trim();
  if (id && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) {
    throw new Error(`GOOGLE_CLIENT_ID must be an OAuth client ID ending in .apps.googleusercontent.com, got "${id}"`);
  }
  return id;
}

/**
 * SUMMARY_PROVIDER: "local" (a model server set up on the admin page) or "api"
 * (a hosted provider). "codex" was removed; it becomes "api" when a provider
 * key is set, else "local".
 */
function summaryProvider(): "local" | "api" {
  const v = str("SUMMARY_PROVIDER", "local").trim().toLowerCase();
  if (v === "local" || v === "api") return v;
  const hasKey = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"].some((k) => process.env[k]?.trim());
  if (v === "codex") {
    console.warn(`SUMMARY_PROVIDER=codex is no longer supported (Codex was removed); using ${hasKey ? "a hosted API" : "the local model"}. Set SUMMARY_PROVIDER=api or local.`);
    return hasKey ? "api" : "local";
  }
  throw new Error(`SUMMARY_PROVIDER must be "local" or "api", got "${v}"`);
}

/** "8443, 9443" → [8443, 9443]. */
function ports(name: string): number[] {
  const raw = str(name, "").trim();
  if (!raw) return [];
  return raw.split(/[\s,]+/).filter(Boolean).map((p) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must list port numbers, got "${p}"`);
    return n;
  });
}

export interface SmtpServer {
  host: string;
  port: number;
  /** TLS from the start (port 465); otherwise STARTTLS, which is required. */
  secure: boolean;
  user: string;
  pass: string;
}

/**
 * Sending email (address verification for people who sign up, password resets,
 * payment receipts, security alerts), through a mail server given either
 * - piece by piece: SMTP_HOST, SMTP_PORT (587, or 465 for TLS from the start),
 *   SMTP_USER, SMTP_PASS (with Gmail, an app password); or
 * - as one address: SMTP_URL, e.g. smtps://user:app-password@smtp.gmail.com:465.
 * The sender is MAIL_FROM (or SMTP_FROM), e.g. "Meeting Minutes <minutes@example.com>".
 * MAIL_TRANSPORT=log writes messages to the server log instead (trying it out).
 */
function mailSettings() {
  const transport = oneOf("MAIL_TRANSPORT", ["smtp", "log"] as const, "smtp");
  const from = (str("MAIL_FROM", "") || str("SMTP_FROM", "")).trim();
  let server: SmtpServer | null = null;
  const smtpUrl = str("SMTP_URL", "").trim();
  const host = str("SMTP_HOST", "").trim();
  if (smtpUrl && host) throw new Error("Set either SMTP_URL or SMTP_HOST (with SMTP_PORT, SMTP_USER, SMTP_PASS), not both.");
  if (smtpUrl) {
    if (!/^smtps?:\/\//.test(smtpUrl)) throw new Error("SMTP_URL must start with smtp:// or smtps://");
    let u: URL;
    try {
      u = new URL(smtpUrl);
    } catch {
      throw new Error("SMTP_URL is not a valid address (write @ in the user name or password as %40).");
    }
    const secure = u.protocol === "smtps:";
    server = {
      host: u.hostname,
      port: u.port ? Number(u.port) : secure ? 465 : 587,
      secure,
      user: decodeURIComponent(u.username),
      pass: decodeURIComponent(u.password),
    };
  } else if (host) {
    const port = int("SMTP_PORT", 587);
    if (port < 1 || port > 65535) throw new Error(`SMTP_PORT must be a port number, got ${port}`);
    server = {
      host,
      port,
      secure: bool("SMTP_SECURE", port === 465),
      user: str("SMTP_USER", "").trim(),
      // App passwords are often copied with their spaces ("abcd efgh ijkl mnop"); Gmail accepts them either way.
      pass: str("SMTP_PASS", ""),
    };
    if (!!server.user !== !!server.pass) throw new Error("Set SMTP_USER and SMTP_PASS together (or neither, for a server that needs no login).");
  }
  if (transport === "smtp" && server && !from) throw new Error("Set MAIL_FROM (or SMTP_FROM), the sender address, together with the mail server.");
  return { transport, server, from: from || "Meeting Minutes <minutes@localhost>" };
}

/**
 * ECPay (綠界) for buying minutes. ECPAY_MODE "stage" uses ECPay's test system
 * (no real money; its public test shop unless ECPAY_MERCHANT_ID and keys are
 * set); "production" takes real payments and needs all three of the shop's
 * values from the ECPay merchant back office (系統開發管理 → 系統介接設定).
 */
function ecpaySettings() {
  const mode = oneOf("ECPAY_MODE", ["stage", "production"] as const, "stage");
  const merchantId = str("ECPAY_MERCHANT_ID", "").trim();
  const hashKey = str("ECPAY_HASH_KEY", "").trim();
  const hashIv = str("ECPAY_HASH_IV", "").trim();
  const given = [merchantId, hashKey, hashIv].filter(Boolean).length;
  if (given && given < 3) throw new Error("Set ECPAY_MERCHANT_ID, ECPAY_HASH_KEY and ECPAY_HASH_IV together.");
  if (merchantId && !/^\d{7,10}$/.test(merchantId)) throw new Error(`ECPAY_MERCHANT_ID must be the shop's 7-10 digit number, got "${merchantId}"`);
  if (mode === "production" && !given) throw new Error("ECPAY_MODE=production needs ECPAY_MERCHANT_ID, ECPAY_HASH_KEY and ECPAY_HASH_IV.");
  // ECPay's published test shop: payments there are simulated.
  const test = { merchantId: "3002607", hashKey: "pwFHCqoQZGmho4w6", hashIv: "EkRm7iFT261dpevs" };
  return { mode, ...(given ? { merchantId, hashKey, hashIv } : test), testShop: !given };
}

function retentionDays(raw: string): 0 | 7 | 30 {
  const v = raw.trim();
  if (v === "" || v === "0") return 0;
  if (v === "7" || v === "30") return Number(v) as 7 | 30;
  throw new Error(`MEDIA_RETENTION_DAYS must be 0 (keep recordings), 7 or 30, got "${raw}"`);
}

export const config = {
  host: str("HOST", "127.0.0.1"),
  port: int("PORT", 8787),
  /**
   * Extra HTTPS ports (same certificate) that send browsers to PUBLIC_URL, for
   * an address the site used to have: REDIRECT_PORTS=8443 after moving to 443.
   * The worker API is still answered there, so enrolled workers keep working.
   */
  redirectPorts: ports("REDIRECT_PORTS"),
  /**
   * What REDIRECT_PORTS do. "handoff" (while moving): they serve the site, and a
   * page opened there moves to PUBLIC_URL by itself, unless the browser still
   * holds recordings not uploaded, which are kept per address and readable only
   * there; it asks for those first. "redirect": a plain 308 for every page.
   */
  redirectMode: oneOf("REDIRECT_PORT_MODE", ["handoff", "redirect"] as const, "handoff"),
  /** A plain-HTTP port (normally 80) that sends everything to PUBLIC_URL. */
  httpRedirectPort: str("HTTP_REDIRECT_PORT", "").trim() ? int("HTTP_REDIRECT_PORT", 80) : null,
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
  /**
   * Addresses of the proxy, when it is on another machine with a public address.
   * Forwarded headers are believed only from the proxy: from this machine, a
   * private network, or one of these.
   */
  trustedProxies: str("TRUSTED_PROXIES", "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  /** Shown on the sign-in page to people without an account or who forgot their password. */
  adminContact: str("ADMIN_CONTACT", "").trim(),
  /** Google OAuth client ID; empty turns direct export to Google Docs off (summaries can still be copied into one). */
  googleClientId: googleClientId(),
  /** Host names requests must name; empty accepts any. See allowedHosts(). */
  allowedHosts: allowedHosts(),
  cookieSecure: bool("COOKIE_SECURE", tls !== null || publicUrl.startsWith("https://")),
  sessionTtlDays: int("SESSION_TTL_DAYS", 30),
  maxUploadBytes: int("MAX_UPLOAD_MB", 4096) * 1024 * 1024,
  uploadChunkBytes: int("UPLOAD_CHUNK_MB", 32) * 1024 * 1024,
  workerToken: loadOrCreateSecret(join(dataDir, "worker.token"), process.env.WORKER_TOKEN),
  jobStaleSeconds: int("JOB_STALE_SEC", 180),
  jobMaxAttempts: int("JOB_MAX_ATTEMPTS", 3),
  /**
   * Speaker recognition by voice (cosine similarity of voice fingerprints, -1..1).
   * At or above `match`, a speaker is named after the voice profile; from
   * `suggest` up to `match`, the profile is only offered to the user.
   */
  voice: {
    match: num("VOICE_MATCH_THRESHOLD", 0.6, -1, 1),
    suggest: num("VOICE_SUGGEST_THRESHOLD", 0.45, -1, 1),
    /** Seconds of speech a speaker needs for a usable fingerprint. */
    minSpeechSec: num("VOICE_MIN_SPEECH_SEC", 5, 0, 600),
  },
  frontendDist: absPath(str("FRONTEND_DIST", "frontend/dist")),
  /**
   * Which model writes summaries. These are the defaults; an administrator can
   * change all of them on the admin page (Admin → Summary model), and what is
   * saved there takes precedence until it is reset.
   */
  summary: {
    provider: summaryProvider(),
    /** A hosted model: the provider (its key from ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY or GEMINI_API_KEY) and model. */
    apiProvider: oneOf("SUMMARY_API_PROVIDER", ["anthropic", "openai", "openrouter", "gemini"] as const, "anthropic"),
    /** Empty: the provider's suggested model. */
    apiModel: str("SUMMARY_API_MODEL", "").trim(),
    /** Context to use when the provider does not report the model's (Anthropic does). */
    apiContextTokens: Math.round(num("SUMMARY_API_CONTEXT_TOKENS", 128_000, 8192, 2_000_000)),
    /** Summaries written at once with a hosted model. */
    apiConcurrency: Math.max(1, int("SUMMARY_API_CONCURRENCY", 2)),
  },
  /**
   * Where speech is recognised. These are the defaults; an administrator can
   * change them on the admin page (Admin → Transcription). "local" runs
   * Qwen3-ASR on the worker's GPU; "api" sends each speech segment to a hosted
   * transcription API. The API key is the worker's (OPENROUTER_API_KEY or
   * ASR_API_KEY in its environment); the backend never handles it.
   */
  /**
   * Compacting originals: once a meeting has been transcribed and
   * `compactAfterDays` have passed, a worker replaces its original with a mono
   * Opus copy at `compactKbps` (32 kbit/s is about 14 MB per hour), dropping
   * any video. Defaults: an administrator can change the first two in
   * Admin → System, and what is saved there wins until it is reset.
   */
  media: {
    compact: bool("MEDIA_COMPACT", false),
    compactAfterDays: Math.round(num("MEDIA_COMPACT_AFTER_DAYS", 7, 0, 3650)),
    compactKbps: Math.round(num("MEDIA_COMPACT_KBPS", 32, 12, 256)),
    /**
     * Keep a video's picture. Off by default: once a video has been
     * transcribed, it is replaced by the audio-only copy at once, whatever
     * the compacting policy says (that policy is for audio).
     */
    keepVideo: bool("MEDIA_KEEP_VIDEO", false),
    /**
     * Recordings are deleted this many days after their transcription
     * (0: kept; 7 or 30), keeping the transcript and summaries. The site's
     * maximum: each person may choose a shorter period in Settings.
     */
    retentionDays: retentionDays(str("MEDIA_RETENTION_DAYS", "0")),
  },
  asr: {
    engine: oneOf("ASR_ENGINE", ["local", "api"] as const, "local"),
    apiProvider: oneOf("ASR_API_PROVIDER", ["openrouter", "openai"] as const, "openrouter"),
    /** OpenAI-compatible servers only; OpenRouter's address is fixed. Empty: api.openai.com. */
    apiBaseUrl: str("ASR_API_BASE_URL", "").replace(/\/+$/, ""),
    apiModel: str("ASR_API_MODEL", "qwen/qwen3-asr-1.7b"),
    /**
     * Who separates speakers: "local" (pyannote on the worker's GPU), "cpu"
     * (sherpa-onnx on the worker's CPU, free, nothing uploaded) or "pyannoteai"
     * (the pyannote team's hosted service; the worker's PYANNOTEAI_API_KEY).
     * With "cpu" or "pyannoteai" and the transcription API, a worker needs no
     * GPU, CUDA or torch.
     */
    diarization: oneOf("DIARIZATION_ENGINE", ["local", "cpu", "pyannoteai"] as const, "local"),
  },
  /**
   * A model served on this machine (or the local network): Ollama's own API, or
   * any OpenAI-compatible server (vLLM, llama.cpp, LM Studio, SGLang).
   */
  llm: {
    api: oneOf("LLM_API", ["ollama", "openai"] as const, "ollama"),
    baseUrl: str("LLM_BASE_URL", "http://127.0.0.1:11434").replace(/\/+$/, ""),
    // Qwen3.8 27B at 3-bit (Q3_K_M, about 13 GB). Only 16 of its 64 layers keep a
    // KV cache (the rest are Gated DeltaNet), so a 64K window adds about 2 GB
    // (8-bit cache) and the whole fits one 24 GB GPU.
    model: str("LLM_MODEL", "batiai/qwen3.8-27b:q3"),
    /** Bearer token for an OpenAI-compatible server that requires one. Never shown in the UI or sent to the browser. */
    apiKey: str("LLM_API_KEY", ""),
    /** Largest context window (prompt + answer) a summary may use; longer transcripts are summarised in parts. */
    contextTokens: Math.round(num("LLM_CONTEXT_TOKENS", 65536, 4096, 1_048_576)),
    /** Let reasoning models (Qwen3) think before answering: better on hard material, several times slower. */
    think: bool("LLM_THINK", false),
    /** Ollama only: seconds the model stays in GPU memory after a summary (0 frees it at once, for transcription). */
    keepAliveSec: Math.round(num("LLM_KEEP_ALIVE_SEC", 0, 0, 86_400)),
    concurrency: Math.max(1, int("LLM_CONCURRENCY", 1)),
    /** Longest a whole summary may take, including every part of a long transcript. */
    timeoutSeconds: int("LLM_TIMEOUT_SEC", 3600),
  },
  mail: mailSettings(),
  ecpay: ecpaySettings(),
  isTest: process.env.NODE_ENV === "test",
} as const;

export type Config = typeof config;
