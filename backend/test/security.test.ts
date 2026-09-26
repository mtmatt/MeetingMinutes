import { describe, expect, test } from "bun:test";
import { Client, app, memberClient, waitFor, worker } from "./helpers";

async function readyMeeting(c: Client, file: { name: string; type: string }, bytes = new Uint8Array(64)) {
  const res = await c.post("/api/meetings", { title: "Security", file: { name: file.name, size: bytes.length, type: file.type } });
  const { meeting } = (await res.json()) as any;
  await c.req("PUT", `/api/meetings/${meeting.id}/upload?offset=0`, { body: bytes, headers: { "content-type": "application/octet-stream" } });
  expect((await c.post(`/api/meetings/${meeting.id}/upload/complete`)).status).toBe(200);
  // Claim this meeting's job and complete it with a one-line transcript.
  const job = await waitFor(async () => {
    const r = await worker.call("/jobs/claim", { workerId: "sec", info: {} });
    if (r.status === 204) return null;
    const { job } = (await r.json()) as any;
    if (job.meetingId === meeting.id) return job;
    await worker.call(`/jobs/${job.jobId}/fail`, { workerId: "sec", error: "not this test", retryable: false });
    return null;
  });
  await worker.call(`/jobs/${job.jobId}/complete`, {
    workerId: "sec",
    result: { durationSec: 3, language: "Chinese", hasVideo: false, hasPlayback: false, hasPeaks: false, speakers: [], segments: [{ start: 0, end: 3, speaker: null, text: "測試" }] },
  });
  return meeting.id as string;
}

describe("security", () => {
  test("original media is served by extension type, never the type declared at upload", async () => {
    const c = await memberClient("mallory");
    const html = new TextEncoder().encode("<html><script>alert(document.cookie)</script></html>".padEnd(64, " "));
    const id = await readyMeeting(c, { name: "song.mp3", type: "text/html" }, html);
    const res = await c.get(`/api/meetings/${id}/media/original`);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // The site-wide policy applies too: no inline or foreign scripts, no framing.
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  test("another user's summary cannot be stopped or deleted through one's own meeting", async () => {
    const alice = await memberClient("alice-sec");
    const bob = await memberClient("bob-sec");
    const aliceMeeting = await readyMeeting(alice, { name: "a.wav", type: "audio/wav" });
    const bobMeeting = await readyMeeting(bob, { name: "b.wav", type: "audio/wav" });
    const { summary } = (await (await alice.post(`/api/meetings/${aliceMeeting}/summaries`, { prompt: "SLOW_PLEASE", outputLanguage: "en" })).json()) as any;

    const attack = await bob.del(`/api/meetings/${bobMeeting}/summaries/${summary.id}`);
    expect(attack.status).toBe(404);
    const still = (await (await alice.get(`/api/meetings/${aliceMeeting}`)).json()) as any;
    expect(still.meeting.summaries.find((s: any) => s.id === summary.id)?.status).not.toBe("canceled");

    // Summaries use the shared Codex quota: at most three in progress per person.
    const more = [];
    for (let i = 0; i < 3; i++) more.push(await alice.post(`/api/meetings/${aliceMeeting}/summaries`, { prompt: "SLOW_PLEASE", outputLanguage: "en" }));
    expect(more.map((r) => r.status)).toEqual([201, 201, 429]);
    expect(((await more[2]!.json()) as any).code).toBe("too_many_summaries");

    // Clean up so later tests are not queued behind these.
    const all = (await (await alice.get(`/api/meetings/${aliceMeeting}`)).json()) as any;
    for (const s of all.meeting.summaries) await alice.del(`/api/meetings/${aliceMeeting}/summaries/${s.id}`);
  });

  test("the live event stream ends when the session ends", async () => {
    const carol = await memberClient("carol-sec");
    const id = await readyMeeting(carol, { name: "c.wav", type: "audio/wav" });
    const res = await app.fetch(new Request("http://mm.test/api/events", { headers: { host: "mm.test", cookie: carol.cookie } }));
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // "ready"

    // Signed out elsewhere (same session), then something changes on one of carol's meetings.
    const cookie = carol.cookie;
    await carol.post("/api/auth/logout");
    const other = new Client();
    await other.post("/api/auth/login", { username: "carol-sec", password: "member password 123" });
    await other.patch(`/api/meetings/${id}`, { title: "renamed" });

    const ended = await Promise.race([
      (async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) return true;
        }
      })(),
      Bun.sleep(5000).then(() => false),
    ]);
    expect(ended).toBe(true);
    expect(cookie).not.toBe("");
  });
});
