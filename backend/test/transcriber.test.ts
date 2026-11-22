import { afterAll, describe, expect, test } from "bun:test";
import { Client, adminClient, memberClient, worker } from "./helpers";

/** An uploaded meeting waiting for transcription. */
async function upload(c: Client) {
  const bytes = new Uint8Array(512);
  const res = await c.post("/api/meetings", { title: "API sync", file: { name: "sync.wav", size: bytes.length } });
  const { meeting } = (await res.json()) as any;
  await c.req("PUT", `/api/meetings/${meeting.id}/upload?offset=0`, { body: bytes, headers: { "content-type": "application/octet-stream" } });
  expect((await c.post(`/api/meetings/${meeting.id}/upload/complete`)).status).toBe(200);
  return meeting.id as string;
}

/** Claim jobs until this meeting's comes up; others are failed (tests share one queue). */
async function claim(meetingId: string) {
  for (let i = 0; i < 30; i++) {
    const res = await worker.call("/jobs/claim", { workerId: "gpu-asr" });
    if (res.status === 204) return null;
    const { job } = (await res.json()) as any;
    if (job.meetingId === meetingId) return job;
    await worker.call(`/jobs/${job.jobId}/fail`, { workerId: "gpu-asr", error: "not this test", retryable: false });
  }
  return null;
}

const openrouter = (model = "qwen/qwen3-asr-1.7b") => ({ engine: "api", api: { provider: "openrouter", baseUrl: "", model } });

describe("where transcription runs", () => {
  afterAll(async () => {
    await (await adminClient()).del("/api/admin/transcriber");
  });

  test("only administrators can change it, and input is checked", async () => {
    const member = await memberClient("asr-member");
    expect((await member.get("/api/admin/transcriber")).status).toBe(403);
    expect((await member.req("PUT", "/api/admin/transcriber", { json: openrouter() })).status).toBe(403);
    const admin = await adminClient();
    const badModel = await admin.req("PUT", "/api/admin/transcriber", { json: openrouter("whisper; rm -rf /") });
    expect(badModel.status).toBe(422);
    const badUrl = await admin.req("PUT", "/api/admin/transcriber", {
      json: { engine: "api", api: { provider: "openai", baseUrl: "file:///etc/passwd", model: "whisper-1" } },
    });
    expect(badUrl.status).toBe(422);
    const badProvider = await admin.req("PUT", "/api/admin/transcriber", { json: { engine: "api", api: { provider: "elsewhere", baseUrl: "", model: "x" } } });
    expect(badProvider.status).toBe(422);
  });

  test("defaults to the local GPU; the admin's choice goes with each job and resets", async () => {
    const admin = await adminClient();
    const initial = (await (await admin.get("/api/admin/transcriber")).json()) as any;
    expect(initial.saved).toBe(false);
    expect(initial.settings.engine).toBe("local");
    // OpenRouter, with the same Qwen3-ASR model as the local one, is what an admin is offered first.
    expect(initial.defaults.api).toEqual({ provider: "openrouter", baseUrl: "", model: "qwen/qwen3-asr-1.7b" });
    expect(initial.addresses.openrouter).toBe("https://openrouter.ai/api/v1");

    let job = await claim(await upload(admin));
    expect(job.asr).toEqual({ engine: "local" });

    const saved = (await (await admin.req("PUT", "/api/admin/transcriber", { json: openrouter("openai/whisper-large-v3") })).json()) as any;
    expect(saved.saved).toBe(true);
    expect(saved.updatedBy).toBe("Admin");
    job = await claim(await upload(admin));
    expect(job.asr).toEqual({ engine: "api", provider: "openrouter", model: "openai/whisper-large-v3", baseUrl: "https://openrouter.ai/api/v1" });
    // The worker is told where transcription runs, to know how much GPU memory a session needs.
    const beat = (await (await worker.call("/worker/heartbeat", { workerId: "gpu-asr" })).json()) as any;
    expect(beat.transcriber).toEqual({ engine: "api" });

    const reset = (await (await admin.del("/api/admin/transcriber")).json()) as any;
    expect(reset.saved).toBe(false);
    expect(reset.settings.engine).toBe("local");
  });

  test("an OpenAI-compatible server: the pasted endpoint is trimmed to the server's address", async () => {
    const admin = await adminClient();
    const res = await admin.req("PUT", "/api/admin/transcriber", {
      json: { engine: "api", api: { provider: "openai", baseUrl: "https://api.groq.com/openai/v1/audio/transcriptions", model: "whisper-large-v3" } },
    });
    expect(res.status).toBe(200);
    const state = (await res.json()) as any;
    expect(state.settings.api.baseUrl).toBe("https://api.groq.com/openai/v1");
    const job = await claim(await upload(admin));
    expect(job.asr).toEqual({ engine: "api", provider: "openai", model: "whisper-large-v3", baseUrl: "https://api.groq.com/openai/v1" });
    // Empty means OpenAI itself.
    await admin.req("PUT", "/api/admin/transcriber", { json: { engine: "api", api: { provider: "openai", baseUrl: "", model: "whisper-1" } } });
    expect((await claim(await upload(admin))).asr.baseUrl).toBe("https://api.openai.com/v1");
  });

  test("people are told where their recording is transcribed", async () => {
    const admin = await adminClient();
    const member = await memberClient("asr-reader");
    await admin.del("/api/admin/transcriber");
    let state = (await (await member.get("/api/auth/state")).json()) as any;
    expect(state.transcriber).toEqual({ engine: "local", provider: null, model: null, onServer: true, host: null });
    await admin.req("PUT", "/api/admin/transcriber", { json: openrouter() });
    state = (await (await member.get("/api/auth/state")).json()) as any;
    expect(state.transcriber).toEqual({ engine: "api", provider: "openrouter", model: "qwen/qwen3-asr-1.7b", onServer: false, host: "openrouter.ai" });
    // A transcription server on this machine (a vLLM serving Qwen3-ASR) keeps the recording here.
    await admin.req("PUT", "/api/admin/transcriber", { json: { engine: "api", api: { provider: "openai", baseUrl: "http://127.0.0.1:8000/v1", model: "Qwen/Qwen3-ASR-1.7B" } } });
    state = (await (await member.get("/api/auth/state")).json()) as any;
    expect(state.transcriber.onServer).toBe(true);
    expect(state.transcriber.host).toBeNull();
    // Signed out: nothing.
    expect(((await (await new Client().get("/api/auth/state")).json()) as any).transcriber).toBeNull();
  });

  test("the admin page shows which workers have a key, never the key", async () => {
    const admin = await adminClient();
    await worker.call("/worker/heartbeat", { workerId: "gpu-keyed", name: "keyed", info: { asrApiKeys: { openrouter: true, openai: false } } });
    await worker.call("/worker/heartbeat", { workerId: "gpu-old", name: "old", info: { asrModel: "Qwen/Qwen3-ASR-1.7B" } });
    const state = (await (await admin.get("/api/admin/transcriber")).json()) as any;
    const byName = Object.fromEntries(state.workers.map((w: any) => [w.name, w.keys]));
    expect(byName.keyed).toEqual({ openrouter: true, openai: false });
    // A worker from before API transcription reports nothing: it cannot use an API.
    expect(byName.old).toBeNull();
    expect(state.keyVariables.openrouter).toEqual(["OPENROUTER_API_KEY", "ASR_API_KEY"]);
  });
});
