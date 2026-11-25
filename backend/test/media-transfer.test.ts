import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { meetingDir } from "../src/services/meetings";
import { TRANSFER_FILE, ffmpegBin, transferTuning, transfersSettled } from "../src/services/mediaTransfer";
import { adminClient, app, memberClient, type Client } from "./helpers";

async function call(token: string, method: string, path: string, json?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (json !== undefined) headers["content-type"] = "application/json";
  const url = path.startsWith("/internal/") ? path : `/internal${path}`;
  return app.fetch(new Request(`http://mm.test${url}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) }));
}

async function enroll(name: string) {
  const admin = await adminClient();
  const created = (await (await admin.post("/api/admin/worker-keys", { name })).json()) as any;
  const got = (await (await call("", "POST", "/enroll", { code: created.code })).json()) as any;
  return { id: got.workerId as string, token: got.token as string };
}

async function upload(c: Client, name: string, bytes: Uint8Array) {
  const { meeting } = (await (await c.post("/api/meetings", { title: name, file: { name, size: bytes.length } })).json()) as any;
  // In chunks, as the upload page sends them (1 MB in tests).
  for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
    const chunk = bytes.slice(offset, offset + 1024 * 1024);
    const res = await c.req("PUT", `/api/meetings/${meeting.id}/upload?offset=${offset}`, { body: chunk, headers: { "content-type": "application/octet-stream" } });
    expect(res.status).toBe(200);
  }
  expect((await c.post(`/api/meetings/${meeting.id}/upload/complete`)).status).toBe(200);
  return meeting.id as string;
}

async function claim(token: string, workerId: string, meetingId: string) {
  for (let i = 0; i < 40; i++) {
    const res = await call(token, "POST", "/jobs/claim", { workerId, kinds: ["transcribe"] });
    if (res.status === 204) return null;
    const { job } = (await res.json()) as any;
    if (job.meetingId === meetingId) return job;
    await call(token, "POST", `/jobs/${job.jobId}/fail`, { workerId, error: "not this test", retryable: false });
  }
  return null;
}

const ffmpeg = ffmpegBin();
const original = transferTuning.minOriginalBytes;

describe.skipIf(!ffmpeg)("the audio-only copy a remote worker downloads", () => {
  let video: Uint8Array;
  beforeAll(() => {
    // Ten seconds of a moving picture with a tone: a "screen recording".
    const dir = mkdtempSync(join(tmpdir(), "mm-transfer-"));
    const file = join(dir, "screen.mp4");
    const made = Bun.spawnSync([
      ffmpeg!, "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=10",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
      "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "2M", "-c:a", "aac", "-b:a", "128k", "-shortest", file,
    ]); // prettier-ignore
    expect(made.exitCode).toBe(0);
    video = new Uint8Array(readFileSync(file));
    transferTuning.minOriginalBytes = 1024;
  });
  afterAll(() => {
    transferTuning.minOriginalBytes = original;
  });

  test("is made when the job is claimed, sent instead of the original, and keeps the video known", async () => {
    const owner = await memberClient("transfer-owner");
    const id = await upload(owner, "screen.mp4", video);
    const { id: keyId, token } = await enroll("Far away GPU");
    const wid = `${keyId}-gpu0`;
    const job = await claim(token, wid, id);
    const url = `${job.media.transfer.url}&workerId=${wid}`;

    // While it is being made: ask again shortly.
    const first = await call(token, "GET", url);
    if (first.status === 202) {
      expect(first.headers.get("retry-after")).toBe("3");
      await transfersSettled();
    }
    const res = await call(token, "GET", url);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-mm-media")).toBe("transfer");
    expect(res.headers.get("content-type")).toBe("audio/ogg");
    const copy = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(copy.slice(0, 4))).toBe("OggS");
    expect(copy.length).toBeLessThan(video.length / 5);
    // Resumable like the original.
    const part = await app.fetch(
      new Request(`http://mm.test${url}`, { headers: { authorization: `Bearer ${token}`, range: "bytes=100-" } }),
    );
    expect(part.status).toBe(206);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(copy.slice(100));
    // The original is still there for older workers.
    const whole = await call(token, "GET", `${job.media.url}?workerId=${wid}`);
    expect(whole.headers.get("x-mm-media")).toBe("original");
    expect((await whole.arrayBuffer()).byteLength).toBe(video.length);

    // The worker saw only audio; the server knows the original was a video.
    const done = await call(token, "POST", `/jobs/${job.jobId}/complete`, {
      workerId: wid,
      result: {
        durationSec: 10, language: "Chinese", hasVideo: false, hasPlayback: false, hasPeaks: false,
        speakers: ["SPEAKER_00"], segments: [{ start: 0, end: 3, speaker: "SPEAKER_00", text: "畫面錄影。" }],
      },
    }); // prettier-ignore
    expect(done.status).toBe(200);
    const m = ((await (await owner.get(`/api/meetings/${id}`)).json()) as any).meeting;
    expect(m.media.hasVideo).toBe(true);
    // Done with: the copy is removed.
    expect(existsSync(join(meetingDir(id), TRANSFER_FILE))).toBe(false);
    expect(existsSync(join(meetingDir(id), "transfer.json"))).toBe(false);
  });
});
