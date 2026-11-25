import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db";
import { parseJson } from "../lib/util";
import type { MeetingRow, SegmentRow, SpeakerRow, TranscribeOptions } from "../types";
import { meetingDir, originalPath, PLAYBACK_FILE } from "./meetings";

/**
 * An evaluation set for comparing speech recognition models (Qwen3-ASR,
 * Breeze ASR…), made from the segments people corrected by hand: their text is
 * what was really said, so it can score a model's output on the same audio.
 *
 * One folder per meeting: the recording, and reference.json with every
 * segment (start, end, speaker name, text, whether it was edited). The worker's
 * `compare-asr` command reads it on a GPU machine. Unedited segments are
 * exported too, marked as such: they are the model's own output, so they say
 * nothing about accuracy, and the comparison leaves them out unless asked.
 */

export interface ExportOptions {
  /** Meetings to export; empty: every ready meeting with at least `minEdited` corrected segments. */
  meetingIds?: string[];
  minEdited?: number;
  /** Copy the small playback copy (mono AAC) instead of the original. */
  playback?: boolean;
}

export interface ExportedMeeting {
  id: string;
  title: string;
  edited: number;
  segments: number;
  audio: string;
}

export function exportAsrEval(outDir: string, opts: ExportOptions = {}): ExportedMeeting[] {
  const minEdited = opts.minEdited ?? 5;
  const edited = db.query<{ n: number }, { m: string }>("SELECT COUNT(*) AS n FROM segments WHERE meeting_id = $m AND edited = 1");
  let meetings: MeetingRow[];
  if (opts.meetingIds?.length) {
    meetings = opts.meetingIds.map((id) => {
      const m = db.query<MeetingRow, { id: string }>("SELECT * FROM meetings WHERE id = $id").get({ id });
      if (!m) throw new Error(`No meeting ${id}.`);
      if (m.status !== "ready") throw new Error(`Meeting ${id} is not transcribed (status ${m.status}).`);
      return m;
    });
  } else {
    meetings = db
      .query<MeetingRow, []>("SELECT * FROM meetings WHERE status = 'ready' ORDER BY COALESCE(occurred_at, created_at) DESC")
      .all()
      .filter((m) => edited.get({ m: m.id })!.n >= minEdited);
  }
  mkdirSync(outDir, { recursive: true });
  const out: ExportedMeeting[] = [];
  for (const m of meetings) {
    const playback = join(meetingDir(m.id), PLAYBACK_FILE);
    const source = opts.playback && existsSync(playback) ? playback : originalPath(m);
    if (!existsSync(source)) throw new Error(`The recording of ${m.id} is missing (${source}).`);
    const dir = join(outDir, m.id);
    mkdirSync(dir, { recursive: true });
    const audio = `audio.${source === playback ? "m4a" : m.media_ext}`;
    copyFileSync(source, join(dir, audio));

    const names = new Map(
      db.query<SpeakerRow, { m: string }>("SELECT * FROM speakers WHERE meeting_id = $m").all({ m: m.id }).map((s) => [s.key, s.name]),
    );
    const segments = db.query<SegmentRow, { m: string }>("SELECT * FROM segments WHERE meeting_id = $m ORDER BY idx").all({ m: m.id });
    const options = parseJson<Partial<TranscribeOptions>>(m.options, {});
    const reference = {
      version: 1,
      meetingId: m.id,
      title: m.title,
      audio,
      durationSec: m.duration_sec,
      language: m.language,
      // As the worker got them, so each model can be given the same hints.
      vocabulary: options.vocabulary ?? "",
      script: options.script ?? "zh-TW",
      segments: segments.map((s) => ({
        start: s.start_sec,
        end: s.end_sec,
        speaker: s.speaker ? (names.get(s.speaker) ?? s.speaker) : null,
        text: s.text,
        edited: !!s.edited,
      })),
    };
    writeFileSync(join(dir, "reference.json"), JSON.stringify(reference, null, 1));
    out.push({ id: m.id, title: m.title, edited: segments.filter((s) => s.edited).length, segments: segments.length, audio });
  }
  return out;
}
