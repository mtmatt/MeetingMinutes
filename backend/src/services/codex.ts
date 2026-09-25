import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config";

export interface CodexResult {
  text: string;
  usage: Record<string, number> | null;
  model: string | null;
}

export class CodexError extends Error {}

function codexEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  if (config.codex.home) env.CODEX_HOME = config.codex.home;
  env.NO_COLOR = "1";
  return env;
}

let featureCache: Promise<Set<string>> | null = null;

/**
 * Feature flags known to the installed codex binary. Passing an unknown flag
 * to --disable is a hard error, so we only disable flags that exist.
 */
export function knownFeatures(): Promise<Set<string>> {
  featureCache ??= (async () => {
    try {
      const proc = Bun.spawn([config.codex.bin, "features", "list"], {
        env: codexEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const names = new Set<string>();
      for (const line of out.split("\n")) {
        const m = line.match(/^([a-z0-9_.]+)\s+(\S.*?)\s+(true|false)\s*$/);
        if (m && !m[2]!.includes("removed")) names.add(m[1]!);
      }
      return names;
    } catch {
      return new Set<string>();
    }
  })();
  return featureCache;
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
  const known = await knownFeatures();
  for (const f of config.codex.disableFeatures) if (known.has(f)) args.push("--disable", f);
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
}

export async function codexStatus(): Promise<CodexStatus> {
  try {
    const v = Bun.spawn([config.codex.bin, "--version"], { env: codexEnv(), stdout: "pipe", stderr: "pipe" });
    const version = (await new Response(v.stdout).text()).trim() || null;
    await v.exited;
    const s = Bun.spawn([config.codex.bin, "login", "status"], { env: codexEnv(), stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(s.stdout).text(), new Response(s.stderr).text()]);
    const code = await s.exited;
    const detail = (out + "\n" + err)
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("WARNING: proceeding"))
      .join("\n")
      .trim();
    return { available: true, loggedIn: code === 0, version, detail };
  } catch (e) {
    return { available: false, loggedIn: false, version: null, detail: String(e) };
  }
}
