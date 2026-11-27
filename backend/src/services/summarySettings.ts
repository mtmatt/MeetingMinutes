import { z } from "zod";
import { config } from "../config";
import { parseJson } from "../lib/util";
import type { SummaryProvider } from "../types";
import { API_PROVIDERS, PROVIDER_INFO, type ApiProvider } from "./summaryApis";
import { deleteSetting, readSetting, settingMeta, writeSetting } from "./settingsStore";

/**
 * Which model writes summaries, as chosen by an administrator.
 *
 * The environment (.env) gives the defaults. Once an administrator saves the
 * settings on the admin page they are kept in the database and take
 * precedence, until they are reset. Secrets (LLM_API_KEY, ANTHROPIC_API_KEY and
 * the other providers' keys) are never part of these settings: they stay in the
 * environment and never reach the browser.
 */

/** Model names as providers and servers spell them: "batiai/qwen3.8-27b:q3", "Qwen/Qwen3-14B-AWQ", "claude-haiku-5-5", "anthropic/claude-haiku-4.5". */
export const MODEL_NAME = /^[\w][\w.:/@+-]{0,199}$/;

export const baseUrl = z
  .string()
  .trim()
  .max(300)
  // The address of the server, not of one endpoint: API docs often show the full
  // chat URL (…/v1/chat/completions, …/api/chat), which people paste as is.
  .transform((s) => s.replace(/\/+$/, "").replace(/\/(chat\/completions|completions|models|api\/chat|api\/generate)$/i, "").replace(/\/+$/, ""))
  .refine((s) => {
    try {
      const u = new URL(s);
      return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && !u.search && !u.hash && !isForbiddenHost(s);
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

/** A hosted model: the provider (with its fixed address) and the model name. */
export const apiSettingsSchema = z.object({
  provider: z.enum(API_PROVIDERS),
  model: z.string().trim().regex(MODEL_NAME, "Enter a model name such as claude-haiku-5-5."),
  /** Largest context to use when the provider does not say (Anthropic does; most OpenAI-compatible APIs do not). */
  contextTokens: z.number().int().min(8192).max(2_000_000),
});

export const summarySettingsSchema = z.object({
  provider: z.enum(["local", "api"]),
  local: localSettingsSchema,
  api: apiSettingsSchema,
});

export type LocalModelSettings = z.infer<typeof localSettingsSchema>;
export type ApiModelSettings = z.infer<typeof apiSettingsSchema>;
export type SummarySettings = z.infer<typeof summarySettingsSchema>;

const KEY = "summarizer";

/** The settings .env describes; used until an administrator saves others. */
export function defaultSummarySettings(): SummarySettings {
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
    api: {
      provider: config.summary.apiProvider,
      model: config.summary.apiModel || PROVIDER_INFO[config.summary.apiProvider].defaultModel,
      contextTokens: config.summary.apiContextTokens,
    },
  };
}

/**
 * The settings in force. Saved settings are merged over the defaults field by
 * field, so a setting added in a later version starts at its default.
 */
export function summarySettings(): SummarySettings {
  const defaults = defaultSummarySettings();
  const value = readSetting(KEY);
  if (value === null) return defaults;
  const saved = parseJson<Partial<SummarySettings> & { provider?: string }>(value, {});
  const merged = {
    // Codex was removed: settings saved with it fall back to the default.
    provider: saved.provider === "local" || saved.provider === "api" ? saved.provider : defaults.provider,
    local: { ...defaults.local, ...(saved.local ?? {}) },
    api: { ...defaults.api, ...(saved.api ?? {}) },
  };
  const parsed = summarySettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : defaults;
}

export function summarySettingsMeta() {
  return settingMeta(KEY);
}

export function saveSummarySettings(settings: SummarySettings, userId: string): SummarySettings {
  writeSetting(KEY, summarySettingsSchema.parse(settings), userId);
  return summarySettings();
}

/** Forget what was saved: the .env defaults apply again. */
export function resetSummarySettings(): SummarySettings {
  deleteSetting(KEY);
  return summarySettings();
}

/**
 * Addresses no setting may point at: the cloud metadata service (169.254.169.254
 * and its names) and the rest of the link-local range, and "any address" (0.0.0.0).
 * On a cloud machine they hand out the machine's own credentials.
 */
export function isForbiddenHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
    return (
      /^169\.254\./.test(host) ||
      /^0+(\.0+){0,3}$/.test(host) ||
      host === "::" ||
      /^fe[89ab][0-9a-f]?:/.test(host) ||
      /^::ffff:(169\.254\.|a9fe:)/.test(host) ||
      host === "fd00:ec2::254" ||
      host === "metadata" ||
      host === "metadata.google.internal" ||
      host.endsWith(".metadata.google.internal")
    );
  } catch {
    return true;
  }
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
  /** The hosted provider ("anthropic"…), for provider "api". */
  vendor: ApiProvider | null;
  model: string | null;
  /** Local model on this machine: the transcript never leaves the server. */
  onServer: boolean;
  /** Host the transcript is sent to: a hosted provider's, or a model server's on another machine (null when on this server). */
  host: string | null;
} {
  if (s.provider === "api") {
    return { provider: "api", vendor: s.api.provider, model: s.api.model, onServer: false, host: PROVIDER_INFO[s.api.provider].host };
  }
  const onServer = isLoopbackUrl(s.local.baseUrl);
  return { provider: "local", vendor: null, model: s.local.model, onServer, host: onServer ? null : new URL(s.local.baseUrl).host };
}
