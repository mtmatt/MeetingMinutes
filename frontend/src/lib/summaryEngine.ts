import type { SummarizerInfo } from "../api/types";
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

/** Name of the model that writes summaries, for sentences such as "{engine} is writing the summary". */
export function engineName(info: SummarizerInfo | null, fallback: string): string {
  if (!info) return fallback;
  if (info.provider === "codex") return "Codex";
  return info.model ? modelDisplayName(info.model) : fallback;
}

export function useSummaryEngine(): { name: string; info: SummarizerInfo | null } {
  const { summarizer } = useAuth();
  const { t } = useI18n();
  return { name: engineName(summarizer, t("summary.engineFallback")), info: summarizer };
}
