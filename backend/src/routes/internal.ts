import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { clientIp, requireWorker } from "../auth/middleware";
import { tokenLimiter } from "../auth/ratelimit";
import { config } from "../config";
import { db, now } from "../db";
import { serveFile } from "../lib/serveFile";
import { httpError } from "../lib/util";
import { completeCompactJob } from "../services/mediaCompaction";
import { dropTransferIfIdle, transferFor, transferHasVideo } from "../services/mediaTransfer";
import {
  INCOMING_FILES,
  type IncomingName,
  claimJob,
  completeJob,
  completeVoiceprintJob,
  failJob,
  getMeeting,
  getRunningJob,
  mediaTypeFor,
  originalPath,
  remoteJobView,
  reportProgress,
  writeIncoming,
} from "../services/meetings";
import { effectiveSettings, profileIdFor } from "../services/workerProfiles";
import { enrollWorker, workerIdBelongs } from "../services/workerKeys";
import { noteWorkerAnswered } from "../services/workerWake";
import type { AppEnv, JobKind } from "../types";
import { SMALL_JSON_LIMIT_BYTES, body } from "./validate";

/**
 * API used by workers: on this machine with the shared WORKER_TOKEN, or on
 * other machines with their own token (see services/workerKeys.ts). Workers
 * only ever call in; nothing here calls them.
 */
export const internalRoutes = new Hono<AppEnv>();
// Enrollment is how a remote worker gets its token, so it cannot require one.
internalRoutes.use(async (c, next) => (c.req.path === "/internal/enroll" ? next() : requireWorker(c, next)));

const workerId = z.string().min(1).max(128);

/**
 * A finished job's result (a long meeting's transcript, voice fingerprints) is
 * the one large message a worker sends: as much as the server accepts in one
 * request. Everything else a worker says is a few short fields.
 */
const RESULT_LIMIT_BYTES = 64 * 1024 * 1024;

/** A remote worker acts only under its own key's worker IDs. */
function own(c: Context<AppEnv>, id: string) {
  const w = c.get("worker");
  if (!w.local && !workerIdBelongs(w.keyId!, id)) httpError(403, "This worker ID belongs to another worker.", "forbidden");
}

internalRoutes.post("/enroll", async (c) => {
  const ip = clientIp(c);
  const retry = tokenLimiter.check(ip);
  if (retry) httpError(429, `Too many attempts. Try again in ${retry}s.`, "rate_limited");
  const input = await body(c, z.object({ code: z.string().trim().min(1).max(200) }), SMALL_JSON_LIMIT_BYTES);
  const enrolled = enrollWorker(input.code, ip);
  if (!enrolled) {
    tokenLimiter.hit(ip);
    httpError(403, "This enrollment code is unknown, already used or expired. Create a new one in Admin → System.", "bad_enroll_code");
  }
  console.log(`[workers] ${enrolled!.name} (${enrolled!.id}) enrolled from ${ip}`);
  return c.json({ workerId: enrolled!.id, name: enrolled!.name, token: enrolled!.token });
});

function seen(id: string, name?: string, info?: unknown) {
  db.query(
    `INSERT INTO workers (id, name, info, last_seen_at) VALUES ($id, $name, $info, $t)
     ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at,
       name = CASE WHEN $hasName THEN excluded.name ELSE workers.name END,
       info = CASE WHEN $hasInfo THEN excluded.info ELSE workers.info END`,
  ).run({
    id,
    name: name ?? id,
    info: JSON.stringify(info ?? {}),
    hasName: name ? 1 : 0,
    hasInfo: info ? 1 : 0,
    t: now(),
  });
}

internalRoutes.post("/worker/heartbeat", async (c) => {
  // `info` is kept and shown on the admin page: a few lines about the machine, never megabytes.
  const input = await body(
    c,
    z.object({ workerId, name: z.string().max(128).optional(), info: z.record(z.string(), z.unknown()).optional() }),
    SMALL_JSON_LIMIT_BYTES,
  );
  own(c, input.workerId);
  seen(input.workerId, input.name, input.info);
  const keyId = c.get("worker").keyId;
  if (keyId) noteWorkerAnswered(keyId);
  // A worker started on demand says so as it exits when idle: offline now, not a minute from now,
  // so that work queued meanwhile wakes it again at once. (Online means seen in the last minute.)
  if (input.info?.state === "stopped") {
    db.query("UPDATE workers SET last_seen_at = $t WHERE id = $id").run({ id: input.workerId, t: now() - 61_000 });
  }
  // Where transcription runs (for this machine) decides how much free GPU memory a worker waits for before claiming.
  const s = effectiveSettings(profileIdFor(c.get("worker").keyId));
  return c.json({ ok: true, transcriber: { engine: s.engine, diarization: s.diarization } });
});

internalRoutes.post("/jobs/claim", async (c) => {
  // Workers list the job kinds they can run; older ones send nothing and get transcriptions.
  const input = await body(
    c,
    z.object({
      workerId,
      kinds: z.array(z.string().max(32)).max(16).optional(),
      // What the worker can run; workers from before this send nothing (local models plus the transcription API).
      capabilities: z
        .object({
          asr: z.array(z.string().max(32)).max(8),
          diarization: z.array(z.string().max(32)).max(8),
          keys: z.record(z.string().max(32), z.boolean()).optional(),
        })
        .optional(),
    }),
    SMALL_JSON_LIMIT_BYTES,
  );
  own(c, input.workerId);
  seen(input.workerId);
  if (c.get("worker").keyId) noteWorkerAnswered(c.get("worker").keyId!);
  const remote = !c.get("worker").local;
  const kinds = (input.kinds ?? ["transcribe"]).filter(
    // Compacting rewrites originals on this server's disk: workers here only.
    (k): k is JobKind => k === "transcribe" || k === "voiceprint" || (k === "compact" && !remote),
  );
  const job = claimJob(input.workerId, kinds, input.capabilities, profileIdFor(c.get("worker").keyId));
  if (!job) return c.body(null, 204);
  if (remote && job.kind !== "compact") {
    // Start making the small copy it will download, so it is ready (or nearly) when asked for.
    const m = getMeeting(job.meetingId);
    if (m) transferFor(m);
  }
  // A remote worker gets addresses to download from and upload to, never paths on this server.
  return c.json({ job: remote ? remoteJobView(job) : job });
});

/**
 * The recording of a job this worker is running (byte ranges, to resume).
 * `?variant=audio`: the small audio-only copy (see mediaTransfer), answered
 * with 202 and Retry-After while it is being made; X-MM-Media says which
 * file was sent ("transfer" or "original").
 */
internalRoutes.get("/jobs/:id/media", (c) => {
  const id = workerId.parse(c.req.query("workerId") ?? "");
  own(c, id);
  const job = getRunningJob(c.req.param("id"), id);
  if (!job) httpError(409, "This job is not yours, or no longer running.", "not_running");
  const m = getMeeting(job!.meeting_id);
  if (!m) httpError(404, "The meeting is gone.", "not_found");
  if (m!.media_deleted_at != null) httpError(410, "The recording was deleted after its retention period.", "media_deleted");
  if (c.req.query("variant") === "audio" && job!.kind !== "compact") {
    const transfer = transferFor(m!);
    if (transfer.kind === "pending") {
      reportProgress(job!.id, id, job!.kind === "transcribe" ? "downloading" : "voiceprint", 0);
      return c.json({ pending: true, retryAfter: 3 }, 202, { "Retry-After": "3", "Cache-Control": "no-store" });
    }
    if (transfer.kind === "ready") {
      const res = serveFile(c, transfer.path, "audio/ogg");
      res.headers.set("X-MM-Media", "transfer");
      return res;
    }
  }
  const res = serveFile(c, originalPath(m!), mediaTypeFor(m!.media_ext));
  res.headers.set("X-MM-Media", "original");
  return res;
});

/**
 * A file a remote worker made for a job it is running (playback copy,
 * waveform), in chunks at `offset`; it is put in place when the job completes.
 */
internalRoutes.put("/jobs/:id/files/:name", async (c) => {
  const id = workerId.parse(c.req.query("workerId") ?? "");
  own(c, id);
  const name = c.req.param("name") as IncomingName;
  // Own names only: `in` would also accept "constructor" or "toString", which have no size limit.
  if (!Object.hasOwn(INCOMING_FILES, name)) httpError(404, "Unknown file.", "not_found");
  const job = getRunningJob(c.req.param("id"), id);
  if (!job || job.kind !== "transcribe") httpError(409, "This job is not yours, or no longer running.", "not_running");
  const offset = Number(c.req.query("offset"));
  if (!Number.isSafeInteger(offset) || offset < 0) httpError(400, "Bad offset.", "bad_request");
  const chunk = new Uint8Array(await c.req.arrayBuffer());
  if (chunk.byteLength === 0 || chunk.byteLength > config.uploadChunkBytes + 1024) httpError(400, "Bad chunk size.", "bad_request");
  const result = await writeIncoming(job!, name, offset, chunk);
  if ("error" in result) return c.json({ error: result.error, code: "offset_mismatch", received: result.received }, 409);
  return c.json({ received: result.received });
});

internalRoutes.post("/jobs/:id/progress", async (c) => {
  const input = await body(c, z.object({ workerId, stage: z.string().max(64), progress: z.number().min(0).max(1) }), SMALL_JSON_LIMIT_BYTES);
  own(c, input.workerId);
  seen(input.workerId);
  const ok = reportProgress(c.req.param("id"), input.workerId, input.stage, input.progress);
  return c.json({ continue: ok });
});

/** One voice fingerprint per speaker: a speaker embedding (any length up to 4096) and how much they spoke. */
const voicesSchema = z
  .record(
    z.string().max(64),
    z.object({
      embedding: z.array(z.number().finite()).min(8).max(4096),
      speechSec: z.number().nonnegative(),
    }),
  )
  .refine((v) => Object.keys(v).length <= 64, "Too many speakers.");

const voiceModel = z.string().min(1).max(200);

const resultSchema = z.object({
  durationSec: z.number().nonnegative(),
  language: z.string().max(64).nullable(),
  hasVideo: z.boolean(),
  hasPlayback: z.boolean(),
  hasPeaks: z.boolean(),
  speakers: z.array(z.string().max(64)).max(64),
  segments: z
    .array(
      z.object({
        start: z.number().nonnegative(),
        end: z.number().nonnegative(),
        speaker: z.string().max(64).nullable(),
        text: z.string().max(20000),
      }),
    )
    .max(200000),
  diarization: z
    .object({
      status: z.enum(["ok", "off", "unavailable", "failed"]),
      reason: z.string().max(1000).nullable().optional(),
      speakers: z.number().int().nonnegative().optional(),
    })
    .optional(),
  voiceModel: voiceModel.optional(),
  voices: voicesSchema.optional(),
});

const voiceprintSchema = z.object({ voiceModel, voices: voicesSchema });

/** The meeting a job belongs to (any status), or "" if there is no such job. */
function jobMeeting(jobId: string): string {
  return db.query<{ meeting_id: string }, { id: string }>("SELECT meeting_id FROM jobs WHERE id = $id").get({ id: jobId })?.meeting_id ?? "";
}

internalRoutes.post("/jobs/:id/complete", async (c) => {
  const id = c.req.param("id");
  // The result is validated as what the job is, so a malformed result gets the real error (422).
  const job = db.query<{ kind: JobKind }, { id: string }>("SELECT kind FROM jobs WHERE id = $id").get({ id });
  if (job?.kind === "compact") {
    const input = await body(c, z.object({ workerId, result: z.object({ durationSec: z.number().nonnegative() }) }), SMALL_JSON_LIMIT_BYTES);
    own(c, input.workerId);
    seen(input.workerId);
    const ok = completeCompactJob(id, input.workerId, input.result);
    return c.json({ accepted: ok }, ok ? 200 : 409);
  }
  if (job?.kind === "voiceprint") {
    const input = await body(c, z.object({ workerId, result: voiceprintSchema }), RESULT_LIMIT_BYTES);
    own(c, input.workerId);
    seen(input.workerId);
    const ok = completeVoiceprintJob(id, input.workerId, input.result);
    if (ok) dropTransferIfIdle(jobMeeting(id));
    return c.json({ accepted: ok }, ok ? 200 : 409);
  }
  const input = await body(c, z.object({ workerId, result: resultSchema }), RESULT_LIMIT_BYTES);
  own(c, input.workerId);
  seen(input.workerId);
  const meetingId = jobMeeting(id);
  const meeting = meetingId ? getMeeting(meetingId) : null;
  // A worker that was sent the audio-only copy cannot see the original's video; this server can.
  const hasVideo = meeting ? transferHasVideo(meeting) : null;
  const ok = completeJob(id, input.workerId, hasVideo === null ? input.result : { ...input.result, hasVideo });
  if (ok && meetingId) dropTransferIfIdle(meetingId);
  return c.json({ accepted: ok }, ok ? 200 : 409);
});

internalRoutes.post("/jobs/:id/fail", async (c) => {
  const input = await body(c, z.object({ workerId, error: z.string().max(4000), retryable: z.boolean().default(false) }), SMALL_JSON_LIMIT_BYTES);
  own(c, input.workerId);
  seen(input.workerId);
  const meetingId = jobMeeting(c.req.param("id"));
  const ok = failJob(c.req.param("id"), input.workerId, input.error, input.retryable);
  // Kept while the job is queued again (another worker will want it).
  if (ok && meetingId) dropTransferIfIdle(meetingId);
  return c.json({ accepted: ok }, ok ? 200 : 409);
});
