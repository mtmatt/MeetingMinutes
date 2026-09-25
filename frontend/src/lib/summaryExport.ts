import type { MeetingDetail, Segment, Summary } from "../api/types";
import type { Locale } from "../api/types";

/** "00:12:40": the same form the summary uses for its citations. */
function stamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** Local time with its UTC offset, e.g. 2026-09-24T14:00:00+08:00. */
function localIso(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(off / 60)}:${p(off % 60)}`
  );
}

const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;

/** Joins segment texts: no space between Chinese characters, one between Latin words. */
function joinText(parts: string[]): string {
  let out = "";
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (out && !CJK.test(out.at(-1)!) && !CJK.test(part[0]!)) out += " ";
    out += part;
  }
  return out;
}

/** Consecutive lines by the same speaker become one paragraph. */
function transcriptMarkdown(meeting: MeetingDetail, locale: Locale): string {
  const names = new Map(meeting.speakers.map((s) => [s.key, s.name]));
  const colon = locale === "zh-TW" ? "：" : ": ";
  const paras: string[] = [];
  let run: { speaker: string | null; start: number; parts: string[] } | null = null;
  const flush = () => {
    if (!run) return;
    const text = joinText(run.parts);
    const who = run.speaker ? (names.get(run.speaker) ?? run.speaker) : null;
    if (text) paras.push(`**[${stamp(run.start)}]${who ? ` ${who}` : ""}${colon}**${text}`);
    run = null;
  };
  for (const s of meeting.segments as Segment[]) {
    if (run && run.speaker === s.speaker) run.parts.push(s.text);
    else {
      flush();
      run = { speaker: s.speaker, start: s.start, parts: [s.text] };
    }
  }
  flush();
  return paras.join("\n\n");
}

export interface SummaryExport {
  meeting: MeetingDetail;
  summary: Summary;
  version: number;
  /** Localized template name as shown in the app. */
  templateLabel: string;
  withTranscript: boolean;
  locale: Locale;
  transcriptHeading: string;
}

/**
 * The summary as a standalone Markdown file. Front matter carries the meeting
 * details (title, date, length, speakers, which summary version) so the file
 * still makes sense once it leaves the app; the body is the summary exactly as
 * shown, optionally followed by the transcript its timestamps point into.
 */
export function summaryMarkdown(x: SummaryExport): string {
  const { meeting, summary } = x;
  const q = (v: string) => JSON.stringify(v); // JSON strings are valid YAML scalars.
  const fm = [
    "---",
    `title: ${q(meeting.title)}`,
    `date: ${q(localIso(meeting.occurredAt ?? meeting.createdAt))}`,
  ];
  if (meeting.durationSec != null) fm.push(`duration: ${q(stamp(meeting.durationSec))}`);
  if (meeting.speakers.length) fm.push(`speakers: [${meeting.speakers.map((s) => q(s.name)).join(", ")}]`);
  fm.push(
    `summary_template: ${q(x.templateLabel)}`,
    `summary_version: ${x.version}`,
    `summary_generated: ${q(localIso(summary.finishedAt ?? summary.createdAt))}`,
    `link: ${q(`${window.location.origin}/m/${meeting.id}`)}`,
    "---",
  );
  let out = `${fm.join("\n")}\n\n${(summary.content ?? "").trim()}\n`;
  if (x.withTranscript && meeting.segments.length) {
    out += `\n---\n\n## ${x.transcriptHeading}\n\n${transcriptMarkdown(meeting, x.locale)}\n`;
  }
  return out;
}

/** A file name that is safe on Windows, macOS and Linux. */
export function safeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "")
      .slice(0, 120) || "meeting"
  );
}

export function downloadText(filename: string, text: string, type = "text/markdown;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
