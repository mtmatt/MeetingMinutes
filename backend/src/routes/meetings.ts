import { Hono } from "hono";
import { existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { config } from "../config";
import { requireUser } from "../auth/middleware";
import { db, now } from "../db";
import { formatClock, httpError, newId, shortId } from "../lib/util";
import { publish } from "../services/events";
import {
  AUDIO_EXTENSIONS,
  DEFAULT_OPTIONS,
  PEAKS_FILE,
  PLAYBACK_FILE,
  VIDEO_EXTENSIONS,
  deleteMeeting,
  enqueueTranscription,
  ensureMeetingDir,
  getOwnedMeeting,
  mediaTypeFor,
  meetingDetail,
  meetingDir,
  meetingSummary,
  originalPath,
  touchMeeting,
} from "../services/meetings";
import {
  cancelSummary,
  enqueueSummary,
  postProcessSummarySpeakers,
  renderTranscript,
  replaceSpeakerName,
  summaryPublic,
  syncAllSummariesSpeakers,
  syncSpeakerNamesInContent,
} from "../services/summarizer";
import { getTemplateFor } from "../services/templates";
import type { AppEnv, MeetingRow, SegmentRow, SpeakerRow, SummaryRow, TranscribeOptions } from "../types";
import { body } from "./validate";

export const meetingRoutes = new Hono<AppEnv>();
meetingRoutes.use(requireUser);

const optionsSchema = z.object({
  language: z.string().trim().max(32).default("auto"),
  diarize: z.boolean().default(true),
  numSpeakers: z.number().int().min(1).max(32).nullable().default(null),
  minSpeakers: z.number().int().min(1).max(32).nullable().default(null),
  maxSpeakers: z.number().int().min(1).max(32).nullable().default(null),
  vocabulary: z.string().max(2000).default(""),
  script: z.enum(["zh-TW", "zh-CN", "none"]).default("zh-TW"),
});

const summaryRequestSchema = z.object({
  templateId: z.string().max(64).nullable().default(null),
  prompt: z.string().trim().min(1, "The prompt cannot be empty.").max(20000),
  outputLanguage: z.enum(["zh-TW", "en", "auto"]).default("zh-TW"),
});

/** Queued or running summaries one person may have at once (they use the shared Codex quota). */
const MAX_ACTIVE_SUMMARIES = 3;

function owned(c: { get(k: "user"): { id: string } }, id: string): MeetingRow {
  const m = getOwnedMeeting(id, c.get("user").id);
  if (!m) httpError(404, "Meeting not found.", "not_found");
  return m;
}

function validateTemplate(userId: string, templateId: string | null) {
  if (templateId && !getTemplateFor(userId, templateId)) httpError(422, "Unknown template.", "invalid_input");
}

// ------------------------------------------------------------------ list

meetingRoutes.get("/", (c) => {
  const user = c.get("user");
  const q = (c.req.query("q") ?? "").trim();
  const rows = q
    ? db
        .query<MeetingRow, { u: string; q: string }>(
          `SELECT DISTINCT m.* FROM meetings m LEFT JOIN segments s ON s.meeting_id = m.id
           WHERE m.owner_id = $u AND (m.title LIKE $q ESCAPE '\\' OR s.text LIKE $q ESCAPE '\\')
           ORDER BY COALESCE(m.occurred_at, m.created_at) DESC LIMIT 500`,
        )
        .all({ u: user.id, q: `%${q.replace(/[\\%_]/g, (ch) => "\\" + ch)}%` })
    : db
        .query<MeetingRow, { u: string }>(
          "SELECT * FROM meetings WHERE owner_id = $u ORDER BY COALESCE(occurred_at, created_at) DESC LIMIT 500",
        )
        .all({ u: user.id });
  if (!q) return c.json({ meetings: rows.map(meetingSummary) });
  // For searches, show where the words were said.
  const needle = q.toLowerCase();
  const find = db.query<{ text: string; start_sec: number }, { m: string; q: string }>(
    "SELECT text, start_sec FROM segments WHERE meeting_id = $m AND text LIKE $q ESCAPE '\\' ORDER BY idx LIMIT 1",
  );
  const like = `%${q.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`;
  return c.json({
    meetings: rows.map((m) => {
      const hit = find.get({ m: m.id, q: like });
      let match: { text: string; start: number } | null = null;
      if (hit) {
        const i = hit.text.toLowerCase().indexOf(needle);
        const from = Math.max(0, i - 40);
        const to = Math.min(hit.text.length, i + needle.length + 90);
        match = { text: (from > 0 ? "…" : "") + hit.text.slice(from, to) + (to < hit.text.length ? "…" : ""), start: hit.start_sec };
      }
      return { ...meetingSummary(m), match };
    }),
  });
});

// ---------------------------------------------------------------- create

meetingRoutes.post("/", async (c) => {
  const user = c.get("user");
  const input = await body(
    c,
    z.object({
      title: z.string().trim().min(1).max(200),
      occurredAt: z.number().int().positive().nullable().default(null),
      file: z.object({
        name: z.string().min(1).max(500),
        size: z.number().int().positive(),
        type: z.string().max(200).default(""),
      }),
      options: optionsSchema.default(DEFAULT_OPTIONS),
      summary: summaryRequestSchema.nullable().default(null),
    }),
  );
  if (input.file.size > config.maxUploadBytes) {
    return c.json(
      {
        error: `File is larger than the ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB limit.`,
        code: "too_large",
        size: input.file.size,
        limitBytes: config.maxUploadBytes,
      },
      413,
    );
  }
  const ext = (input.file.name.split(".").pop() ?? "").toLowerCase();
  const isVideo = VIDEO_EXTENSIONS.includes(ext);
  if (!isVideo && !AUDIO_EXTENSIONS.includes(ext)) {
    httpError(415, `Unsupported file type ".${ext}". Upload an audio or video file.`, "unsupported_type");
  }
  if (input.summary) validateTemplate(user.id, input.summary.templateId);
  const opts: TranscribeOptions = input.options;
  if (opts.minSpeakers && opts.maxSpeakers && opts.minSpeakers > opts.maxSpeakers) {
    httpError(422, "Minimum speakers cannot exceed maximum speakers.", "invalid_input");
  }

  const id = shortId();
  const t = now();
  db.query(
    `INSERT INTO meetings (id, owner_id, title, occurred_at, status, media_name, media_mime, media_size, media_ext, has_video,
       options, auto_summary, created_at, updated_at)
     VALUES ($id, $u, $title, $occ, 'uploading', $name, $mime, $size, $ext, $video, $options, $auto, $t, $t)`,
  ).run({
    id,
    u: user.id,
    title: input.title,
    occ: input.occurredAt,
    name: input.file.name,
    mime: input.file.type || (isVideo ? "video/" : "audio/") + ext,
    size: input.file.size,
    ext,
    video: isVideo ? 1 : 0,
    options: JSON.stringify(opts),
    auto: input.summary ? JSON.stringify(input.summary) : null,
    t,
  });
  ensureMeetingDir(id);
  const m = getOwnedMeeting(id, user.id)!;
  touchMeeting(m);
  return c.json({ meeting: meetingSummary(m), chunkSize: config.uploadChunkBytes }, 201);
});

// ---------------------------------------------------------------- upload

/**
 * Chunked, resumable upload. The client PUTs sequential chunks with the byte
 * offset it believes the server has; a mismatch returns 409 with the actual
 * offset so the client can resume. Chunks keep each request well under
 * typical reverse-proxy body limits.
 */
meetingRoutes.put("/:id/upload", async (c) => {
  const m = owned(c, c.req.param("id"));
  if (m.status !== "uploading") httpError(409, "This meeting is not accepting uploads.", "not_uploading");
  const offset = Number(c.req.query("offset"));
  if (!Number.isSafeInteger(offset) || offset !== m.media_received) {
    return c.json({ error: "Offset mismatch.", code: "offset_mismatch", received: m.media_received }, 409);
  }
  // Chunks are bounded (UPLOAD_CHUNK_MB, enforced by Bun's maxRequestBodySize),
  // so buffering one chunk in memory is cheap and avoids streaming quirks.
  const chunk = new Uint8Array(await c.req.arrayBuffer());
  if (chunk.byteLength === 0) httpError(400, "Empty chunk.", "bad_request");
  if (chunk.byteLength > config.uploadChunkBytes + 1024 || offset + chunk.byteLength > m.media_size) {
    // A transfer problem, not an oversized file: the client can resume from `received`.
    return c.json({ error: "Chunk does not match the declared file size.", code: "bad_chunk", received: m.media_received }, 400);
  }
  const fh = await open(originalPath(m), offset === 0 ? "w" : "r+");
  try {
    await fh.write(chunk, 0, chunk.byteLength, offset);
    await fh.truncate(offset + chunk.byteLength);
  } finally {
    await fh.close();
  }
  const written = chunk.byteLength;
  const received = offset + written;
  db.query("UPDATE meetings SET media_received = $r, progress = $p, updated_at = $t WHERE id = $id").run({
    id: m.id,
    r: received,
    p: received / m.media_size,
    t: now(),
  });
  return c.json({ received });
});

meetingRoutes.post("/:id/upload/complete", (c) => {
  const m = owned(c, c.req.param("id"));
  if (m.status !== "uploading") httpError(409, "Upload already completed.", "not_uploading");
  const path = originalPath(m);
  const size = existsSync(path) ? statSync(path).size : 0;
  if (size !== m.media_size || m.media_received !== m.media_size) {
    return c.json({ error: "Upload incomplete.", code: "incomplete", received: size }, 409);
  }
  enqueueTranscription(m);
  return c.json({ meeting: meetingSummary(getOwnedMeeting(m.id, c.get("user").id)!) });
});

// ---------------------------------------------------------------- detail

meetingRoutes.get("/:id", (c) => c.json({ meeting: meetingDetail(owned(c, c.req.param("id"))) }));

meetingRoutes.patch("/:id", async (c) => {
  const m = owned(c, c.req.param("id"));
  const input = await body(
    c,
    z.object({
      title: z.string().trim().min(1).max(200).optional(),
      occurredAt: z.number().int().positive().nullable().optional(),
    }),
  );
  db.query(
    `UPDATE meetings SET title = COALESCE($title, title),
       occurred_at = CASE WHEN $setOcc THEN $occ ELSE occurred_at END, updated_at = $t WHERE id = $id`,
  ).run({
    id: m.id,
    title: input.title ?? null,
    setOcc: input.occurredAt !== undefined ? 1 : 0,
    occ: input.occurredAt ?? null,
    t: now(),
  });
  const updated = getOwnedMeeting(m.id, c.get("user").id)!;
  touchMeeting(updated);
  return c.json({ meeting: meetingSummary(updated) });
});

meetingRoutes.delete("/:id", async (c) => {
  const m = owned(c, c.req.param("id"));
  const running = db
    .query<{ id: string }, { m: string }>("SELECT id FROM summaries WHERE meeting_id = $m AND status = 'running'")
    .all({ m: m.id });
  for (const s of running) cancelSummary(s.id);
  await deleteMeeting(m);
  return c.json({ ok: true });
});

meetingRoutes.post("/:id/retranscribe", async (c) => {
  const m = owned(c, c.req.param("id"));
  if (m.status === "uploading") httpError(409, "The upload has not finished.", "not_ready");
  const input = await body(c, z.object({ options: optionsSchema.optional(), resetSpeakerNames: z.boolean().default(false) }));
  if (input.options) {
    db.query("UPDATE meetings SET options = $o WHERE id = $id").run({ id: m.id, o: JSON.stringify(input.options) });
  }
  // Re-separating speakers relabels them: SPEAKER_00 may then be someone else,
  // so names given to the old labels must not carry over.
  if (input.resetSpeakerNames) db.query("DELETE FROM speakers WHERE meeting_id = $m").run({ m: m.id });
  enqueueTranscription(m);
  return c.json({ meeting: meetingSummary(getOwnedMeeting(m.id, c.get("user").id)!) });
});

// ------------------------------------------------------------------ media

function serveFile(c: any, path: string, mime: string, downloadName?: string) {
  if (!existsSync(path)) httpError(404, "Media not available.", "not_found");
  const size = statSync(path).size;
  const headers: Record<string, string> = {
    "Content-Type": mime,
    // Media is never interpreted as anything else, even by old browsers.
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };
  if (downloadName) {
    headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  }
  const range = c.req.header("range") as string | undefined;
  const file = Bun.file(path);
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match || (!match[1] && !match[2])) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    let start: number;
    let end: number;
    if (!match[1]) {
      const suffix = Number(match[2]);
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    headers["Content-Length"] = String(end - start + 1);
    return new Response(file.slice(start, end + 1), { status: 206, headers });
  }
  headers["Content-Length"] = String(size);
  return new Response(file, { status: 200, headers });
}

meetingRoutes.get("/:id/media/audio", (c) => {
  const m = owned(c, c.req.param("id"));
  if (m.has_playback) return serveFile(c, join(meetingDir(m.id), PLAYBACK_FILE), "audio/mp4");
  if (m.status === "uploading") httpError(404, "Media not available yet.", "not_found");
  return serveFile(c, originalPath(m), mediaTypeFor(m.media_ext));
});

meetingRoutes.get("/:id/media/original", (c) => {
  const m = owned(c, c.req.param("id"));
  if (m.status === "uploading") httpError(404, "Media not available yet.", "not_found");
  const download = c.req.query("download") === "1";
  return serveFile(c, originalPath(m), mediaTypeFor(m.media_ext), download ? m.media_name : undefined);
});

meetingRoutes.get("/:id/peaks", async (c) => {
  const m = owned(c, c.req.param("id"));
  const path = join(meetingDir(m.id), PEAKS_FILE);
  if (!m.has_peaks || !existsSync(path)) httpError(404, "No waveform yet.", "not_found");
  return new Response(Bun.file(path), {
    headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=3600" },
  });
});

// ------------------------------------------------------- transcript edits

meetingRoutes.patch("/:id/speakers/:key", async (c) => {
  const m = owned(c, c.req.param("id"));
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(80) }));
  const key = c.req.param("key");
  const speaker = db
    .query<SpeakerRow, { m: string; key: string }>("SELECT * FROM speakers WHERE meeting_id = $m AND key = $key")
    .get({ m: m.id, key });
  if (!speaker) httpError(404, "Speaker not found.", "not_found");

  const oldName = speaker.name;
  const newName = input.name;

  db.query("UPDATE speakers SET name = $name WHERE meeting_id = $m AND key = $key")
    .run({ m: m.id, key, name: newName });

  if (oldName !== newName) {
    postProcessSummarySpeakers(m.id, oldName, newName, m.owner_id);
  }

  touchMeeting(m);
  return c.json({ ok: true });
});

meetingRoutes.patch("/:id/segments/:segId", async (c) => {
  const m = owned(c, c.req.param("id"));
  const input = await body(
    c,
    z.object({
      text: z.string().max(20000).optional(),
      speaker: z.string().max(64).nullable().optional(),
    }),
  );
  const segId = Number(c.req.param("segId"));
  const seg = db
    .query<SegmentRow, { id: number; m: string }>("SELECT * FROM segments WHERE id = $id AND meeting_id = $m")
    .get({ id: segId, m: m.id });
  if (!seg) httpError(404, "Segment not found.", "not_found");
  if (input.speaker) {
    const exists = db
      .query("SELECT 1 FROM speakers WHERE meeting_id = $m AND key = $k")
      .get({ m: m.id, k: input.speaker });
    if (!exists) httpError(422, "Unknown speaker.", "invalid_input");
  }
  db.query(
    `UPDATE segments SET text = COALESCE($text, text),
       speaker = CASE WHEN $setSpeaker THEN $speaker ELSE speaker END, edited = 1 WHERE id = $id`,
  ).run({
    id: seg.id,
    text: input.text ?? null,
    setSpeaker: input.speaker !== undefined ? 1 : 0,
    speaker: input.speaker ?? null,
  });
  touchMeeting(m);
  return c.json({ ok: true });
});

/** Add a new speaker label (e.g. when diarization merged two people). */
meetingRoutes.post("/:id/speakers", async (c) => {
  const m = owned(c, c.req.param("id"));
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(80) }));
  const existing = db
    .query<SpeakerRow, { m: string }>("SELECT * FROM speakers WHERE meeting_id = $m")
    .all({ m: m.id });
  const key = `MANUAL_${newId(4)}`;
  db.query("INSERT INTO speakers (meeting_id, key, name, color) VALUES ($m, $key, $name, $color)").run({
    m: m.id,
    key,
    name: input.name,
    color: existing.length % 10,
  });
  touchMeeting(m);
  return c.json({ speaker: { key, name: input.name, color: existing.length % 10 } }, 201);
});

// ---------------------------------------------------------------- export

function srtTime(sec: number, sep: "," | ".") {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n: number, w = 2) => n.toString().padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(r, 3)}`;
}

meetingRoutes.get("/:id/export", (c) => {
  const m = owned(c, c.req.param("id"));
  const format = c.req.query("format") ?? "txt";
  const segments = db
    .query<SegmentRow, { m: string }>("SELECT * FROM segments WHERE meeting_id = $m ORDER BY idx")
    .all({ m: m.id });
  const speakers = db
    .query<SpeakerRow, { m: string }>("SELECT * FROM speakers WHERE meeting_id = $m")
    .all({ m: m.id });
  const names = new Map(speakers.map((s) => [s.key, s.name]));
  const label = (s: SegmentRow) => (s.speaker ? names.get(s.speaker) ?? s.speaker : null);
  const safeTitle = m.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim() || "meeting";
  let content: string;
  let mime = "text/plain; charset=utf-8";
  let ext = format;
  switch (format) {
    case "txt":
      content = renderTranscript(segments, names) + "\n";
      break;
    case "md":
      content = `# ${m.title}\n\n` + renderTranscript(segments, names).split("\n").map((l) => l.replace(/^\[(.+?)\] ([^:]+): /, "**[$1] $2:** ")).join("\n\n") + "\n";
      mime = "text/markdown; charset=utf-8";
      break;
    case "srt":
      content = segments
        .map((s, i) => `${i + 1}\n${srtTime(s.start_sec, ",")} --> ${srtTime(s.end_sec, ",")}\n${label(s) ? `${label(s)}: ` : ""}${s.text}\n`)
        .join("\n");
      break;
    case "vtt":
      content =
        "WEBVTT\n\n" +
        segments
          .map((s) => `${srtTime(s.start_sec, ".")} --> ${srtTime(s.end_sec, ".")}\n${label(s) ? `<v ${label(s)}>` : ""}${s.text}\n`)
          .join("\n");
      mime = "text/vtt; charset=utf-8";
      break;
    case "json":
      content = JSON.stringify(
        {
          title: m.title,
          durationSec: m.duration_sec,
          language: m.language,
          speakers: speakers.map((s) => ({ key: s.key, name: s.name })),
          segments: segments.map((s) => ({
            start: s.start_sec,
            end: s.end_sec,
            speaker: label(s),
            text: s.text,
            clock: formatClock(s.start_sec),
          })),
        },
        null,
        2,
      );
      mime = "application/json";
      break;
    default:
      httpError(400, "Unknown export format.", "bad_request");
  }
  return new Response(content, {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${safeTitle}.${ext}`)}`,
    },
  });
});

// ------------------------------------------------------------- summaries

meetingRoutes.post("/:id/summaries", async (c) => {
  const user = c.get("user");
  const m = owned(c, c.req.param("id"));
  if (m.status !== "ready") httpError(409, "The transcript is not ready yet.", "not_ready");
  const input = await body(c, summaryRequestSchema);
  validateTemplate(user.id, input.templateId);
  // Summaries spend the server's shared Codex quota: a few at a time per person.
  const active =
    db
      .query<{ n: number }, { u: string }>("SELECT COUNT(*) AS n FROM summaries WHERE created_by = $u AND status IN ('queued', 'running')")
      .get({ u: user.id })?.n ?? 0;
  if (active >= MAX_ACTIVE_SUMMARIES) {
    httpError(429, `You already have ${active} summaries in progress. Wait for one to finish.`, "too_many_summaries");
  }
  const s = enqueueSummary(m, user.id, input);
  return c.json({ summary: summaryPublic(s) }, 201);
});

meetingRoutes.post("/:id/summaries/:sid/cancel", (c) => {
  const m = owned(c, c.req.param("id"));
  const s = db
    .query<SummaryRow, { id: string; m: string }>("SELECT * FROM summaries WHERE id = $id AND meeting_id = $m")
    .get({ id: c.req.param("sid"), m: m.id });
  if (!s) httpError(404, "Summary not found.", "not_found");
  if (s.status === "queued") {
    db.query("UPDATE summaries SET status = 'canceled', finished_at = $t WHERE id = $id AND status = 'queued'").run({ id: s.id, t: now() });
    touchMeeting(m);
  } else if (s.status === "running") {
    cancelSummary(s.id);
  }
  return c.json({ ok: true });
});

meetingRoutes.patch("/:id/summaries/:sid", async (c) => {
  const m = owned(c, c.req.param("id"));
  const input = await body(c, z.object({ content: z.string().max(500000) }));
  const r = db
    .query("UPDATE summaries SET content = $content WHERE id = $id AND meeting_id = $m AND status = 'done'")
    .run({ id: c.req.param("sid"), m: m.id, content: input.content });
  if (r.changes === 0) httpError(404, "Summary not found.", "not_found");
  touchMeeting(m);
  return c.json({ ok: true });
});

meetingRoutes.post("/:id/summaries/:sid/postprocess", async (c) => {
  const m = owned(c, c.req.param("id"));
  const sid = c.req.param("sid");
  const summary = db
    .query<SummaryRow, { id: string; m: string }>("SELECT * FROM summaries WHERE id = $id AND meeting_id = $m")
    .get({ id: sid, m: m.id });
  if (!summary) httpError(404, "Summary not found.", "not_found");
  if (summary.status !== "done" || !summary.content) {
    httpError(400, "Only completed summaries can be post-processed.", "invalid_state");
  }

  const input = await body(
    c,
    z.object({
      oldName: z.string().trim().min(1).max(80).optional(),
      newName: z.string().trim().min(1).max(80).optional(),
    }).optional(),
  ).catch(() => undefined);

  let newContent = summary.content;
  if (input?.oldName && input?.newName) {
    newContent = replaceSpeakerName(newContent, input.oldName, input.newName);
  } else {
    newContent = syncSpeakerNamesInContent(m.id, newContent);
  }

  if (newContent !== summary.content) {
    db.query("UPDATE summaries SET content = $content WHERE id = $id").run({ id: summary.id, content: newContent });
    publish(m.owner_id, { type: "summary.updated", meetingId: m.id, summaryId: summary.id });
    touchMeeting(m);
  }

  const updated = db.query<SummaryRow, { id: string }>("SELECT * FROM summaries WHERE id = $id").get({ id: summary.id })!;
  return c.json({ summary: summaryPublic(updated) });
});

meetingRoutes.post("/:id/summaries/postprocess", async (c) => {
  const m = owned(c, c.req.param("id"));
  const input = await body(
    c,
    z.object({
      oldName: z.string().trim().min(1).max(80).optional(),
      newName: z.string().trim().min(1).max(80).optional(),
    }).optional(),
  ).catch(() => undefined);

  let updatedCount = 0;
  if (input?.oldName && input?.newName) {
    updatedCount = postProcessSummarySpeakers(m.id, input.oldName, input.newName, m.owner_id);
  } else {
    updatedCount = syncAllSummariesSpeakers(m.id, m.owner_id);
  }
  if (updatedCount > 0) {
    touchMeeting(m);
  }
  return c.json({ ok: true, updatedCount });
});

meetingRoutes.delete("/:id/summaries/:sid", (c) => {
  const m = owned(c, c.req.param("id"));
  const sid = c.req.param("sid");
  // Only a summary of this (owned) meeting may be stopped or deleted.
  const s = db.query<{ id: string }, { id: string; m: string }>("SELECT id FROM summaries WHERE id = $id AND meeting_id = $m").get({ id: sid, m: m.id });
  if (!s) httpError(404, "Summary not found.", "not_found");
  cancelSummary(s.id);
  db.query("DELETE FROM summaries WHERE id = $id AND meeting_id = $m").run({ id: s.id, m: m.id });
  touchMeeting(m);
  return c.json({ ok: true });
});

