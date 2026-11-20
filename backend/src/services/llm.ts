import { config } from "../config";
import type { LocalModelSettings } from "./summarySettings";

/**
 * Client for a model served on this machine or the local network, through
 * Ollama's own API or an OpenAI-compatible one (vLLM, llama.cpp, LM Studio,
 * SGLang). It is a plain text-in, text-out call: no tools are offered, so a
 * prompt injection in a transcript has nothing to act with.
 */

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatOptions {
  signal?: AbortSignal;
  /** Context window to allocate (Ollama); other servers use what they were started with. */
  numCtx: number;
  /** Longest answer, thinking included. */
  maxTokens: number;
  /** Ollama: seconds the model stays loaded after this call. */
  keepAliveSec: number;
  /** Send Ollama's `think` flag (only to models that support thinking). */
  sendThink: boolean;
}

export interface ChatResult {
  text: string;
  model: string;
  promptTokens: number | null;
  outputTokens: number | null;
  /** The answer stopped at maxTokens or the context window. */
  truncated: boolean;
}

export class LlmError extends Error {}

export interface ModelInfo {
  /** The model's own maximum context, when the server reports it. */
  contextLength: number | null;
  /** Whether the model can think (Ollama's capability list); null if unknown. */
  thinking: boolean | null;
}

const PROBE_TIMEOUT_MS = 8000;

function apiKeyHeaders(s: LocalModelSettings): Record<string, string> {
  return s.api === "openai" && config.llm.apiKey ? { Authorization: `Bearer ${config.llm.apiKey}` } : {};
}

/** OpenAI-style path, whether or not the configured address already ends in /v1. */
export function openaiUrl(baseUrl: string, path: string): string {
  return /\/v1$/.test(baseUrl) ? `${baseUrl}${path}` : `${baseUrl}/v1${path}`;
}

function unreachable(s: LocalModelSettings, e: unknown): LlmError {
  const how = s.api === "ollama" ? " Start it with `scripts/llm.sh serve`," : "";
  const code = (e as { code?: unknown } | null)?.code;
  const cause = typeof code === "string" ? ` (${code})` : e instanceof Error && e.message ? ` (${e.message})` : "";
  return new LlmError(
    `Cannot reach the local model server at ${s.baseUrl}${cause}.${how} or choose another server (or Codex) in Admin → Summary model.`,
  );
}

async function errorText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  try {
    const j = JSON.parse(raw);
    const m = typeof j.error === "string" ? j.error : (j.error?.message ?? j.message ?? j.detail);
    if (typeof m === "string" && m) return m.slice(0, 500);
  } catch {
    /* not JSON */
  }
  return raw.trim().slice(0, 500) || `HTTP ${res.status}`;
}

async function post(s: LocalModelSettings, url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream, application/x-ndjson", ...apiKeyHeaders(s) },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw new LlmError("Canceled.");
    throw unreachable(s, e);
  }
}

async function getJson<T>(s: LocalModelSettings, url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...apiKeyHeaders(s) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (e) {
    throw unreachable(s, e);
  }
  if (!res.ok) throw new LlmError(await errorText(res));
  return (await res.json()) as T;
}

/** Lines of a streamed response body (NDJSON or server-sent events). */
async function* lines(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield line;
    }
  }
  buf += decoder.decode();
  if (buf.trim()) yield buf.trim();
}

function modelMissing(s: LocalModelSettings, detail: string): LlmError {
  const fix =
    s.api === "ollama"
      ? `Download it in Admin → Summary model, or run \`scripts/llm.sh pull ${s.model}\` on the server.`
      : "Check the model name in Admin → Summary model against the models the server lists.";
  const why = detail.trim().replace(/[.:]?$/, ".");
  return new LlmError(`The model "${s.model}" is not available on ${s.baseUrl}: ${why} ${fix}`);
}

async function chatOllama(s: LocalModelSettings, messages: ChatMessage[], o: ChatOptions): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: s.model,
    messages,
    stream: true,
    keep_alive: o.keepAliveSec,
    // Sampling is left to the model's own defaults (its Modelfile), which the
    // publisher tuned; only the window and the answer length are ours.
    options: { num_ctx: o.numCtx, num_predict: o.maxTokens },
  };
  if (o.sendThink) body.think = s.think;
  const res = await post(s, `${s.baseUrl}/api/chat`, body, o.signal);
  if (res.status === 404) throw modelMissing(s, await errorText(res));
  if (!res.ok) throw new LlmError(`The local model server answered: ${await errorText(res)}`);

  let text = "";
  let model = s.model;
  let promptTokens: number | null = null;
  let outputTokens: number | null = null;
  let doneReason: string | null = null;
  try {
    for await (const line of lines(res)) {
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof ev.error === "string") throw new LlmError(`The local model failed: ${ev.error.slice(0, 500)}`);
      if (typeof ev.message?.content === "string") text += ev.message.content;
      if (typeof ev.model === "string") model = ev.model;
      if (ev.done) {
        doneReason = ev.done_reason ?? null;
        promptTokens = typeof ev.prompt_eval_count === "number" ? ev.prompt_eval_count : null;
        outputTokens = typeof ev.eval_count === "number" ? ev.eval_count : null;
      }
    }
  } catch (e) {
    if (o.signal?.aborted) throw new LlmError("Canceled.");
    throw e instanceof LlmError ? e : new LlmError(`The connection to the local model server was lost: ${(e as Error).message}`);
  }
  return { text, model, promptTokens, outputTokens, truncated: doneReason === "length" };
}

async function chatOpenAI(s: LocalModelSettings, messages: ChatMessage[], o: ChatOptions): Promise<ChatResult> {
  const body = {
    model: s.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: o.maxTokens,
    // vLLM, SGLang and llama.cpp pass this to the chat template: Qwen3 and
    // other hybrid models think only when asked. Other servers ignore it.
    chat_template_kwargs: { enable_thinking: s.think },
  };
  const res = await post(s, openaiUrl(s.baseUrl, "/chat/completions"), body, o.signal);
  if (res.status === 404) throw modelMissing(s, await errorText(res));
  if (!res.ok) throw new LlmError(`The local model server answered: ${await errorText(res)}`);

  let text = "";
  let model = s.model;
  let promptTokens: number | null = null;
  let outputTokens: number | null = null;
  let finish: string | null = null;
  try {
    for await (const line of lines(res)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") break;
      let ev: any;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev.error) throw new LlmError(`The local model failed: ${String(ev.error.message ?? ev.error).slice(0, 500)}`);
      const choice = ev.choices?.[0];
      // Reasoning arrives separately (delta.reasoning_content) and is not part of the summary.
      if (typeof choice?.delta?.content === "string") text += choice.delta.content;
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (typeof ev.model === "string") model = ev.model;
      if (ev.usage) {
        promptTokens = ev.usage.prompt_tokens ?? promptTokens;
        outputTokens = ev.usage.completion_tokens ?? outputTokens;
      }
    }
  } catch (e) {
    if (o.signal?.aborted) throw new LlmError("Canceled.");
    throw e instanceof LlmError ? e : new LlmError(`The connection to the local model server was lost: ${(e as Error).message}`);
  }
  return { text, model, promptTokens, outputTokens, truncated: finish === "length" };
}

export function chat(s: LocalModelSettings, messages: ChatMessage[], o: ChatOptions): Promise<ChatResult> {
  return s.api === "ollama" ? chatOllama(s, messages, o) : chatOpenAI(s, messages, o);
}

/** Context length and capabilities of the configured model, as far as the server tells. */
export async function modelInfo(s: LocalModelSettings): Promise<ModelInfo> {
  if (s.api === "ollama") {
    let show: { capabilities?: string[]; model_info?: Record<string, unknown> };
    try {
      show = await getJson(s, `${s.baseUrl}/api/show`, { method: "POST", body: { model: s.model } });
    } catch (e) {
      if (e instanceof LlmError && /not found/i.test(e.message)) throw modelMissing(s, e.message);
      throw e;
    }
    const ctxKey = Object.keys(show.model_info ?? {}).find((k) => k.endsWith(".context_length"));
    const ctx = ctxKey ? Number(show.model_info![ctxKey]) : NaN;
    return {
      contextLength: Number.isFinite(ctx) && ctx > 0 ? ctx : null,
      thinking: Array.isArray(show.capabilities) ? show.capabilities.includes("thinking") : null,
    };
  }
  const list = await getJson<{ data?: { id: string; max_model_len?: number }[] }>(s, openaiUrl(s.baseUrl, "/models"));
  const entry = list.data?.find((m) => m.id === s.model);
  if (list.data?.length && !entry) throw modelMissing(s, `the server offers ${list.data.map((m) => m.id).slice(0, 8).join(", ")}.`);
  return { contextLength: typeof entry?.max_model_len === "number" ? entry.max_model_len : null, thinking: null };
}

// ---------------------------------------------------------------- status

export interface LocalModelStatus {
  reachable: boolean;
  /** Server software and version, e.g. "Ollama 0.13.0". */
  server: string | null;
  /** Models the server can run, by name. */
  models: { name: string; size: number | null; details: string | null }[];
  /** The configured model is among them. */
  installed: boolean;
  /** Ollama: the model is in memory right now, and how much of it is on the GPU. */
  loaded: { sizeBytes: number; vramBytes: number } | null;
  contextLength: number | null;
  thinking: boolean | null;
  error: string | null;
}

/** Probe a model server, for the admin page. Never throws. */
export async function localModelStatus(s: LocalModelSettings): Promise<LocalModelStatus> {
  const status: LocalModelStatus = {
    reachable: false,
    server: null,
    models: [],
    installed: false,
    loaded: null,
    contextLength: null,
    thinking: null,
    error: null,
  };
  try {
    if (s.api === "ollama") {
      const [version, tags] = await Promise.all([
        getJson<{ version?: string }>(s, `${s.baseUrl}/api/version`),
        getJson<{ models?: { name: string; size?: number; details?: { parameter_size?: string; quantization_level?: string } }[] }>(
          s,
          `${s.baseUrl}/api/tags`,
        ),
      ]);
      status.reachable = true;
      status.server = `Ollama ${version.version ?? ""}`.trim();
      status.models = (tags.models ?? []).map((m) => ({
        name: m.name,
        size: m.size ?? null,
        details: [m.details?.parameter_size, m.details?.quantization_level].filter(Boolean).join(" · ") || null,
      }));
      // "qwen3" means "qwen3:latest".
      const want = s.model.includes(":") ? s.model : `${s.model}:latest`;
      status.installed = status.models.some((m) => m.name === s.model || m.name === want);
      if (status.installed) {
        const [info, ps] = await Promise.all([
          modelInfo(s).catch(() => null),
          getJson<{ models?: { name: string; size?: number; size_vram?: number }[] }>(s, `${s.baseUrl}/api/ps`).catch(() => null),
        ]);
        status.contextLength = info?.contextLength ?? null;
        status.thinking = info?.thinking ?? null;
        const running = ps?.models?.find((m) => m.name === s.model || m.name === want);
        if (running) status.loaded = { sizeBytes: running.size ?? 0, vramBytes: running.size_vram ?? 0 };
      }
    } else {
      const list = await getJson<{ data?: { id: string; owned_by?: string; max_model_len?: number }[] }>(s, openaiUrl(s.baseUrl, "/models"));
      status.reachable = true;
      status.server = "OpenAI-compatible";
      status.models = (list.data ?? []).map((m) => ({ name: m.id, size: null, details: m.max_model_len ? `${m.max_model_len.toLocaleString("en-US")} tokens` : null }));
      const entry = list.data?.find((m) => m.id === s.model);
      status.installed = Boolean(entry);
      status.contextLength = entry?.max_model_len ?? null;
    }
  } catch (e) {
    status.error = e instanceof Error ? e.message : String(e);
  }
  return status;
}

// ------------------------------------------------------------ model pull

export interface PullState {
  model: string;
  baseUrl: string;
  status: string;
  completed: number | null;
  total: number | null;
  done: boolean;
  error: string | null;
  startedAt: number;
}

let pull: PullState | null = null;

export function pullState(): PullState | null {
  return pull;
}

/** Download a model into Ollama in the background; progress is read with pullState(). */
export function startPull(s: LocalModelSettings): PullState {
  if (s.api !== "ollama") throw new LlmError("Only an Ollama server can download models from here.");
  if (pull && !pull.done) return pull;
  const state: PullState = { model: s.model, baseUrl: s.baseUrl, status: "starting", completed: null, total: null, done: false, error: null, startedAt: Date.now() };
  pull = state;
  void (async () => {
    try {
      const res = await post(s, `${s.baseUrl}/api/pull`, { model: s.model, stream: true });
      if (!res.ok) throw new LlmError(await errorText(res));
      for await (const line of lines(res)) {
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof ev.error === "string") throw new LlmError(ev.error);
        if (typeof ev.status === "string") state.status = ev.status;
        if (typeof ev.total === "number") state.total = ev.total;
        if (typeof ev.completed === "number") state.completed = ev.completed;
      }
      if (state.status !== "success") throw new LlmError(`The download stopped (${state.status}).`);
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
    } finally {
      state.done = true;
    }
  })();
  return state;
}
