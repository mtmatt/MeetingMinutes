import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/db";
import { meetingDir } from "../src/services/meetings";
import { effectiveRetentionDays, sweepMediaRetention } from "../src/services/mediaRetention";
import { Client, adminClient, memberClient, worker } from "./helpers";

const WORKER = "gpu-retention";
const DAY = 86_400_000;

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

/** A transcribed meeting with its files on disk, transcribed `daysAgo` days ago. */
async function transcribed(c: Client, daysAgo: number) {
  const bytes = new Uint8Array(2048).fill(3);
  const res = await c.post("/api/meetings", { title: "週會", file: { name: "週會.m4a", size: bytes.length } });
  const { meeting } = (await res.json()) as any;
  await c.req("PUT", `/api/meetings/${meeting.id}/upload?offset=0`, { body: bytes, headers: { "content-type": "application/octet-stream" } });
  expect((await c.post(`/api/meetings/${meeting.id}/upload/complete`)).status).toBe(200);
  const job = await claim(meeting.id, ["transcribe"]);
  writeFileSync(join(meetingDir(meeting.id), "playback.m4a"), "playback");
  writeFileSync(join(meetingDir(meeting.id), "peaks.json"), "[]");
  const done = await worker.call(`/jobs/${job.jobId}/complete`, {
    workerId: WORKER,
    result: {
      durationSec: 600,
      language: "Chinese",
      hasVideo: false,
      hasPlayback: true,
      hasPeaks: true,
      speakers: ["SPEAKER_00"],
      segments: [{ start: 0, end: 3, speaker: "SPEAKER_00", text: "開會。" }],
    },
  });
  expect(done.status).toBe(200);
  // Anything queued after it (fingerprints) is done, so nothing holds the recording.
  db.query("UPDATE jobs SET status = 'done' WHERE meeting_id = $m AND status IN ('queued', 'running')").run({ m: meeting.id });
  db.query("UPDATE meetings SET transcribed_at = $t WHERE id = $id").run({ id: meeting.id, t: Date.now() - daysAgo * DAY });
  return meeting.id as string;
}

async function setSiteRetention(days: 0 | 7 | 30) {
  const admin = await adminClient();
  const cur = (await (await admin.get("/api/admin/media")).json()) as any;
  const res = await admin.req("PUT", "/api/admin/media", { json: { ...cur.settings, retentionDays: days } });
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

async function setOwn(c: Client, days: 7 | 30 | null) {
  const res = await c.req("PATCH", "/api/me", { json: { mediaRetentionDays: days } });
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

const detail = async (c: Client, id: string) => ((await (await c.get(`/api/meetings/${id}`)).json()) as any).meeting;

describe("deleting recordings after their retention period", () => {
  afterAll(async () => {
    await (await adminClient()).del("/api/admin/media");
  });

  test("the shorter of the site's period and the person's own applies", () => {
    expect(effectiveRetentionDays(null, null)).toBeNull();
    expect(effectiveRetentionDays(7, null)).toBe(7);
    expect(effectiveRetentionDays(null, 30)).toBe(30);
    expect(effectiveRetentionDays(7, 30)).toBe(7);
    expect(effectiveRetentionDays(30, 7)).toBe(7);
  });

  test("kept by default; the site's period and a person's choice are public to them", async () => {
    const c = await memberClient("ret-default");
    const id = await transcribed(c, 400);
    await sweepMediaRetention();
    const m = await detail(c, id);
    expect(m.media.deletedAt).toBeNull();
    expect(m.media.deletesAt).toBeNull();
    expect((await c.get(`/api/meetings/${id}/media/audio`)).status).toBe(200);

    await setSiteRetention(30);
    const state = (await (await c.get("/api/auth/state")).json()) as any;
    expect(state.mediaRetentionDays).toBe(30);
    expect(state.user.mediaRetentionDays).toBeNull();
    // Saving the period deletes what is already past it at once, rather than at the next sweep.
    const after = await detail(c, id);
    expect(typeof after.media.deletedAt).toBe("number");
    const fresh = await transcribed(c, 1);
    const d = await detail(c, fresh);
    expect(d.media.deletedAt).toBeNull();
    expect(Math.round((d.media.deletesAt - Date.now()) / DAY)).toBe(29);
  });

  test("past the site's period the files go and the transcript and summary stay", async () => {
    await setSiteRetention(30);
    const c = await memberClient("ret-site");
    const old = await transcribed(c, 31);
    const recent = await transcribed(c, 3);
    expect(existsSync(join(meetingDir(old), "playback.m4a"))).toBe(true);

    expect(await sweepMediaRetention()).toBeGreaterThanOrEqual(1);

    expect(existsSync(meetingDir(old))).toBe(false);
    const m = await detail(c, old);
    expect(typeof m.media.deletedAt).toBe("number");
    expect(m.media.deletesAt).toBeNull();
    expect(m.media.hasPlayback).toBe(false);
    expect(m.media.hasPeaks).toBe(false);
    expect(m.status).toBe("ready");
    expect(m.segments.map((s: any) => s.text)).toEqual(["開會。"]);

    for (const path of ["media/audio", "media/original", "peaks"]) {
      const res = await c.get(`/api/meetings/${old}/${path}`);
      expect(res.status).toBe(410);
      expect(((await res.json()) as any).code).toBe("media_deleted");
    }
    const again = await c.post(`/api/meetings/${old}/retranscribe`, {});
    expect(again.status).toBe(410);
    // The transcript and its export still work.
    expect((await c.get(`/api/meetings/${old}/export?format=txt`)).status).toBe(200);

    // The recent one is untouched.
    expect(existsSync(join(meetingDir(recent), "playback.m4a"))).toBe(true);
    expect((await detail(c, recent)).media.deletedAt).toBeNull();
  });

  test("a person may keep theirs for a shorter time than the site, not longer", async () => {
    await setSiteRetention(30);
    const short = await memberClient("ret-short");
    expect((await setOwn(short, 7)).user.mediaRetentionDays).toBe(7);
    const a = await transcribed(short, 8);
    const keep = await memberClient("ret-keep");
    const b = await transcribed(keep, 8);
    await setOwn(keep, 30);

    await sweepMediaRetention();
    expect((await detail(short, a)).media.deletedAt).not.toBeNull();
    expect((await detail(keep, b)).media.deletedAt).toBeNull();

    // With the site at 7 days, choosing 30 still means 7.
    await setSiteRetention(7);
    await sweepMediaRetention();
    expect((await detail(keep, b)).media.deletedAt).not.toBeNull();

    // Only 7, 30 or null.
    expect((await short.req("PATCH", "/api/me", { json: { mediaRetentionDays: 14 } })).status).toBe(422);
    expect((await setOwn(short, null)).user.mediaRetentionDays).toBeNull();
  });

  test("with the site keeping recordings, a person's own period still applies", async () => {
    await setSiteRetention(0);
    const c = await memberClient("ret-own-only");
    await setOwn(c, 7);
    const id = await transcribed(c, 10);
    await sweepMediaRetention();
    expect((await detail(c, id)).media.deletedAt).not.toBeNull();
  });

  test("a recording being worked on is kept until the work is done", async () => {
    await setSiteRetention(7);
    const c = await memberClient("ret-busy");
    const id = await transcribed(c, 10);
    db.query("INSERT INTO jobs (id, meeting_id, kind, status, created_at) VALUES ('busy-ret-1', $m, 'voiceprint', 'queued', $t)").run({
      m: id,
      t: Date.now(),
    });
    await sweepMediaRetention();
    expect((await detail(c, id)).media.deletedAt).toBeNull();
    db.query("UPDATE jobs SET status = 'done' WHERE id = 'busy-ret-1'").run();
    await sweepMediaRetention();
    expect((await detail(c, id)).media.deletedAt).not.toBeNull();
  });

  test("an older admin page that leaves the period out keeps what is saved", async () => {
    await setSiteRetention(7);
    const admin = await adminClient();
    const res = await admin.req("PUT", "/api/admin/media", { json: { compact: false, afterDays: 7 } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.settings.retentionDays).toBe(7);
    expect(typeof body.retention.deleted).toBe("number");
    // Only 0, 7 or 30.
    expect((await admin.req("PUT", "/api/admin/media", { json: { compact: false, afterDays: 7, retentionDays: 14 } })).status).toBe(422);
  });
});
