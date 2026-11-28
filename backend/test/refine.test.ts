import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { acceptableFix, applyReplacement, editDistance, setRefineClientForTests } from "../src/services/refine";
import { adminClient, memberClient, waitFor, worker, type Client } from "./helpers";

let n = 0;
/** Every request the stand-in model received. */
const calls: { max_tokens: number; content: string }[] = [];
/** What the stand-in "model" corrects: misheard → right. */
const FIXES: [string, string][] = [
  ["瑞克特", "React"],
  ["A屁愛", "API"],
];

/** A stand-in for the Anthropic client: reads the ids in each part and answers like the model would. */
const fake = {
  messages: {
    async parse(args: any) {
      const content = String(args.messages[0].content);
      // A real request takes a while: long enough for a second request to find this one running.
      await new Promise((r) => setTimeout(r, 40));
      calls.push({ max_tokens: args.max_tokens, content });
      const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      if (args.max_tokens === 4000) return { parsed_output: { topic: "前端改版會議", terms: ["React", "API"] }, usage };
      const fixes: { id: number; wrong: string; right: string }[] = [];
      const editable = content.split("the phrase that was actually said:")[1] ?? "";
      for (const line of editable.split("\n")) {
        if (!line.startsWith("{")) continue;
        const s = JSON.parse(line) as { id: number; speaker: string; text: string };
        for (const [a, b] of FIXES) if (s.text.includes(a)) fixes.push({ id: s.id, wrong: a, right: b });
        // What the server must refuse: the speaker's name glued in front, and a whole sentence rewritten.
        if (s.text.includes("他們應該")) fixes.push({ id: s.id, wrong: "他們應該", right: `${s.speaker}: 他們應該` });
        if (s.text.includes("整句重寫")) fixes.push({ id: s.id, wrong: s.text, right: "完全不同的一句話，內容已經被模型改寫掉了" });
        // Nothing misheard, the phrase "corrected" to itself.
        if (s.text.includes("下週見")) fixes.push({ id: s.id, wrong: "下週見", right: "下週見" });
      }
      return { parsed_output: { fixes }, usage };
    },
  },
};

/** A transcribed meeting with these sentences (and a speaker), owned by `c`. */
async function meeting(c: Client, lines: string[], opts: { edited?: number[] } = {}) {
  const me = ((await (await c.get("/api/me")).json()) as any).user.id as string;
  const id = `refine-m${++n}`;
  const t = Date.now();
  db.query(
    `INSERT INTO meetings (id, owner_id, title, status, media_name, media_mime, media_size, media_ext, duration_sec, language, options, created_at, updated_at, transcribed_at)
     VALUES ($id, $o, '前端週會', 'ready', 'a.m4a', 'audio/mp4', 1, 'm4a', 600, 'Chinese', '{"script":"zh-TW"}', $t, $t, $t)`,
  ).run({ id, o: me, t });
  db.query("INSERT INTO speakers (meeting_id, key, name, color) VALUES ($m, 'S0', '林怡君', 0)").run({ m: id });
  lines.forEach((text, i) =>
    db
      .query("INSERT INTO segments (meeting_id, idx, start_sec, end_sec, speaker, text, edited) VALUES ($m, $i, $s, $e, 'S0', $text, $ed)")
      .run({ m: id, i, s: i * 5, e: i * 5 + 4, text, ed: opts.edited?.includes(i) ? 1 : 0 }),
  );
  return id;
}

const detail = async (c: Client, id: string) => ((await (await c.get(`/api/meetings/${id}`)).json()) as any).meeting;

async function setRefine(enabled: boolean) {
  const res = await (await adminClient()).req("PUT", "/api/admin/refine", { json: { enabled, model: "claude-haiku-5-5" } });
  expect(res.status).toBe(200);
}

describe("correcting a transcript with a hosted model", () => {
  // The shared setup gives the server an Anthropic key (for its fake summary API); corrections get their own stand-in.
  beforeAll(() => setRefineClientForTests(fake));
  afterAll(async () => {
    setRefineClientForTests(null);
    await (await adminClient()).del("/api/admin/refine");
    // These meetings have no recording: other tests that list meetings must not meet them.
    db.query("DELETE FROM meetings WHERE id LIKE 'refine-m%'").run();
  });

  test("a correction replaces a misheard phrase and nothing else", () => {
    expect(applyReplacement("我們改用瑞克特來寫", "瑞克特", "React")).toBe("我們改用React來寫");
    // The phrase must be in the sentence, and change.
    expect(applyReplacement("我們改用React", "瑞克特", "React")).toBeNull();
    expect(applyReplacement("下週見", "下週見", "下週見")).toBeNull();
    // Only adding to what was said: a name or a label in front.
    expect(applyReplacement("他們應該也是有在做", "他們", "蔡承霖: 他們")).toBeNull();
    expect(applyReplacement("他們應該也是有在做", "他們", "蔡承霖：他們")).toBeNull();
    expect(applyReplacement("點將資訊股份有限公司", "點將資訊", "蔡承霖點將資訊")).toBeNull();
    // A speaker's name where none was heard; but a misheard name may be corrected to it.
    expect(applyReplacement("那個人說好", "那個人", "蔡承霖", ["蔡承霖"])).toBeNull();
    expect(applyReplacement("我是蔡成林", "蔡成林", "蔡承霖", ["蔡承霖"])).toBe("我是蔡承霖");
  });

  test("a fix is a small change, never a rewrite", () => {
    expect(editDistance("瑞克特很好用", "React很好用")).toBe(5);
    expect(acceptableFix("我們改用瑞克特來寫前端", "我們改用React來寫前端")).toBe(true);
    expect(acceptableFix("我們改用瑞克特", "我們改用瑞克特")).toBe(false);
    expect(acceptableFix("好，我們開始。先看上週的待辦", "完全不同的一句話，內容已經被模型改寫掉了")).toBe(false);
    expect(acceptableFix("好的", "")).toBe(false);
  });

  test("off until an administrator turns it on; people are told when it is on", async () => {
    const c = await memberClient("refine-off");
    const id = await meeting(c, ["我們改用瑞克特"]);
    await setRefine(false);
    expect((await c.post(`/api/meetings/${id}/refine`)).status).toBe(409);
    expect(((await (await c.get("/api/auth/state")).json()) as any).refine.available).toBe(false);
    // Only administrators set it.
    expect((await c.req("PUT", "/api/admin/refine", { json: { enabled: true, model: "x" } })).status).toBe(403);
    await setRefine(true);
    expect(((await (await c.get("/api/auth/state")).json()) as any).refine).toMatchObject({ available: true, vendor: "Anthropic" });
  });

  test("fixes misheard words, keeps the original, leaves hand edits and rewrites alone, and can be undone", async () => {
    await setRefine(true);
    const c = await memberClient("refine-amy");
    const id = await meeting(
      c,
      ["我們這次改用瑞克特來重寫前端。", "後端的A屁愛下週凍結。", "我手動改過的瑞克特句子。", "這句整句重寫測試。", "好，下週見。", "他們應該也是有在做。"],
      { edited: [2] },
    );
    const res = await c.post(`/api/meetings/${id}/refine`);
    expect(res.status).toBe(200);
    // One at a time.
    expect((await c.post(`/api/meetings/${id}/refine`)).status).toBe(409);
    const m = await waitFor(async () => {
      const d = await detail(c, id);
      return d.refinement?.status === "done" && d;
    });
    const texts = m.segments.map((s: any) => s.text);
    expect(texts[0]).toBe("我們這次改用React來重寫前端。");
    expect(texts[1]).toBe("後端的API下週凍結。");
    expect(texts[2]).toBe("我手動改過的瑞克特句子。"); // edited by hand: untouched
    expect(texts[3]).toBe("這句整句重寫測試。"); // a rewrite: refused
    expect(texts[4]).toBe("好，下週見。"); // nothing to correct
    expect(texts[5]).toBe("他們應該也是有在做。"); // a speaker's name glued on: refused
    expect(m.segments[5].original).toBeUndefined();
    expect(m.segments[0].original).toBe("我們這次改用瑞克特來重寫前端。");
    expect(m.segments[4].original).toBeUndefined();
    expect(m.refinement.changed).toBe(2);
    // The hand-edited sentence was not even sent to be corrected; the topic was read first.
    expect(calls.some((x) => (x.content.split("the phrase that was actually said:")[1] ?? "").includes("我手動改過的"))).toBe(false);
    // The speaker goes as a field of its own, never in front of the words.
    expect(calls.some((x) => x.content.includes('"speaker":"林怡君","text":"我們這次改用瑞克特來重寫前端。"'))).toBe(true);
    expect(calls.some((x) => x.max_tokens === 4000)).toBe(true);

    const undo = await c.post(`/api/meetings/${id}/refine/undo`);
    expect(((await undo.json()) as any).restored).toBe(2);
    const back = await detail(c, id);
    expect(back.segments[0].text).toBe("我們這次改用瑞克特來重寫前端。");
    expect(back.segments[0].original).toBeUndefined();
  });

  test("a prepaid person pays at the summary rates, and is refused without enough points", async () => {
    await setRefine(true);
    const c = await memberClient("refine-paid");
    const me = ((await (await c.get("/api/me")).json()) as any).user.id as string;
    db.query("UPDATE users SET billing = 'prepaid', credits = 0 WHERE id = $id").run({ id: me });
    const id = await meeting(c, ["我們改用瑞克特。"]);
    const refused = await c.post(`/api/meetings/${id}/refine`);
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as any).code).toBe("insufficient_credits");

    db.query("UPDATE users SET credits = 100000 WHERE id = $id").run({ id: me });
    expect((await c.post(`/api/meetings/${id}/refine`)).status).toBe(200);
    await waitFor(async () => (await detail(c, id)).refinement?.status === "done");
    const row = db.query<{ charged: number | null; usage: string }, { m: string }>("SELECT charged, usage FROM refinements WHERE meeting_id = $m").get({ m: id })!;
    // Two requests of 1,000 read and 200 written at 0.1 / 0.5 points per thousand: 0.4 points.
    expect(JSON.parse(row.usage)).toEqual({ input: 2000, output: 400 });
    expect(row.charged).toBe(400);
    const ledger = db.query<{ title: string; delta: number }, { u: string }>("SELECT title, delta FROM credit_ledger WHERE user_id = $u ORDER BY id DESC LIMIT 1").get({ u: me })!;
    expect(ledger).toEqual({ title: "前端週會 · 逐字稿修正", delta: -400 });
  });

  test("the automatic summary waits for the corrected transcript", async () => {
    await setRefine(true);
    const c = await memberClient("refine-then-summary");
    const id = await meeting(c, ["我們改用瑞克特。"]);
    const { enqueueRefinementAfterTranscription } = await import("../src/services/refine");
    const m = db.query<any, { id: string }>("SELECT * FROM meetings WHERE id = $id").get({ id });
    expect(enqueueRefinementAfterTranscription(m, { templateId: null, prompt: "摘要", outputLanguage: "zh-TW" })).toBe(true);
    // No summary until the correction is done.
    const summaries = () => db.query<{ n: number }, { m: string }>("SELECT COUNT(*) AS n FROM summaries WHERE meeting_id = $m").get({ m: id })!.n;
    await waitFor(async () => (await detail(c, id)).refinement?.status === "done");
    await waitFor(async () => summaries() === 1);
    expect(summaries()).toBe(1);
  });

  test("transcribing again (or re-splitting speakers) can ask for a correction of the new transcript", async () => {
    await setRefine(true);
    const c = await memberClient("refine-again");
    // A real upload and transcription, so transcribing again goes through the worker.
    const bytes = new Uint8Array(2048).fill(5);
    const created = await c.post("/api/meetings", { title: "再轉錄", file: { name: "a.m4a", size: bytes.length } });
    const { meeting } = (await created.json()) as any;
    await c.req("PUT", `/api/meetings/${meeting.id}/upload?offset=0`, { body: bytes, headers: { "content-type": "application/octet-stream" } });
    await c.post(`/api/meetings/${meeting.id}/upload/complete`);
    const finish = async () => {
      for (let i = 0; i < 60; i++) {
        const res = await worker.call("/jobs/claim", { workerId: "gpu-refine", kinds: ["transcribe"] });
        if (res.status === 204) break;
        const { job } = (await res.json()) as any;
        if (job.meetingId !== meeting.id) {
          await worker.call(`/jobs/${job.jobId}/fail`, { workerId: "gpu-refine", error: "not this test", retryable: false });
          continue;
        }
        const done = await worker.call(`/jobs/${job.jobId}/complete`, {
          workerId: "gpu-refine",
          result: { durationSec: 60, language: "Chinese", hasVideo: false, hasPlayback: false, hasPeaks: false, speakers: ["SPEAKER_00"], segments: [{ start: 0, end: 3, speaker: "SPEAKER_00", text: "我們改用瑞克特。" }] },
        });
        expect(done.status).toBe(200);
        return;
      }
      throw new Error("the transcription was never handed out");
    };
    await finish();
    // Not asked at upload: no correction.
    expect((await detail(c, meeting.id)).refinement).toBeNull();

    const d = await detail(c, meeting.id);
    expect((await c.post(`/api/meetings/${meeting.id}/retranscribe`, { options: { ...d.options, refine: true } })).status).toBe(200);
    await finish();
    const after = await waitFor(async () => {
      const m = await detail(c, meeting.id);
      return m.refinement?.status === "done" && m;
    });
    expect(after.options.refine).toBe(true);
    expect(after.segments[0].text).toBe("我們改用React。");
    db.query("DELETE FROM meetings WHERE id = $id").run({ id: meeting.id });
  });
});
