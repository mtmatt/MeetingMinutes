import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { db } from "../src/db";
import { jpegSize, slideTokens, slidesDir } from "../src/services/slides";
import { summaryInputTokens } from "../src/services/summarizer";
import type { MeetingRow } from "../src/types";
import { Client, adminClient, memberClient, worker } from "./helpers";

const WORKER = "gpu-slides";

/** A JPEG header of the given size (the server reads only the header, never decodes it). */
function jpeg(width: number, height: number, pad = 2000): Uint8Array {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, ...new Array(pad).fill(0x11), 0xff, 0xd9]);
}

async function claim(meetingId: string) {
  for (let i = 0; i < 60; i++) {
    const res = await worker.call("/jobs/claim", { workerId: WORKER, kinds: ["transcribe"] });
    if (res.status === 204) return null;
    const { job } = (await res.json()) as any;
    if (job.meetingId === meetingId) return job;
    await worker.call(`/jobs/${job.jobId}/fail`, { workerId: WORKER, error: "not this test", retryable: false });
  }
  return null;
}

async function uploading(c: Client, summary: unknown = null) {
  const bytes = new Uint8Array(1024).fill(7);
  const res = await c.post("/api/meetings", { title: "產品發表", file: { name: "talk.mp4", size: bytes.length }, summary });
  expect(res.status).toBe(201);
  const { meeting } = (await res.json()) as any;
  await c.req("PUT", `/api/meetings/${meeting.id}/upload?offset=0`, { body: bytes, headers: { "content-type": "application/octet-stream" } });
  return meeting.id as string;
}

function sendSlide(c: Client, id: string, at: number, key: string, data: Uint8Array) {
  return c.req("POST", `/api/meetings/${id}/slides?at=${at}&key=${key}`, { body: data, headers: { "content-type": "image/jpeg" } });
}

async function transcribe(id: string) {
  const job = await claim(id);
  expect(job).not.toBeNull();
  const done = await worker.call(`/jobs/${job.jobId}/complete`, {
    workerId: WORKER,
    result: {
      durationSec: 900,
      language: "Chinese",
      hasVideo: true,
      hasPlayback: false,
      hasPeaks: false,
      speakers: ["SPEAKER_00"],
      segments: [
        { start: 1, end: 5, speaker: "SPEAKER_00", text: "今天介紹新產品。" },
        { start: 300, end: 310, speaker: "SPEAKER_00", text: "這是價格。" },
      ],
    },
  });
  expect(done.status).toBe(200);
}

async function waitSummary(c: Client, id: string) {
  for (let i = 0; i < 100; i++) {
    const { meeting } = (await (await c.get(`/api/meetings/${id}`)).json()) as any;
    const s = meeting.summaries[0];
    if (s && (s.status === "done" || s.status === "failed")) return s;
    await Bun.sleep(30);
  }
  throw new Error("summary did not finish");
}

describe("slides", () => {
  test("reads the size from a JPEG header and refuses other files", () => {
    expect(jpegSize(jpeg(1280, 720))).toEqual({ width: 1280, height: 720 });
    expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0, 0, 0, 0, 0]))).toBeNull();
    // About what Anthropic counts: 1280×720 is ~1229 tokens; a huge picture is scaled down first.
    expect(slideTokens(1280, 720)).toBe(1229);
    expect(slideTokens(4000, 3000)).toBeLessThanOrEqual(1534);
  });

  test("pictures are added while uploading, checked, stored once, listed in order, served and deleted", async () => {
    const c = await memberClient("slides-owner");
    const id = await uploading(c);

    const first = await sendSlide(c, id, 300.5, "slide-key-0002", jpeg(1280, 720));
    expect(first.status).toBe(201);
    const a = ((await first.json()) as any).slide;
    expect(a).toMatchObject({ at: 300.5, width: 1280, height: 720 });
    // Sent again after a dropped connection: the same picture, stored once.
    const again = await sendSlide(c, id, 300.5, "slide-key-0002", jpeg(1280, 720));
    expect(((await again.json()) as any).slide.id).toBe(a.id);
    expect((await sendSlide(c, id, 2, "slide-key-0001", jpeg(1280, 720))).status).toBe(201);

    // Not a JPEG, too small, too large, no time, a bad id.
    expect((await sendSlide(c, id, 3, "slide-key-0003", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]))).status).toBe(415);
    expect((await sendSlide(c, id, 3, "slide-key-0004", jpeg(32, 32))).status).toBe(415);
    expect((await sendSlide(c, id, 3, "slide-key-0005", jpeg(4000, 3000))).status).toBe(415);
    expect((await sendSlide(c, id, 3, "slide-key-0006", jpeg(1280, 720, 1600 * 1024))).status).toBe(413);
    expect((await c.req("POST", `/api/meetings/${id}/slides?key=slide-key-0007`, { body: jpeg(1280, 720) })).status).toBe(422);
    expect((await sendSlide(c, id, 3, "x/../../y", jpeg(1280, 720))).status).toBe(422);

    // Someone else's meeting does not exist for them.
    const other = await memberClient("slides-other");
    expect((await sendSlide(other, id, 3, "slide-key-0008", jpeg(1280, 720))).status).toBe(404);
    expect((await other.get(`/api/meetings/${id}/slides/${a.id}`)).status).toBe(404);

    expect((await c.post(`/api/meetings/${id}/upload/complete`)).status).toBe(200);
    // Once the recording is in, no more pictures arrive.
    expect((await sendSlide(c, id, 4, "slide-key-0009", jpeg(1280, 720))).status).toBe(409);

    const { meeting } = (await (await c.get(`/api/meetings/${id}`)).json()) as any;
    expect(meeting.slides.map((s: any) => s.at)).toEqual([2, 300.5]);

    const img = await c.get(`/api/meetings/${id}/slides/${a.id}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await img.arrayBuffer()).length).toBe(jpeg(1280, 720).length);

    expect((await c.del(`/api/meetings/${id}/slides/${a.id}`)).status).toBe(200);
    expect((await c.get(`/api/meetings/${id}/slides/${a.id}`)).status).toBe(404);
    const after = (await (await c.get(`/api/meetings/${id}`)).json()) as any;
    expect(after.meeting.slides).toHaveLength(1);

    // Deleting the meeting deletes its pictures.
    expect(existsSync(slidesDir(id))).toBe(true);
    expect((await c.del(`/api/meetings/${id}`)).status).toBe(200);
    expect(existsSync(slidesDir(id))).toBe(false);
    expect(db.query("SELECT COUNT(*) AS n FROM slides WHERE meeting_id = $m").get({ m: id })).toEqual({ n: 0 });
  });

  test("a summary is shown the slides with their times, unless asked not to; the estimate counts them", async () => {
    const admin = await adminClient();
    await admin.del("/api/admin/summarizer"); // the hosted model (the stand-in), which reads pictures
    const c = await memberClient("slides-summary");
    const id = await uploading(c, { templateId: null, prompt: "Write minutes.", outputLanguage: "zh-TW" });
    await sendSlide(c, id, 0, "slide-key-1001", jpeg(1280, 720));
    await sendSlide(c, id, 299, "slide-key-1002", jpeg(1280, 720, 4000));
    expect((await c.post(`/api/meetings/${id}/upload/complete`)).status).toBe(200);
    await transcribe(id);

    const auto = await waitSummary(c, id);
    expect(auto.status).toBe("done");
    expect(auto.withSlides).toBe(true);
    expect(auto.slidesSent).toBe(2);
    const prompt = readFileSync(process.env.FAKE_ANTHROPIC_PROMPT_FILE!, "utf8");
    expect(prompt).toContain("Slide 1, on screen from [00:00:00]:");
    expect(prompt).toContain("Slide 2, on screen from [00:04:59]:");
    expect(prompt.match(/<<image image\/jpeg \d+>>/g)).toHaveLength(2);
    expect(prompt).toContain("<slides>");
    // The pictures come before the instructions and the transcript.
    expect(prompt.indexOf("<<image")).toBeLessThan(prompt.indexOf("<transcript>"));

    const m = db.query<MeetingRow, { id: string }>("SELECT * FROM meetings WHERE id = $id").get({ id })!;
    expect(summaryInputTokens(m, "Write minutes.", true) - summaryInputTokens(m, "Write minutes.", false)).toBe(2 * (1229 + 16));

    // Asked without the slides.
    await c.del(`/api/meetings/${id}/summaries/${auto.id}`);
    const res = await c.post(`/api/meetings/${id}/summaries`, { templateId: null, prompt: "Write minutes.", outputLanguage: "zh-TW", slides: false });
    expect(res.status).toBe(201);
    const plain = await waitSummary(c, id);
    expect(plain.withSlides).toBe(false);
    expect(plain.slidesSent).toBeNull();
    expect(readFileSync(process.env.FAKE_ANTHROPIC_PROMPT_FILE!, "utf8")).not.toContain("<<image");
  });

  test("slides the model shows are linked to the stored slides; others and outside pictures are dropped", async () => {
    const admin = await adminClient();
    await admin.del("/api/admin/summarizer");
    const c = await memberClient("slides-shown");
    const id = await uploading(c);
    await sendSlide(c, id, 5, "slide-key-3001", jpeg(1280, 720));
    await sendSlide(c, id, 60, "slide-key-3002", jpeg(1280, 720));
    expect((await c.post(`/api/meetings/${id}/upload/complete`)).status).toBe(200);
    await transcribe(id);
    const res = await c.post(`/api/meetings/${id}/summaries`, { templateId: null, prompt: "SHOW_SLIDES_PLEASE minutes", outputLanguage: "zh-TW" });
    expect(res.status).toBe(201);
    const s = await waitSummary(c, id);
    const { meeting } = (await (await c.get(`/api/meetings/${id}`)).json()) as any;
    const second = meeting.slides.find((x: any) => x.at === 60).id;
    expect(s.content).toContain(`![The cost table](slide:${second})`);
    expect(s.content).not.toContain("slide:9");
    expect(s.content).not.toContain("evil.example");
    // The prompt asked for it.
    expect(readFileSync(process.env.FAKE_ANTHROPIC_PROMPT_FILE!, "utf8")).toContain("![short description](slide:N)");
  });

  test("a model that refuses pictures writes the summary from the transcript alone", async () => {
    const admin = await adminClient();
    await admin.del("/api/admin/summarizer");
    const c = await memberClient("slides-refused");
    const id = await uploading(c);
    await sendSlide(c, id, 10, "slide-key-2001", jpeg(1280, 720));
    expect((await c.post(`/api/meetings/${id}/upload/complete`)).status).toBe(200);
    await transcribe(id);
    const res = await c.post(`/api/meetings/${id}/summaries`, { templateId: null, prompt: "NO_PICTURES_PLEASE minutes", outputLanguage: "zh-TW" });
    expect(res.status).toBe(201);
    const s = await waitSummary(c, id);
    expect(s.status).toBe("done");
    expect(s.slidesSent).toBeNull();
  });

  test("a local model is shown slides only when the administrator says it reads pictures", async () => {
    const admin = await adminClient();
    const cur = (await (await admin.get("/api/admin/summarizer")).json()) as any;
    const local = { ...cur.settings, provider: "local" };
    expect((await admin.req("PUT", "/api/admin/summarizer", { json: local })).status).toBe(200);
    let state = (await (await admin.get("/api/auth/state")).json()) as any;
    expect(state.summarizer.vision).toBe(false);
    expect((await admin.req("PUT", "/api/admin/summarizer", { json: { ...local, local: { ...local.local, vision: true } } })).status).toBe(200);
    state = (await (await admin.get("/api/auth/state")).json()) as any;
    expect(state.summarizer.vision).toBe(true);
    await admin.del("/api/admin/summarizer");
  });
});
