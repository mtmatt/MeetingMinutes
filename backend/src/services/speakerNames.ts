import { db } from "../db";
import { escapeRegExp, parseJson } from "../lib/util";
import type { SpeakerRow } from "../types";

/** Speaker key → the name a summary uses for that speaker. */
export type NameMap = Record<string, string>;

export interface SkippedRename {
  key: string;
  from: string;
  to: string;
  /**
   * shared: another speaker has (or will have) the same name, so replacing
   *   would merge two people; never done automatically, not even on request.
   * ambiguous: the old name is a single character ("A", "陳"), which also
   *   occurs in unrelated text; done only on request.
   */
  reason: "shared" | "ambiguous";
}

export interface Reconciled {
  content: string;
  names: NameMap;
  skipped: SkippedRename[];
}

export function currentSpeakerNames(meetingId: string): NameMap {
  const rows = db.query<SpeakerRow, { m: string }>("SELECT * FROM speakers WHERE meeting_id = $m").all({ m: meetingId });
  return Object.fromEntries(rows.map((s) => [s.key, s.name]));
}

export function parseNameMap(json: string | null): NameMap | null {
  return json == null ? null : parseJson<NameMap>(json, {});
}

/** Regex sources that find one speaker in a summary: its name first, then other spellings. */
function patternsFor(key: string, name: string): string[] {
  // Word boundaries for names that start or end with a letter or digit, so
  // "Ann" does not match inside "Anna". CJK text has no spaces between words;
  // other speakers' names are protected separately (see reconcileSpeakerNames).
  const word = (s: string) => `${/^\w/.test(s) ? "(?<!\\w)" : ""}${escapeRegExp(s)}${/\w$/.test(s) ? "(?!\\w)" : ""}`;
  const out = [word(name), word(key)];
  // A default label may appear in another case, or translated in summaries
  // written in Chinese.
  const n = name.match(/^speaker\s*(\d+)$/i)?.[1];
  if (n) out.push(`(?<!\\w)[Ss][Pp][Ee][Aa][Kk][Ee][Rr]\\s*${n}(?!\\d)`, `(?:發言者|講者|發言人)\\s*${n}(?!\\d)`);
  return out;
}

const isAmbiguous = (name: string) => [...name.trim()].length < 2;

// Placeholders from the Unicode private use area, which summaries do not contain.
const OPEN = "\uE000";
const CLOSE = "\uE001";
const SLOT = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");

/**
 * Bring the speaker names written in a summary up to date.
 *
 * `used` is what the summary was written with (key → name), `current` the
 * meeting's speakers now. Each speaker whose name changed is replaced only when
 * that is safe (see SkippedRename); `force` lists keys whose ambiguous rename
 * the user asked for anyway. Renames happen together, through placeholders, so
 * swapping two names works and a new name is never renamed again. Every other
 * speaker's name is held in place too, so renaming "小明" leaves "王小明" alone.
 */
export function reconcileSpeakerNames(content: string, used: NameMap, current: NameMap, force: string[] = []): Reconciled {
  const names: NameMap = { ...used };
  const skipped: SkippedRename[] = [];
  const renamed = new Map<string, string>();
  for (const [key, from] of Object.entries(used)) {
    const to = current[key];
    if (to === undefined || to === from) continue;
    const othersFinal = Object.keys({ ...used, ...current })
      .filter((k) => k !== key)
      .map((k) => current[k] ?? used[k]);
    if (othersFinal.includes(to)) skipped.push({ key, from, to, reason: "shared" });
    else if (isAmbiguous(from) && !force.includes(key)) skipped.push({ key, from, to, reason: "ambiguous" });
    else renamed.set(key, to);
  }
  if (!renamed.size || content.includes(OPEN)) return { content, names, skipped };

  // Every name in the text becomes a placeholder, longest first (so "王小明"
  // is taken before "小明" could match inside it); then each placeholder
  // becomes the speaker's new name, or its unchanged one.
  const slots = Object.entries(used)
    .map(([key, from]) => ({ key, from, to: renamed.get(key) ?? from }))
    .sort((a, b) => b.from.length - a.from.length);
  let text = content;
  slots.forEach((slot, i) => {
    const all = patternsFor(slot.key, slot.from);
    for (const p of renamed.has(slot.key) ? all : all.slice(0, 1)) text = text.replace(new RegExp(p, "gu"), `${OPEN}${i}${CLOSE}`);
  });
  text = text.replace(SLOT, (_, i: string) => slots[Number(i)]!.to);
  for (const [key, to] of renamed) names[key] = to;
  return { content: text, names, skipped };
}
