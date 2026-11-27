import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { db, now } from "../src/db";
import { WAKE_RETRY_MS, WAKE_TRIES_PER_JOB, resetWakeState, wakeSignature, wakeSweep } from "../src/services/workerWake";
import { adminClient, app, memberClient } from "./helpers";

/** A stand-in for the platform's wake-up address: records each call. */
const calls: { headers: Headers; body: any }[] = [];
let status = 200;
let answer = "ok";
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    calls.push({ headers: req.headers, body: await req.json().catch(() => null) });
    return new Response(status === 200 ? answer : "nope", { status });
  },
});
const WAKE_URL = `http://127.0.0.1:${server.port}/wake`;
afterAll(() => server.stop(true));

async function internal(token: string, path: string, json: unknown) {
  return app.fetch(
    new Request(`http://mm.test/internal${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(json),
    }),
  );
}

async function enroll(name: string) {
  const admin = await adminClient();
  const created = (await (await admin.post("/api/admin/worker-keys", { name })).json()) as any;
  const got = (await (await internal("", "/enroll", { code: created.code })).json()) as any;
  return { id: got.workerId as string, token: got.token as string };
}

/** A transcription waiting in the queue, `ageMs` old. */
function queued(ageMs = 10_000): string {
  const owner = db.query<{ id: string }, []>("SELECT id FROM users ORDER BY created_at LIMIT 1").get()!.id;
  const m = `wake-m-${Math.random().toString(36).slice(2, 10)}`;
  const t = now() - ageMs;
  db.query(
    `INSERT INTO meetings (id, owner_id, title, status, media_name, media_mime, media_size, media_ext, created_at, updated_at)
     VALUES ($id, $o, 'Wake', 'queued', 'a.wav', 'audio/wav', 1, 'wav', $t, $t)`,
  ).run({ id: m, o: owner, t });
  const id = `wake-j-${Math.random().toString(36).slice(2, 10)}`;
  db.query("INSERT INTO jobs (id, meeting_id, status, created_at) VALUES ($id, $m, 'queued', $t)").run({ id, m, t });
  return id;
}

function clearQueue() {
  db.query("UPDATE jobs SET status = 'canceled' WHERE status = 'queued'").run();
}

beforeEach(() => {
  // Each test sets up its own workers' addresses.
  db.query("DELETE FROM settings WHERE key = 'workerWake'").run();
  calls.length = 0;
  status = 200;
  answer = "ok";
  resetWakeState();
});

describe("workers started on demand", () => {
  test("the signature is the one the worker checks", () => {
    // The same vector as worker/tests/test_wake.py.
    const token = "mmw_wkabcdefghjk.secretpart";
    const hash = createHash("sha256").update(token).digest("hex");
    expect(hash).toBe("ae7305186eb003211ae370cde4476cfb5d18827ad76fe904681ed015fca7e7f8");
    expect(wakeSignature(hash, "wkabcdefghjk", 1_800_000_000_000)).toBe(
      "t=1800000000000,sig=00fc6caddf2dde8c3eb03fe844db79dfc3b6d5c5977982fefeb1c34e39de2c45",
    );
  });

  test("an offline worker is called, signed with its token, when work waits for it", async () => {
    clearQueue();
    const admin = await adminClient();
    const { id, token } = await enroll("Modal T4");
    expect((await admin.req("PUT", `/api/admin/worker-wake/${id}`, { json: { url: WAKE_URL } })).status).toBe(200);

    // Nothing queued: nobody is called.
    expect(await wakeSweep()).toEqual([]);
    queued();
    expect(await wakeSweep()).toEqual([id]);
    expect(calls).toHaveLength(1);
    const header = calls[0]!.headers.get("x-mm-wake")!;
    const [, t, sig] = header.match(/^t=(\d+),sig=([0-9a-f]{64})$/)!;
    const key = createHash("sha256").update(token).digest("hex");
    expect(sig).toBe(createHmac("sha256", key).update(`${t}.${id}`).digest("hex"));
    expect(calls[0]!.body).toMatchObject({ worker: id, reason: "queued" });

    // Called again only after a while, and not while it is online.
    expect(await wakeSweep()).toEqual([]);
    expect(await wakeSweep(now() + WAKE_RETRY_MS + 1000)).toEqual([id]);
    const state = ((await (await admin.get("/api/admin/worker-profiles")).json()) as any).wake[id];
    expect(state).toMatchObject({ url: WAKE_URL, ok: true, status: 200, error: null });
    expect((await internal(token, "/worker/heartbeat", { workerId: id })).status).toBe(200);
    resetWakeState();
    expect(await wakeSweep()).toEqual([]);
    db.query("UPDATE workers SET last_seen_at = 0 WHERE id = $id").run({ id });
    expect((await admin.req("PUT", `/api/admin/worker-wake/${id}`, { json: { url: null } })).status).toBe(200);
  });

  test("once it has run and stopped, new work wakes it again at once; while it starts, the page says so", async () => {
    clearQueue();
    const admin = await adminClient();
    const { id, token } = await enroll("Modal again");
    await admin.req("PUT", `/api/admin/worker-wake/${id}`, { json: { url: WAKE_URL } });
    const wake = async () => ((await (await admin.get("/api/admin/worker-profiles")).json()) as any).wake[id];
    queued();
    expect(await wakeSweep()).toEqual([id]);
    // Called, not up yet: starting (a cold start), and not called again meanwhile.
    expect((await wake()).starting).toBe(true);
    expect(await wakeSweep()).toEqual([]);
    // It comes up, takes the work, and when idle says it stopped: offline at once, not a minute later.
    await internal(token, "/worker/heartbeat", { workerId: id, info: { state: "idle" } });
    expect((await wake()).starting).toBe(false);
    clearQueue();
    await internal(token, "/worker/heartbeat", { workerId: id, info: { state: "stopped" } });
    // New work a moment later (well within the two minutes between calls): it is called again at once.
    queued();
    expect(await wakeSweep()).toEqual([id]);
    expect(calls).toHaveLength(2);
    clearQueue();
    await admin.req("PUT", `/api/admin/worker-wake/${id}`, { json: { url: null } });
  });

  test("it gives up on a job it was called for several times, and reports failures", async () => {
    clearQueue();
    const admin = await adminClient();
    const { id } = await enroll("Modal broken");
    await admin.req("PUT", `/api/admin/worker-wake/${id}`, { json: { url: WAKE_URL } });
    queued();
    status = 500;
    let t = now();
    for (let i = 0; i < WAKE_TRIES_PER_JOB; i++) {
      expect(await wakeSweep(t)).toEqual([id]);
      t += WAKE_RETRY_MS + 1000;
    }
    expect(await wakeSweep(t)).toEqual([]);
    const state = ((await (await admin.get("/api/admin/worker-profiles")).json()) as any).wake[id];
    expect(state.ok).toBe(false);
    // Only the status: what the other side answered ("nope") is neither kept nor shown.
    expect(state.error).toBe("HTTP 500");
    // A new job is worth trying again.
    queued(5_000);
    clearQueue();
    queued(1_000);
    expect(await wakeSweep(t)).toEqual([id]);
    await admin.req("PUT", `/api/admin/worker-wake/${id}`, { json: { url: null } });
  });

  test("a fallback is called only once the job has waited its turn while another worker is online", async () => {
    clearQueue();
    const admin = await adminClient();
    const { id } = await enroll("Modal fallback");
    await admin.req("PUT", `/api/admin/worker-wake/${id}`, { json: { url: WAKE_URL } });
    await admin.req("PUT", `/api/admin/worker-profiles/${id}`, { json: { engine: null, diarization: null, fallbackSec: 120 } });
    // This server's own worker is online.
    expect((await internal("test-worker-token", "/worker/heartbeat", { workerId: "server-gpu0" })).status).toBe(200);
    queued(30_000);
    expect(await wakeSweep()).toEqual([]);
    clearQueue();
    queued(200_000);
    expect(await wakeSweep()).toEqual([id]);
    db.query("UPDATE workers SET last_seen_at = 0 WHERE id = 'server-gpu0'").run();
    await admin.req("PUT", `/api/admin/worker-wake/${id}`, { json: { url: null } });
    await admin.req("PUT", `/api/admin/worker-profiles/${id}`, { json: { engine: null, diarization: null, fallbackSec: null } });
    clearQueue();
  });

  test("only administrators set it, over https, and can call it to test", async () => {
    const admin = await adminClient();
    const member = await memberClient("wake-member");
    const { id } = await enroll("Modal test");
    expect((await member.req("PUT", `/api/admin/worker-wake/${id}`, { json: { url: WAKE_URL } })).status).toBe(403);
    expect((await admin.req("PUT", `/api/admin/worker-wake/${id}`, { json: { url: "http://example.com/wake" } })).status).toBe(422);
    expect((await admin.req("PUT", `/api/admin/worker-wake/nope`, { json: { url: WAKE_URL } })).status).toBe(404);
    // An address typed but not saved can be tried first; it is neither saved nor remembered as the last call.
    const before = calls.length;
    const tried = (await (await admin.post(`/api/admin/worker-wake/${id}/test`, { url: WAKE_URL })).json()) as any;
    expect(tried).toMatchObject({ ok: true, status: 200 });
    expect(calls.length).toBe(before + 1);
    expect(((await (await admin.get("/api/admin/worker-profiles")).json()) as any).wake[id]).toBeUndefined();
    expect((await admin.post(`/api/admin/worker-wake/${id}/test`, { url: "http://example.com/wake" })).status).toBe(422);
    await admin.req("PUT", `/api/admin/worker-wake/${id}`, { json: { url: WAKE_URL } });
    const res = (await (await admin.post(`/api/admin/worker-wake/${id}/test`)).json()) as any;
    expect(res).toMatchObject({ ok: true, status: 200 });
    expect(res.running).toBeUndefined();
    expect(calls.at(-1)!.body).toMatchObject({ reason: "test" });
    // Modal answers {"running": true} when a run is already starting: the test says so (and nothing else of the answer).
    answer = JSON.stringify({ ok: true, call: "fc-1", running: true, note: "<b>not shown</b>" });
    const again = (await (await admin.post(`/api/admin/worker-wake/${id}/test`)).json()) as any;
    expect(again).toEqual({ ok: true, status: 200, error: null, running: true });
    // Revoking the worker forgets its address.
    await admin.req("DELETE", `/api/admin/worker-keys/${id}`);
    expect(((await (await admin.get("/api/admin/worker-profiles")).json()) as any).wake[id]).toBeUndefined();
  });
});
