import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { db, now } from "../db";
import { newId } from "../lib/util";
import type { SlideRow } from "../types";

/**
 * Pictures of what was on screen during a meeting: slides, a shared screen.
 *
 * They are picked in the uploader's own browser (WebGL compares the video's
 * frames and keeps one each time the picture changes a lot, as when a slide
 * changes), so only those pictures are sent, never the video itself. Summaries
 * may be shown them, paid for like the rest of what the model reads.
 *
 * They are kept apart from the recording (data/slides/<meeting>), so deleting
 * the recording after its retention period leaves them with the transcript.
 */

export const SLIDE_LIMITS = {
  /** Pictures one meeting may have. */
  perMeeting: 300,
  /** Largest picture (JPEG), in bytes. The browser sends about 100–300 KB. */
  maxBytes: 1536 * 1024,
  /** Longest side, in pixels. */
  maxEdge: 2560,
  /** Smallest side: a picture smaller than this holds nothing readable. */
  minEdge: 64,
  /** Most pictures one summary is shown (Anthropic takes up to 100 in one request). */
  perSummary: 50,
  /** Most bytes of pictures one request carries (base64 adds a third; requests are capped at 32 MB). */
  summaryBytes: 16 * 1024 * 1024,
};

export function slidesDir(meetingId: string): string {
  return join(config.dataDir, "slides", meetingId);
}

export function slidePath(s: Pick<SlideRow, "id" | "meeting_id">): string {
  return join(slidesDir(s.meeting_id), `${s.id}.jpg`);
}

/** Width and height of a baseline or progressive JPEG, or null when it is not one. */
export function jpegSize(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    // Fill bytes, and markers without a length.
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (buf[i + 2]! << 8) | buf[i + 3]!;
    if (len < 2) return null;
    // Start of frame (any coding except the DHT/JPG/DAC markers among C4, C8, CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (buf[i + 5]! << 8) | buf[i + 6]!;
      const width = (buf[i + 7]! << 8) | buf[i + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (marker === 0xda) return null; // image data before any frame header
    i += 2 + len;
  }
  return null;
}

export class SlideError extends Error {
  constructor(
    readonly status: 400 | 409 | 413 | 415,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export function listSlides(meetingId: string): SlideRow[] {
  return db.query<SlideRow, { m: string }>("SELECT * FROM slides WHERE meeting_id = $m ORDER BY at_sec, created_at").all({ m: meetingId });
}

export function slideCount(meetingId: string): number {
  return db.query<{ n: number }, { m: string }>("SELECT COUNT(*) AS n FROM slides WHERE meeting_id = $m").get({ m: meetingId })?.n ?? 0;
}

export function getSlide(meetingId: string, id: string): SlideRow | null {
  return db.query<SlideRow, { m: string; id: string }>("SELECT * FROM slides WHERE meeting_id = $m AND id = $id").get({ m: meetingId, id });
}

/** Store one picture. The same `clientKey` sent again returns the picture stored the first time. */
export async function addSlide(meetingId: string, clientKey: string, atSec: number, data: Uint8Array): Promise<SlideRow> {
  const existing = db
    .query<SlideRow, { m: string; k: string }>("SELECT * FROM slides WHERE meeting_id = $m AND client_key = $k")
    .get({ m: meetingId, k: clientKey });
  if (existing) return existing;
  if (data.byteLength === 0) throw new SlideError(400, "The picture is empty.", "bad_request");
  if (data.byteLength > SLIDE_LIMITS.maxBytes) throw new SlideError(413, "The picture is too large.", "too_large");
  const size = jpegSize(data);
  if (!size) throw new SlideError(415, "Pictures must be JPEG images.", "unsupported_type");
  const long = Math.max(size.width, size.height);
  const short = Math.min(size.width, size.height);
  if (long > SLIDE_LIMITS.maxEdge || short < SLIDE_LIMITS.minEdge) {
    throw new SlideError(415, `Pictures must be between ${SLIDE_LIMITS.minEdge} and ${SLIDE_LIMITS.maxEdge} pixels a side.`, "unsupported_type");
  }
  if (slideCount(meetingId) >= SLIDE_LIMITS.perMeeting) {
    throw new SlideError(409, `A meeting can have at most ${SLIDE_LIMITS.perMeeting} pictures.`, "too_many_slides");
  }
  const id = newId(12);
  const dir = slidesDir(meetingId);
  mkdirSync(dir, { recursive: true });
  const row: SlideRow = {
    id,
    meeting_id: meetingId,
    client_key: clientKey,
    at_sec: atSec,
    width: size.width,
    height: size.height,
    bytes: data.byteLength,
    created_at: now(),
  };
  await Bun.write(slidePath(row), data);
  try {
    db.query(
      `INSERT INTO slides (id, meeting_id, client_key, at_sec, width, height, bytes, created_at)
       VALUES ($id, $m, $k, $at, $w, $h, $b, $t)`,
    ).run({ id, m: meetingId, k: clientKey, at: atSec, w: size.width, h: size.height, b: data.byteLength, t: row.created_at });
  } catch (e) {
    await unlink(slidePath(row)).catch(() => undefined);
    // Sent twice at once: the other request stored it.
    const raced = db
      .query<SlideRow, { m: string; k: string }>("SELECT * FROM slides WHERE meeting_id = $m AND client_key = $k")
      .get({ m: meetingId, k: clientKey });
    if (raced) return raced;
    throw e;
  }
  return row;
}

export async function deleteSlide(s: SlideRow): Promise<void> {
  db.query("DELETE FROM slides WHERE id = $id").run({ id: s.id });
  await unlink(slidePath(s)).catch(() => undefined);
}

/** Every picture of a meeting (the meeting is being deleted). */
export async function removeSlides(meetingId: string): Promise<void> {
  db.query("DELETE FROM slides WHERE meeting_id = $m").run({ m: meetingId });
  await rm(slidesDir(meetingId), { recursive: true, force: true });
}

export function slidePublic(s: SlideRow) {
  return { id: s.id, at: s.at_sec, width: s.width, height: s.height };
}

/**
 * About how many tokens a model spends reading a picture: Anthropic counts
 * width × height / 750 after scaling it to fit 1568 pixels and 1.15 megapixels;
 * OpenAI's and Gemini's counts come out close to that for slide-sized pictures.
 */
export function slideTokens(width: number, height: number): number {
  let w = width;
  let h = height;
  const edge = 1568 / Math.max(w, h);
  if (edge < 1) {
    w *= edge;
    h *= edge;
  }
  const area = Math.sqrt(1_150_000 / (w * h));
  if (area < 1) {
    w *= area;
    h *= area;
  }
  return Math.ceil((w * h) / 750);
}

/** The pictures one summary is shown: all of them, or an even spread across the meeting when there are too many. */
export function slidesForSummary(meetingId: string): SlideRow[] {
  const all = listSlides(meetingId).filter((s) => existsSync(slidePath(s)));
  let picked = all;
  if (all.length > SLIDE_LIMITS.perSummary) {
    const step = all.length / SLIDE_LIMITS.perSummary;
    picked = Array.from({ length: SLIDE_LIMITS.perSummary }, (_, i) => all[Math.floor(i * step)]!);
  }
  const out: SlideRow[] = [];
  let bytes = 0;
  for (const s of picked) {
    if (bytes + s.bytes > SLIDE_LIMITS.summaryBytes) break;
    bytes += s.bytes;
    out.push(s);
  }
  return out;
}

export function slideTokensTotal(slides: SlideRow[]): number {
  return slides.reduce((n, s) => n + slideTokens(s.width, s.height), 0);
}

/** A picture's bytes as base64, for a model request. */
export function slideBase64(s: SlideRow): string {
  return readFileSync(slidePath(s)).toString("base64");
}
