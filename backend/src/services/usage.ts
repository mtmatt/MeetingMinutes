import { db, now } from "../db";
import { parseJson } from "../lib/util";
import { rates, summaryCost, transcriptionCost } from "./credits";

/**
 * What someone used, for their usage dashboard: recording transcribed and summaries
 * written over a period, by day or month (Taiwan time), and sorted into kinds — the
 * recording's language and length, the weekday of the meeting, the summary template
 * and model — with the points they cost: what was charged on a prepaid account, and
 * otherwise (a free account, or work from before points) what it comes to at the
 * current rates. An administrator can
 * ask for one person or the whole site (then also by person).
 *
 * It counts finished work on recordings still in the library: transcribing again
 * counts again, and a deleted recording takes its work with it (the points ledger on
 * the purchase page keeps every charge).
 */

export const USAGE_RANGES = ["30d", "90d", "12m", "all"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

const DAY = 86_400_000;
/** Taiwan is UTC+8 all year. */
const TZ = 8 * 3_600_000;

/** Recording lengths the dashboard sorts meetings into, in minutes (upper bounds). */
const LENGTHS: { key: string; max: number }[] = [
  { key: "lt15", max: 15 },
  { key: "lt30", max: 30 },
  { key: "lt60", max: 60 },
  { key: "lt120", max: 120 },
  { key: "ge120", max: Infinity },
];

interface TranscriptionRow {
  meeting_id: string;
  title: string;
  owner_id: string;
  language: string | null;
  duration_sec: number | null;
  occurred_at: number | null;
  created_at: number;
  finished_at: number;
  charged: number | null;
}

interface SummaryRow {
  meeting_id: string;
  title: string;
  created_by: string | null;
  template_name: string | null;
  model: string | null;
  usage: string | null;
  finished_at: number;
  charged: number | null;
}

export interface UsageBucket {
  /** "2026-11-26" (by day) or "2026-11" (by month), Taiwan time. */
  key: string;
  /** Seconds of recording transcribed. */
  sec: number;
  transcriptions: number;
  summaries: number;
  /** Thousandths of a point, transcription and summaries. */
  points: number;
}

interface Group {
  key: string;
  count: number;
  sec: number;
  points: number;
}

function dayKey(t: number): string {
  return new Date(t + TZ).toISOString().slice(0, 10);
}
function monthKey(t: number): string {
  return new Date(t + TZ).toISOString().slice(0, 7);
}

/** The first moment of the Taiwan day (or month) holding `t`, as a timestamp. */
function startOfDay(t: number): number {
  return Math.floor((t + TZ) / DAY) * DAY - TZ;
}
function startOfMonth(t: number): number {
  const d = new Date(t + TZ);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - TZ;
}
function addMonths(t: number, n: number): number {
  const d = new Date(t + TZ);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1) - TZ;
}

/** Tokens a finished summary read and wrote, as the model reported them (null when it did not). */
function tokens(usage: string | null): { input: number; output: number } | null {
  const u = parseJson<Record<string, unknown> | null>(usage, null);
  if (!u) return null;
  const input = Number(u.input_tokens ?? u.prompt_tokens ?? NaN);
  const output = Number(u.output_tokens ?? u.completion_tokens ?? NaN);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  return { input: Number.isFinite(input) ? input : 0, output: Number.isFinite(output) ? output : 0 };
}

function bump(map: Map<string, Group>, key: string, sec: number, points: number) {
  const g = map.get(key) ?? { key, count: 0, sec: 0, points: 0 };
  g.count += 1;
  g.sec += sec;
  g.points += points;
  map.set(key, g);
}

const sortGroups = (map: Map<string, Group>) => [...map.values()].sort((a, b) => b.sec - a.sec || b.count - a.count || b.points - a.points);

/**
 * `userId`: whose usage; null for the whole site. `range`: the last 30 or 90 days (by day),
 * the last 12 months, or everything (by month).
 */
export function usageReport(userId: string | null, range: UsageRange, at = now()) {
  const byMonth = range === "12m" || range === "all";
  const owner = userId ? "AND m.owner_id = $u" : "";
  const by = userId ? "AND s.created_by = $u" : "";
  const params: Record<string, string> = userId ? { u: userId } : {};

  // The period: whole Taiwan days (or months), ending with the current one.
  let from: number;
  if (range === "30d") from = startOfDay(at) - 29 * DAY;
  else if (range === "90d") from = startOfDay(at) - 89 * DAY;
  else if (range === "12m") from = addMonths(startOfMonth(at), -11);
  else {
    const first = db
      .query<{ t: number | null }, Record<string, string>>(
        `SELECT MIN(t) AS t FROM (
           SELECT MIN(j.finished_at) AS t FROM jobs j JOIN meetings m ON m.id = j.meeting_id
             WHERE j.kind = 'transcribe' AND j.status = 'done' ${owner}
           UNION ALL
           SELECT MIN(s.finished_at) FROM summaries s WHERE s.status = 'done' ${by})`,
      )
      .get(params)?.t;
    from = startOfMonth(first ?? at);
  }

  const transcriptions = db
    .query<TranscriptionRow, Record<string, string | number>>(
      `SELECT j.meeting_id, m.title, m.owner_id, m.language, m.duration_sec, m.occurred_at, m.created_at, j.finished_at, j.charged
         FROM jobs j JOIN meetings m ON m.id = j.meeting_id
        WHERE j.kind = 'transcribe' AND j.status = 'done' AND j.finished_at >= $from ${owner}
        ORDER BY j.finished_at`,
    )
    .all({ ...params, from });
  const summaries = db
    .query<SummaryRow, Record<string, string | number>>(
      `SELECT s.meeting_id, m.title, s.created_by, s.template_name, s.model, s.usage, s.finished_at, s.charged
         FROM summaries s JOIN meetings m ON m.id = s.meeting_id
        WHERE s.status = 'done' AND s.finished_at >= $from ${by}
        ORDER BY s.finished_at`,
    )
    .all({ ...params, from });
  const failed = db
    .query<{ jobs: number; summaries: number }, Record<string, string | number>>(
      `SELECT
         (SELECT COUNT(*) FROM jobs j JOIN meetings m ON m.id = j.meeting_id
           WHERE j.kind = 'transcribe' AND j.status = 'failed' AND j.finished_at >= $from ${owner}) AS jobs,
         (SELECT COUNT(*) FROM summaries s WHERE s.status = 'failed' AND s.finished_at >= $from ${by}) AS summaries`,
    )
    .get({ ...params, from })!;

  // Buckets: every day or month of the period, empty ones included, so the chart's gaps are real.
  const series: UsageBucket[] = [];
  const index = new Map<string, UsageBucket>();
  for (let t = from; t <= at; t = byMonth ? addMonths(t, 1) : t + DAY) {
    const key = byMonth ? monthKey(t) : dayKey(t);
    if (index.has(key)) continue;
    const b = { key, sec: 0, transcriptions: 0, summaries: 0, points: 0 };
    series.push(b);
    index.set(key, b);
  }
  const bucket = (t: number) => index.get(byMonth ? monthKey(t) : dayKey(t));

  const totals = {
    sec: 0,
    transcriptions: transcriptions.length,
    meetings: new Set(transcriptions.map((r) => r.meeting_id)).size,
    summaries: summaries.length,
    inputTokens: 0,
    outputTokens: 0,
    /** Summaries whose model did not report its tokens (left out of the token totals). */
    unknownTokens: 0,
    pointsTranscription: 0,
    pointsSummary: 0,
    /** Work that was not charged, counted at the current rates instead. */
    estimatedItems: 0,
    failedTranscriptions: failed.jobs,
    failedSummaries: failed.summaries,
  };
  const languages = new Map<string, Group>();
  const lengths = new Map<string, Group>(LENGTHS.map((l) => [l.key, { key: l.key, count: 0, sec: 0, points: 0 }]));
  const weekdays = new Map<string, Group>(Array.from({ length: 7 }, (_, i) => [String(i), { key: String(i), count: 0, sec: 0, points: 0 }]));
  const meetings = new Map<string, { id: string; title: string; sec: number; transcriptions: number; summaries: number; points: number }>();
  const people = new Map<string, { sec: number; transcriptions: number; summaries: number; points: number }>();
  const person = (id: string | null) => {
    const k = id ?? "";
    const p = people.get(k) ?? { sec: 0, transcriptions: 0, summaries: 0, points: 0 };
    people.set(k, p);
    return p;
  };
  const meeting = (id: string, title: string) => {
    const m = meetings.get(id) ?? { id, title, sec: 0, transcriptions: 0, summaries: 0, points: 0 };
    meetings.set(id, m);
    return m;
  };

  const r0 = rates();
  for (const r of transcriptions) {
    const sec = r.duration_sec ?? 0;
    // What it cost, or (not charged) what it comes to at today's rates.
    if (r.charged == null) totals.estimatedItems += 1;
    const pts = r.charged ?? (sec > 0 ? transcriptionCost(sec, r0) : 0);
    totals.sec += sec;
    totals.pointsTranscription += pts;
    const b = bucket(r.finished_at);
    if (b) {
      b.sec += sec;
      b.transcriptions += 1;
      b.points += pts;
    }
    bump(languages, r.language || "", sec, pts);
    const len = LENGTHS.find((l) => sec / 60 < l.max)!;
    bump(lengths, len.key, sec, pts);
    // The weekday the meeting was held (or, without a date, added), in Taiwan.
    bump(weekdays, String(new Date((r.occurred_at ?? r.created_at) + TZ).getUTCDay()), sec, pts);
    const m = meeting(r.meeting_id, r.title);
    m.sec += sec;
    m.transcriptions += 1;
    m.points += pts;
    const p = person(r.owner_id);
    p.sec += sec;
    p.transcriptions += 1;
    p.points += pts;
  }

  const templates = new Map<string, Group & { input: number; output: number }>();
  const models = new Map<string, Group & { input: number; output: number }>();
  const tally = (map: Map<string, Group & { input: number; output: number }>, key: string, pts: number, tk: { input: number; output: number } | null) => {
    const g = map.get(key) ?? { key, count: 0, sec: 0, points: 0, input: 0, output: 0 };
    g.count += 1;
    g.points += pts;
    g.input += tk?.input ?? 0;
    g.output += tk?.output ?? 0;
    map.set(key, g);
  };
  for (const s of summaries) {
    const tk = tokens(s.usage);
    if (s.charged == null) totals.estimatedItems += 1;
    const pts = s.charged ?? (tk ? summaryCost(tk.input, tk.output, r0) : 0);
    totals.pointsSummary += pts;
    if (tk) {
      totals.inputTokens += tk.input;
      totals.outputTokens += tk.output;
    } else totals.unknownTokens += 1;
    const b = bucket(s.finished_at);
    if (b) {
      b.summaries += 1;
      b.points += pts;
    }
    // A summary written from a prompt typed for it has no template name.
    tally(templates, s.template_name ?? "", pts, tk);
    tally(models, s.model ?? "", pts, tk);
    const m = meeting(s.meeting_id, s.title);
    m.summaries += 1;
    m.points += pts;
    const p = person(s.created_by);
    p.summaries += 1;
    p.points += pts;
  }

  const sortTokens = (map: Map<string, Group & { input: number; output: number }>) =>
    [...map.values()].sort((a, b) => b.count - a.count || b.input + b.output - (a.input + a.output));

  // The library as it is now (not limited to the period).
  const library = db
    .query<{ meetings: number; bytes: number | null; sec: number | null }, Record<string, string>>(
      `SELECT COUNT(*) AS meetings, SUM(m.media_size) AS bytes, SUM(m.duration_sec) AS sec FROM meetings m WHERE 1 = 1 ${owner}`,
    )
    .get(params)!;

  let byUser: { id: string | null; username: string | null; displayName: string | null; billing: string | null; sec: number; transcriptions: number; summaries: number; points: number }[] | null = null;
  if (!userId) {
    const names = new Map(
      db
        .query<{ id: string; username: string; display_name: string | null; billing: string }, []>("SELECT id, username, display_name, billing FROM users")
        .all()
        .map((u) => [u.id, u]),
    );
    byUser = [...people.entries()]
      .map(([id, p]) => {
        const u = names.get(id);
        return { id: u ? id : null, username: u?.username ?? null, displayName: u?.display_name ?? null, billing: u?.billing ?? null, ...p };
      })
      .sort((a, b) => b.sec - a.sec || b.summaries - a.summaries);
  }

  const prepaid = userId
    ? db.query<{ billing: string }, { u: string }>("SELECT billing FROM users WHERE id = $u").get({ u: userId })?.billing === "prepaid"
    : false;

  return {
    range,
    by: byMonth ? ("month" as const) : ("day" as const),
    from,
    to: at,
    /** Usage is shown in points, always (charged, or at the current rates). */
    showPoints: true,
    /** The account pays with points. */
    prepaid,
    /** The rates the uncharged work was counted at (points per minute, per thousand tokens). */
    rates: r0,
    totals,
    series,
    languages: sortGroups(languages),
    lengths: LENGTHS.map((l) => lengths.get(l.key)!),
    // Monday first.
    weekdays: [1, 2, 3, 4, 5, 6, 0].map((d) => weekdays.get(String(d))!),
    templates: sortTokens(templates),
    models: sortTokens(models),
    top: [...meetings.values()].sort((a, b) => b.points - a.points || b.sec - a.sec).slice(0, 10),
    library: { meetings: library.meetings, bytes: library.bytes ?? 0, sec: library.sec ?? 0 },
    byUser,
  };
}

export type UsageReport = ReturnType<typeof usageReport>;
