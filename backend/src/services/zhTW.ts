import * as OpenCC from "opencc-js";
import type { DictLike } from "opencc-js";
import { escapeRegExp } from "../lib/util";

/**
 * Bring a summary into Taiwan Traditional Chinese.
 *
 * Models asked for Traditional Chinese still slip into Simplified, some
 * (Qwen3 among them) often for whole paragraphs. Converting the whole text with
 * OpenCC would fix that but damage the parts that are already right, because
 * Simplified-to-Traditional conversion is not idempotent: 干擾 becomes 幹擾,
 * 發佈 becomes 釋出, 後台 becomes 後臺. So only the clauses that contain a
 * character that exists solely in Simplified (们, 软, 发…) are converted, with
 * OpenCC's Taiwan phrasing (s2twp, as the transcripts use: 软件 → 軟體), and
 * everything else is left exactly as written.
 */

interface Tables {
  convert: (text: string) => string;
  /** Characters that never occur in Traditional text. */
  simplifiedOnly: Set<string>;
}

let tables: Tables | null = null;

function entries(dict: DictLike): (readonly [string, string])[] {
  if (typeof dict !== "string") return [...dict];
  return dict.split("|").map((e) => {
    const sp = e.indexOf(" ");
    return [e.slice(0, sp), e.slice(sp + 1)] as const;
  });
}

function load(): Tables {
  if (tables) return tables;
  // Simplified → Traditional: phrases first, then single characters.
  const [phrases, characters] = OpenCC.Locale.from.cn?.[0] ?? [];
  if (!phrases || !characters) throw new Error("opencc-js is missing its Simplified Chinese dictionaries");
  // A character the Traditional side of any phrase uses is valid Traditional
  // (干 in 干涉, 后 in 皇后, 里 in 公里), even though the character table maps
  // it elsewhere by default. The rest of the table's keys are Simplified only.
  const traditional = new Set<string>();
  for (const [, t] of entries(phrases)) for (const ch of t) traditional.add(ch);
  const simplifiedOnly = new Set<string>();
  for (const [s, t] of entries(characters)) {
    if ([...s].length === 1 && s !== t && !traditional.has(s)) simplifiedOnly.add(s);
  }
  tables = { convert: OpenCC.Converter({ from: "cn", to: "twp" }), simplifiedOnly };
  return tables;
}

/** Whether the text contains a character that only Simplified Chinese uses. */
export function hasSimplified(text: string): boolean {
  const { simplifiedOnly } = load();
  for (const ch of text) if (simplifiedOnly.has(ch)) return true;
  return false;
}

// Placeholders from the Unicode private use area (speakerNames.ts uses E000/E001).
const OPEN = "";
const CLOSE = "";
const SLOT = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");

/**
 * Clause boundaries: sentence and clause punctuation, brackets, quotes, table
 * cells and line breaks. Conversion decisions are made per clause, so one
 * Simplified sentence does not get the Traditional one next to it converted.
 */
const CLAUSE = /([\n。．！？；：，、!?;:,()（）「」『』“”‘’"《》〈〉【】[\]|…—]+)/;

/**
 * Convert the Simplified parts of `text` to Taiwan Traditional Chinese.
 * `keep` lists strings that must come out unchanged, such as speaker names
 * (renaming a speaker later finds them by their exact spelling).
 */
export function toTaiwanTraditional(text: string, keep: readonly string[] = []): string {
  if (!text || !hasSimplified(text)) return text;
  const { convert } = load();

  // Set aside what must not change: code, links, and the given names. Inline
  // code with Chinese in it is a term the model chose to highlight, not code.
  const held: string[] = [];
  const hold = (s: string) => `${OPEN}${held.push(s) - 1}${CLOSE}`;
  let work = text.replace(/```[\s\S]*?```|`[^`\n]+`|<?https?:\/\/[^\s)>\]]+>?/g, (s) =>
    s.startsWith("`") && !s.startsWith("```") && /\p{Script=Han}/u.test(s) ? s : hold(s),
  );
  const names = [...new Set(keep.map((k) => k.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (names.length) work = work.replace(new RegExp(names.map(escapeRegExp).join("|"), "g"), hold);

  work = work
    .split(CLAUSE)
    .map((part, i) => (i % 2 === 0 && hasSimplified(part) ? convert(part) : part))
    .join("");
  return work.replace(SLOT, (_, n: string) => held[Number(n)] ?? "");
}
