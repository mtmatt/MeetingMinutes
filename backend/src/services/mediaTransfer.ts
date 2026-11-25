import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config, REPO_ROOT } from "../config";
import { db } from "../db";
import type { MeetingRow } from "../types";
import { getMeeting, meetingDir, originalPath } from "./meetings";

/**
 * What a worker on another machine downloads: the recording's audio as a small
 * copy (mono Ogg Opus, 48 kbit/s: about 21 MB per hour), not the original as
 * uploaded, which may be a video or an uncompressed WAV several times larger.
 * Over a slow link between this server and the worker, sending the original
 * can take longer than the transcription itself.
 *
 * The worker needs only the sound: it decodes to 16 kHz mono for recognition
 * and makes the playback copy (mono AAC, 64 kbit/s) from it. Whether the
 * original has video is found here, from the original, and recorded when the
 * transcription comes back.
 *
 * The copy is made on first request, here, with ffmpeg (the one that comes with
 * the worker's Python packages, FFMPEG_BIN, or one on the PATH), one at a time
 * and at low priority, so the web server stays responsive on a small machine.
 * Until it is ready the worker is told to ask again; without ffmpeg, or when
 * the copy would not be much smaller, the original is sent as before. The
 * copy is removed once nothing is running for the meeting.
 */

export const TRANSFER_FILE = "transfer.ogg";
const TRANSFER_TMP = "transfer.tmp.ogg";
const TRANSFER_META = "transfer.json";
const TRANSFER_KBPS = 48;
export const transferTuning = {
  /** Originals smaller than this are sent as they are (a few minutes of compressed audio). */
  minOriginalBytes: 8 * 1024 * 1024,
};
/** The copy must be at most this share of the original's size to be worth sending instead. */
const MAX_RATIO = 0.8;
/** An encode that takes longer than this is stopped, and the original sent instead. */
const ENCODE_TIMEOUT_MS = 30 * 60 * 1000;
/** Copies left behind (a worker that never came back) are removed after this long. */
const STALE_MS = 6 * 3600 * 1000;

export type TransferState =
  | { kind: "ready"; path: string; size: number; hasVideo: boolean | null }
  | { kind: "pending" }
  | { kind: "original" };

interface TransferMeta {
  /** The original it was made from (name, size, modification time), so a replaced original is noticed. */
  source: string;
  size: number;
  mtimeMs: number;
  use: "transfer" | "original";
  hasVideo: boolean | null;
  error?: string;
}

const encoding = new Map<string, Promise<void>>();
let queue: Promise<void> = Promise.resolve();

let ffmpegCache: string | null | undefined;

/** An ffmpeg this server can run, or null. Looked up once. */
export function ffmpegBin(): string | null {
  if (ffmpegCache !== undefined) return ffmpegCache;
  const candidates: string[] = [];
  if (process.env.FFMPEG_BIN?.trim()) candidates.push(process.env.FFMPEG_BIN.trim());
  // The worker's own ffmpeg (imageio-ffmpeg), present wherever install.sh set up a worker.
  const python = join(REPO_ROOT, "worker", ".venv", "bin", "python");
  if (existsSync(python)) {
    try {
      const out = Bun.spawnSync([python, "-I", "-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const path = out.stdout.toString().trim();
      if (out.exitCode === 0 && path) candidates.push(path);
    } catch {
      // no usable Python there
    }
  }
  candidates.push("ffmpeg");
  ffmpegCache = null;
  for (const bin of candidates) {
    try {
      if (Bun.spawnSync([bin, "-hide_banner", "-version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0) {
        ffmpegCache = bin;
        break;
      }
    } catch {
      // not found
    }
  }
  if (!ffmpegCache) console.warn("[media] no ffmpeg found: workers on other machines will download originals as uploaded");
  return ffmpegCache;
}

/** For tests. */
export function resetFfmpegCache(bin?: string | null) {
  ffmpegCache = bin;
}

function metaPath(id: string) {
  return join(meetingDir(id), TRANSFER_META);
}

function readMeta(id: string): TransferMeta | null {
  try {
    return JSON.parse(readFileSync(metaPath(id), "utf8")) as TransferMeta;
  } catch {
    return null;
  }
}

function sourceOf(m: MeetingRow) {
  const src = originalPath(m);
  if (!existsSync(src)) return null;
  const st = statSync(src);
  return { path: src, source: basename(src), size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
}

/** The meta, if it was made from the meeting's current original. */
function currentMeta(m: MeetingRow): TransferMeta | null {
  const src = sourceOf(m);
  const meta = readMeta(m.id);
  if (!src || !meta) return null;
  return meta.source === src.source && meta.size === src.size && meta.mtimeMs === src.mtimeMs ? meta : null;
}

/**
 * What to send a remote worker for this meeting, starting the copy if needed.
 * "pending": being made; ask again shortly.
 */
export function transferFor(m: MeetingRow): TransferState {
  // A compacted original is already small mono Opus; a small one is not worth the wait.
  if (m.compacted_at != null || m.media_size < transferTuning.minOriginalBytes) return { kind: "original" };
  const src = sourceOf(m);
  if (!src) return { kind: "original" };
  const meta = currentMeta(m);
  const file = join(meetingDir(m.id), TRANSFER_FILE);
  if (meta?.use === "original") return { kind: "original" };
  if (meta?.use === "transfer" && existsSync(file)) {
    return { kind: "ready", path: file, size: statSync(file).size, hasVideo: meta.hasVideo };
  }
  if (encoding.has(m.id)) return { kind: "pending" };
  const bin = ffmpegBin();
  if (!bin) return { kind: "original" };
  const job = (queue = queue.then(() => encode(m.id, bin, src)).finally(() => encoding.delete(m.id)));
  encoding.set(m.id, job);
  return { kind: "pending" };
}

/** Whether the original has video, as found while making the copy (null: not known). */
export function transferHasVideo(m: MeetingRow): boolean | null {
  const meta = currentMeta(m);
  return meta ? meta.hasVideo : null;
}

/** For tests: wait for the copies being made. */
export function transfersSettled(): Promise<void> {
  return queue;
}

/** Streams, as `ffmpeg -i` lists them; cover art in audio files is a video stream flagged "attached pic". */
function hasVideoStream(stderr: string): boolean | null {
  const streams = stderr.split("\n").filter((l) => /Stream #\d+:\d+/.test(l));
  if (!streams.length) return null;
  return streams.some((l) => l.includes(": Video:") && !l.includes("attached pic"));
}

async function encode(id: string, bin: string, src: { path: string; source: string; size: number; mtimeMs: number }) {
  const dir = meetingDir(id);
  if (!existsSync(dir)) return;
  const tmp = join(dir, TRANSFER_TMP);
  const out = join(dir, TRANSFER_FILE);
  const started = performance.now();
  const meta: TransferMeta = { source: src.source, size: src.size, mtimeMs: src.mtimeMs, use: "original", hasVideo: null };
  const args = [
    bin, "-hide_banner", "-nostdin", "-nostats", "-y",
    // Uploaded media is untrusted: local files only, never URLs a crafted playlist points at.
    "-protocol_whitelist", "file",
    "-i", src.path,
    "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "48000",
    "-c:a", "libopus", "-b:a", `${TRANSFER_KBPS}k`, "-application", "voip",
    "-f", "ogg", tmp,
  ]; // prettier-ignore
  // Below the web server, so pages stay quick on a one-core machine.
  const cmd = existsSync("/usr/bin/nice") || existsSync("/bin/nice") ? ["nice", "-n", "10", ...args] : args;
  try {
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), ENCODE_TIMEOUT_MS);
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    clearTimeout(timer);
    meta.hasVideo = hasVideoStream(stderr);
    const size = existsSync(tmp) ? statSync(tmp).size : 0;
    if (code !== 0 || size === 0) {
      meta.error = `ffmpeg exited with ${code}: ${stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`;
      console.warn(`[media] could not make the transfer copy of ${id}; sending the original. ${meta.error}`);
      rmSync(tmp, { force: true });
    } else if (size > src.size * MAX_RATIO) {
      rmSync(tmp, { force: true });
    } else {
      renameSync(tmp, out);
      meta.use = "transfer";
      console.log(
        `[media] transfer copy of ${id}: ${(src.size / 1e6).toFixed(1)} MB -> ${(size / 1e6).toFixed(1)} MB in ${((performance.now() - started) / 1000).toFixed(1)} s`,
      );
    }
  } catch (e) {
    meta.error = String(e);
    console.warn(`[media] could not make the transfer copy of ${id}; sending the original.`, e);
    rmSync(tmp, { force: true });
  }
  if (existsSync(dir)) writeFileSync(metaPath(id), JSON.stringify(meta));
}

/** Remove the copy when nothing is queued or running for the meeting (it is made again if needed). */
export function dropTransferIfIdle(id: string) {
  if (encoding.has(id)) return;
  const busy = db
    .query<{ n: number }, { m: string }>("SELECT COUNT(*) AS n FROM jobs WHERE meeting_id = $m AND status IN ('queued', 'running')")
    .get({ m: id })!.n;
  if (busy) return;
  const dir = meetingDir(id);
  for (const name of [TRANSFER_FILE, TRANSFER_TMP, TRANSFER_META]) rmSync(join(dir, name), { force: true });
}

/** Remove copies left behind: older than STALE_MS, with nothing queued or running for the meeting. */
export function sweepTransfers(): number {
  if (!existsSync(config.mediaDir)) return 0;
  let n = 0;
  const cutoff = Date.now() - STALE_MS;
  for (const id of readdirSync(config.mediaDir)) {
    const meta = join(config.mediaDir, id, TRANSFER_META);
    if (!existsSync(meta) || statSync(meta).mtimeMs > cutoff) continue;
    if (!getMeeting(id)) continue;
    dropTransferIfIdle(id);
    if (!existsSync(meta)) n++;
  }
  return n;
}
