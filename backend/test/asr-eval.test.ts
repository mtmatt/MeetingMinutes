import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAsrEval } from "../src/services/asrEval";
import { adminClient, worker, type Client } from "./helpers";

const AUDIO = new Uint8Array(4000).map((_, i) => i % 199);

async function transcribed(c: Client, title: string) {
  const { meeting } = (await (await c.post("/api/meetings", { title, file: { name: "talk.wav", size: AUDIO.length } })).json()) as any;
  await c.req("PUT", `/api/meetings/${meeting.id}/upload?offset=0`, { body: AUDIO, headers: { "content-type": "application/octet-stream" } });
  await c.post(`/api/meetings/${meeting.id}/upload/complete`);
  for (let i = 0; i < 20; i++) {
    const claim = await worker.call("/jobs/claim", { workerId: "gpu0" });
    if (claim.status === 204) break;
    const { job } = (await claim.json()) as any;
    if (job.meetingId !== meeting.id) {
      await worker.call(`/jobs/${job.jobId}/fail`, { workerId: "gpu0", error: "not this test", retryable: false });
      continue;
    }
    const segments = [
      { start: 0, end: 3, speaker: "SPEAKER_00", text: "我們今天討論 release。" },
      { start: 3, end: 6, speaker: "SPEAKER_01", text: "測試要再週三前補齊。" },
      { start: 6, end: 8, speaker: "SPEAKER_00", text: "好。" },
    ];
    const result = { durationSec: 8, language: "Chinese", hasVideo: false, hasPlayback: false, hasPeaks: false, speakers: ["SPEAKER_00", "SPEAKER_01"], segments };
    expect((await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu0", result })).status).toBe(200);
    return meeting.id as string;
  }
  throw new Error("could not complete the transcription job");
}

describe("exporting corrected transcripts for comparing speech recognition models", () => {
  test("meetings with enough corrections are exported with their recording and every segment, corrections marked", async () => {
    const c = await adminClient();
    const id = await transcribed(c, "週會");
    const other = await transcribed(c, "沒人改過");
    const d = ((await (await c.get(`/api/meetings/${id}`)).json()) as any).meeting;
    // Someone fixes a word and names a speaker.
    const fix = await c.patch(`/api/meetings/${id}/segments/${d.segments[1].id}`, { text: "測試要在週三前補齊。" });
    expect(fix.status).toBe(200);
    await c.patch(`/api/meetings/${id}/speakers/SPEAKER_00`, { name: "王小明" });

    const out = mkdtempSync(join(tmpdir(), "mm-asr-eval-"));
    const exported = exportAsrEval(out, { minEdited: 1 });
    expect(exported.map((m) => m.id)).toContain(id);
    expect(exported.map((m) => m.id)).not.toContain(other);
    const ref = JSON.parse(readFileSync(join(out, id, "reference.json"), "utf8"));
    expect(ref).toMatchObject({ version: 1, meetingId: id, title: "週會", audio: "audio.wav", script: "zh-TW" });
    expect(ref.segments).toHaveLength(3);
    expect(ref.segments[1]).toEqual({ start: 3, end: 6, speaker: "Speaker 2", text: "測試要在週三前補齊。", edited: true });
    expect(ref.segments[0]).toMatchObject({ speaker: "王小明", edited: false });
    expect(new Uint8Array(readFileSync(join(out, id, "audio.wav")))).toEqual(AUDIO);

    // Named meetings are exported whatever their corrections; unknown ones are an error.
    const named = exportAsrEval(mkdtempSync(join(tmpdir(), "mm-asr-eval-")), { meetingIds: [other] });
    expect(named).toEqual([expect.objectContaining({ id: other, edited: 0, segments: 3 })]);
    expect(() => exportAsrEval(out, { meetingIds: ["nope"] })).toThrow("No meeting nope");
    // Without corrections nothing qualifies at the default threshold.
    expect(existsSync(join(out, other))).toBe(false);
  });
});
