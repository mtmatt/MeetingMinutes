import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { db, now } from "../db";
import { newId, parseJson } from "../lib/util";
import type { MeetingRow, RefinementRow, SegmentRow, SpeakerRow, SummaryRequest, TranscribeOptions, UserRow } from "../types";
import { chargeRefinement, CreditsError, summaryHold } from "./credits";
import { publish } from "./events";
import { estimateTokens } from "./localSummary";
import { DEFAULT_OPTIONS, enqueueAutoSummary, getMeeting, touchMeeting } from "./meetings";
import { deleteSetting, readSetting, settingMeta, writeSetting } from "./settingsStore";
import { anthropicClient, providerKey, providerKeyValues } from "./summaryApis";
import { toTaiwanTraditional } from "./zhTW";

/**
 * Correcting a transcript with a hosted model (Claude Haiku by default), from
 * what the meeting is about.
 *
 * Speech recognition mishears names, product names and terms, and the English
 * words in a mixed Mandarin/English meeting. The model first reads the whole
 * transcript (and the latest summary, when there is one) and lists the topic
 * and the terms that matter; then it goes through the transcript in parts and
 * fixes only the words that were clearly misheard. Timestamps, speakers and
 * sentence breaks never change, sentences a person edited by hand are left as
 * they are, and a change that rewrites too much of a sentence is not applied.
 * Every corrected sentence keeps its original text, so a correction can be
 * undone. A prepaid person pays for the tokens at the summary rates.
 */

export const refineSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Anthropic model id. */
  model: z.string().trim().min(1).max(100),
});
export type RefineSettings = z.infer<typeof refineSettingsSchema>;

const KEY = "refine";
const DEFAULT_MODEL = "claude-haiku-5-5";
/** Sentences sent to the model at once (with a little context before them). */
const CHUNK_SEGMENTS = 60;
const CHUNK_CHARS = 5000;
/** Sentences before a part shown as context only. */
const CONTEXT_BEFORE = 3;
/** The most of the transcript the first reading takes (characters). */
const READ_CHARS = 400_000;
/** Corrections running at once, across the site. */
const CONCURRENCY = 2;

export function defaultRefineSettings(): RefineSettings {
  return { enabled: false, model: DEFAULT_MODEL };
}

export function refineSettings(): RefineSettings {
  const parsed = refineSettingsSchema.safeParse({ ...defaultRefineSettings(), ...parseJson<Partial<RefineSettings>>(readSetting(KEY), {}) });
  return parsed.success ? parsed.data : defaultRefineSettings();
}

export function refineSettingsMeta() {
  return settingMeta(KEY);
}

export function saveRefineSettings(s: RefineSettings, userId: string): RefineSettings {
  writeSetting(KEY, refineSettingsSchema.parse(s), userId);
  return refineSettings();
}

export function resetRefineSettings(): RefineSettings {
  deleteSetting(KEY);
  return refineSettings();
}

/** Turned on, with an Anthropic key on the server. */
export function refineAvailable(): boolean {
  return refineSettings().enabled && providerKey("anthropic") !== null;
}

/** What people are told: whether they can ask for it, and where the transcript goes. */
export function publicRefineInfo() {
  return { available: refineAvailable(), vendor: "Anthropic", host: "api.anthropic.com" };
}

// ------------------------------------------------------------------ queue

/** The latest correction of a meeting, as the meeting page shows it. */
export function latestRefinement(meetingId: string) {
  const r = db
    .query<RefinementRow, { m: string }>("SELECT * FROM refinements WHERE meeting_id = $m ORDER BY created_at DESC LIMIT 1")
    .get({ m: meetingId });
  if (!r) return null;
  return { id: r.id, status: r.status, error: r.error, changed: r.changed, createdAt: r.created_at, finishedAt: r.finished_at };
}

export function activeRefinement(meetingId: string): RefinementRow | null {
  return db
    .query<RefinementRow, { m: string }>("SELECT * FROM refinements WHERE meeting_id = $m AND status IN ('queued', 'running') LIMIT 1")
    .get({ m: meetingId });
}

/** Tokens a correction is expected to read: the transcript about twice (the reading, then the parts with their context). */
export function refineInputTokens(meetingId: string): number {
  const chars = db.query<{ n: number | null }, { m: string }>("SELECT SUM(LENGTH(text)) AS n FROM segments WHERE meeting_id = $m").get({ m: meetingId })?.n ?? 0;
  return estimateTokens("x".repeat(Math.min(chars, READ_CHARS))) * 2 + 2000;
}

/**
 * Queue a correction. `hold`: points set aside for a prepaid person (thrown
 * CreditsError when they have too few). `thenSummary`: the automatic summary
 * to write once it is done (or once it failed: the summary then uses the
 * transcript as it is).
 */
export function enqueueRefinement(m: MeetingRow, user: UserRow, thenSummary: SummaryRequest | null = null): RefinementRow {
  const hold = summaryHold(user, refineInputTokens(m.id));
  const id = newId(12);
  db.query(
    `INSERT INTO refinements (id, meeting_id, created_by, status, hold, then_summary, created_at)
     VALUES ($id, $m, $u, 'queued', $hold, $then, $t)`,
  ).run({ id, m: m.id, u: user.id, hold, then: thenSummary ? JSON.stringify(thenSummary) : null, t: now() });
  touchMeeting(m);
  kick();
  return db.query<RefinementRow, { id: string }>("SELECT * FROM refinements WHERE id = $id").get({ id })!;
}

/** Queue one after a transcription, falling back to the summary alone when the owner has too few points. */
export function enqueueRefinementAfterTranscription(m: MeetingRow, thenSummary: SummaryRequest | null): boolean {
  const owner = db.query<UserRow, { id: string }>("SELECT * FROM users WHERE id = $id").get({ id: m.owner_id });
  if (!owner) return false;
  try {
    enqueueRefinement(m, owner, thenSummary);
    return true;
  } catch (e) {
    if (e instanceof CreditsError) return false;
    throw e;
  }
}

/** Put the transcript back as it was before it was corrected. Returns how many sentences changed back. */
export function undoRefinement(meetingId: string): number {
  const n = db
    .query("UPDATE segments SET text = original_text, original_text = NULL WHERE meeting_id = $m AND original_text IS NOT NULL")
    .run({ m: meetingId }).changes;
  const m = getMeeting(meetingId);
  if (m) touchMeeting(m);
  return n;
}

/** Corrections that were running when the server stopped. */
export function recoverRefinements() {
  db.query("UPDATE refinements SET status = 'queued', started_at = NULL WHERE status = 'running'").run();
  kick();
}

/** Tests: a stand-in for the Anthropic client (the real one is never called in tests). */
let testClient: unknown = null;
export function setRefineClientForTests(client: unknown) {
  testClient = client;
}

let running = 0;
let scheduled = false;

export function kick() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    void pump();
  });
}

async function pump() {
  while (running < CONCURRENCY) {
    const next = db.query<RefinementRow, []>("SELECT * FROM refinements WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1").get();
    if (!next) return;
    const claimed = db.query("UPDATE refinements SET status = 'running', started_at = $t WHERE id = $id AND status = 'queued'").run({ id: next.id, t: now() });
    if (claimed.changes === 0) continue;
    running++;
    void execute(next).finally(() => {
      running--;
      kick();
    });
  }
}

// ------------------------------------------------------------------ the work

const ContextSchema = z.object({
  topic: z.string(),
  terms: z.array(z.string()),
});

/** Replacements, not sentences: the server applies them, so nothing else in a sentence can change. */
const FixesSchema = z.object({
  fixes: z.array(z.object({ id: z.number().int(), wrong: z.string(), right: z.string() })),
});

interface Usage {
  input: number;
  output: number;
}

const SYSTEM = `You find speech recognition errors in a meeting transcript. The meeting may mix Mandarin Chinese (Taiwan, Traditional characters) and English.

A recogniser writes what it heard. Its mistakes sound like what was said but make no sense in context: a homophone or near-homophone in Mandarin (same or similar pinyin, often with a different tone), an English word or name written as Chinese characters that sound like it, an English word broken up or misspelled, a misheard name, product name, acronym or term.

For each phrase that does not fit the meeting, say it aloud in your head (pinyin for Chinese, its pronunciation for English), and look for a word that sounds the same or nearly so AND fits the topic, the terms and the sentences around it. Correct it only when you find such a word and are confident. When nothing sounds close, or the phrase already makes sense, leave it.

Give each correction as the exact wrong phrase, copied character for character from the sentence, and the phrase that replaces it. Keep each phrase short: only the misheard word or words. Never add words, names, speaker labels or punctuation that were not said; never rephrase, tidy up, translate or remove anything; never change Traditional characters to Simplified. A sentence with nothing misheard gets no correction.`;

/** Sentences as data: the speaker is a field of its own, so it is never taken for part of what was said. */
function textOf(segments: { id: number; speaker: string; text: string }[]): string {
  return segments.map((s) => JSON.stringify({ id: s.id, speaker: s.speaker, text: s.text })).join("\n");
}

/**
 * Apply one replacement to a sentence, or null when it is not a correction: the
 * wrong phrase must be in the sentence, the right one must differ, be about as
 * long, and not merely add to it (a name or speaker label in front, say).
 */
export function applyReplacement(text: string, wrong: string, right: string, speakerNames: readonly string[] = []): string | null {
  const w = wrong.trim();
  const r = right.trim();
  if (!w || !r || w === r || !text.includes(w)) return null;
  if (r.includes(w)) return null; // only adds to what was said
  const wl = [...w].length;
  const rl = [...r].length;
  if (rl > wl * 3 + 6 || rl * 3 + 6 < wl) return null;
  if (/[:：]\s*$/.test(r) || /^[^:：]{1,20}[:：]/.test(r)) return null; // a speaker label
  // A speaker's name appearing where none was heard (unless the misheard phrase was that name).
  if (speakerNames.some((n) => n && r.includes(n) && !text.includes(n) && editDistance(w, n) > Math.ceil([...n].length / 2))) return null;
  return text.split(w).join(r);
}

/** Levenshtein distance, for the check that a correction did not rewrite a sentence. */
export function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length]!;
}

/** A correction is a fix, not a rewrite: most of the sentence stays as it was. */
export function acceptableFix(before: string, after: string): boolean {
  const a = before.trim();
  const b = after.trim();
  if (!b || a === b) return false;
  const len = [...a].length;
  const ratio = [...b].length / Math.max(1, len);
  if (ratio < 0.6 || ratio > 1.6) return false;
  // A term written in English instead of misheard Chinese changes a few characters more than its length.
  return editDistance(a, b) <= Math.max(6, Math.ceil(len * 0.5));
}

async function execute(r: RefinementRow) {
  const m = getMeeting(r.meeting_id);
  if (!m) return;
  publish(m.owner_id, { type: "meeting.updated", meetingId: m.id });
  const usage: Usage = { input: 0, output: 0 };
  const settings = refineSettings();
  try {
    const key = providerKey("anthropic");
    if (!key) throw new Error("This server has no Anthropic API key (ANTHROPIC_API_KEY), so transcripts cannot be corrected.");
    if (m.status !== "ready") throw new Error("The transcript is not ready.");
    const client = (testClient as ReturnType<typeof anthropicClient> | null) ?? anthropicClient(key);
    const options: TranscribeOptions = { ...DEFAULT_OPTIONS, ...parseJson<Partial<TranscribeOptions>>(m.options, {}) };
    const speakers = new Map(
      db.query<SpeakerRow, { m: string }>("SELECT * FROM speakers WHERE meeting_id = $m").all({ m: m.id }).map((s) => [s.key, s.name]),
    );
    const segments = db.query<SegmentRow, { m: string }>("SELECT * FROM segments WHERE meeting_id = $m ORDER BY idx").all({ m: m.id });
    const items = segments.map((s) => ({ id: s.id, speaker: (s.speaker && speakers.get(s.speaker)) || s.speaker || "?", text: s.text, edited: !!s.edited }));
    const summary = db
      .query<{ content: string | null }, { m: string }>("SELECT content FROM summaries WHERE meeting_id = $m AND status = 'done' ORDER BY created_at DESC LIMIT 1")
      .get({ m: m.id })?.content;
    const known = [
      `Meeting title: ${m.title}`,
      speakers.size ? `Speakers: ${[...speakers.values()].join(", ")}` : "",
      options.vocabulary.trim() ? `Terms the uploader listed: ${options.vocabulary.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    // 1. What the meeting is about, and the terms that matter.
    const reading = textOf(items).slice(0, READ_CHARS);
    const ctx = await client.messages.parse({
      model: settings.model,
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { effort: "low", format: zodOutputFormat(ContextSchema) },
      messages: [
        {
          role: "user",
          content: `${known}${summary ? `\n\nSummary of the meeting:\n${summary.slice(0, 8000)}` : ""}\n\nTranscript:\n${reading}\n\nIn one or two sentences, what is this meeting about? Then list up to 60 names, product names, acronyms and technical terms as they should be written (correct spelling, Traditional Chinese where Chinese), including ones the recogniser probably misheard.`,
        },
      ],
    });
    usage.input += ctx.usage.input_tokens;
    usage.output += ctx.usage.output_tokens;
    const context = ctx.parsed_output ?? { topic: "", terms: [] };
    const brief = `${known}\nTopic: ${context.topic}\nTerms: ${context.terms.slice(0, 60).join(", ")}`;

    // 2. The transcript in parts: fix only misheard words.
    const fixes = new Map<number, string>();
    const names = [...speakers.values()];
    let start = 0;
    while (start < items.length) {
      let end = start;
      let chars = 0;
      while (end < items.length && end - start < CHUNK_SEGMENTS && chars < CHUNK_CHARS) chars += items[end++]!.text.length;
      const part = items.slice(start, end).filter((s) => !s.edited);
      if (part.length) {
        const before = items.slice(Math.max(0, start - CONTEXT_BEFORE), start);
        const res = await client.messages.parse({
          model: settings.model,
          max_tokens: 16000,
          // The brief is the same for every part: cached after the first.
          system: [{ type: "text", text: `${SYSTEM}\n\n${brief}`, cache_control: { type: "ephemeral" } }],
          // Weighing how words sound against the topic is worth some thought.
          output_config: { effort: "medium", format: zodOutputFormat(FixesSchema) },
          messages: [
            {
              role: "user",
              content: `${before.length ? `Context (do not correct):\n${textOf(before)}\n\n` : ""}Find the misheard phrases in these sentences (one JSON object per sentence). For each, give the sentence id, the wrong phrase exactly as written in its text, and the phrase that was actually said:\n${textOf(part)}`,
            },
          ],
        });
        usage.input += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
        usage.output += res.usage.output_tokens;
        const allowed = new Map(part.map((s) => [s.id, s.text]));
        for (const f of res.parsed_output?.fixes ?? []) {
          const was = allowed.get(f.id);
          if (was === undefined) continue;
          const current = fixes.get(f.id) ?? was;
          const next = applyReplacement(current, f.wrong, f.right, names);
          if (next != null && acceptableFix(was, next)) fixes.set(f.id, next);
        }
      }
      start = end;
    }

    // 3. Apply: keep the original text, never touch a sentence edited by hand meanwhile.
    const secrets = providerKeyValues();
    let changed = 0;
    db.transaction(() => {
      const apply = db.query(
        `UPDATE segments SET original_text = COALESCE(original_text, text), text = $text
         WHERE id = $id AND meeting_id = $m AND edited = 0 AND text = $was`,
      );
      for (const [id, raw] of fixes) {
        const text = options.script === "zh-TW" ? toTaiwanTraditional(raw, names) : raw;
        if (secrets.some((s) => text.includes(s))) continue;
        const was = items.find((s) => s.id === id)!.text;
        if (text === was) continue;
        changed += apply.run({ id, m: m.id, text, was }).changes;
      }
      const cost = r.created_by ? chargeRefinement(r.created_by, m, usage.input, usage.output) : null;
      db.query(
        `UPDATE refinements SET status = 'done', error = NULL, model = $model, usage = $usage, topic = $topic, changed = $changed, charged = $charged, finished_at = $t
         WHERE id = $id`,
      ).run({ id: r.id, model: settings.model, usage: JSON.stringify(usage), topic: context.topic, changed, charged: cost, t: now() });
    })();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[refine] ${r.id} failed:`, message);
    db.query("UPDATE refinements SET status = 'failed', error = $e, usage = $usage, finished_at = $t WHERE id = $id").run({
      id: r.id,
      e: message.slice(0, 500),
      usage: JSON.stringify(usage),
      t: now(),
    });
  }
  // The automatic summary waits for the corrected transcript (or goes ahead without it).
  const after = getMeeting(r.meeting_id);
  const then = parseJson<SummaryRequest | null>(r.then_summary, null);
  if (after && then) {
    const has = db.query<{ n: number }, { m: string }>("SELECT COUNT(*) AS n FROM summaries WHERE meeting_id = $m").get({ m: after.id })?.n;
    if (!has) enqueueAutoSummary(after, then);
  }
  if (after) touchMeeting(after);
}
