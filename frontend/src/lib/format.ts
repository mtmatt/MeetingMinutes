import type { Locale } from "../api/types";
import type { TFn } from "../i18n";

export function clock(totalSeconds: number, forceHours = false): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 || forceHours ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** "1 h 24 min", "12 min", "45 s" */
export function duration(sec: number | null | undefined, locale: Locale): string {
  if (sec == null) return "–";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (locale === "zh-TW") {
    if (h) return `${h} 小時 ${m} 分`;
    if (m) return `${m} 分鐘`;
    return `${s} 秒`;
  }
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min`;
  return `${s} s`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

const intlLocale = (l: Locale) => (l === "zh-TW" ? "zh-TW" : "en-GB");

export function dateLong(ms: number, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: "long" }).format(ms);
}

export function dateTime(ms: number, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: "medium", timeStyle: "short" }).format(ms);
}

export function time(ms: number, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { timeStyle: "short" }).format(ms);
}

export function monthYear(ms: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "zh-TW" ? "zh-TW" : "en-US", { year: "numeric", month: "long" }).format(ms);
}

export function dayParts(ms: number, locale: Locale): { day: string; weekday: string } {
  const d = new Date(ms);
  return {
    day: String(d.getDate()),
    weekday: new Intl.DateTimeFormat(locale === "zh-TW" ? "zh-TW" : "en-US", { weekday: "short" }).format(d),
  };
}

export function relative(ms: number, t: TFn, locale: Locale): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return t("time.justNow");
  if (min < 60) return t("time.minutesAgo", { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t("time.hoursAgo", { n: h });
  const d = Math.floor(h / 24);
  if (d < 14) return t("time.daysAgo", { n: d });
  return dateLong(ms, locale);
}

/** Future relative time, e.g. invite expiry. */
export function until(ms: number, locale: Locale): string {
  const rtf = new Intl.RelativeTimeFormat(locale === "zh-TW" ? "zh-TW" : "en", { numeric: "auto" });
  const diff = ms - Date.now();
  const h = Math.round(diff / 3600000);
  if (Math.abs(h) < 48) return rtf.format(h, "hour");
  return rtf.format(Math.round(h / 24), "day");
}

/** Value for <input type="datetime-local"> in the browser's timezone. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

const CJK = /[㐀-鿿豈-﫿]/g;
/** Word count that treats each CJK character as a word. */
export function wordCount(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const latin = text.replace(CJK, " ").split(/\s+/).filter((w) => /\w/.test(w)).length;
  return cjk + latin;
}

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  if (/[㐀-鿿]/.test(trimmed[0]!)) return trimmed[0]!;
  const parts = trimmed.split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function speakerVar(color: number | undefined): string {
  return `var(--spk-${(color ?? 8) % 10})`;
}
