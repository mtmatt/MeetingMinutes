import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { meetingDir } from "../src/services/meetings";
import { Client, adminClient, app, memberClient } from "./helpers";

/** A call to the worker API with a given token (a remote worker's, or the shared one). */
async function call(token: string, method: string, path: string, opts: { json?: unknown; body?: Uint8Array; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(opts.headers ?? {}) };
  let body: string | Uint8Array | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.body) {
    headers["content-type"] = "application/octet-stream";
    body = opts.body;
  }
  // Addresses the server hands out (job.media.url) already start with /internal.
  const url = path.startsWith("/internal/") ? path : `/internal${path}`;
  return app.fetch(new Request(`http://mm.test${url}`, { method, headers, body }));
}

const SHARED = "test-worker-token";

async function enroll(name: string) {
  const admin = await adminClient();
  const created = (await (await admin.post("/api/admin/worker-keys", { name })).json()) as any;
  const res = await call("", "POST", "/enroll", { json: { code: created.code } });
  expect(res.status).toBe(200);
  const got = (await res.json()) as any;
  return { id: got.workerId as string, token: got.token as string, code: created.code as string };
}

const AUDIO = new Uint8Array(5000).map((_, i) => i % 251);

async function upload(c: Client) {
  const res = await c.post("/api/meetings", { title: "Remote", file: { name: "remote.wav", size: AUDIO.length } });
  const { meeting } = (await res.json()) as any;
  await c.req("PUT", `/api/meetings/${meeting.id}/upload?offset=0`, { body: AUDIO, headers: { "content-type": "application/octet-stream" } });
  expect((await c.post(`/api/meetings/${meeting.id}/upload/complete`)).status).toBe(200);
  return meeting.id as string;
}

async function claimAs(token: string, workerId: string, meetingId: string) {
  for (let i = 0; i < 40; i++) {
    const res = await call(token, "POST", "/jobs/claim", { json: { workerId, kinds: ["transcribe", "voiceprint", "compact"] } });
    if (res.status === 204) return null;
    const { job } = (await res.json()) as any;
    if (job.meetingId === meetingId) return job;
    await call(token, "POST", `/jobs/${job.jobId}/fail`, { json: { workerId, error: "not this test", retryable: false } });
  }
  return null;
}

describe("workers on other machines", () => {
  test("only administrators create them; a code works once", async () => {
    const member = await memberClient("rw-member");
    expect((await member.post("/api/admin/worker-keys", { name: "Mac" })).status).toBe(403);
    const { code, token, id } = await enroll("Mac mini");
    expect(id).toMatch(/^wk[a-z0-9]{10}$/);
    expect(token.startsWith(`mmw_${id}.`)).toBe(true);
    // Used: never again.
    expect((await call("", "POST", "/enroll", { json: { code } })).status).toBe(403);
    expect((await call("", "POST", "/enroll", { json: { code: "mme_guess" } })).status).toBe(403);
    const list = (await (await (await adminClient()).get("/api/admin/worker-keys")).json()) as any;
    const entry = list.keys.find((k: any) => k.id === id);
    expect(entry).toMatchObject({ name: "Mac mini", pending: false, revokedAt: null });
    expect(JSON.stringify(list)).not.toContain(token);
    // People are told recordings may be processed on other machines.
    expect(((await (await member.get("/api/auth/state")).json()) as any).externalWorkers).toBe(true);
  });

  test("a remote worker acts only under its own worker IDs", async () => {
    const { id, token } = await enroll("Linux box");
    expect((await call(token, "POST", "/worker/heartbeat", { json: { workerId: `${id}-gpu0` } })).status).toBe(200);
    expect((await call(token, "POST", "/worker/heartbeat", { json: { workerId: "school-4090" } })).status).toBe(403);
    expect((await call(token, "POST", "/worker/heartbeat", { json: { workerId: `${id}x` } })).status).toBe(403);
    expect((await call("mmw_nope.secret", "POST", "/worker/heartbeat", { json: { workerId: "x" } })).status).toBe(401);
  });

  test("it downloads the recording of its job and uploads its files, never seeing server paths", async () => {
    const owner = await memberClient("rw-owner");
    const id = await upload(owner);
    const { id: keyId, token } = await enroll("GPU box");
    const wid = `${keyId}-gpu0`;
    const job = await claimAs(token, wid, id);
    expect(job.mediaPath).toBeUndefined();
    expect(job.outDir).toBeUndefined();
    expect(job.media).toEqual({ url: `/internal/jobs/${job.jobId}/media`, size: AUDIO.length, ext: "wav" });
    expect(job.uploads.files).toEqual(["playback.m4a", "peaks.json"]);

    // Whole, and resumed from byte 1000.
    const whole = await call(token, "GET", `${job.media.url}?workerId=${wid}`);
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(AUDIO);
    const part = await call(token, "GET", `${job.media.url}?workerId=${wid}`, { headers: { range: "bytes=1000-" } });
    expect(part.status).toBe(206);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(AUDIO.slice(1000));
    // Another remote worker cannot fetch it.
    const other = await enroll("Someone else");
    expect((await call(other.token, "GET", `${job.media.url}?workerId=${wid}`)).status).toBe(403);
    expect((await call(other.token, "GET", `${job.media.url}?workerId=${other.id}`)).status).toBe(409);

    // The playback copy in two chunks; a wrong offset is refused with what arrived.
    const playback = new Uint8Array(3000).fill(9);
    const put = (offset: number, bytes: Uint8Array, name = "playback.m4a") =>
      call(token, "PUT", `/jobs/${job.jobId}/files/${name}?workerId=${wid}&offset=${offset}`, { body: bytes });
    expect((await put(0, playback.slice(0, 2000))).status).toBe(200);
    const bad = await put(500, playback.slice(2000));
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as any).received).toBe(2000);
    expect((await put(2000, playback.slice(2000))).status).toBe(200);
    expect((await put(0, new TextEncoder().encode('{"version":1,"peaks":[]}'), "peaks.json")).status).toBe(200);
    expect((await put(0, new Uint8Array([1]), "../etc/passwd")).status).toBe(404);

    const done = await call(token, "POST", `/jobs/${job.jobId}/complete`, {
      json: {
        workerId: wid,
        result: {
          durationSec: 10, language: "Chinese", hasVideo: false, hasPlayback: true, hasPeaks: true,
          speakers: ["SPEAKER_00"], segments: [{ start: 0, end: 3, speaker: "SPEAKER_00", text: "遠端轉錄。" }],
        },
      },
    });
    expect(done.status).toBe(200);
    const dir = meetingDir(id);
    expect(new Uint8Array(readFileSync(join(dir, "playback.m4a")))).toEqual(playback);
    expect(existsSync(join(dir, "peaks.json"))).toBe(true);
    const m = ((await (await owner.get(`/api/meetings/${id}`)).json()) as any).meeting;
    expect(m.media).toMatchObject({ hasPlayback: true, hasPeaks: true });
    // After the job: nothing more to fetch.
    expect((await call(token, "GET", `${job.media.url}?workerId=${wid}`)).status).toBe(409);
  });

  test("remote workers are never handed compactions", async () => {
    const { id, token } = await enroll("No compaction");
    const res = await call(token, "POST", "/jobs/claim", { json: { workerId: id, kinds: ["compact"] } });
    expect(res.status).toBe(204);
  });

  test("revoking stops the token at once and puts its running job back in the queue", async () => {
    const owner = await memberClient("rw-revoke");
    const id = await upload(owner);
    const { id: keyId, token } = await enroll("Stolen laptop");
    const job = await claimAs(token, keyId, id);
    expect(job).not.toBeNull();
    const admin = await adminClient();
    const res = (await (await admin.del(`/api/admin/worker-keys/${keyId}`)).json()) as any;
    expect(res.requeued).toBe(1);
    expect((await call(token, "POST", "/worker/heartbeat", { json: { workerId: keyId } })).status).toBe(401);
    // The workers here pick it up again, as before.
    const again = await claimAs(SHARED, "gpu-local", id);
    expect(again.jobId).toBe(job.jobId);
    expect(again.mediaPath).toBeDefined();
  });
});
