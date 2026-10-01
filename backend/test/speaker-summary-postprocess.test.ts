import { describe, expect, test } from "bun:test";
import { replaceSpeakerName, syncSpeakerNamesInContent } from "../src/services/summarizer";
import { Client, adminClient, waitFor, worker } from "./helpers";
import { db } from "../src/db";

const CHUNK = 1024 * 1024;

async function createAndUpload(c: Client, bytes: Uint8Array, extra: Record<string, unknown> = {}) {
  const res = await c.post("/api/meetings", {
    title: "Weekly sync",
    file: { name: "sync.m4a", size: bytes.length, type: "audio/mp4" },
    ...extra,
  });
  expect(res.status).toBe(201);
  const { meeting, chunkSize } = (await res.json()) as any;
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
  durationSec: 15,
  language: "Chinese",
  hasVideo: false,
  hasPlayback: false,
  hasPeaks: false,
  speakers: ["SPEAKER_00", "SPEAKER_01"],
  segments: [
    { start: 0.5, end: 4.2, speaker: "SPEAKER_00", text: "大家好，我們開始今天的 weekly sync。" },
    { start: 4.4, end: 9.0, speaker: "SPEAKER_01", text: "上週的 release 已經部署完成。" },
  ],
};

describe("speaker summary post-processing", () => {
  describe("replaceSpeakerName unit tests", () => {
    test("replaces English speaker label and respects word boundaries", () => {
      const content = `
# Meeting Summary
Participants: Speaker 1, Speaker 2, Speaker 10

- **Speaker 1**: Proposed new feature architecture.
- **Speaker 2**: Asked about the timeline.
- **Speaker 10**: Reviewed the security posture.
Speaker 1's proposal was approved.
`;
      const updated = replaceSpeakerName(content, "Speaker 1", "Alice");
      expect(updated).toContain("Participants: Alice, Speaker 2, Speaker 10");
      expect(updated).toContain("- **Alice**: Proposed new feature architecture.");
      expect(updated).toContain("- **Speaker 2**: Asked about the timeline.");
      expect(updated).toContain("- **Speaker 10**: Reviewed the security posture.");
      expect(updated).toContain("Alice's proposal was approved.");
    });

    test("replaces Chinese variations for default speaker labels", () => {
      const content = `
發言者 1 提出架構設計。講者 1 指出測試重點。發言人 1 總結。
發言者 10 提出反對。講者 2 表示同意。
`;
      const updated = replaceSpeakerName(content, "Speaker 1", "王小明");
      expect(updated).toContain("王小明 提出架構設計。王小明 指出測試重點。王小明 總結。");
      expect(updated).toContain("發言者 10 提出反對。講者 2 表示同意。");
    });

    test("replaces custom/non-default speaker names", () => {
      const content = "Alice agreed with Bob on the roadmap. Alice Wang is someone else.";
      const updated = replaceSpeakerName(content, "Alice", "Charlie");
      expect(updated).toBe("Charlie agreed with Bob on the roadmap. Charlie Wang is someone else.");

      const zh = "王小明表示同意，王小明醫師會後補充說明。";
      const zhUpdated = replaceSpeakerName(zh, "王小明", "李大同");
      expect(zhUpdated).toBe("李大同表示同意，李大同醫師會後補充說明。");
    });

    test("handles edge cases: empty strings, unchanged names, regex characters", () => {
      expect(replaceSpeakerName("", "Speaker 1", "Alice")).toBe("");
      expect(replaceSpeakerName("hello", "hello", "hello")).toBe("hello");
      expect(replaceSpeakerName("Dr. (Smith) [MD]: test", "Dr. (Smith) [MD]", "Jane")).toBe("Jane: test");
    });
  });

  describe("API integration tests", () => {
    test("renaming a speaker automatically replaces the speaker name in all summaries", async () => {
      const c = await adminClient();
      const id = await createAndUpload(c, new Uint8Array(2048));
      const job = await claimFor(id);
      await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu0", result: RESULT });

      // Create a summary for this meeting
      const sumRes = await c.post(`/api/meetings/${id}/summaries`, {
        templateId: "builtin-minutes",
        prompt: "Summarize this meeting.",
        outputLanguage: "zh-TW",
      });
      expect(sumRes.status).toBe(201);
      const { summary } = (await sumRes.json()) as any;

      // Simulate a completed summary with default speaker names
      const initialText = `# 週會記錄

## 與會者
Speaker 1, Speaker 2

## 討論內容
- **Speaker 1**: 報告了前端進度。
- **Speaker 2**: 確認後端 API 已上線。
發言者 1 總結了下一步行動。
`;
      db.query("UPDATE summaries SET status = 'done', content = $content WHERE id = $id").run({
        id: summary.id,
        content: initialText,
      });

      // Rename SPEAKER_00 to 王小明
      const renameRes = await c.patch(`/api/meetings/${id}/speakers/SPEAKER_00`, { name: "王小明" });
      expect(renameRes.status).toBe(200);

      // Verify the summary was updated in the database
      const detail = (await (await c.get(`/api/meetings/${id}`)).json()) as any;
      const updatedSummary = detail.meeting.summaries.find((s: any) => s.id === summary.id);
      expect(updatedSummary.content).toContain("王小明, Speaker 2");
      expect(updatedSummary.content).toContain("- **王小明**: 報告了前端進度。");
      expect(updatedSummary.content).toContain("- **Speaker 2**: 確認後端 API 已上線。");
      expect(updatedSummary.content).toContain("王小明 總結了下一步行動。");
      expect(updatedSummary.content).not.toContain("Speaker 1");
      expect(updatedSummary.content).not.toContain("發言者 1");

      // Now rename 王小明 to Alice (renaming already-renamed speaker)
      const rename2 = await c.patch(`/api/meetings/${id}/speakers/SPEAKER_00`, { name: "Alice" });
      expect(rename2.status).toBe(200);

      const detail2 = (await (await c.get(`/api/meetings/${id}`)).json()) as any;
      const updatedSummary2 = detail2.meeting.summaries.find((s: any) => s.id === summary.id);
      expect(updatedSummary2.content).toContain("Alice, Speaker 2");
      expect(updatedSummary2.content).toContain("- **Alice**: 報告了前端進度。");
      expect(updatedSummary2.content).toContain("Alice 總結了下一步行動。");
      expect(updatedSummary2.content).not.toContain("王小明");
    });

    test("postprocess endpoints explicitly update speaker names in summaries", async () => {
      const c = await adminClient();
      const id = await createAndUpload(c, new Uint8Array(2048));
      const job = await claimFor(id);
      await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu0", result: RESULT });

      // Rename speakers first
      await c.patch(`/api/meetings/${id}/speakers/SPEAKER_00`, { name: "Bob" });
      await c.patch(`/api/meetings/${id}/speakers/SPEAKER_01`, { name: "Carol" });

      // Create a summary manually with old content
      const sumRes = await c.post(`/api/meetings/${id}/summaries`, {
        templateId: "builtin-minutes",
        prompt: "Summarize this meeting.",
        outputLanguage: "zh-TW",
      });
      const { summary } = (await sumRes.json()) as any;

      const rawContent = "Speaker 1 said hello. Speaker 2 said world.";
      db.query("UPDATE summaries SET status = 'done', content = $content WHERE id = $id").run({
        id: summary.id,
        content: rawContent,
      });

      // Call single summary postprocess
      const ppRes = await c.post(`/api/meetings/${id}/summaries/${summary.id}/postprocess`, {});
      expect(ppRes.status).toBe(200);
      const ppJson = (await ppRes.json()) as any;
      expect(ppJson.summary.content).toBe("Bob said hello. Carol said world.");

      // Also test meeting-wide postprocess endpoint
      db.query("UPDATE summaries SET content = 'Speaker 1 is back.' WHERE id = $id").run({ id: summary.id });
      const allRes = await c.post(`/api/meetings/${id}/summaries/postprocess`, {});
      expect(allRes.status).toBe(200);

      const detail = (await (await c.get(`/api/meetings/${id}`)).json()) as any;
      const s = detail.meeting.summaries.find((x: any) => x.id === summary.id);
      expect(s.content).toBe("Bob is back.");
    });
  });
});
