import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/db";
import { meetingDir } from "../src/services/meetings";
import { Client, adminClient, memberClient, worker } from "./helpers";

const WORKER = "gpu-compact";

/** A transcribed meeting with a playback copy; `video`: the original had video. */
async function transcribed(c: Client, opts: { video?: boolean; bytes?: number; durationSec?: number } = {}) {
  const bytes = new Uint8Array(opts.bytes ?? 4096).fill(7);
  const res = await c.post("/api/meetings", { title: "Board meeting", file: { name: "Board meeting.mp4", size: bytes.length } });
  const { meeting } = (await res.json()) as any;
  await c.req("PUT", `/api/meetings/${meeting.id}/upload?offset=0`, { body: bytes, headers: { "content-type": "application/octet-stream" } });
  expect((await c.post(`/api/meetings/${meeting.id}/upload/complete`)).status).toBe(200);
  const job = await claim(meeting.id, ["transcribe", "voiceprint"]);
  writeFileSync(join(meetingDir(meeting.id), "playback.m4a"), "playback");
  const done = await worker.call(`/jobs/${job.jobId}/complete`, {
    workerId: WORKER,
    result: {
      durationSec: opts.durationSec ?? 3600,
      language: "Chinese",
      hasVideo: opts.video ?? true,
      hasPlayback: true,
      hasPeaks: false,
      speakers: ["SPEAKER_00"],
      segments: [{ start: 0, end: 3, speaker: "SPEAKER_00", text: "開會。" }],
    },
  });
  expect(done.status).toBe(200);
  return meeting.id as string;
}

/** Claim until this meeting's job comes up; others are failed (tests share one queue). */
async function claim(meetingId: string, kinds: string[]) {
  for (let i = 0; i < 60; i++) {
    const res = await worker.call("/jobs/claim", { workerId: WORKER, kinds });
    if (res.status === 204) return null;
    const { job } = (await res.json()) as any;
    if (job.meetingId === meetingId) return job;
    await worker.call(`/jobs/${job.jobId}/fail`, { workerId: WORKER, error: "not this test", retryable: false });
  }
  return null;
}

const original = (id: string, ext: string) => join(meetingDir(id), `original.${ext}`);

async function setPolicy(compact: boolean, afterDays: number) {
  const res = await (await adminClient()).req("PUT", "/api/admin/media", { json: { compact, afterDays } });
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

describe("compacting originals to audio only", () => {
  afterAll(async () => {
    await (await adminClient()).del("/api/admin/media");
  });

  test("off by default; only administrators can turn it on", async () => {
    const admin = await adminClient();
    const state = (await (await admin.get("/api/admin/media")).json()) as any;
    expect(state.settings).toEqual({ compact: false, afterDays: 7, retentionDays: 0 });
    expect(state.stats.bitrateKbps).toBe(32);
    const member = await memberClient("compact-member");
    expect((await member.get("/api/admin/media")).status).toBe(403);
    expect((await member.req("PUT", "/api/admin/media", { json: { compact: true, afterDays: 0 } })).status).toBe(403);
    expect((await admin.req("PUT", "/api/admin/media", { json: { compact: true, afterDays: -1 } })).status).toBe(422);
    // People are told, so whoever uploads a video knows it is not kept as uploaded.
    expect(((await (await member.get("/api/auth/state")).json()) as any).mediaPolicy).toEqual({ compact: false, afterDays: 7, videoAudioOnly: true });
  });

  test("a due video is replaced by an Opus copy; the video and the old file are gone", async () => {
    const owner = await memberClient("compact-owner");
    const id = await transcribed(owner);
    // A video becomes audio as soon as it is transcribed, whatever the policy's wait (that is for audio).
    await setPolicy(true, 7);
    // Older workers, which do not ask for compactions, are never handed one.
    const legacy = await worker.call("/jobs/claim", { workerId: WORKER });
    if (legacy.status === 200) expect(((await legacy.json()) as any).job.kind).not.toBe("compact");

    const job = await claim(id, ["compact"]);
    expect(job.kind).toBe("compact");
    expect(job.options).toEqual({ bitrateKbps: 32, output: join(meetingDir(id), "original.compact.opus") });
    expect(job.mediaPath).toBe(original(id, "mp4"));
    // The meeting stays readable while it runs.
    expect(((await (await owner.get(`/api/meetings/${id}`)).json()) as any).meeting.status).toBe("ready");

    writeFileSync(job.options.output, new Uint8Array(1000).fill(1));
    const done = await worker.call(`/jobs/${job.jobId}/complete`, { workerId: WORKER, result: { durationSec: 3600.4 } });
    expect(done.status).toBe(200);
    const m = ((await (await owner.get(`/api/meetings/${id}`)).json()) as any).meeting;
    expect(m.media).toMatchObject({ name: "Board meeting.opus", mime: "audio/ogg", size: 1000, hasVideo: false, compacted: true });
    expect(existsSync(original(id, "mp4"))).toBe(false);
    expect(existsSync(original(id, "opus"))).toBe(true);
    expect(existsSync(job.options.output)).toBe(false);

    const dl = await owner.get(`/api/meetings/${id}/media/original?download=1`);
    expect(dl.headers.get("content-type")).toContain("audio/ogg");
    expect(dl.headers.get("content-disposition")).toContain(".opus");
    const after = (await (await (await adminClient()).get("/api/admin/media")).json()) as any;
    expect(after.stats.compacted).toBeGreaterThanOrEqual(1);
    expect(after.stats.savedBytes).toBeGreaterThanOrEqual(4096 - 1000);
    // Done once: never queued again.
    await setPolicy(true, 0);
    expect(await claim(id, ["compact"])).toBeNull();
  });

  test("a video is turned into audio once transcribed, even with the policy off", async () => {
    await setPolicy(false, 7);
    const owner = await memberClient("compact-video-now");
    const id = await transcribed(owner);
    const job = await claim(id, ["compact"]);
    expect(job?.kind).toBe("compact");
    await worker.call(`/jobs/${job.jobId}/fail`, { workerId: WORKER, error: "test", retryable: false });
  });

  test("audio waits for the policy's days, and is left alone with the policy off", async () => {
    const owner = await memberClient("compact-audio-wait");
    // 400 KB a minute is about 53 kbit/s: worth compacting to 32.
    const id = await transcribed(owner, { video: false, bytes: 400_000, durationSec: 60 });
    await setPolicy(false, 0);
    expect(await claim(id, ["compact"])).toBeNull();
    const state = await setPolicy(true, 7);
    expect(await claim(id, ["compact"])).toBeNull();
    expect(state.stats.candidates).toBeGreaterThanOrEqual(1);
    await setPolicy(true, 0);
    expect((await claim(id, ["compact"]))?.kind).toBe("compact");
  });

  test("a copy of the wrong length is thrown away and the original kept, without retrying forever", async () => {
    const owner = await memberClient("compact-bad");
    const id = await transcribed(owner);
    await setPolicy(true, 0);
    const job = await claim(id, ["compact"]);
    writeFileSync(job.options.output, new Uint8Array(500));
    await worker.call(`/jobs/${job.jobId}/complete`, { workerId: WORKER, result: { durationSec: 12 } });
    const m = ((await (await owner.get(`/api/meetings/${id}`)).json()) as any).meeting;
    expect(m.media.compacted).toBe(false);
    expect(m.media.hasVideo).toBe(true);
    expect(existsSync(original(id, "mp4"))).toBe(true);
    expect(existsSync(job.options.output)).toBe(false);
    const row = db.query<{ status: string; error: string }, { id: string }>("SELECT status, error FROM jobs WHERE id = $id").get({ id: job.jobId })!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("3600.0 s");
    await setPolicy(true, 0);
    expect(await claim(id, ["compact"])).toBeNull();
  });

  test("transcribing again during a compaction keeps the original", async () => {
    const owner = await memberClient("compact-busy");
    const id = await transcribed(owner);
    await setPolicy(true, 0);
    const job = await claim(id, ["compact"]);
    writeFileSync(job.options.output, new Uint8Array(500));
    expect((await owner.post(`/api/meetings/${id}/retranscribe`, {})).status).toBeLessThan(300);
    const done = await worker.call(`/jobs/${job.jobId}/complete`, { workerId: WORKER, result: { durationSec: 3600 } });
    expect(done.status).toBe(409);
    expect(existsSync(original(id, "mp4"))).toBe(true);
    // The transcription reads the original as uploaded.
    expect((await claim(id, ["transcribe", "voiceprint"])).mediaPath).toBe(original(id, "mp4"));
  });

  test("audio that is already small is left alone", async () => {
    const owner = await memberClient("compact-small");
    // 4 KB over an hour: far below 32 kbit/s, nothing to gain.
    const id = await transcribed(owner, { video: false, bytes: 4096, durationSec: 3600 });
    await setPolicy(true, 0);
    expect(await claim(id, ["compact"])).toBeNull();
    // A large audio file over a short time (a WAV) is compacted.
    const wav = await transcribed(owner, { video: false, bytes: 400_000, durationSec: 10 });
    await setPolicy(true, 0);
    expect((await claim(wav, ["compact"]))?.kind).toBe("compact");
  });
});
