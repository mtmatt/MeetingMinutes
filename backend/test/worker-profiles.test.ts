import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { setWakeUrl } from "../src/services/workerWake";
import { Client, adminClient, app, memberClient } from "./helpers";

async function call(token: string, path: string, json: unknown) {
  return app.fetch(
    new Request(`http://mm.test/internal${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(json),
    }),
  );
}

const SHARED = "test-worker-token";
const GPU_CAPS = { asr: ["local", "api"], diarization: ["local", "cpu", "pyannoteai"] };

async function enroll(name: string) {
  const admin = await adminClient();
  const created = (await (await admin.post("/api/admin/worker-keys", { name })).json()) as any;
  const got = (await (await call("", "/enroll", { code: created.code })).json()) as any;
  return { id: got.workerId as string, token: got.token as string };
}

async function upload(c: Client) {
  const bytes = new Uint8Array(512);
  const res = await c.post("/api/meetings", { title: "Profiles", file: { name: "p.wav", size: bytes.length } });
  const { meeting } = (await res.json()) as any;
  await c.req("PUT", `/api/meetings/${meeting.id}/upload?offset=0`, { body: bytes, headers: { "content-type": "application/octet-stream" } });
  expect((await c.post(`/api/meetings/${meeting.id}/upload/complete`)).status).toBe(200);
  return meeting.id as string;
}

/** Claim until this meeting's job comes up (others are failed); null if none is handed out. */
async function claimAs(token: string, workerId: string, meetingId: string, capabilities: unknown) {
  for (let i = 0; i < 40; i++) {
    const res = await call(token, "/jobs/claim", { workerId, kinds: ["transcribe"], capabilities });
    if (res.status === 204) return null;
    const { job } = (await res.json()) as any;
    if (job.meetingId === meetingId) return job;
    await call(token, `/jobs/${job.jobId}/fail`, { workerId, error: "not this test", retryable: false });
  }
  return null;
}

const api = (diarization = "local") => ({ engine: "api", diarization, api: { provider: "openrouter", baseUrl: "", model: "qwen/qwen3-asr-1.7b" } });

describe("settings per worker machine", () => {
  beforeAll(async () => {
    const admin = await adminClient();
    await admin.del("/api/admin/transcriber");
  });
  afterAll(async () => {
    const admin = await adminClient();
    await admin.del("/api/admin/transcriber");
    await admin.req("PUT", "/api/admin/worker-profiles/local", { json: { engine: null, diarization: null, fallbackSec: null } });
  });

  test("a worker without the needed key is not handed the job", async () => {
    const admin = await adminClient();
    await admin.req("PUT", "/api/admin/transcriber", { json: api() });
    const id = await upload(admin);
    expect(await claimAs(SHARED, "keys-0", id, { ...GPU_CAPS, keys: { openrouter: false, openai: false, pyannoteai: false } })).toBeNull();
    const job = await claimAs(SHARED, "keys-0", id, { ...GPU_CAPS, keys: { openrouter: true, openai: false, pyannoteai: false } });
    expect(job.asr.engine).toBe("api");
    // pyannoteAI too.
    await admin.req("PUT", "/api/admin/transcriber", { json: api("pyannoteai") });
    const id2 = await upload(admin);
    expect(await claimAs(SHARED, "keys-0", id2, { ...GPU_CAPS, keys: { openrouter: true, pyannoteai: false } })).toBeNull();
    expect((await claimAs(SHARED, "keys-0", id2, { ...GPU_CAPS, keys: { openrouter: true, pyannoteai: true } }))?.diarization).toEqual({ engine: "pyannoteai" });
  });

  test("a machine can work its own way: the Mac on its GPU while the site uses the API", async () => {
    const admin = await adminClient();
    await admin.req("PUT", "/api/admin/transcriber", { json: api("cpu") });
    const mac = await enroll("Mac");
    const saved = await admin.req("PUT", `/api/admin/worker-profiles/${mac.id}`, { json: { engine: "local", diarization: "local", fallbackSec: null } });
    expect(saved.status).toBe(200);
    const id = await upload(admin);
    // Without keys, the Mac still takes it: it does not need any.
    const job = await claimAs(mac.token, mac.id, id, { ...GPU_CAPS, keys: { openrouter: false, pyannoteai: false } });
    expect(job.asr).toEqual({ engine: "local" });
    expect(job.diarization).toEqual({ engine: "local" });
    const beat = (await (await call(mac.token, "/worker/heartbeat", { workerId: mac.id })).json()) as any;
    expect(beat.transcriber).toEqual({ engine: "local", diarization: "local" });
    // This server's workers keep the site-wide settings.
    const local = (await (await call(SHARED, "/worker/heartbeat", { workerId: "srv-0" })).json()) as any;
    expect(local.transcriber).toEqual({ engine: "api", diarization: "cpu" });
    const listed = (await (await admin.get("/api/admin/worker-profiles")).json()) as any;
    expect(listed.profiles[mac.id]).toEqual({ engine: "local", diarization: "local", fallbackSec: null });
    // Revoking forgets its settings.
    await admin.del(`/api/admin/worker-keys/${mac.id}`);
    expect(((await (await admin.get("/api/admin/worker-profiles")).json()) as any).profiles[mac.id]).toBeUndefined();
  });

  test("a fallback machine waits while another is online, and not when it is alone", async () => {
    const admin = await adminClient();
    await admin.del("/api/admin/transcriber");
    await admin.req("PUT", "/api/admin/worker-profiles/local", { json: { engine: null, diarization: null, fallbackSec: 120 } });
    const gpu = await enroll("GPU box");
    await call(gpu.token, "/worker/heartbeat", { workerId: gpu.id });
    const id = await upload(admin);
    expect(await claimAs(SHARED, "srv-fallback", id, GPU_CAPS)).toBeNull();
    // Waiting longer than two minutes: the fallback takes it.
    db.query("UPDATE jobs SET created_at = created_at - 200000 WHERE meeting_id = $m AND status = 'queued'").run({ m: id });
    expect((await claimAs(SHARED, "srv-fallback", id, GPU_CAPS))?.meetingId).toBe(id);
    // Alone (no other machine seen in the last minute): no waiting.
    db.query("UPDATE workers SET last_seen_at = 0").run();
    const id2 = await upload(admin);
    expect((await claimAs(SHARED, "srv-fallback", id2, GPU_CAPS))?.meetingId).toBe(id2);
    await admin.del(`/api/admin/worker-keys/${gpu.id}`);
  });

  test("fallbacks wait for a worker started on demand, and take turns by their wait", async () => {
    // As set up in practice: Modal first (started on demand), a Mac after 1 minute, the server after 10.
    const admin = await adminClient();
    await admin.del("/api/admin/transcriber");
    db.query("UPDATE workers SET last_seen_at = 0").run();
    const modal = await enroll("Modal");
    setWakeUrl(modal.id, "https://me--meetingminutes-worker-wake.modal.run", null);
    const mac = await enroll("Mac");
    await admin.req("PUT", `/api/admin/worker-profiles/${mac.id}`, { json: { engine: null, diarization: null, fallbackSec: 60 } });
    await admin.req("PUT", "/api/admin/worker-profiles/local", { json: { engine: null, diarization: null, fallbackSec: 600 } });
    await call(mac.token, "/worker/heartbeat", { workerId: mac.id });
    await call(SHARED, "/worker/heartbeat", { workerId: "srv-tiers" });
    const id = await upload(admin);
    // Modal is offline but can be woken: neither fallback takes the new recording.
    expect(await claimAs(SHARED, "srv-tiers", id, GPU_CAPS)).toBeNull();
    expect(await claimAs(mac.token, mac.id, id, GPU_CAPS)).toBeNull();
    // After a minute and a half the Mac's turn has come, not yet the server's (the Mac is ahead of it).
    db.query("UPDATE jobs SET created_at = created_at - 90000 WHERE meeting_id = $m AND status = 'queued'").run({ m: id });
    expect(await claimAs(SHARED, "srv-tiers", id, GPU_CAPS)).toBeNull();
    expect((await claimAs(mac.token, mac.id, id, GPU_CAPS))?.meetingId).toBe(id);
    // Without the wake-up address, the Mac is first again.
    setWakeUrl(modal.id, null, null);
    const id2 = await upload(admin);
    expect((await claimAs(mac.token, mac.id, id2, GPU_CAPS))?.meetingId).toBe(id2);
    await admin.req("PUT", "/api/admin/worker-profiles/local", { json: { engine: null, diarization: null, fallbackSec: null } });
    await admin.del(`/api/admin/worker-keys/${modal.id}`);
    await admin.del(`/api/admin/worker-keys/${mac.id}`);
  });

  test("people are told what any machine may do", async () => {
    const admin = await adminClient();
    await admin.del("/api/admin/transcriber");
    const member = await memberClient("profiles-reader");
    const state = async () => ((await (await member.get("/api/auth/state")).json()) as any).transcriber;
    const other = await enroll("API box");
    await admin.req("PUT", `/api/admin/worker-profiles/${other.id}`, { json: { engine: "api", diarization: "pyannoteai", fallbackSec: null } });
    const s = await state();
    // The server transcribes locally, that machine through the API: speech may go to OpenRouter, and the recording to pyannoteAI.
    expect(s).toMatchObject({ engine: "api", provider: "openrouter", host: "openrouter.ai", mixed: true, diarization: "pyannoteai", diarizationMixed: true });
    await admin.del(`/api/admin/worker-keys/${other.id}`);
    expect(await state()).toMatchObject({ engine: "local", mixed: false, diarization: "local", diarizationMixed: false });
  });

  test("only administrators change them, and only for known machines", async () => {
    const member = await memberClient("profiles-member");
    expect((await member.req("PUT", "/api/admin/worker-profiles/local", { json: { engine: "local", diarization: null, fallbackSec: null } })).status).toBe(403);
    const admin = await adminClient();
    expect((await admin.req("PUT", "/api/admin/worker-profiles/wknope", { json: { engine: "local", diarization: null, fallbackSec: null } })).status).toBe(404);
    expect((await admin.req("PUT", "/api/admin/worker-profiles/local", { json: { engine: "gpu", diarization: null, fallbackSec: null } })).status).toBe(422);
    expect((await admin.req("PUT", "/api/admin/worker-profiles/local", { json: { engine: null, diarization: null, fallbackSec: 1 } })).status).toBe(422);
  });
});
