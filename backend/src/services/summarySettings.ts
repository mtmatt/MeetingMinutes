import { z } from "zod";
import { config } from "../config";
import { db, now } from "../db";
import { parseJson } from "../lib/util";
import type { SummaryProvider } from "../types";

/**
 * Which model writes summaries, as chosen by an administrator.
 *
 * The environment (.env) gives the defaults. Once an administrator saves the
 * settings on the admin page they are kept in the database and take
 * precedence, until they are reset. Secrets (LLM_API_KEY) are never part of
 * these settings: they stay in the environment and never reach the browser.
 */

/** Model names as Ollama, vLLM and Codex spell them: "batiai/qwen3.8-27b:q3", "Qwen/Qwen3-14B-AWQ", "gpt-5.1-codex". */
const MODEL_NAME = /^[\w][\w.:/@+-]{0,199}$/;
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

const baseUrl = z
  .string()
  .trim()
  .max(300)
  .transform((s) => s.replace(/\/+$/, ""))
  .refine((s) => {
    try {
      const u = new URL(s);
      return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && !u.search && !u.hash;
    } catch {
      return false;
    }
  }, "Enter the server address as http://host:port (no user name, password or query).");

export const localSettingsSchema = z.object({
  api: z.enum(["ollama", "openai"]),
  baseUrl,
  model: z.string().trim().regex(MODEL_NAME, "Enter a model name such as batiai/qwen3.8-27b:q3."),
  contextTokens: z.number().int().min(4096).max(1_048_576),
  think: z.boolean(),
  keepAliveSec: z.number().int().min(0).max(86_400),
});

export const summarySettingsSchema = z.object({
  provider: z.enum(["local", "codex"]),
  local: localSettingsSchema,
  codex: z.object({
    model: z.string().trim().regex(MODEL_NAME, "Enter a Codex model name, or leave it empty.").nullable(),
    reasoningEffort: z.enum(REASONING_EFFORTS).nullable(),
  }),
});

export type LocalModelSettings = z.infer<typeof localSettingsSchema>;
export type SummarySettings = z.infer<typeof summarySettingsSchema>;

const KEY = "summarizer";

/** The settings .env describes; used until an administrator saves others. */
export function defaultSummarySettings(): SummarySettings {
  const effort = config.codex.reasoningEffort;
  return {
    provider: config.summary.provider,
    local: {
      api: config.llm.api,
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      contextTokens: config.llm.contextTokens,
      think: config.llm.think,
      keepAliveSec: config.llm.keepAliveSec,
    },
    codex: {
      model: config.codex.model ?? null,
      reasoningEffort: effort && (REASONING_EFFORTS as readonly string[]).includes(effort) ? (effort as SummarySettings["codex"]["reasoningEffort"]) : null,
    },
  };
}

interface StoredRow {
  value: string;
  updated_at: number;
  updated_by: string | null;
}

function storedRow(): StoredRow | null {
  return db.query<StoredRow, { k: string }>("SELECT value, updated_at, updated_by FROM settings WHERE key = $k").get({ k: KEY });
}

/**
 * The settings in force. Saved settings are merged over the defaults field by
 * field, so a setting added in a later version starts at its default.
 */
export function summarySettings(): SummarySettings {
  const defaults = defaultSummarySettings();
  const row = storedRow();
  if (!row) return defaults;
  const saved = parseJson<Partial<SummarySettings>>(row.value, {});
  const merged = {
    provider: saved.provider ?? defaults.provider,
    local: { ...defaults.local, ...(saved.local ?? {}) },
    codex: { ...defaults.codex, ...(saved.codex ?? {}) },
  };
  const parsed = summarySettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : defaults;
}

export function summarySettingsMeta(): { saved: boolean; updatedAt: number | null; updatedBy: string | null } {
  const row = storedRow();
  if (!row) return { saved: false, updatedAt: null, updatedBy: null };
  const by = row.updated_by
    ? db.query<{ display_name: string }, { id: string }>("SELECT display_name FROM users WHERE id = $id").get({ id: row.updated_by })
    : null;
  return { saved: true, updatedAt: row.updated_at, updatedBy: by?.display_name ?? null };
}

export function saveSummarySettings(settings: SummarySettings, userId: string): SummarySettings {
  const value = summarySettingsSchema.parse(settings);
  db.query(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($k, $v, $t, $u)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run({ k: KEY, v: JSON.stringify(value), t: now(), u: userId });
  return summarySettings();
}

/** Forget what was saved: the .env defaults apply again. */
export function resetSummarySettings(): SummarySettings {
  db.query("DELETE FROM settings WHERE key = $k").run({ k: KEY });
  return summarySettings();
}

/** True when the address is this machine, so transcripts sent to it stay on the server. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/** What people starting a summary are told about where it is written. */
export function publicSummarizerInfo(s: SummarySettings = summarySettings()): {
  provider: SummaryProvider;
  model: string | null;
  /** Local model on this machine: the transcript never leaves the server. */
  onServer: boolean;
  /** Host of a local model server on another machine (null otherwise). */
  host: string | null;
} {
  if (s.provider === "codex") return { provider: "codex", model: s.codex.model, onServer: false, host: null };
  const onServer = isLoopbackUrl(s.local.baseUrl);
  return { provider: "local", model: s.local.model, onServer, host: onServer ? null : new URL(s.local.baseUrl).host };
}
