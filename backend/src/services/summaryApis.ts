import Anthropic from "@anthropic-ai/sdk";

/**
 * Hosted models that can write summaries, besides a model on this machine.
 *
 * Each has a fixed address: only the model name is chosen on the admin page,
 * so a saved setting can never send a transcript (or the key) anywhere else.
 * Keys are read from the server's environment, never stored in the database
 * and never sent to the browser; the admin page only learns whether one is set.
 */

export const API_PROVIDERS = ["anthropic", "openai", "openrouter", "gemini"] as const;
export type ApiProvider = (typeof API_PROVIDERS)[number];

interface ProviderInfo {
  label: string;
  /** Environment variables holding the key, in order of preference. */
  keyVariables: string[];
  /** OpenAI-compatible address (Chat Completions); Anthropic uses its own SDK. */
  baseUrl: string;
  /** Where transcripts go, for the people writing summaries. */
  host: string;
  /** Suggested model; others are typed on the admin page. */
  defaultModel: string;
  /** OpenAI's own API takes max_completion_tokens (newer models refuse max_tokens). */
  tokenParam: "max_tokens" | "max_completion_tokens";
}

export const PROVIDER_INFO: Record<ApiProvider, ProviderInfo> = {
  anthropic: {
    label: "Anthropic",
    keyVariables: ["ANTHROPIC_API_KEY"],
    baseUrl: "https://api.anthropic.com",
    host: "api.anthropic.com",
    defaultModel: "claude-haiku-5-5",
    tokenParam: "max_tokens",
  },
  openai: {
    label: "OpenAI",
    keyVariables: ["OPENAI_API_KEY"],
    baseUrl: "https://api.openai.com/v1",
    host: "api.openai.com",
    defaultModel: "gpt-5-mini",
    tokenParam: "max_completion_tokens",
  },
  openrouter: {
    label: "OpenRouter",
    keyVariables: ["OPENROUTER_API_KEY"],
    baseUrl: "https://openrouter.ai/api/v1",
    host: "openrouter.ai",
    defaultModel: "anthropic/claude-haiku-4.5",
    tokenParam: "max_tokens",
  },
  gemini: {
    label: "Google Gemini",
    keyVariables: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    host: "generativelanguage.googleapis.com",
    defaultModel: "gemini-2.5-flash",
    tokenParam: "max_tokens",
  },
};

/** The provider's key from the environment, or null. */
export function providerKey(provider: ApiProvider): string | null {
  for (const name of PROVIDER_INFO[provider].keyVariables) {
    const v = process.env[name]?.trim();
    if (v) return v;
  }
  return null;
}

/** Which providers have a key (never the keys themselves). */
export function providerKeys(): Record<ApiProvider, boolean> {
  return Object.fromEntries(API_PROVIDERS.map((p) => [p, providerKey(p) !== null])) as Record<ApiProvider, boolean>;
}

/** Every key a provider might use, for the check that a summary never repeats a server secret. */
export function providerKeyValues(): string[] {
  return API_PROVIDERS.flatMap((p) => PROVIDER_INFO[p].keyVariables.map((n) => process.env[n]?.trim() ?? "")).filter((v) => v.length >= 16);
}

const clients = new Map<string, Anthropic>();

/**
 * One client per key. The SDK retries rate limits, overload and connection
 * errors itself (with backoff); a summary's own deadline is passed per call.
 */
export function anthropicClient(apiKey: string): Anthropic {
  let client = clients.get(apiKey);
  if (!client) {
    client = new Anthropic({ apiKey, maxRetries: 4 });
    clients.set(apiKey, client);
  }
  return client;
}
