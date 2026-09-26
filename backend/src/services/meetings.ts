import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { db, now } from "../db";
import { newId, parseJson } from "../lib/util";
import type { JobRow, MeetingRow, SegmentRow, SpeakerRow, SummaryRequest, SummaryRow, TranscribeOptions } from "../types";
import { publish } from "./events";
import { enqueueSummary, summaryPublic } from "./summarizer";

export const SPEAKER_COLORS = 10;

export const DEFAULT_OPTIONS: TranscribeOptions = {
  language: "auto",
  diarize: true,
  numSpeakers: null,
  minSpeakers: null,
  maxSpeakers: null,
  vocabulary: "",
  script: "zh-TW",
};

export const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "wma", "amr", "aiff", "aif", "caf", "weba"];
export const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "webm", "avi", "m4v", "wmv", "flv", "ts", "mts", "m2ts", "3gp", "mpeg", "mpg"];

/**
 * Content type for serving an original file, from its (allow-listed) extension.
 * Never the type the browser declared at upload: that is user input, and e.g.
 * "text/html" would be served from this site's origin.
 */
const MEDIA_TYPES: Record<string, string> = {
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg",
  oga: "audio/ogg", opus: "audio/ogg", wma: "audio/x-ms-wma", amr: "audio/amr", aiff: "audio/aiff", aif: "audio/aiff",
  caf: "audio/x-caf", weba: "audio/webm", mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska",
  webm: "video/webm", avi: "video/x-msvideo", m4v: "video/mp4", wmv: "video/x-ms-wmv", flv: "video/x-flv",
  ts: "video/mp2t", mts: "video/mp2t", m2ts: "video/mp2t", "3gp": "video/3gpp", mpeg: "video/mpeg", mpg: "video/mpeg",
};

export function mediaTypeFor(ext: string): string {
  return MEDIA_TYPES[ext] ?? "application/octet-stream";
}

export function meetingDir(id: string): string {
  return join(config.mediaDir, id);
}

export function originalPath(m: Pick<MeetingRow, "id" | "media_ext">): string {
  return join(meetingDir(m.id), `original.${m.media_ext}`);
}

export const PLAYBACK_FILE = "playback.m4a";
export const PEAKS_FILE = "peaks.json";

export function ensureMeetingDir(id: string) {
  mkdirSync(meetingDir(id), { recursive: true });
}

export function getMeeting(id: string): MeetingRow | null {
  return db.query<MeetingRow, { id: string }>("SELECT * FROM meetings WHERE id = $id").get({ id });
}

export function getOwnedMeeting(id: string, userId: string): MeetingRow | null {
  return db
    .query<MeetingRow, { id: string; u: string }>("SELECT * FROM meetings WHERE id = $id AND owner_id = $u")
    .get({ id, u: userId });
}

export function touchMeeting(m: MeetingRow) {
  publish(m.owner_id, { type: "meeting.updated", meetingId: m.id });
}

/** Plain text of a Markdown line, for previews. */
function plain(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#|]+/g, "")
    .replace(/^\s*([-+]|\d+\.)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The gist of a summary for list previews: the paragraph under a
 * "Summary / 摘要 / TL;DR" heading when present, otherwise the first prose
 * paragraph after the title.
 */
export function summaryExcerpt(content: string, max = 180): string | null {
  const lines = content.replace(/```[\s\S]*?```/g, "").split("\n");
  const isHeading = (l: string) => /^#{1,6}\s/.test(l);
  const gist = /^#{1,4}\s*(summary|tl;?dr|overview|摘要|重點|概要|總結)/i;
  const collect = (from: number) => {
    const out: string[] = [];
    for (let i = from; i < lines.length; i++) {
      const l = lines[i]!.trim();
      if (isHeading(l)) {
        if (out.length) break;
        continue;
      }
      if (!l) {
        if (out.length) break;
        continue;
      }
      if (/^\|/.test(l)) continue;
      out.push(plain(l));
    }
    return out.join(" ").trim();
  };
  const at = lines.findIndex((l) => gist.test(l.trim()));
  let text = at >= 0 ? collect(at + 1) : "";
  if (!text) {
    // Skip the title and a short metadata line directly under it.
    const first = lines.findIndex((l) => /^#\s/.test(l.trim()));
    text = collect(first >= 0 ? first + 1 : 0);
    if (text.length < 40) text = collect(lines.findIndex((l, i) => i > first + 1 && isHeading(l.trim())) + 1) || text;
  }
  if (!text) return null;
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

export function meetingSummary(m: MeetingRow) {
  const latest = db
    .query<Pick<SummaryRow, "id" | "status" | "created_at">, { m: string }>(
      "SELECT id, status, created_at FROM summaries WHERE meeting_id = $m ORDER BY created_at DESC LIMIT 1",
    )
    .get({ m: m.id });
  const speakerCount =
    db.query<{ n: number }, { m: string }>("SELECT COUNT(*) AS n FROM speakers WHERE meeting_id = $m").get({ m: m.id })?.n ?? 0;
  const latestDone = db
    .query<{ content: string | null }, { m: string }>(
      "SELECT content FROM summaries WHERE meeting_id = $m AND status = 'done' ORDER BY created_at DESC LIMIT 1",
    )
    .get({ m: m.id });
  const preview = db
    .query<{ text: string }, { m: string }>(
      "SELECT group_concat(text, ' ') AS text FROM (SELECT text FROM segments WHERE meeting_id = $m ORDER BY idx LIMIT 6)",
    )
    .get({ m: m.id })?.text;
  const options = parseJson<TranscribeOptions>(m.options, DEFAULT_OPTIONS);
  return {
    id: m.id,
    title: m.title,
    occurredAt: m.occurred_at,
    status: m.status,
    stage: m.stage,
    progress: m.progress,
    error: m.error,
    media: {
      name: m.media_name,
      mime: m.media_mime,
      size: m.media_size,
      received: m.media_received,
      hasVideo: !!m.has_video,
      hasPlayback: !!m.has_playback,
      hasPeaks: !!m.has_peaks,
    },
    durationSec: m.duration_sec,
    language: m.language,
    options,
    speakerCount,
    diarization: parseJson<DiarizationOutcome | null>(m.diarization, null),
    preview: preview ? preview.slice(0, 220) : null,
    summaryExcerpt: latestDone?.content ? summaryExcerpt(latestDone.content) : null,
    latestSummary: latest ? { id: latest.id, status: latest.status, createdAt: latest.created_at } : null,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    transcribedAt: m.transcribed_at,
  };
}

export function meetingDetail(m: MeetingRow) {
  const speakers = db
    .query<SpeakerRow, { m: string }>("SELECT * FROM speakers WHERE meeting_id = $m ORDER BY key")
    .all({ m: m.id });
  const segments = db
    .query<SegmentRow, { m: string }>("SELECT * FROM segments WHERE meeting_id = $m ORDER BY idx")
    .all({ m: m.id });
  const summaries = db
    .query<SummaryRow, { m: string }>("SELECT * FROM summaries WHERE meeting_id = $m ORDER BY created_at DESC")
    .all({ m: m.id });
  return {
    ...meetingSummary(m),
    autoSummary: parseJson<SummaryRequest | null>(m.auto_summary, null),
    speakers: speakers.map((s) => ({ key: s.key, name: s.name, color: s.color })),
    segments: segments.map((s) => ({
      id: s.id,
      start: s.start_sec,
      end: s.end_sec,
      speaker: s.speaker,
      text: s.text,
      edited: !!s.edited,
    })),
    summaries: summaries.map(summaryPublic),
  };
}

export async function deleteMeeting(m: MeetingRow) {
  db.query("UPDATE jobs SET status = 'canceled', finished_at = $t WHERE meeting_id = $m AND status IN ('queued','running')").run({
    m: m.id,
    t: now(),
  });
  db.query("DELETE FROM meetings WHERE id = $id").run({ id: m.id });
  await rm(meetingDir(m.id), { recursive: true, force: true });
  publish(m.owner_id, { type: "meeting.deleted", meetingId: m.id });
}

// -------------------------------------------------------------- job queue

export function enqueueTranscription(m: MeetingRow) {
  db.transaction(() => {
    db.query("UPDATE jobs SET status = 'canceled', finished_at = $t WHERE meeting_id = $m AND status IN ('queued','running')").run({
      m: m.id,
      t: now(),
    });
    db.query("INSERT INTO jobs (id, meeting_id, status, created_at) VALUES ($id, $m, 'queued', $t)").run({
      id: newId(12),
      m: m.id,
      t: now(),
    });
    db.query(
      "UPDATE meetings SET status = 'queued', stage = NULL, progress = 0, error = NULL, updated_at = $t WHERE id = $id",
    ).run({ id: m.id, t: now() });
  })();
  touchMeeting(m);
}

export interface ClaimedJob {
  jobId: string;
  meetingId: string;
  attempt: number;
  mediaPath: string;
  outDir: string;
  options: TranscribeOptions;
  title: string;
}

export function claimJob(workerId: string): ClaimedJob | null {
  return db.transaction((): ClaimedJob | null => {
    const job = db
      .query<JobRow, []>("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
      .get();
    if (!job) return null;
    const t = now();
    db.query(
      "UPDATE jobs SET status = 'running', worker_id = $w, attempts = attempts + 1, claimed_at = $t, heartbeat_at = $t WHERE id = $id",
    ).run({ id: job.id, w: workerId, t });
    const m = getMeeting(job.meeting_id)!;
    db.query("UPDATE meetings SET status = 'processing', stage = 'starting', progress = 0, updated_at = $t WHERE id = $id").run({
      id: m.id,
      t,
    });
    touchMeeting(m);
    return {
      jobId: job.id,
      meetingId: m.id,
      attempt: job.attempts + 1,
      mediaPath: originalPath(m),
      outDir: meetingDir(m.id),
      options: { ...DEFAULT_OPTIONS, ...parseJson<Partial<TranscribeOptions>>(m.options, {}) },
      title: m.title,
    };
  })();
}

function getRunningJob(jobId: string, workerId: string): JobRow | null {
  return db
    .query<JobRow, { id: string; w: string }>("SELECT * FROM jobs WHERE id = $id AND worker_id = $w AND status = 'running'")
    .get({ id: jobId, w: workerId });
}

/** Returns false when the job is no longer ours (canceled, reassigned or deleted). */
export function reportProgress(jobId: string, workerId: string, stage: string, progress: number): boolean {
  const job = getRunningJob(jobId, workerId);
  if (!job) return false;
  const t = now();
  db.query("UPDATE jobs SET heartbeat_at = $t WHERE id = $id").run({ id: jobId, t });
  db.query("UPDATE meetings SET stage = $stage, progress = $p, updated_at = $t WHERE id = $id").run({
    id: job.meeting_id,
    stage: stage.slice(0, 64),
    p: Math.max(0, Math.min(1, progress)),
    t,
  });
  const m = getMeeting(job.meeting_id);
  if (m) touchMeeting(m);
  return true;
}

export interface TranscriptResult {
  durationSec: number;
  language: string | null;
  hasVideo: boolean;
  hasPlayback: boolean;
  hasPeaks: boolean;
  speakers: string[];
  segments: { start: number; end: number; speaker: string | null; text: string }[];
  diarization?: DiarizationOutcome;
}

/**
 * What happened to speaker diarization in a transcription:
 * ok (ran), off (not requested), unavailable (model could not be loaded),
 * failed (ran into an error; the transcript has no speakers).
 */
export interface DiarizationOutcome {
  status: "ok" | "off" | "unavailable" | "failed";
  reason?: string | null;
  speakers?: number;
}

export function completeJob(jobId: string, workerId: string, result: TranscriptResult): boolean {
  const job = getRunningJob(jobId, workerId);
  if (!job) return false;
  const t = now();
  let meeting: MeetingRow | null = null;
  db.transaction(() => {
    db.query("UPDATE jobs SET status = 'done', finished_at = $t, heartbeat_at = $t WHERE id = $id").run({ id: jobId, t });
    const m = job.meeting_id;
    // Keep user-assigned speaker names across re-transcriptions where keys match.
    const previousNames = new Map(
      db
        .query<SpeakerRow, { m: string }>("SELECT * FROM speakers WHERE meeting_id = $m")
        .all({ m })
        .map((s) => [s.key, s.name]),
    );
    db.query("DELETE FROM segments WHERE meeting_id = $m").run({ m });
    db.query("DELETE FROM speakers WHERE meeting_id = $m").run({ m });
    const insSpeaker = db.query("INSERT INTO speakers (meeting_id, key, name, color) VALUES ($m, $key, $name, $color)");
    result.speakers.forEach((key, i) => {
      insSpeaker.run({ m, key, name: previousNames.get(key) ?? `Speaker ${i + 1}`, color: i % SPEAKER_COLORS });
    });
    const insSeg = db.query(
      "INSERT INTO segments (meeting_id, idx, start_sec, end_sec, speaker, text) VALUES ($m, $idx, $s, $e, $sp, $text)",
    );
    const known = new Set(result.speakers);
    result.segments.forEach((seg, idx) => {
      insSeg.run({
        m,
        idx,
        s: seg.start,
        e: seg.end,
        sp: seg.speaker && known.has(seg.speaker) ? seg.speaker : null,
        text: seg.text,
      });
    });
    db.query(
      `UPDATE meetings SET status = 'ready', stage = NULL, progress = 1, error = NULL, duration_sec = $d, language = $lang,
         has_video = $hv, has_playback = $hp, has_peaks = $hk, diarization = $dz, transcribed_at = $t, updated_at = $t WHERE id = $id`,
    ).run({
      id: m,
      d: result.durationSec,
      lang: result.language,
      hv: result.hasVideo ? 1 : 0,
      hp: result.hasPlayback && existsSync(join(meetingDir(m), PLAYBACK_FILE)) ? 1 : 0,
      hk: result.hasPeaks && existsSync(join(meetingDir(m), PEAKS_FILE)) ? 1 : 0,
      dz: result.diarization ? JSON.stringify(result.diarization) : null,
      t,
    });
    meeting = getMeeting(m);
  })();
  const m = meeting as MeetingRow | null;
  if (m) {
    touchMeeting(m);
    const auto = parseJson<SummaryRequest | null>(m.auto_summary, null);
    // Auto-summarise only once: the first successful transcription.
    const hasSummary = db.query<{ n: number }, { m: string }>("SELECT COUNT(*) AS n FROM summaries WHERE meeting_id = $m").get({ m: m.id })?.n;
    if (auto && auto.prompt.trim() && !hasSummary) enqueueSummary(m, m.owner_id, auto);
  }
  return true;
}

export function failJob(jobId: string, workerId: string, error: string, retryable: boolean): boolean {
  const job = getRunningJob(jobId, workerId);
  if (!job) return false;
  finishFailedJob(job, error, retryable);
  return true;
}

function finishFailedJob(job: JobRow, error: string, retryable: boolean) {
  const t = now();
  const retry = retryable && job.attempts < config.jobMaxAttempts;
  if (retry) {
    db.query("UPDATE jobs SET status = 'queued', worker_id = NULL, error = $e WHERE id = $id").run({ id: job.id, e: error });
    db.query("UPDATE meetings SET status = 'queued', stage = 'retrying', progress = 0, updated_at = $t WHERE id = $id").run({
      id: job.meeting_id,
      t,
    });
  } else {
    db.query("UPDATE jobs SET status = 'failed', error = $e, finished_at = $t WHERE id = $id").run({ id: job.id, e: error, t });
    db.query("UPDATE meetings SET status = 'failed', stage = NULL, error = $e, updated_at = $t WHERE id = $id").run({
      id: job.meeting_id,
      e: error.slice(0, 2000),
      t,
    });
  }
  const m = getMeeting(job.meeting_id);
  if (m) touchMeeting(m);
}

/** Requeue jobs whose worker stopped sending heartbeats. */
export function reapStaleJobs() {
  const cutoff = now() - config.jobStaleSeconds * 1000;
  const stale = db
    .query<JobRow, { c: number }>("SELECT * FROM jobs WHERE status = 'running' AND heartbeat_at < $c")
    .all({ c: cutoff });
  for (const job of stale) {
    console.warn(`[jobs] job ${job.id} lost its worker (${job.worker_id}); requeueing`);
    finishFailedJob(job, "The worker stopped responding.", true);
  }
}

export function queueStats() {
  const rows = db
    .query<{ status: string; n: number }, []>("SELECT status, COUNT(*) AS n FROM jobs WHERE status IN ('queued','running') GROUP BY status")
    .all();
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return { queued: by.queued ?? 0, running: by.running ?? 0 };
}
