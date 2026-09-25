import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config";
import { Client, adminClient, memberClient, waitFor, worker } from "./helpers";

const CHUNK = 1024 * 1024;

async function createAndUpload(c: Client, bytes: Uint8Array, extra: Record<string, unknown> = {}) {
  const res = await c.post("/api/meetings", {
    title: "Weekly sync",
    file: { name: "sync.m4a", size: bytes.length, type: "audio/mp4" },
    ...extra,
  });
  expect(res.status).toBe(201);
  const { meeting, chunkSize } = (await res.json()) as any;
  expect(chunkSize).toBe(CHUNK);
  for (let off = 0; off < bytes.length; off += chunkSize) {
    const r = await c.req("PUT", `/api/meetings/${meeting.id}/upload?offset=${off}`, {
      body: bytes.slice(off, off + chunkSize),
      headers: { "content-type": "application/octet-stream" },
    });
    expect(r.status).toBe(200);
  }
  const done = await c.post(`/api/meetings/${meeting.id}/upload/complete`);
  expect(done.status).toBe(200);
  return meeting.id as string;
}

async function claimFor(meetingId: string, workerId = "gpu0") {
  // Claim until we get the job for this meeting (tests share one queue).
  for (let i = 0; i < 20; i++) {
    const res = await worker.call("/jobs/claim", { workerId, info: {} });
    if (res.status === 204) return null;
    const { job } = (await res.json()) as any;
    if (job.meetingId === meetingId) return job;
    await worker.call(`/jobs/${job.jobId}/fail`, { workerId, error: "not this test", retryable: false });
  }
  return null;
}

const RESULT = {
  durationSec: 125.5,
  language: "Chinese",
  hasVideo: false,
  hasPlayback: true,
  hasPeaks: true,
  speakers: ["SPEAKER_00", "SPEAKER_01"],
  segments: [
    { start: 0.5, end: 4.2, speaker: "SPEAKER_00", text: "大家好，我們開始今天的 weekly sync。" },
    { start: 4.4, end: 9.0, speaker: "SPEAKER_01", text: "上週的 release 已經部署完成。" },
    { start: 9.1, end: 12.0, speaker: "SPEAKER_01", text: "下週三前要補齊測試。" },
  ],
};

describe("meeting lifecycle", () => {
  test("rejects unsupported file types and oversize files", async () => {
    const c = await adminClient();
    const bad = await c.post("/api/meetings", { title: "x", file: { name: "notes.pdf", size: 10 } });
    expect(bad.status).toBe(415);
    const big = await c.post("/api/meetings", { title: "x", file: { name: "a.mp3", size: 11 * 1024 * 1024 } });
    expect(big.status).toBe(413);
  });

  test("chunked upload detects offset mismatch and incomplete uploads", async () => {
    const c = await adminClient();
    const res = await c.post("/api/meetings", { title: "Partial", file: { name: "p.wav", size: 3000 } });
    const { meeting } = (await res.json()) as any;
    const wrong = await c.req("PUT", `/api/meetings/${meeting.id}/upload?offset=5`, { body: new Uint8Array(10) });
    expect(wrong.status).toBe(409);
    expect(((await wrong.json()) as any).received).toBe(0);
    await c.req("PUT", `/api/meetings/${meeting.id}/upload?offset=0`, { body: new Uint8Array(1000) });
    const early = await c.post(`/api/meetings/${meeting.id}/upload/complete`);
    expect(early.status).toBe(409);
    const tooMuch = await c.req("PUT", `/api/meetings/${meeting.id}/upload?offset=1000`, { body: new Uint8Array(2500) });
    expect(tooMuch.status).toBe(413);
  });

  test("upload -> worker -> transcript -> automatic summary", async () => {
    const c = await adminClient();
    const bytes = new Uint8Array(2.5 * CHUNK).map((_, i) => i % 251);
    const id = await createAndUpload(c, bytes, {
      options: { language: "auto", diarize: true, vocabulary: "Kubernetes, 王小明", script: "zh-TW" },
      summary: { templateId: "builtin-minutes", prompt: "Write minutes.", outputLanguage: "zh-TW" },
    });
    const stored = readFileSync(join(config.mediaDir, id, "original.m4a"));
    expect(Buffer.compare(stored, Buffer.from(bytes))).toBe(0);

    const job = await claimFor(id);
    expect(job).not.toBeNull();
    expect(job.options.vocabulary).toBe("Kubernetes, 王小明");
    expect(job.mediaPath).toBe(join(config.mediaDir, id, "original.m4a"));

    const prog = await worker.call(`/jobs/${job.jobId}/progress`, { workerId: "gpu0", stage: "transcribing", progress: 0.5 });
    expect(((await prog.json()) as any).continue).toBe(true);
    const mid = (await (await c.get(`/api/meetings/${id}`)).json()) as any;
    expect(mid.meeting.status).toBe("processing");
    expect(mid.meeting.stage).toBe("transcribing");

    // A different worker cannot complete someone else's job.
    const hijack = await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu1", result: RESULT });
    expect(hijack.status).toBe(409);

    writeFileSync(join(job.outDir, "playback.m4a"), new Uint8Array(4096).map((_, i) => i % 256));
    writeFileSync(join(job.outDir, "peaks.json"), JSON.stringify({ version: 1, peaks: [0.1, 0.5] }));
    const done = await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu0", result: RESULT });
    expect(done.status).toBe(200);

    const detail = (await (await c.get(`/api/meetings/${id}`)).json()) as any;
    expect(detail.meeting.status).toBe("ready");
    expect(detail.meeting.segments).toHaveLength(3);
    expect(detail.meeting.speakers.map((s: any) => s.name)).toEqual(["Speaker 1", "Speaker 2"]);
    expect(detail.meeting.media.hasPlayback).toBe(true);

    const summary = await waitFor(async () => {
      const d = (await (await c.get(`/api/meetings/${id}`)).json()) as any;
      const s = d.meeting.summaries[0];
      return s && s.status === "done" ? s : null;
    });
    expect(summary.content).toContain("# Fake minutes");
    expect(summary.templateName).toBe("Meeting minutes");
    expect(summary.usage.input_tokens).toBe(100);

    const prompt = readFileSync(process.env.FAKE_CODEX_PROMPT_FILE!, "utf8");
    expect(prompt).toContain("Write minutes.");
    expect(prompt).toContain("[00:00:04] Speaker 2: 上週的 release 已經部署完成。 下週三前要補齊測試。");
    expect(prompt).toContain("繁體中文");
    const args = JSON.parse(readFileSync(process.env.FAKE_CODEX_ARGS_FILE!, "utf8")) as string[];
    expect(args).toContain("read-only");
    expect(args).toContain("--ephemeral");
    // Only features the binary knows about are disabled.
    expect(args.join(" ")).toContain("--disable shell_tool");
    expect(args.join(" ")).not.toContain("--disable computer_use");
  });

  test("speaker rename, segment edit, exports and range requests", async () => {
    const c = await adminClient();
    const id = await createAndUpload(c, new Uint8Array(5000));
    const job = await claimFor(id);
    writeFileSync(join(job.outDir, "playback.m4a"), new Uint8Array(4096).map((_, i) => i % 256));
    await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu0", result: RESULT });

    expect((await c.patch(`/api/meetings/${id}/speakers/SPEAKER_00`, { name: "王小明" })).status).toBe(200);
    const detail = (await (await c.get(`/api/meetings/${id}`)).json()) as any;
    const seg = detail.meeting.segments[0];
    expect((await c.patch(`/api/meetings/${id}/segments/${seg.id}`, { text: "大家好。" })).status).toBe(200);
    expect((await c.patch(`/api/meetings/${id}/segments/${seg.id}`, { speaker: "NOPE" })).status).toBe(422);

    const srt = await (await c.get(`/api/meetings/${id}/export?format=srt`)).text();
    expect(srt).toContain("00:00:00,500 --> 00:00:04,200\n王小明: 大家好。");
    const vtt = await (await c.get(`/api/meetings/${id}/export?format=vtt`)).text();
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    const json = (await (await c.get(`/api/meetings/${id}/export?format=json`)).json()) as any;
    expect(json.segments[0].speaker).toBe("王小明");

    const range = await c.req("GET", `/api/meetings/${id}/media/audio`, { headers: { range: "bytes=100-199" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 100-199/4096");
    const buf = new Uint8Array(await range.arrayBuffer());
    expect(buf.length).toBe(100);
    expect(buf[0]).toBe(100);
    const suffix = await c.req("GET", `/api/meetings/${id}/media/audio`, { headers: { range: "bytes=-10" } });
    expect(suffix.headers.get("content-range")).toBe("bytes 4086-4095/4096");
    const bad = await c.req("GET", `/api/meetings/${id}/media/audio`, { headers: { range: "bytes=5000-" } });
    expect(bad.status).toBe(416);

    // Re-transcription keeps renamed speakers.
    await c.post(`/api/meetings/${id}/retranscribe`, {});
    const job2 = await claimFor(id);
    await worker.call(`/jobs/${job2.jobId}/complete`, { workerId: "gpu0", result: RESULT });
    const after = (await (await c.get(`/api/meetings/${id}`)).json()) as any;
    expect(after.meeting.speakers[0].name).toBe("王小明");
  });

  test("users cannot see each other's meetings", async () => {
    const admin = await adminClient();
    const id = await createAndUpload(admin, new Uint8Array(100));
    const other = await memberClient("henry");
    expect((await other.get(`/api/meetings/${id}`)).status).toBe(404);
    expect((await other.get(`/api/meetings/${id}/media/original`)).status).toBe(404);
    expect((await other.del(`/api/meetings/${id}`)).status).toBe(404);
    const list = (await (await other.get("/api/meetings")).json()) as any;
    expect(list.meetings).toHaveLength(0);
  });

  test("failed summaries surface the codex error; manual re-run works", async () => {
    const c = await adminClient();
    const id = await createAndUpload(c, new Uint8Array(100));
    const job = await claimFor(id);
    await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu0", result: RESULT });
    const res = await c.post(`/api/meetings/${id}/summaries`, { templateId: null, prompt: "FAIL_PLEASE", outputLanguage: "en" });
    expect(res.status).toBe(201);
    const failed = await waitFor(async () => {
      const d = (await (await c.get(`/api/meetings/${id}`)).json()) as any;
      const s = d.meeting.summaries[0];
      return s && s.status === "failed" ? s : null;
    });
    expect(failed.error).toContain("usage limit reached");
  });

  test("a running summary can be canceled", async () => {
    const c = await adminClient();
    const id = await createAndUpload(c, new Uint8Array(100));
    const job = await claimFor(id);
    await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu0", result: RESULT });
    const { summary } = (await (await c.post(`/api/meetings/${id}/summaries`, { prompt: "SLOW_PLEASE", outputLanguage: "en" })).json()) as any;
    await waitFor(async () => {
      const d = (await (await c.get(`/api/meetings/${id}`)).json()) as any;
      return d.meeting.summaries[0].status === "running";
    });
    await c.post(`/api/meetings/${id}/summaries/${summary.id}/cancel`);
    const s = await waitFor(async () => {
      const d = (await (await c.get(`/api/meetings/${id}`)).json()) as any;
      return d.meeting.summaries[0].status === "canceled" ? d.meeting.summaries[0] : null;
    });
    expect(s.status).toBe("canceled");
  });

  test("worker failure retries, then marks the meeting failed", async () => {
    const c = await adminClient();
    const id = await createAndUpload(c, new Uint8Array(100));
    for (let attempt = 1; attempt <= config.jobMaxAttempts; attempt++) {
      const job = await claimFor(id);
      expect(job.attempt).toBe(attempt);
      await worker.call(`/jobs/${job.jobId}/fail`, { workerId: "gpu0", error: "CUDA out of memory", retryable: true });
    }
    const d = (await (await c.get(`/api/meetings/${id}`)).json()) as any;
    expect(d.meeting.status).toBe("failed");
    expect(d.meeting.error).toContain("CUDA out of memory");
  });

  test("deleting a meeting removes its files and cancels the job", async () => {
    const c = await adminClient();
    const id = await createAndUpload(c, new Uint8Array(100));
    const job = await claimFor(id);
    expect((await c.del(`/api/meetings/${id}`)).status).toBe(200);
    const prog = await worker.call(`/jobs/${job.jobId}/progress`, { workerId: "gpu0", stage: "x", progress: 0.1 });
    expect(((await prog.json()) as any).continue).toBe(false);
    expect((await c.get(`/api/meetings/${id}`)).status).toBe(404);
  });

  test("search matches transcript text", async () => {
    const c = await adminClient();
    const list = (await (await c.get(`/api/meetings?q=${encodeURIComponent("補齊測試")}`)).json()) as any;
    expect(list.meetings.length).toBeGreaterThan(0);
    const none = (await (await c.get(`/api/meetings?q=${encodeURIComponent("%")}`)).json()) as any;
    expect(none.meetings).toHaveLength(0);
  });
});

describe("templates", () => {
  test("built-ins are listed and read-only; users manage their own", async () => {
    const c = await memberClient("ivy");
    const list = (await (await c.get("/api/templates")).json()) as any;
    expect(list.templates.filter((t: any) => t.builtin).length).toBeGreaterThanOrEqual(5);
    expect((await c.patch("/api/templates/builtin-minutes", { name: "hack" })).status).toBe(404);
    const created = (await (await c.post("/api/templates", { name: "Mine", body: "Summarise." })).json()) as any;
    expect(created.template.builtin).toBe(false);
    const other = await memberClient("jack");
    expect((await other.patch(`/api/templates/${created.template.id}`, { name: "x" })).status).toBe(404);
    expect((await c.del(`/api/templates/${created.template.id}`)).status).toBe(200);
  });
});
