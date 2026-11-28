import type { ApiProvider, SummarizerInfo } from "../api/types";
import { useI18n } from "../i18n";
import { useAuth } from "./auth";

/**
 * A model name as people read it: "batiai/qwen3.8-27b:q3" → "Qwen3.8 27B · Q3",
 * "qwen3:14b" → "Qwen3 14B", "Qwen/Qwen3-14B-AWQ" → "Qwen3 14B-AWQ", "qwen3:latest" → "Qwen3".
 */
export function modelDisplayName(model: string): string {
  const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  const [name = bare, tag] = bare.split(":");
  const nice = (name.charAt(0).toUpperCase() + name.slice(1)).replace(/-(\d+(?:\.\d+)?)b(?=-|$)/i, " $1B");
  if (!tag || tag === "latest") return nice;
  if (/^\d+(\.\d+)?[bm]$/i.test(tag)) return `${nice} ${tag.toUpperCase()}`;
  // Quantisation tags: q3, q4_K_M, iq3, fp16, bf16.
  if (/^(i?q\d|fp\d|bf\d|int\d)/i.test(tag)) return `${nice} · ${tag.toUpperCase()}`;
  return `${nice}:${tag}`;
}

/** The companies behind the hosted summary APIs. */
export const VENDOR_NAMES: Record<ApiProvider, string> = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter", gemini: "Google Gemini" };

/**
 * Who writes summaries, as people are told: the company the transcript is
 * sent to ("Anthropic"), or, for a model the site runs itself, `fallback`
 * ("AI"). Which model it is stays with the administrators.
 */
export function engineWho(info: SummarizerInfo | null, fallback: string): string {
  if (info?.provider === "api" && info.vendor) return VENDOR_NAMES[info.vendor];
  return fallback;
}

/** Name of the model that writes summaries (administrators' pages). */
export function engineName(info: SummarizerInfo | null, fallback: string): string {
  if (!info) return fallback;
  if (!info.model) return fallback;
  // Hosted model names are already readable ("claude-haiku-5-5", "gpt-5-mini"); only the vendor prefix goes.
  if (info.provider === "api") return info.model.includes("/") ? info.model.slice(info.model.lastIndexOf("/") + 1) : info.model;
  return modelDisplayName(info.model);
}

export function useSummaryEngine(): { name: string; model: string; info: SummarizerInfo | null } {
  const { summarizer } = useAuth();
  const { t } = useI18n();
  return { name: engineWho(summarizer, t("summary.engineFallback")), model: engineName(summarizer, t("summary.engineFallback")), info: summarizer };
}
