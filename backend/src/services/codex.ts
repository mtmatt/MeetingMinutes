import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config";

export interface CodexResult {
  text: string;
  usage: Record<string, number> | null;
  model: string | null;
}

export class CodexError extends Error {}

/**
 * Environment for the codex process: only what it needs to run and reach the
 * API. Server secrets (HF_TOKEN, WORKER_TOKEN, …) are not passed on, so even a
 * tool that slipped through could not read them from the environment.
 */
const CODEX_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
];

export function codexEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of CODEX_ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  // The test stand-in for codex is configured through FAKE_CODEX_* variables.
  if (config.isTest) for (const [k, v] of Object.entries(process.env)) if (k.startsWith("FAKE_CODEX_") && v !== undefined) env[k] = v;
  if (config.codex.home) env.CODEX_HOME = config.codex.home;
  env.NO_COLOR = "1";
  return env;
}

/**
 * Tools that could read files or run commands. Summaries only run when the
 * installed codex lists every one of them, so each is either disabled with
 * --disable or reported as removed. If a codex update renames or drops one,
 * summaries stop with an explanation instead of running with tools enabled.
 */
export const REQUIRED_DISABLED = ["shell_tool", "unified_exec", "view_image"];

export interface FeatureInfo {
  /** Feature name -> stage column ("stable", "removed", …). */
  stages: Map<string, string>;
  /** Why tool isolation cannot be guaranteed with this codex, or null. */
  isolationError: string | null;
}

let featureCache: Promise<FeatureInfo> | null = null;

/** For tests: forget the cached `codex features list`. */
export function resetCodexFeatureCache() {
  featureCache = null;
}

export function parseFeatures(out: string, disable: string[]): FeatureInfo {
  const stages = new Map<string, string>();
  for (const line of out.split("\n")) {
    const m = line.match(/^([a-z0-9_.]+)\s+(\S.*?)\s+(true|false)\s*$/);
    if (m) stages.set(m[1]!, m[2]!.trim());
  }
  const missing = REQUIRED_DISABLED.filter((f) => !stages.has(f));
  const notDisabled = REQUIRED_DISABLED.filter((f) => stages.has(f) && !stages.get(f)!.includes("removed") && !disable.includes(f));
  let isolationError: string | null = null;
  if (stages.size === 0) {
    isolationError = "Could not read `codex features list`, so Codex tools cannot be verified as disabled.";
  } else if (missing.length) {
    isolationError = `This Codex version does not list ${missing.join(", ")}; tool isolation cannot be verified. Update CODEX_DISABLE_FEATURES for the new feature names.`;
  } else if (notDisabled.length) {
    isolationError = `CODEX_DISABLE_FEATURES must include ${notDisabled.join(", ")}.`;
  }
  return { stages, isolationError };
}

/**
 * Feature flags of the installed codex binary. Passing an unknown flag to
 * --disable is a hard error, so only listed, non-removed flags are disabled.
 */
export function codexFeatures(): Promise<FeatureInfo> {
  featureCache ??= (async () => {
    try {
      const proc = Bun.spawn([config.codex.bin, "features", "list"], { env: codexEnv(), stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return parseFeatures(out, config.codex.disableFeatures);
    } catch {
      return parseFeatures("", config.codex.disableFeatures);
    }
  })();
  return featureCache;
}

/**
 * Codex JSON item types a summary may produce. Anything else (a command, a
 * file change, an MCP or web call, or a type this code does not know) means a
 * tool is in use: the run is stopped and its output discarded.
 */
const ALLOWED_ITEM_TYPES = new Set(["agent_message", "reasoning", "todo_list", "error"]);

/** Server credentials that must never appear in a summary. */
function serverSecrets(): string[] {
  const secrets = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim().length >= 16) secrets.add(v.trim());
  };
  add(config.workerToken);
  for (const k of ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"]) add(process.env[k]);
  // Codex's own login (ChatGPT tokens or API key).
  const authFile = join(config.codex.home ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
  try {
    if (existsSync(authFile)) {
      const walk = (v: unknown) => {
        if (typeof v === "string") add(v.length >= 24 ? v : null);
        else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
      };
      walk(JSON.parse(readFileSync(authFile, "utf8")));
    }
  } catch {
    /* unreadable: nothing to compare against */
  }
  return [...secrets];
}

export function containsSecret(text: string, secrets = serverSecrets()): boolean {
  return secrets.some((s) => text.includes(s));
}

export async function buildCodexArgs(workdir: string, outFile: string): Promise<string[]> {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--json",
    "--cd",
    workdir,
    "--output-last-message",
    outFile,
  ];
  if (!config.codex.useUserConfig) args.push("--ignore-user-config");
  const { stages } = await codexFeatures();
  for (const f of config.codex.disableFeatures) {
    const stage = stages.get(f);
    if (stage && !stage.includes("removed")) args.push("--disable", f);
  }
  args.push("-c", 'web_search="disabled"');
  if (config.codex.model) args.push("--model", config.codex.model);
  if (config.codex.reasoningEffort) args.push("-c", `model_reasoning_effort="${config.codex.reasoningEffort}"`);
  args.push("-");
  return args;
}

/**
 * Run a single non-interactive Codex turn with the prompt on stdin and return
 * the final agent message. Codex runs in an empty temp directory with a
 * read-only sandbox and tool features disabled, so it behaves like a plain
 * model call billed against the server's ChatGPT/Codex plan.
 */
export async function runCodex(prompt: string, opts: { signal?: AbortSignal; onEvent?: (e: any) => void } = {}): Promise<CodexResult> {
  const features = await codexFeatures();
  if (features.isolationError) throw new CodexError(`Summaries are paused: ${features.isolationError}`);
  const workdir = await mkdtemp(join(tmpdir(), "mm-codex-"));
  const outFile = join(workdir, "..", `${workdir.split("/").pop()}.out.md`);
  try {
    const args = await buildCodexArgs(workdir, outFile);
    const proc = Bun.spawn([config.codex.bin, ...args], {
      cwd: workdir,
      env: codexEnv(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeout = setTimeout(() => proc.kill("SIGTERM"), config.codex.timeoutSeconds * 1000);
    const onAbort = () => proc.kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // Cancellation may have arrived while we were still preparing arguments.
    if (opts.signal?.aborted) onAbort();

    proc.stdin.write(prompt);
    await proc.stdin.end();

    let usage: Record<string, number> | null = null;
    let model: string | null = config.codex.model ?? null;
    let lastError: string | null = null;
    let agentText: string | null = null;
    /** Set when codex started using a tool; the run is stopped at once. */
    let toolUse: string | null = null;

    const stdoutDone = (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of proc.stdout) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("{")) continue;
          let ev: any;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          opts.onEvent?.(ev);
          const itemType = ev.item?.type;
          if (typeof ev.type === "string" && ev.type.startsWith("item.") && itemType && !ALLOWED_ITEM_TYPES.has(itemType) && !toolUse) {
            // Stop before the tool's result can reach the model (and so the summary).
            toolUse = String(itemType);
            proc.kill("SIGKILL");
          }
          if (ev.type === "turn.completed" && ev.usage) usage = ev.usage;
          else if (ev.type === "turn.failed") lastError = ev.error?.message ?? "Codex turn failed";
          else if (ev.type === "error" && typeof ev.message === "string") lastError = ev.message;
          else if (ev.type === "item.completed" && ev.item?.type === "agent_message") agentText = ev.item.text ?? agentText;
          if (typeof ev.model === "string") model = ev.model;
        }
      }
    })();
    const stderrText = new Response(proc.stderr).text();

    const code = await proc.exited;
    await stdoutDone;
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onAbort);

    if (opts.signal?.aborted) throw new CodexError("Canceled.");
    if (toolUse) throw new CodexError(`Codex tried to use a tool (${toolUse}); the run was stopped and nothing was kept.`);
    let text = "";
    try {
      text = (await readFile(outFile, "utf8")).trim();
    } catch {
      text = (agentText ?? "").trim();
    }
    if (code !== 0 || !text) {
      const stderr = (await stderrText)
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("WARNING: proceeding"))
        .slice(-5)
        .join("\n");
      const reason = lastError || stderr || `codex exited with code ${code}`;
      if (proc.signalCode === "SIGTERM" && !opts.signal?.aborted) {
        throw new CodexError(`Codex timed out after ${config.codex.timeoutSeconds}s.`);
      }
      throw new CodexError(reason.slice(0, 2000));
    }
    if (containsSecret(text)) throw new CodexError("The output contained server credentials, so it was discarded.");
    return { text, usage, model };
  } finally {
    await rm(workdir, { recursive: true, force: true });
    await rm(outFile, { force: true });
  }
}

export interface CodexStatus {
  available: boolean;
  loggedIn: boolean;
  version: string | null;
  detail: string;
  /** Why summaries are paused for safety (tools cannot be verified as disabled), or null. */
  isolationError?: string | null;
}

/**
 * Turn `codex --version` and `codex login status` output into a status line.
 * Codex prints housekeeping warnings on the same streams (e.g. "WARNING: failed
 * to clean up stale arg0 temp dirs"); those are not part of the status.
 */
export function parseCodexStatus(versionOut: string, loginOut: string, loginExit: number): Omit<CodexStatus, "available"> {
  const meaningful = (text: string) =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^warning\b/i.test(l));
  const version = meaningful(versionOut).find((l) => /\d+\.\d+/.test(l)) ?? null;
  return { loggedIn: loginExit === 0, version, detail: meaningful(loginOut).join("\n") };
}

export async function codexStatus(): Promise<CodexStatus> {
  try {
    const v = Bun.spawn([config.codex.bin, "--version"], { env: codexEnv(), stdout: "pipe", stderr: "pipe" });
    const [vOut, vErr] = await Promise.all([new Response(v.stdout).text(), new Response(v.stderr).text()]);
    await v.exited;
    const s = Bun.spawn([config.codex.bin, "login", "status"], { env: codexEnv(), stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(s.stdout).text(), new Response(s.stderr).text()]);
    const code = await s.exited;
    const { isolationError } = await codexFeatures();
    return { available: true, ...parseCodexStatus(vOut + "\n" + vErr, out + "\n" + err, code), isolationError };
  } catch (e) {
    return { available: false, loggedIn: false, version: null, detail: String(e) };
  }
}
