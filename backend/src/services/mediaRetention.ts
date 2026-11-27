import { rm } from "node:fs/promises";
import { db, now } from "../db";
import type { MeetingRow } from "../types";
import { getMeeting, meetingDir, touchMeeting } from "./meetings";
import { mediaSettings } from "./mediaCompaction";

/**
 * Deleting recordings after a while.
 *
 * The site keeps recordings for at most `retentionDays` after transcription
 * (Admin → System; 0 keeps them), and each person may choose a shorter period
 * for their own (Settings). Once it has passed, the meeting's files go (the
 * original, the playback copy, the waveform, any copy waiting for a worker)
 * and the meeting keeps its transcript, speakers and summaries. Without the
 * recording it cannot be played, downloaded, transcribed again or
 * fingerprinted.
 */

const DAY_MS = 86_400_000;
/** The periods a person can choose for their own recordings. */
export const RETENTION_CHOICES = [7, 30] as const;
export type RetentionChoice = (typeof RETENTION_CHOICES)[number];
/** Most recordings deleted by one sweep; the rest follow in the next. */
const SWEEP_LIMIT = 100;

/** The site's maximum, in days; null when it keeps recordings. */
export function siteRetentionDays(): number | null {
  const d = mediaSettings().retentionDays;
  return d > 0 ? d : null;
}

/** How long one person's recordings are kept (the shorter of theirs and the site's); null: kept. */
export function effectiveRetentionDays(own: number | null, site = siteRetentionDays()): number | null {
  if (site == null) return own ?? null;
  if (own == null) return site;
  return Math.min(own, site);
}

/** The same rule in SQL, for the owner `u` of meeting `m`; $site is 0 when the site keeps recordings. */
const EFFECTIVE_SQL = `CASE WHEN $site = 0 THEN u.media_retention_days
  WHEN u.media_retention_days IS NULL THEN $site
  ELSE MIN($site, u.media_retention_days) END`;

/**
 * A meeting's recording: when it was deleted, or when it will be (null when it
 * is kept, or before its transcription has finished).
 */
export function mediaRetention(m: Pick<MeetingRow, "owner_id" | "transcribed_at" | "media_deleted_at">): {
  deletedAt: number | null;
  deletesAt: number | null;
} {
  if (m.media_deleted_at != null) return { deletedAt: m.media_deleted_at, deletesAt: null };
  if (m.transcribed_at == null) return { deletedAt: null, deletesAt: null };
  const own = db
    .query<{ d: number | null }, { u: string }>("SELECT media_retention_days AS d FROM users WHERE id = $u")
    .get({ u: m.owner_id })?.d ?? null;
  const days = effectiveRetentionDays(own);
  return { deletedAt: null, deletesAt: days == null ? null : m.transcribed_at + days * DAY_MS };
}

/**
 * Meetings whose recording is due for deletion: transcribed long enough ago,
 * and with no work queued or running (a transcription, a fingerprint or a
 * compaction reads the recording; it is deleted at the next sweep after).
 */
function dueMeetings(t: number): string[] {
  const site = siteRetentionDays() ?? 0;
  return db
    .query<{ id: string }, { site: number; now: number; day: number; limit: number }>(
      `SELECT m.id FROM meetings m JOIN users u ON u.id = m.owner_id
        WHERE m.media_deleted_at IS NULL AND m.status = 'ready' AND m.transcribed_at IS NOT NULL
          AND (${EFFECTIVE_SQL}) IS NOT NULL
          AND m.transcribed_at + (${EFFECTIVE_SQL}) * $day <= $now
          AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.meeting_id = m.id AND j.status IN ('queued', 'running'))
        ORDER BY m.transcribed_at ASC LIMIT $limit`,
    )
    .all({ site, now: t, day: DAY_MS, limit: SWEEP_LIMIT })
    .map((r) => r.id);
}

/**
 * Delete one meeting's recording, keeping everything else. The row is marked
 * first (so nothing starts reading the files), then the files go.
 */
export async function deleteMeetingMedia(id: string, t = now()): Promise<boolean> {
  const marked = db.transaction(() => {
    const busy = db
      .query<{ n: number }, { m: string }>("SELECT COUNT(*) AS n FROM jobs WHERE meeting_id = $m AND status IN ('queued', 'running')")
      .get({ m: id })!.n;
    if (busy) return false;
    const r = db
      .query(
        `UPDATE meetings SET media_deleted_at = $t, has_playback = 0, has_peaks = 0, has_video = 0,
           media_size = 0, media_received = 0, updated_at = $t
         WHERE id = $id AND media_deleted_at IS NULL AND status = 'ready'`,
      )
      .run({ id, t });
    return r.changes > 0;
  })();
  if (!marked) return false;
  await rm(meetingDir(id), { recursive: true, force: true });
  const m = getMeeting(id);
  if (m) touchMeeting(m);
  return true;
}

/** Delete every recording that is due. Returns how many were. */
export async function sweepMediaRetention(t = now()): Promise<number> {
  let n = 0;
  for (const id of dueMeetings(t)) if (await deleteMeetingMedia(id, t)) n++;
  return n;
}

/** What the admin page shows: recordings deleted so far, and those due within the next week. */
export function retentionStats(t = now()) {
  const deleted = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM meetings WHERE media_deleted_at IS NOT NULL").get()?.n ?? 0;
  const site = siteRetentionDays() ?? 0;
  const soon = db
    .query<{ n: number; bytes: number | null }, { site: number; until: number; day: number }>(
      `SELECT COUNT(*) AS n, SUM(m.media_size) AS bytes FROM meetings m JOIN users u ON u.id = m.owner_id
        WHERE m.media_deleted_at IS NULL AND m.status = 'ready' AND m.transcribed_at IS NOT NULL
          AND (${EFFECTIVE_SQL}) IS NOT NULL
          AND m.transcribed_at + (${EFFECTIVE_SQL}) * $day <= $until`,
    )
    .get({ site, until: t + 7 * DAY_MS, day: DAY_MS });
  return { deleted, dueWithinWeek: soon?.n ?? 0, dueWithinWeekBytes: soon?.bytes ?? 0 };
}
