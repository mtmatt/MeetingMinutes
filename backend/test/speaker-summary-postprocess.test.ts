import { describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { reconcileSpeakerNames } from "../src/services/speakerNames";
import { Client, memberClient, waitFor, worker } from "./helpers";

// ------------------------------------------------------------------ helpers

type Seg = { start: number; end: number; speaker: string | null; text: string };

/** A meeting transcribed with the given speakers, in order of first appearance. */
async function transcribed(c: Client, speakers: string[], segments: Seg[]) {
  const res = await c.post("/api/meetings", { title: "Weekly sync", file: { name: "sync.wav", size: 64, type: "audio/wav" } });
  const { meeting } = (await res.json()) as any;
  await c.req("PUT", `/api/meetings/${meeting.id}/upload?offset=0`, { body: new Uint8Array(64), headers: { "content-type": "application/octet-stream" } });
  expect((await c.post(`/api/meetings/${meeting.id}/upload/complete`)).status).toBe(200);
  await completeJob(meeting.id, speakers, segments);
  return meeting.id as string;
}

async function completeJob(meetingId: string, speakers: string[], segments: Seg[]) {
  const job = await waitFor(async () => {
    const r = await worker.call("/jobs/claim", { workerId: "names", info: {} });
    if (r.status === 204) return null;
    const { job } = (await r.json()) as any;
    if (job.meetingId === meetingId) return job;
    await worker.call(`/jobs/${job.jobId}/fail`, { workerId: "names", error: "not this test", retryable: false });
    return null;
  });
  const result = { durationSec: 10, language: "Chinese", hasVideo: false, hasPlayback: false, hasPeaks: false, speakers, segments };
  expect((await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "names", result })).status).toBe(200);
}

/** pyannote's SPEAKER_01 talks first, so it is "Speaker 1" and SPEAKER_00 is "Speaker 2". */
const SECOND_KEY_FIRST: [string[], Seg[]] = [
  ["SPEAKER_01", "SPEAKER_00"],
  [
    { start: 0, end: 4, speaker: "SPEAKER_01", text: "我先報告進度" },
    { start: 4, end: 8, speaker: "SPEAKER_00", text: "我補充風險" },
  ],
];

async function summarize(c: Client, id: string, prompt = "ECHO_SPEAKERS_PLEASE") {
  const res = await c.post(`/api/meetings/${id}/summaries`, { prompt, outputLanguage: "zh-TW" });
  expect(res.status).toBe(201);
  return ((await res.json()) as any).summary.id as string;
}

async function summary(c: Client, id: string, sid: string) {
  const detail = (await (await c.get(`/api/meetings/${id}`)).json()) as any;
  return detail.meeting.summaries.find((s: any) => s.id === sid);
}

const finished = (c: Client, id: string, sid: string) =>
  waitFor(async () => {
    const s = await summary(c, id, sid);
    return s?.status === "done" ? s : null;
  }, 15000);

const rename = async (c: Client, id: string, key: string, name: string) => {
  const res = await c.patch(`/api/meetings/${id}/speakers/${key}`, { name });
  expect(res.status).toBe(200);
  return ((await res.json()) as any).summaries as { updated: number; skipped: number };
};

/** Pretend a finished summary says `content`, written with `names`. */
function setSummary(sid: string, content: string, names: Record<string, string>) {
  db.query("UPDATE summaries SET status = 'done', content = $c, speaker_names = $n WHERE id = $id").run({ id: sid, c: content, n: JSON.stringify(names) });
}

// --------------------------------------------------------------- unit tests

describe("reconcileSpeakerNames", () => {
  const two = { S0: "Speaker 1", S1: "Speaker 2" };

  test("replaces a default label, in every spelling, and nothing else", () => {
    const content = [
      "Participants: Speaker 1, Speaker 2, Speaker 10",
      "- **Speaker 1**: proposed the architecture. speaker 1 also wrote the plan.",
      "Speaker 1's proposal was approved.",
      "發言者 1 提出架構設計。講者1 指出測試重點。發言人 1 總結。發言者 10 反對，講者 2 同意。",
    ].join("\n");
    const r = reconcileSpeakerNames(content, { ...two, S9: "Speaker 10" }, { S0: "Alice", S1: "Speaker 2", S9: "Speaker 10" });
    expect(r.content).toBe(
      [
        "Participants: Alice, Speaker 2, Speaker 10",
        "- **Alice**: proposed the architecture. Alice also wrote the plan.",
        "Alice's proposal was approved.",
        "Alice 提出架構設計。Alice 指出測試重點。Alice 總結。發言者 10 反對，講者 2 同意。",
      ].join("\n"),
    );
    expect(r.names).toEqual({ S0: "Alice", S1: "Speaker 2", S9: "Speaker 10" });
    expect(r.skipped).toEqual([]);
  });

  test("custom names respect word boundaries; regex characters are literal", () => {
    const r = reconcileSpeakerNames("Ann met Anna. Ann's plan.", { S0: "Ann", S1: "Anna" }, { S0: "Annie", S1: "Anna" });
    expect(r.content).toBe("Annie met Anna. Annie's plan.");
    const re = reconcileSpeakerNames("Dr. (Smith) [MD]: test. DrX (Smith) [MD]", { S0: "Dr. (Smith) [MD]" }, { S0: "Jane" });
    expect(re.content).toBe("Jane: test. DrX (Smith) [MD]");
  });

  test("a name inside another speaker's name is left alone (CJK has no word boundaries)", () => {
    const content = "決議：小明負責報價，王小明負責合約。";
    const r = reconcileSpeakerNames(content, { S0: "小明", S1: "王小明" }, { S0: "林小明", S1: "王小明" });
    expect(r.content).toBe("決議：林小明負責報價，王小明負責合約。");
    // And the other way round.
    const r2 = reconcileSpeakerNames(content, { S0: "小明", S1: "王小明" }, { S0: "小明", S1: "王大明" });
    expect(r2.content).toBe("決議：小明負責報價，王大明負責合約。");
  });

  test("two speakers can swap names", () => {
    const r = reconcileSpeakerNames("Alice asked, Bob answered.", { S0: "Alice", S1: "Bob" }, { S0: "Bob", S1: "Alice" });
    expect(r.content).toBe("Bob asked, Alice answered.");
    expect(r.names).toEqual({ S0: "Bob", S1: "Alice" });
  });

  test("a name another speaker has is never written in: that would merge two people", () => {
    const content = "Bob agreed; Carol objected.";
    const r = reconcileSpeakerNames(content, { S0: "Bob", S1: "Carol" }, { S0: "Bob", S1: "Bob" });
    expect(r.content).toBe(content);
    expect(r.names).toEqual({ S0: "Bob", S1: "Carol" });
    expect(r.skipped).toEqual([{ key: "S1", from: "Carol", to: "Bob", reason: "shared" }]);
    // Not even when asked.
    expect(reconcileSpeakerNames(content, { S0: "Bob", S1: "Carol" }, { S0: "Bob", S1: "Bob" }, ["S1"]).content).toBe(content);
  });

  test("a one-character name is replaced only on request, and then only as a word", () => {
    const content = "A will draft Plan A. 陳說明天開會。";
    const r = reconcileSpeakerNames(content, { S0: "A", S1: "陳" }, { S0: "Alice", S1: "陳經理" });
    expect(r.content).toBe(content);
    expect(r.skipped.map((s) => [s.key, s.reason])).toEqual([["S0", "ambiguous"], ["S1", "ambiguous"]]);
    const forced = reconcileSpeakerNames(content, { S0: "A", S1: "陳" }, { S0: "Alice", S1: "陳經理" }, ["S0"]);
    expect(forced.content).toBe("Alice will draft Plan Alice. 陳說明天開會。");
    expect(forced.names).toEqual({ S0: "Alice", S1: "陳" });
  });

  test("speakers missing from the meeting now, or unchanged, are left as they are", () => {
    const r = reconcileSpeakerNames("Speaker 1 and Speaker 2", two, { S1: "Speaker 2" });
    expect(r.content).toBe("Speaker 1 and Speaker 2");
    expect(r.names).toEqual(two);
  });
});

// ------------------------------------------------------- through the API

describe("renaming speakers updates summaries", () => {
  test("a new summary keeps who said what, whatever order pyannote numbered the speakers in", async () => {
    const c = await memberClient("names-order");
    const id = await transcribed(c, ...SECOND_KEY_FIRST);
    const s = await finished(c, id, await summarize(c, id));
    expect(s.content).toContain("Speaker 1: 我先報告進度");
    expect(s.content).toContain("Speaker 2: 我補充風險");
    expect(s.speakerNames).toEqual({ SPEAKER_01: "Speaker 1", SPEAKER_00: "Speaker 2" });

    // Renaming the second speaker changes only that speaker's lines.
    expect(await rename(c, id, "SPEAKER_00", "Alice")).toEqual({ updated: 1, skipped: 0 });
    const after = await summary(c, id, s.id);
    expect(after.content).toContain("Speaker 1: 我先報告進度");
    expect(after.content).toContain("Alice: 我補充風險");
    expect(after.speakerNames).toEqual({ SPEAKER_01: "Speaker 1", SPEAKER_00: "Alice" });

    // Renaming again works from the name now in the summary.
    await rename(c, id, "SPEAKER_00", "王小明");
    expect((await summary(c, id, s.id)).content).toContain("王小明: 我補充風險");
  });

  test("a speaker renamed while the summary is being written appears under the new name", async () => {
    const c = await memberClient("names-running");
    const id = await transcribed(c, ...SECOND_KEY_FIRST);
    const sid = await summarize(c, id, "ECHO_SPEAKERS_PLEASE SLOW_PLEASE");
    await waitFor(async () => (await summary(c, id, sid))?.status === "running");
    await rename(c, id, "SPEAKER_01", "Bob");
    const s = await finished(c, id, sid);
    expect(s.content).toContain("Bob: 我先報告進度");
    expect(s.content).toContain("Speaker 2: 我補充風險");
    expect(s.speakerNames.SPEAKER_01).toBe("Bob");
  }, 20000); // the fake Codex takes 5 s to answer SLOW_PLEASE

  test("taking another speaker's name leaves summaries alone, and renaming back loses nothing", async () => {
    const c = await memberClient("names-collide");
    const id = await transcribed(c, ...SECOND_KEY_FIRST);
    const sid = await summarize(c, id, "Write minutes.");
    await finished(c, id, sid);
    setSummary(sid, "Bob agreed; Carol objected.", { SPEAKER_01: "Bob", SPEAKER_00: "Carol" });
    await rename(c, id, "SPEAKER_01", "Bob");
    await rename(c, id, "SPEAKER_00", "Carol");

    expect(await rename(c, id, "SPEAKER_00", "Bob")).toEqual({ updated: 0, skipped: 1 });
    expect((await summary(c, id, sid)).content).toBe("Bob agreed; Carol objected.");
    await rename(c, id, "SPEAKER_00", "Carol");
    const s = await summary(c, id, sid);
    expect(s.content).toBe("Bob agreed; Carol objected.");
    expect(s.speakerNames).toEqual({ SPEAKER_01: "Bob", SPEAKER_00: "Carol" });
  });

  test("a skipped name can be replaced on request, or kept as written", async () => {
    const c = await memberClient("names-resolve");
    const id = await transcribed(c, ...SECOND_KEY_FIRST);
    const sid = await summarize(c, id, "Write minutes.");
    await finished(c, id, sid);
    setSummary(sid, "A will draft Plan A.", { SPEAKER_01: "A", SPEAKER_00: "Speaker 2" });
    await rename(c, id, "SPEAKER_01", "A");
    expect(await rename(c, id, "SPEAKER_01", "Alice")).toEqual({ updated: 0, skipped: 1 });

    const keep = await c.post(`/api/meetings/${id}/summaries/${sid}/speaker-names`, { action: "keep", keys: ["SPEAKER_01"] });
    expect(keep.status).toBe(200);
    expect(((await keep.json()) as any).summary).toMatchObject({ content: "A will draft Plan A.", speakerNames: { SPEAKER_01: "Alice" } });

    setSummary(sid, "A will draft Plan A.", { SPEAKER_01: "A", SPEAKER_00: "Speaker 2" });
    const replace = await c.post(`/api/meetings/${id}/summaries/${sid}/speaker-names`, { action: "replace", keys: ["SPEAKER_01"] });
    expect(replace.status).toBe(200);
    expect(((await replace.json()) as any).summary.content).toBe("Alice will draft Plan Alice.");

    // Two speakers sharing a name: refused even on request.
    setSummary(sid, "Alice and Speaker 2", { SPEAKER_01: "Alice", SPEAKER_00: "Speaker 2" });
    await rename(c, id, "SPEAKER_00", "Alice");
    const merge = await c.post(`/api/meetings/${id}/summaries/${sid}/speaker-names`, { action: "replace", keys: ["SPEAKER_00"] });
    expect(merge.status).toBe(409);
    expect((await summary(c, id, sid)).content).toBe("Alice and Speaker 2");

    // Someone else's summary is not found.
    const other = await memberClient("names-other");
    expect((await other.post(`/api/meetings/${id}/summaries/${sid}/speaker-names`, { action: "keep", keys: ["SPEAKER_00"] })).status).toBe(404);
  });

  test("after a re-transcription, earlier summaries are no longer edited by renames", async () => {
    const c = await memberClient("names-retranscribe");
    const id = await transcribed(c, ...SECOND_KEY_FIRST);
    const sid = await summarize(c, id);
    await finished(c, id, sid);
    // Re-separating speakers: SPEAKER_00 may now be a different person.
    expect((await c.post(`/api/meetings/${id}/retranscribe`, { options: { diarize: true, numSpeakers: 2 }, resetSpeakerNames: true })).status).toBe(200);
    await completeJob(id, ["SPEAKER_00", "SPEAKER_01"], [
      { start: 0, end: 4, speaker: "SPEAKER_00", text: "我先報告進度" },
      { start: 4, end: 8, speaker: "SPEAKER_01", text: "我補充風險" },
    ]);
    const before = await summary(c, id, sid);
    expect(before.speakerNames).toEqual({});
    await rename(c, id, "SPEAKER_00", "Alice");
    expect((await summary(c, id, sid)).content).toBe(before.content);
  });
});
