import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { db } from "../src/db";
import { Client, memberClient, waitFor, worker } from "./helpers";

// Voice fingerprints for the fake people below: unit vectors in 16 dimensions.
// Alice, Bob and Carol sound nothing alike; "aliceLike" is Alice on another
// microphone (similarity 0.95), "aliceish" someone who only resembles her (0.5).
const DIM = 16;
function voice(parts: Record<number, number>): number[] {
  const v = new Array(DIM).fill(0);
  for (const [i, x] of Object.entries(parts)) v[Number(i)] = x;
  return v;
}
const ALICE = voice({ 0: 1 });
const ALICE_LIKE = voice({ 0: 0.95, 3: Math.sqrt(1 - 0.95 ** 2) });
const ALICEISH = voice({ 0: 0.5, 4: Math.sqrt(0.75) });
const BOB = voice({ 1: 1 });
const BOB_LIKE = voice({ 1: 0.9, 5: Math.sqrt(1 - 0.81) });
const CAROL = voice({ 2: 1 });

let users = 0;
/** A new person with no voice profiles, so tests do not share any. */
const person = () => memberClient(`voice${++users}`);

async function upload(c: Client, extra: Record<string, unknown> = {}) {
  const bytes = new Uint8Array(512);
  const res = await c.post("/api/meetings", { title: "Sync", file: { name: "sync.wav", size: bytes.length }, ...extra });
  const { meeting } = (await res.json()) as any;
  await c.req("PUT", `/api/meetings/${meeting.id}/upload?offset=0`, { body: bytes, headers: { "content-type": "application/octet-stream" } });
  expect((await c.post(`/api/meetings/${meeting.id}/upload/complete`)).status).toBe(200);
  return meeting.id as string;
}

/** Claim jobs until this meeting's job of `kind` comes up; others are failed (tests share one queue). */
async function claim(meetingId: string, kinds?: string[], kind = "transcribe") {
  for (let i = 0; i < 30; i++) {
    const res = await worker.call("/jobs/claim", { workerId: "gpu-v", ...(kinds ? { kinds } : {}) });
    if (res.status === 204) return null;
    const { job } = (await res.json()) as any;
    if (job.meetingId === meetingId && (job.kind ?? "transcribe") === kind) return job;
    await worker.call(`/jobs/${job.jobId}/fail`, { workerId: "gpu-v", error: "not this test", retryable: false });
  }
  return null;
}

type Speech = { key: string; voice?: number[]; sec?: number };

/** A transcript in which each speaker says one line of `sec` seconds (default 30). */
function transcript(speakers: Speech[], withVoices = true) {
  let t = 0;
  const segments = speakers.map((s) => {
    const start = t;
    t += s.sec ?? 30;
    return { start, end: t, speaker: s.key, text: `${s.key} talks.` };
  });
  const result: any = {
    durationSec: t,
    language: "Chinese",
    hasVideo: false,
    hasPlayback: false,
    hasPeaks: false,
    speakers: speakers.map((s) => s.key),
    segments,
    diarization: { status: "ok", speakers: speakers.length },
  };
  if (withVoices) {
    result.voiceModel = "test-model";
    result.voices = Object.fromEntries(speakers.filter((s) => s.voice).map((s) => [s.key, { embedding: s.voice, speechSec: s.sec ?? 30 }]));
  }
  return result;
}

async function transcribed(c: Client, speakers: Speech[], opts: { withVoices?: boolean; extra?: Record<string, unknown> } = {}) {
  const id = await upload(c, opts.extra);
  const job = await claim(id, ["transcribe", "voiceprint"]);
  expect(job).not.toBeNull();
  const res = await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu-v", result: transcript(speakers, opts.withVoices ?? true) });
  expect(res.status).toBe(200);
  return id;
}

async function detail(c: Client, id: string) {
  return ((await (await c.get(`/api/meetings/${id}`)).json()) as any).meeting;
}
const speaker = (m: any, key: string) => m.speakers.find((s: any) => s.key === key);

async function rename(c: Client, id: string, key: string, name: string, extra: Record<string, unknown> = {}) {
  const res = await c.patch(`/api/meetings/${id}/speakers/${key}`, { name, ...extra });
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

async function profiles(c: Client) {
  return (await (await c.get("/api/voices")).json()) as any;
}

describe("voice recognition", () => {
  test("a named voice is remembered and recognised in the next recording", async () => {
    const c = await person();
    const first = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE }, { key: "SPEAKER_01", voice: BOB }]);
    const m1 = await detail(c, first);
    expect(m1.voiceRecognition).toBe(true);
    expect(speaker(m1, "SPEAKER_00").voice).toMatchObject({ status: null, fingerprint: true, speechSec: 30 });

    const named = await rename(c, first, "SPEAKER_00", "Alice");
    expect(named.voice).toMatchObject({ remembered: "remembered", profile: { name: "Alice" } });
    let state = await profiles(c);
    expect(state.profiles).toHaveLength(1);
    expect(state.profiles[0]).toMatchObject({ name: "Alice", speechSec: 30, consistent: true });
    expect(state.profiles[0].samples[0]).toMatchObject({ meetingId: first, meetingTitle: "Sync", speakerKey: "SPEAKER_00", speakerName: "Alice" });

    // Next week: Alice on another microphone, plus someone new.
    const second = await transcribed(c, [{ key: "SPEAKER_00", voice: CAROL }, { key: "SPEAKER_01", voice: ALICE_LIKE }]);
    const m2 = await detail(c, second);
    expect(speaker(m2, "SPEAKER_01")).toMatchObject({ name: "Alice", voice: { status: "auto", profile: { name: "Alice" } } });
    expect(speaker(m2, "SPEAKER_01").voice.score).toBeCloseTo(0.95, 2);
    expect(speaker(m2, "SPEAKER_00")).toMatchObject({ name: "Speaker 1", voice: { status: null, profile: null } });

    // A recognised voice is not learned from until the user confirms it; the profile says where to check.
    const awaiting = (await profiles(c)).profiles[0];
    expect(awaiting.samples).toHaveLength(1);
    expect(awaiting.recognised).toBe(1);
    expect(awaiting.awaiting).toEqual([{ meetingId: second, meetingTitle: "Sync", speakerKey: "SPEAKER_01", score: expect.any(Number) }]);
    const confirmed = await c.post(`/api/meetings/${second}/speakers/SPEAKER_01/voice`, { action: "confirm" });
    expect(((await confirmed.json()) as any).voice.remembered).toBe("remembered");
    state = await profiles(c);
    expect(state.profiles[0].samples.map((s: any) => s.meetingId).sort()).toEqual([first, second].sort());
    expect(state.profiles[0].awaiting).toEqual([]);
    expect(speaker(await detail(c, second), "SPEAKER_01").voice.status).toBe("confirmed");
  });

  test("a weaker resemblance is only suggested, and accepting it names the speaker", async () => {
    const c = await person();
    const first = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE }]);
    await rename(c, first, "SPEAKER_00", "Alice");
    const second = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICEISH }]);
    let sp = speaker(await detail(c, second), "SPEAKER_00");
    expect(sp).toMatchObject({ name: "Speaker 1", voice: { status: "suggested", profile: { name: "Alice" } } });
    await c.post(`/api/meetings/${second}/speakers/SPEAKER_00/voice`, { action: "confirm" });
    sp = speaker(await detail(c, second), "SPEAKER_00");
    expect(sp).toMatchObject({ name: "Alice", voice: { status: "confirmed" } });
  });

  test("each person is recognised at most once per meeting, never under a name already used there", async () => {
    const c = await person();
    const first = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE }, { key: "SPEAKER_01", voice: BOB }]);
    await rename(c, first, "SPEAKER_00", "Alice");
    await rename(c, first, "SPEAKER_01", "Bob");
    // Two voices close to Alice: the closer one is Alice; the other is not guessed to be her too.
    const second = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE_LIKE }, { key: "SPEAKER_01", voice: ALICE }, { key: "SPEAKER_02", voice: BOB_LIKE }]);
    const m2 = await detail(c, second);
    expect(speaker(m2, "SPEAKER_01")).toMatchObject({ name: "Alice", voice: { status: "auto" } });
    expect(speaker(m2, "SPEAKER_00")).toMatchObject({ name: "Speaker 1", voice: { status: null } });
    expect(speaker(m2, "SPEAKER_02")).toMatchObject({ name: "Bob", voice: { status: "auto" } });

    // In an older meeting, someone else was called "Bob" by hand (without keeping the voice).
    // When its voices are found, Bob's voice is not given a name already used there.
    const third = await transcribed(c, [{ key: "SPEAKER_00" }, { key: "SPEAKER_01" }], { withVoices: false });
    await rename(c, third, "SPEAKER_00", "Bob", { remember: false });
    await c.post("/api/voices/scan");
    const job = await claim(third, ["voiceprint", "transcribe"], "voiceprint");
    await worker.call(`/jobs/${job.jobId}/complete`, {
      workerId: "gpu-v",
      result: { voiceModel: "test-model", voices: { SPEAKER_00: { embedding: CAROL, speechSec: 30 }, SPEAKER_01: { embedding: BOB, speechSec: 30 } } },
    });
    const m3 = await detail(c, third);
    expect(speaker(m3, "SPEAKER_00")).toMatchObject({ name: "Bob", voice: { status: "ignored" } });
    expect(speaker(m3, "SPEAKER_01")).toMatchObject({ name: "Speaker 2", voice: { status: null } });
  });

  test("rejecting a recognition restores the name and does not guess again", async () => {
    const c = await person();
    const first = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE }]);
    await rename(c, first, "SPEAKER_00", "Alice");
    const second = await transcribed(c, [{ key: "SPEAKER_00", voice: CAROL }, { key: "SPEAKER_01", voice: ALICE_LIKE }]);
    expect(speaker(await detail(c, second), "SPEAKER_01").name).toBe("Alice");
    await c.post(`/api/meetings/${second}/speakers/SPEAKER_01/voice`, { action: "reject" });
    let sp = speaker(await detail(c, second), "SPEAKER_01");
    expect(sp).toMatchObject({ name: "Speaker 2", voice: { status: "rejected", profile: null } });
    // Another rename in the meeting re-runs recognition; the rejected speaker stays unnamed.
    await rename(c, second, "SPEAKER_00", "Carol");
    sp = speaker(await detail(c, second), "SPEAKER_01");
    expect(sp).toMatchObject({ name: "Speaker 2", voice: { status: "rejected" } });
    // Naming them still remembers them.
    expect((await rename(c, second, "SPEAKER_01", "Dana")).voice.remembered).toBe("remembered");
  });

  test("forgetting a voice removes it, and renaming that speaker later does not learn it again", async () => {
    const c = await person();
    const id = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE }]);
    await rename(c, id, "SPEAKER_00", "Alice");
    expect((await profiles(c)).profiles).toHaveLength(1);
    await c.post(`/api/meetings/${id}/speakers/SPEAKER_00/voice`, { action: "forget" });
    // The profile had nothing else, so it is gone.
    expect((await profiles(c)).profiles).toHaveLength(0);
    expect(speaker(await detail(c, id), "SPEAKER_00")).toMatchObject({ name: "Alice", voice: { status: "ignored" } });
    expect((await rename(c, id, "SPEAKER_00", "Alice W.")).voice).toMatchObject({ remembered: "off" });
    expect((await profiles(c)).profiles).toHaveLength(0);
    // Unless asked to remember it.
    await c.post(`/api/meetings/${id}/speakers/SPEAKER_00/voice`, { action: "remember" });
    expect((await profiles(c)).profiles.map((p: any) => p.name)).toEqual(["Alice W."]);
  });

  test("default labels and `remember: false` keep no voice", async () => {
    const c = await person();
    const id = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE }, { key: "SPEAKER_01", voice: BOB }]);
    expect((await rename(c, id, "SPEAKER_00", "Speaker 7")).voice.remembered).toBe("off");
    expect((await rename(c, id, "SPEAKER_01", "Bob", { remember: false })).voice.remembered).toBe("off");
    expect((await profiles(c)).profiles).toHaveLength(0);
    expect(speaker(await detail(c, id), "SPEAKER_01").voice.status).toBe("ignored");
  });

  test("too little speech names the speaker without keeping a voice", async () => {
    const c = await person();
    const id = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE, sec: 2 }]);
    expect(speaker(await detail(c, id), "SPEAKER_00").voice.fingerprint).toBe(false);
    const r = await rename(c, id, "SPEAKER_00", "Alice");
    expect(r.voice).toMatchObject({ remembered: "short", profile: { name: "Alice" } });
    expect((await profiles(c)).profiles[0].samples).toHaveLength(0);
  });

  test("the automatic summary is written with the recognised names", async () => {
    const c = await person();
    const first = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE }]);
    await rename(c, first, "SPEAKER_00", "Alice Chen");
    const second = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE_LIKE }], {
      extra: { summary: { prompt: "Write minutes.", outputLanguage: "en" } },
    });
    const m = await waitFor(async () => {
      const d = await detail(c, second);
      return d.summaries[0]?.status === "done" ? d : null;
    });
    expect(readFileSync(process.env.FAKE_CODEX_PROMPT_FILE!, "utf8")).toContain("Alice Chen: SPEAKER_00 talks.");
    expect(m.summaries[0].speakerNames).toEqual({ SPEAKER_00: "Alice Chen" });
  });

  test("recognition renames speakers in finished summaries, and rejecting it renames them back", async () => {
    const c = await person();
    // An older meeting with a summary that calls the speaker "Speaker 1".
    const old = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE_LIKE }], { extra: { summary: { prompt: "Write minutes.", outputLanguage: "en" } } });
    await waitFor(async () => (await detail(c, old)).summaries[0]?.status === "done");
    const sid = (await detail(c, old)).summaries[0].id;
    db.query("UPDATE summaries SET content = 'Speaker 1 will ship it.' WHERE id = $id").run({ id: sid });
    const recent = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE }]);
    await rename(c, recent, "SPEAKER_00", "Alice");
    // "Find voices in past recordings".
    const scan = (await (await c.post("/api/voices/scan")).json()) as any;
    expect(scan.outcome).toMatchObject({ queued: 0, recognised: 1 });
    let m = await detail(c, old);
    expect(speaker(m, "SPEAKER_00")).toMatchObject({ name: "Alice", voice: { status: "auto" } });
    expect(m.summaries[0].content).toBe("Alice will ship it.");
    await c.post(`/api/meetings/${old}/speakers/SPEAKER_00/voice`, { action: "reject" });
    m = await detail(c, old);
    expect(speaker(m, "SPEAKER_00").name).toBe("Speaker 1");
    expect(m.summaries[0].content).toBe("Speaker 1 will ship it.");
  });

  test("past recordings without fingerprints get them from a background job, and their names are learned", async () => {
    const c = await person();
    // Transcribed before voice fingerprints existed; the user named one speaker.
    const old = await transcribed(c, [{ key: "SPEAKER_00" }, { key: "SPEAKER_01" }, { key: "SPEAKER_02", sec: 1 }], { withVoices: false });
    await rename(c, old, "SPEAKER_00", "Bob");
    expect((await rename(c, old, "SPEAKER_00", "Bob")).voice).toBeNull();
    // Named before recognition knew this speaker's voice: confirmed, waiting for it.
    expect(speaker(await detail(c, old), "SPEAKER_00").voice).toMatchObject({ status: "confirmed", fingerprint: false });
    const later = await transcribed(c, [{ key: "SPEAKER_00", voice: CAROL }]);
    await rename(c, later, "SPEAKER_00", "Carol");

    const scan = (await (await c.post("/api/voices/scan")).json()) as any;
    expect(scan.outcome.queued).toBe(1);
    expect(scan.scan.queued).toBeGreaterThanOrEqual(1);

    // A worker from before voiceprints is never handed one.
    const legacy = await worker.call("/jobs/claim", { workerId: "old-gpu" });
    if (legacy.status === 200) expect(((await legacy.json()) as any).job.kind).not.toBe("voiceprint");
    const job = await claim(old, ["transcribe", "voiceprint"], "voiceprint");
    expect(job).toMatchObject({ kind: "voiceprint", meetingId: old });
    expect(job.options.speakers).toEqual({ SPEAKER_00: [[0, 30]], SPEAKER_01: [[30, 60]], SPEAKER_02: [[60, 61]] });

    // The meeting stays readable while its voices are fingerprinted.
    await worker.call(`/jobs/${job.jobId}/progress`, { workerId: "gpu-v", stage: "voiceprint", progress: 0.5 });
    expect(await detail(c, old)).toMatchObject({ status: "ready", stage: null, progress: 1 });

    // A voiceprint job is completed only by a voiceprint result.
    const wrong = await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu-v", result: transcript([{ key: "SPEAKER_00" }], false) });
    expect(wrong.status).toBe(422);
    expect(((await wrong.json()) as any).error).toContain("voiceModel");
    const res = await worker.call(`/jobs/${job.jobId}/complete`, {
      workerId: "gpu-v",
      result: { voiceModel: "test-model", voices: { SPEAKER_00: { embedding: BOB, speechSec: 30 }, SPEAKER_01: { embedding: CAROL, speechSec: 30 } } },
    });
    expect(res.status).toBe(200);
    const m = await detail(c, old);
    expect(m.status).toBe("ready");
    expect(speaker(m, "SPEAKER_00").voice).toMatchObject({ status: "confirmed", fingerprint: true });
    expect(speaker(m, "SPEAKER_01")).toMatchObject({ name: "Carol", voice: { status: "auto" } });
    expect(speaker(m, "SPEAKER_02").voice).toMatchObject({ fingerprint: false, speechSec: 1 });
    expect((await profiles(c)).profiles.map((p: any) => [p.name, p.samples.length])).toEqual([["Bob", 1], ["Carol", 1]]);
    // Nothing left to fingerprint: scanning again queues nothing.
    expect(((await (await c.post("/api/voices/scan")).json()) as any).outcome.queued).toBe(0);
  });

  test("a voiceprint job that fails leaves the meeting as it was", async () => {
    const c = await person();
    const id = await transcribed(c, [{ key: "SPEAKER_00" }], { withVoices: false });
    await c.post("/api/voices/scan");
    const job = await claim(id, ["voiceprint", "transcribe"], "voiceprint");
    await worker.call(`/jobs/${job.jobId}/fail`, { workerId: "gpu-v", error: "no diarization model", retryable: false });
    expect(await detail(c, id)).toMatchObject({ status: "ready", error: null });
  });

  test("speakers added by hand are fingerprinted once paragraphs are theirs", async () => {
    const c = await person();
    const id = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE }]);
    const added = (await (await c.post(`/api/meetings/${id}/speakers`, { name: "Erin" })).json()) as any;
    // Nothing to fingerprint until paragraphs are theirs.
    expect(db.query("SELECT 1 FROM jobs WHERE meeting_id = $m AND kind = 'voiceprint'").get({ m: id })).toBeNull();
    const segId = (await detail(c, id)).segments[0].id;
    await c.patch(`/api/meetings/${id}/segments/${segId}`, { speaker: added.speaker.key });
    const job = await claim(id, ["voiceprint", "transcribe"], "voiceprint");
    expect(job.options.speakers).toEqual({ [added.speaker.key]: [[0, 30]] });
    await worker.call(`/jobs/${job.jobId}/complete`, {
      workerId: "gpu-v",
      result: { voiceModel: "test-model", voices: { [added.speaker.key]: { embedding: CAROL, speechSec: 30 } } },
    });
    expect((await profiles(c)).profiles.map((p: any) => [p.name, p.samples.length])).toEqual([["Erin", 1]]);
  });

  test("re-separating speakers keeps a person's link only if the key still has their voice", async () => {
    const c = await person();
    const id = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE }, { key: "SPEAKER_01", voice: BOB }]);
    await rename(c, id, "SPEAKER_00", "Alice");
    await rename(c, id, "SPEAKER_01", "Bob");
    await c.post(`/api/meetings/${id}/retranscribe`, {});
    const job = await claim(id, ["transcribe"]);
    // SPEAKER_00 is still Alice; SPEAKER_01 is now Carol, who must not be taken for Bob.
    await worker.call(`/jobs/${job.jobId}/complete`, {
      workerId: "gpu-v",
      result: transcript([{ key: "SPEAKER_00", voice: ALICE_LIKE }, { key: "SPEAKER_01", voice: CAROL }]),
    });
    const m = await detail(c, id);
    expect(speaker(m, "SPEAKER_00").voice).toMatchObject({ status: "confirmed", profile: { name: "Alice" } });
    expect(speaker(m, "SPEAKER_01").voice).toMatchObject({ status: null, profile: null });
    const state = await profiles(c);
    const bob = state.profiles.find((p: any) => p.name === "Bob");
    // Bob's voice is still known, just no longer tied to a speaker of that meeting.
    expect(bob.samples).toEqual([expect.objectContaining({ meetingId: id, speakerKey: null })]);
    const alice = state.profiles.find((p: any) => p.name === "Alice");
    expect(alice.samples).toEqual([expect.objectContaining({ meetingId: id, speakerKey: "SPEAKER_00" })]);
  });

  test("transcribing again without fingerprints keeps the voices already remembered", async () => {
    const c = await person();
    const id = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE }]);
    await rename(c, id, "SPEAKER_00", "Alice");
    await c.post(`/api/meetings/${id}/retranscribe`, {});
    const job = await claim(id, ["transcribe"]);
    // e.g. a worker from before voice fingerprints
    await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu-v", result: transcript([{ key: "SPEAKER_00" }], false) });
    expect(speaker(await detail(c, id), "SPEAKER_00")).toMatchObject({ name: "Alice", voice: { status: "confirmed", fingerprint: true } });
    expect((await profiles(c)).profiles[0].samples).toEqual([expect.objectContaining({ meetingId: id, speakerKey: "SPEAKER_00" })]);
  });

  test("renaming a recognised speaker back to a default label is a rejection", async () => {
    const c = await person();
    const first = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE }]);
    await rename(c, first, "SPEAKER_00", "Alice");
    const second = await transcribed(c, [{ key: "SPEAKER_00", voice: CAROL }, { key: "SPEAKER_01", voice: ALICE_LIKE }]);
    expect(speaker(await detail(c, second), "SPEAKER_01").name).toBe("Alice");
    await rename(c, second, "SPEAKER_01", "Speaker 2");
    // Recognition runs again when someone else is named; it does not name them Alice again.
    await rename(c, second, "SPEAKER_00", "Carol");
    expect(speaker(await detail(c, second), "SPEAKER_01")).toMatchObject({ name: "Speaker 2", voice: { status: "rejected", defaultName: true } });
  });

  test("a shorter fingerprint after transcribing again does not replace a remembered voice", async () => {
    const c = await person();
    const id = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE, sec: 40 }]);
    await rename(c, id, "SPEAKER_00", "Alice");
    await c.post(`/api/meetings/${id}/retranscribe`, {});
    const job = await claim(id, ["transcribe"]);
    await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu-v", result: transcript([{ key: "SPEAKER_00", voice: ALICE_LIKE, sec: 3 }]) });
    expect(speaker(await detail(c, id), "SPEAKER_00").voice).toMatchObject({ status: "confirmed", fingerprint: false });
    expect((await profiles(c)).profiles[0].samples).toEqual([expect.objectContaining({ speakerKey: "SPEAKER_00", speechSec: 40 })]);
  });

  test("scanning remembers named speakers even where other speakers still need fingerprints, and reports failed jobs", async () => {
    const c = await person();
    const id = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE }, { key: "SPEAKER_01" }]);
    // Named while recognition was off, so not remembered then.
    await c.patch("/api/voices/settings", { enabled: false });
    await rename(c, id, "SPEAKER_00", "Alice");
    await c.patch("/api/voices/settings", { enabled: true });
    const scan = (await (await c.post("/api/voices/scan")).json()) as any;
    expect(scan.outcome).toMatchObject({ queued: 1, remembered: 1 });
    expect(scan.profiles.map((p: any) => p.name)).toEqual(["Alice"]);
    const job = await claim(id, ["voiceprint", "transcribe"], "voiceprint");
    await worker.call(`/jobs/${job.jobId}/fail`, { workerId: "gpu-v", error: "Voice fingerprints need the speaker diarization model", retryable: false });
    const state = await profiles(c);
    expect(state.scan).toMatchObject({ queued: 0, running: 0, failed: 1, error: "Voice fingerprints need the speaker diarization model" });
  });

  test("turning recognition off stops naming and remembering", async () => {
    const c = await person();
    const first = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE }]);
    await rename(c, first, "SPEAKER_00", "Alice");
    const off = (await (await c.patch("/api/voices/settings", { enabled: false })).json()) as any;
    expect(off.enabled).toBe(false);
    const second = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE_LIKE }, { key: "SPEAKER_01", voice: BOB }]);
    const m = await detail(c, second);
    expect(m.voiceRecognition).toBe(false);
    expect(speaker(m, "SPEAKER_00").name).toBe("Speaker 1");
    expect((await rename(c, second, "SPEAKER_01", "Bob")).voice.remembered).toBe("off");
    expect((await c.post("/api/voices/scan")).status).toBe(409);
    // Profiles made before stay until deleted, and learn nothing new while off.
    await c.post(`/api/meetings/${first}/retranscribe`, {});
    const job = await claim(first, ["transcribe"]);
    await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu-v", result: transcript([{ key: "SPEAKER_00", voice: ALICE_LIKE }]) });
    const alice = (await profiles(c)).profiles;
    expect(alice.map((p: any) => p.name)).toEqual(["Alice"]);
    const stored = db.query<{ embedding: Uint8Array }, { m: string }>("SELECT embedding FROM voice_samples WHERE meeting_id = $m").get({ m: first })!;
    expect(new Float32Array(stored.embedding.slice().buffer)[0]).toBeCloseTo(1, 5); // still ALICE, not ALICE_LIKE
  });

  test("profiles can be renamed, merged and deleted", async () => {
    const c = await person();
    const a = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE }, { key: "SPEAKER_01", voice: BOB }]);
    await rename(c, a, "SPEAKER_00", "Alice");
    await rename(c, a, "SPEAKER_01", "Bob");
    const b = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE_LIKE }, { key: "SPEAKER_01", voice: CAROL }]);
    await rename(c, b, "SPEAKER_00", "愛麗絲"); // the same person, named differently
    let state = await profiles(c);
    const id = (name: string) => state.profiles.find((p: any) => p.name === name).id;

    // Renaming a profile renames its speakers; a name in use is refused.
    const taken = await c.patch(`/api/voices/${id("Bob")}`, { name: "alice" });
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as any).code).toBe("name_taken");
    state = (await (await c.patch(`/api/voices/${id("Bob")}`, { name: "Robert" })).json()) as any;
    expect(speaker(await detail(c, a), "SPEAKER_01").name).toBe("Robert");

    state = (await (await c.post(`/api/voices/${id("愛麗絲")}/merge`, { into: id("Alice") })).json()) as any;
    expect(state.profiles.map((p: any) => [p.name, p.samples.length])).toEqual([["Alice", 2], ["Robert", 1]]);
    expect(speaker(await detail(c, b), "SPEAKER_00")).toMatchObject({ name: "Alice", voice: { status: "confirmed" } });

    // Deleting a person forgets their voice; speakers keep the names the user gave them.
    const c2 = await transcribed(c, [{ key: "SPEAKER_00", voice: BOB_LIKE }]);
    expect(speaker(await detail(c, c2), "SPEAKER_00").name).toBe("Robert");
    state = (await (await c.del(`/api/voices/${id("Robert")}`)).json()) as any;
    expect(state.profiles.map((p: any) => p.name)).toEqual(["Alice"]);
    expect(speaker(await detail(c, a), "SPEAKER_01")).toMatchObject({ name: "Robert", voice: { status: "ignored" } });
    // ...but the name recognition gave is taken back.
    expect(speaker(await detail(c, c2), "SPEAKER_00")).toMatchObject({ name: "Speaker 1", voice: { status: null } });

    const sample = state.profiles[0].samples[0];
    state = (await (await c.del(`/api/voices/${state.profiles[0].id}/samples/${sample.id}`)).json()) as any;
    expect(state.profiles[0].samples).toHaveLength(1);
  });

  test("a profile whose samples sound like different people is flagged", async () => {
    const c = await person();
    const a = await transcribed(c, [{ key: "SPEAKER_00", voice: ALICE }]);
    const b = await transcribed(c, [{ key: "SPEAKER_00", voice: BOB }]);
    await rename(c, a, "SPEAKER_00", "Guest");
    await rename(c, b, "SPEAKER_00", "Guest");
    expect((await profiles(c)).profiles[0]).toMatchObject({ name: "Guest", consistent: false });
  });

  test("voices are private to each person", async () => {
    const alice = await person();
    const mallory = await person();
    const id = await transcribed(alice, [{ key: "SPEAKER_00", voice: ALICE }]);
    await rename(alice, id, "SPEAKER_00", "Alice");
    const pid = (await profiles(alice)).profiles[0].id;
    // Someone else's recording of the same voice is not recognised with Alice's profiles.
    const theirs = await transcribed(mallory, [{ key: "SPEAKER_00", voice: ALICE_LIKE }]);
    expect(speaker(await detail(mallory, theirs), "SPEAKER_00").name).toBe("Speaker 1");
    expect((await profiles(mallory)).profiles).toEqual([]);
    expect((await mallory.patch(`/api/voices/${pid}`, { name: "x" })).status).toBe(404);
    expect((await mallory.post(`/api/voices/${pid}/merge`, { into: pid })).status).toBe(404);
    expect((await mallory.del(`/api/voices/${pid}`)).status).toBe(404);
    expect((await mallory.post(`/api/meetings/${id}/speakers/SPEAKER_00/voice`, { action: "forget" })).status).toBe(404);
    expect((await profiles(alice)).profiles).toHaveLength(1);
  });

  test("malformed fingerprints are refused", async () => {
    const c = await person();
    const id = await upload(c);
    const job = await claim(id, ["transcribe"]);
    const bad = transcript([{ key: "SPEAKER_00", voice: ALICE }]);
    bad.voices.SPEAKER_00.embedding = [1, 2];
    expect((await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu-v", result: bad })).status).toBe(422);
    // An all-zero vector has no direction: the transcript is kept, without that fingerprint.
    const zero = transcript([{ key: "SPEAKER_00", voice: new Array(DIM).fill(0) }]);
    expect((await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu-v", result: zero })).status).toBe(200);
    expect(speaker(await detail(c, id), "SPEAKER_00").voice).toMatchObject({ fingerprint: false });
  });
});
