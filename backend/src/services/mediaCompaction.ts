import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { z } from "zod";
import { config } from "../config";
import { db, now } from "../db";
import { newId, parseJson } from "../lib/util";
import type { MeetingRow } from "../types";
import { COMPACT_EXT, compactTempPath, getMeeting, getRunningJob, originalPath, touchMeeting } from "./meetings";
import { deleteSetting, readSetting, settingMeta, writeSetting } from "./settingsStore";

/**
 * Compacting originals to save disk space.
 *
 * Once a meeting has been transcribed and `afterDays` have passed, a worker
 * re-encodes its original as mono Opus (MEDIA_COMPACT_KBPS, 32 kbit/s by
 * default: about 14 MB per hour), dropping any video, and the backend swaps
 * the copy in. Everything that reads the original (re-transcribing,
 * re-splitting speakers, voice fingerprints) needs only its audio; the video
 * pane and downloading the video as uploaded are what is given up.
 *
 * Only originals that shrink are touched: any video, or audio above 1.5 times
 * the target bitrate. Meetings without the small playback copy (which the
 * player uses) are left alone, so playback never depends on Opus support.
 */

export const mediaSettingsSchema = z.object({
  compact: z.boolean(),
  /** Days after transcription before the original is compacted (0: at once). */
  afterDays: z.number().int().min(0).max(3650),
  /** Recordings are deleted this many days after transcription (0: kept). Each person may choose shorter. */
  retentionDays: z.union([z.literal(0), z.literal(7), z.literal(30)]),
});

export type MediaSettings = z.infer<typeof mediaSettingsSchema>;

const KEY = "media";
const DAY_MS = 86_400_000;
/** Most compactions queued by one sweep; the rest follow in the next. */
const SWEEP_LIMIT = 50;

export function defaultMediaSettings(): MediaSettings {
  return { compact: config.media.compact, afterDays: config.media.compactAfterDays, retentionDays: config.media.retentionDays };
}

export function mediaSettings(): MediaSettings {
  const defaults = defaultMediaSettings();
  const value = readSetting(KEY);
  if (value === null) return defaults;
  const parsed = mediaSettingsSchema.safeParse({ ...defaults, ...parseJson<Partial<MediaSettings>>(value, {}) });
  return parsed.success ? parsed.data : defaults;
}

export function mediaSettingsMeta() {
  return settingMeta(KEY);
}

export function saveMediaSettings(settings: MediaSettings, userId: string): MediaSettings {
  writeSetting(KEY, mediaSettingsSchema.parse(settings), userId);
  return mediaSettings();
}

export function resetMediaSettings(): MediaSettings {
  deleteSetting(KEY);
  return mediaSettings();
}

/** Bytes per second of a compacted original. */
function compactBytesPerSec(): number {
  return (config.media.compactKbps * 1000) / 8;
}

/**
 * Meetings whose original would shrink. `dueBy`: only those transcribed at or
 * before this time. A meeting with a job queued or running is skipped (it is
 * being transcribed again, or already being compacted), and so is one whose
 * compaction failed for good, so it is not tried over and over.
 */
const CANDIDATES = `
  FROM meetings m
  WHERE m.status = 'ready' AND m.compacted_at IS NULL AND m.has_playback = 1
    AND m.transcribed_at IS NOT NULL AND m.transcribed_at <= $dueBy
    AND m.duration_sec > 0
    AND (m.has_video = 1 OR m.media_size * 8.0 / m.duration_sec > $minBps)
    AND NOT EXISTS (
      SELECT 1 FROM jobs j WHERE j.meeting_id = m.id
        AND (j.status IN ('queued', 'running') OR (j.kind = 'compact' AND j.status = 'failed'))
    )`;

function candidateParams(dueBy: number) {
  return { dueBy, minBps: config.media.compactKbps * 1000 * 1.5 };
}

/**
 * Queue compactions for meetings that are due. Returns how many were queued.
 * Videos are turned into audio as soon as they are transcribed (unless
 * MEDIA_KEEP_VIDEO is set); other originals follow the policy.
 */
export function enqueueCompactions(): number {
  const s = mediaSettings();
  const t = now();
  const videos = !config.media.keepVideo;
  if (!s.compact && !videos) return 0;
  return db.transaction(() => {
    const ids = new Set<string>();
    const pick = (sql: string, dueBy: number) => {
      for (const { id } of db
        .query<{ id: string }, { dueBy: number; minBps: number; limit: number }>(`SELECT m.id ${CANDIDATES} ${sql} ORDER BY m.transcribed_at ASC LIMIT $limit`)
        .all({ ...candidateParams(dueBy), limit: SWEEP_LIMIT - ids.size }))
        ids.add(id);
    };
    if (videos) pick("AND m.has_video = 1", t);
    if (s.compact && ids.size < SWEEP_LIMIT) pick("", t - s.afterDays * DAY_MS);
    const insert = db.query("INSERT INTO jobs (id, meeting_id, status, kind, created_at) VALUES ($id, $m, 'queued', 'compact', $t)");
    for (const id of ids) insert.run({ id: newId(12), m: id, t });
    return ids.size;
  })();
}

/** What the admin page shows: what has been saved, and what compacting would still save. */
export function compactionStats() {
  const done = db
    .query<{ n: number; saved: number | null }, []>(
      "SELECT COUNT(*) AS n, SUM(original_size - media_size) AS saved FROM meetings WHERE compacted_at IS NOT NULL",
    )
    .get();
  const bps = compactBytesPerSec();
  const estimate = (dueBy: number) =>
    db
      .query<{ n: number; bytes: number | null; after: number | null }, { dueBy: number; minBps: number }>(
        `SELECT COUNT(*) AS n, SUM(m.media_size) AS bytes, SUM(m.duration_sec) AS after ${CANDIDATES}`,
      )
      .get(candidateParams(dueBy));
  const all = estimate(Number.MAX_SAFE_INTEGER);
  const due = estimate(now() - mediaSettings().afterDays * DAY_MS);
  const saving = (r: { bytes: number | null; after: number | null } | null) => Math.max(0, (r?.bytes ?? 0) - (r?.after ?? 0) * bps);
  const failed = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'compact' AND status = 'failed'").get();
  return {
    compacted: done?.n ?? 0,
    savedBytes: Math.max(0, done?.saved ?? 0),
    /** Not compacted yet (whether due or not), and what compacting them would save. */
    candidates: all?.n ?? 0,
    candidateSavingBytes: Math.round(saving(all)),
    /** Of those, the ones old enough to be compacted now. */
    due: due?.n ?? 0,
    dueSavingBytes: Math.round(saving(due)),
    failed: failed?.n ?? 0,
    bitrateKbps: config.media.compactKbps,
  };
}

/** The worker's report of the copy it wrote; its size is taken from the file itself. */
export interface CompactResult {
  durationSec: number;
}

/**
 * Swap the compact copy in for the original. Returns false when the job is no
 * longer this worker's. The copy is thrown away, and the original kept, when
 * the meeting is busy again (being transcribed) or the copy does not check out.
 */
export function completeCompactJob(jobId: string, workerId: string, result: CompactResult): boolean {
  const job = getRunningJob(jobId, workerId);
  if (!job || job.kind !== "compact") return false;
  const tmp = compactTempPath(job.meeting_id);
  let swapped: MeetingRow | null = null;
  db.transaction(() => {
    const t = now();
    const finish = (status: "done" | "failed" | "canceled", error: string | null = null) =>
      db.query("UPDATE jobs SET status = $s, error = $e, finished_at = $t, heartbeat_at = $t WHERE id = $id").run({ id: jobId, s: status, e: error, t });
    const m = getMeeting(job.meeting_id);
    const busy = db
      .query<{ n: number }, { m: string; id: string }>(
        "SELECT COUNT(*) AS n FROM jobs WHERE meeting_id = $m AND id != $id AND status IN ('queued', 'running')",
      )
      .get({ m: job.meeting_id, id: jobId })!.n;
    if (!m || m.status !== "ready" || m.compacted_at != null || busy) {
      // Being transcribed again (which reads the original), or already done: keep the original as it is.
      rmSync(tmp, { force: true });
      finish("canceled", "The meeting was busy; it will be compacted later.");
      return;
    }
    const size = existsSync(tmp) ? statSync(tmp).size : 0;
    const expected = m.duration_sec ?? 0;
    const tolerance = Math.max(2, expected * 0.02);
    if (size === 0 || (expected > 0 && Math.abs(result.durationSec - expected) > tolerance)) {
      rmSync(tmp, { force: true });
      finish(
        "failed",
        size === 0
          ? "The compact copy is missing or empty."
          : `The compact copy is ${result.durationSec.toFixed(1)} s long, but the recording is ${expected.toFixed(1)} s; the original was kept.`,
      );
      return;
    }
    const oldPath = originalPath(m);
    const newPath = originalPath({ id: m.id, media_ext: COMPACT_EXT });
    renameSync(tmp, newPath);
    db.query(
      `UPDATE meetings SET original_size = media_size, media_size = $size, media_received = $size, media_ext = $ext,
         media_mime = 'audio/ogg', media_name = $name, has_video = 0, compacted_at = $t, updated_at = $t WHERE id = $id`,
    ).run({ id: m.id, size, ext: COMPACT_EXT, name: compactName(m.media_name), t });
    if (oldPath !== newPath) rmSync(oldPath, { force: true });
    finish("done");
    swapped = getMeeting(m.id);
  })();
  if (swapped) touchMeeting(swapped);
  return true;
}

/** "Weekly sync.mp4" → "Weekly sync.opus". */
export function compactName(name: string): string {
  const stem = name.replace(/\.[^./\\]{1,8}$/, "");
  return `${stem || "recording"}.${COMPACT_EXT}`;
}

/** Shown on the upload page, so people know a video will not be kept as uploaded. */
export function publicMediaPolicy(s: MediaSettings = mediaSettings()): { compact: boolean; afterDays: number; videoAudioOnly: boolean } {
  return { compact: s.compact, afterDays: s.afterDays, videoAudioOnly: !config.media.keepVideo };
}
