import { z } from "zod";
import { config } from "../config";
import { db, now } from "../db";
import { parseJson } from "../lib/util";
import { deleteSetting, readSetting, settingMeta, writeSetting } from "./settingsStore";
import { isLoopbackUrl, MODEL_NAME } from "./summarySettings";

/**
 * Where speech is recognised, as chosen by an administrator.
 *
 * - "local": Qwen3-ASR on the worker's GPU; the recording never leaves the server.
 * - "api": a hosted transcription API. Speaker diarization still runs on the
 *   worker, which sends each speech segment (at most MAX_SEGMENT_SEC long) to
 *   the API. OpenRouter comes first; any OpenAI-compatible server
 *   (`POST /audio/transcriptions`: OpenAI, Groq, a vLLM serving Qwen3-ASR) works too.
 *
 * The environment (.env) gives the defaults; saved settings take precedence
 * until they are reset. API keys are never part of these settings: each
 * worker reads its own from its environment, and reports only whether it has one.
 */

export const ASR_ENGINES = ["local", "api"] as const;
export const ASR_PROVIDERS = ["openrouter", "openai"] as const;
export type AsrEngine = (typeof ASR_ENGINES)[number];
export type AsrProvider = (typeof ASR_PROVIDERS)[number];

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Environment variables a worker reads the key from, in order, per provider (as the worker does). */
export const ASR_KEY_VARIABLES: Record<AsrProvider, string[]> = {
  openrouter: ["OPENROUTER_API_KEY", "ASR_API_KEY"],
  openai: ["ASR_API_KEY", "OPENAI_API_KEY"],
};

/** Empty means the provider's default address. API docs show the full endpoint, which people paste as is. */
const apiBaseUrl = z
  .string()
  .trim()
  .max(300)
  .transform((s) => s.replace(/\/+$/, "").replace(/\/(audio\/transcriptions|models)$/i, "").replace(/\/+$/, ""))
  .refine((s) => {
    if (s === "") return true;
    try {
      const u = new URL(s);
      return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && !u.search && !u.hash;
    } catch {
      return false;
    }
  }, "Enter the server address as https://host/v1 (no user name, password or query).");

export const transcriberSettingsSchema = z.object({
  engine: z.enum(ASR_ENGINES),
  api: z.object({
    provider: z.enum(ASR_PROVIDERS),
    /** OpenAI-compatible servers only; OpenRouter's address is fixed. */
    baseUrl: apiBaseUrl,
    model: z.string().trim().regex(MODEL_NAME, "Enter a model name such as qwen/qwen3-asr-1.7b."),
  }),
});

export type TranscriberSettings = z.infer<typeof transcriberSettingsSchema>;

const KEY = "transcriber";

export function defaultTranscriberSettings(): TranscriberSettings {
  const fallback: TranscriberSettings = {
    engine: config.asr.engine,
    api: { provider: config.asr.apiProvider, baseUrl: config.asr.apiBaseUrl, model: config.asr.apiModel },
  };
  // A malformed .env value must not stop transcription: fall back to the built-in model name and address.
  const parsed = transcriberSettingsSchema.safeParse(fallback);
  return parsed.success
    ? parsed.data
    : { engine: config.asr.engine, api: { provider: config.asr.apiProvider, baseUrl: "", model: "qwen/qwen3-asr-1.7b" } };
}

/** The settings in force: saved ones merged over the defaults field by field. */
export function transcriberSettings(): TranscriberSettings {
  const defaults = defaultTranscriberSettings();
  const value = readSetting(KEY);
  if (value === null) return defaults;
  const saved = parseJson<Partial<TranscriberSettings>>(value, {});
  const parsed = transcriberSettingsSchema.safeParse({
    engine: saved.engine ?? defaults.engine,
    api: { ...defaults.api, ...(saved.api ?? {}) },
  });
  return parsed.success ? parsed.data : defaults;
}

export function transcriberSettingsMeta() {
  return settingMeta(KEY);
}

export function saveTranscriberSettings(settings: TranscriberSettings, userId: string): TranscriberSettings {
  writeSetting(KEY, transcriberSettingsSchema.parse(settings), userId);
  return transcriberSettings();
}

export function resetTranscriberSettings(): TranscriberSettings {
  deleteSetting(KEY);
  return transcriberSettings();
}

/** The address requests go to. */
export function apiAddress(api: TranscriberSettings["api"]): string {
  if (api.provider === "openrouter") return OPENROUTER_BASE_URL;
  return api.baseUrl || OPENAI_BASE_URL;
}

/** What a worker is told with each transcription job (no secrets: the worker has its own key). */
export type JobAsrSettings = { engine: "local" } | { engine: "api"; provider: AsrProvider; model: string; baseUrl: string };

export function jobAsrSettings(s: TranscriberSettings = transcriberSettings()): JobAsrSettings {
  if (s.engine === "local") return { engine: "local" };
  return { engine: "api", provider: s.api.provider, model: s.api.model, baseUrl: apiAddress(s.api) };
}

/** What people uploading a recording are told about where it is transcribed. */
export function publicTranscriberInfo(s: TranscriberSettings = transcriberSettings()): {
  engine: AsrEngine;
  provider: AsrProvider | null;
  model: string | null;
  /** The recording stays on this machine: the local model, or an API server on this machine. */
  onServer: boolean;
  /** Host the speech is sent to (null when it stays on this machine). */
  host: string | null;
} {
  if (s.engine === "local") return { engine: "local", provider: null, model: null, onServer: true, host: null };
  const address = apiAddress(s.api);
  const onServer = isLoopbackUrl(address);
  return { engine: "api", provider: s.api.provider, model: s.api.model, onServer, host: onServer ? null : new URL(address).host };
}

/**
 * Which transcription APIs each online worker has a key for, as the workers
 * report it in their heartbeats. `keys` is null for a worker from before API
 * transcription, which cannot use one.
 */
export function workerApiKeys(): { id: string; name: string; keys: Record<AsrProvider, boolean> | null }[] {
  const rows = db
    .query<{ id: string; name: string; info: string }, { since: number }>(
      "SELECT id, name, info FROM workers WHERE last_seen_at > $since ORDER BY name",
    )
    .all({ since: now() - 60_000 });
  return rows.map((w) => {
    const reported = parseJson<{ asrApiKeys?: Partial<Record<AsrProvider, unknown>> }>(w.info, {}).asrApiKeys;
    return {
      id: w.id,
      name: w.name,
      keys: reported && typeof reported === "object" ? { openrouter: reported.openrouter === true, openai: reported.openai === true } : null,
    };
  });
}
