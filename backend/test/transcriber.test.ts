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
    expect(beat.transcriber).toEqual({ engine: "api", diarization: "local" });

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
    expect(state.transcriber).toMatchObject({ engine: "local", diarization: "local", provider: null, model: null, onServer: true, host: null, mixed: false });
    await admin.req("PUT", "/api/admin/transcriber", { json: openrouter() });
    state = (await (await member.get("/api/auth/state")).json()) as any;
    expect(state.transcriber).toMatchObject({
      engine: "api",
      diarization: "local",
      provider: "openrouter",
      // People are told where their recording goes, not which model: that is for administrators.
      model: null,
      onServer: false,
      host: "openrouter.ai",
      mixed: false,
    });
    const adminState = (await (await admin.get("/api/auth/state")).json()) as any;
    expect(adminState.transcriber.model).toBe("qwen/qwen3-asr-1.7b");
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
    expect(byName.keyed).toEqual({ openrouter: true, openai: false, pyannoteai: false });
    // A worker from before API transcription reports nothing: it cannot use an API.
    expect(byName.old).toBeNull();
    expect(state.keyVariables.openrouter).toEqual(["OPENROUTER_API_KEY", "ASR_API_KEY"]);
  });
});

describe("speaker separation by pyannoteAI", () => {
  afterAll(async () => {
    await (await adminClient()).del("/api/admin/transcriber");
  });

  const cloud = { asr: ["api"], diarization: ["pyannoteai"] };

  async function claimAs(meetingId: string, capabilities?: unknown, kinds?: string[]) {
    for (let i = 0; i < 30; i++) {
      const res = await worker.call("/jobs/claim", { workerId: "cloud-1", ...(kinds ? { kinds } : {}), ...(capabilities ? { capabilities } : {}) });
      if (res.status === 204) return null;
      const { job } = (await res.json()) as any;
      if (job.meetingId === meetingId) return job;
      await worker.call(`/jobs/${job.jobId}/fail`, { workerId: "cloud-1", error: "not this test", retryable: false });
    }
    return null;
  }

  test("a worker without local models gets transcriptions only when both steps run through APIs", async () => {
    const admin = await adminClient();
    await admin.del("/api/admin/transcriber");
    const id = await upload(admin);
    // Local recognition and separation: the cloud-only worker is not handed the job.
    expect(await claimAs(id, cloud)).toBeNull();
    // Transcription API, local separation: still not.
    await admin.req("PUT", "/api/admin/transcriber", { json: { engine: "api", diarization: "local", api: { provider: "openrouter", baseUrl: "", model: "qwen/qwen3-asr-1.7b" } } });
    expect(await claimAs(id, cloud)).toBeNull();
    // Both through APIs: now it is, and the job says so.
    const saved = await admin.req("PUT", "/api/admin/transcriber", {
      json: { engine: "api", diarization: "pyannoteai", api: { provider: "openrouter", baseUrl: "", model: "qwen/qwen3-asr-1.7b" } },
    });
    expect(((await saved.json()) as any).settings.diarization).toBe("pyannoteai");
    const job = await claimAs(id, cloud);
    expect(job.diarization).toEqual({ engine: "pyannoteai" });
    expect(job.asr.engine).toBe("api");
    const beat = (await (await worker.call("/worker/heartbeat", { workerId: "cloud-1" })).json()) as any;
    expect(beat.transcriber).toEqual({ engine: "api", diarization: "pyannoteai" });
  });

  test("workers from before pyannoteAI are not handed jobs that need it", async () => {
    const admin = await adminClient();
    await admin.req("PUT", "/api/admin/transcriber", {
      json: { engine: "local", diarization: "pyannoteai", api: { provider: "openrouter", baseUrl: "", model: "qwen/qwen3-asr-1.7b" } },
    });
    const id = await upload(admin);
    expect(await claimAs(id)).toBeNull();
    // A GPU worker that knows pyannoteAI takes it.
    expect((await claimAs(id, { asr: ["local", "api"], diarization: ["local", "pyannoteai"] }))?.diarization).toEqual({ engine: "pyannoteai" });
  });

  test("people are told the whole recording goes to pyannoteAI", async () => {
    const admin = await adminClient();
    await admin.req("PUT", "/api/admin/transcriber", {
      json: { engine: "api", diarization: "pyannoteai", api: { provider: "openrouter", baseUrl: "", model: "qwen/qwen3-asr-1.7b" } },
    });
    const state = (await (await (await memberClient("diar-reader")).get("/api/auth/state")).json()) as any;
    expect(state.transcriber.diarization).toBe("pyannoteai");
    // Saving from a page that predates the setting keeps it.
    await admin.req("PUT", "/api/admin/transcriber", { json: { engine: "api", api: { provider: "openrouter", baseUrl: "", model: "qwen/qwen3-asr-0.6b" } } });
    expect(((await (await admin.get("/api/admin/transcriber")).json()) as any).settings.diarization).toBe("pyannoteai");
  });

  test("finding voices redoes fingerprints made by another model", async () => {
    const admin = await adminClient();
    const owner = await memberClient("diar-voices");
    await admin.del("/api/admin/transcriber");
    const id = await upload(owner);
    const job = await claimAs(id, undefined, ["transcribe", "voiceprint"]);
    const embedding = new Array(16).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    await worker.call(`/jobs/${job.jobId}/complete`, {
      workerId: "cloud-1",
      result: {
        durationSec: 60, language: "Chinese", hasVideo: false, hasPlayback: false, hasPeaks: false,
        speakers: ["SPEAKER_00"], segments: [{ start: 0, end: 60, speaker: "SPEAKER_00", text: "說話。" }],
        voiceModel: "pyannote/speaker-diarization-community-1", voices: { SPEAKER_00: { embedding, speechSec: 60 } },
      },
    });
    // Same model: nothing to redo.
    let scan = (await (await owner.post("/api/voices/scan")).json()) as any;
    expect(scan.outcome.queued).toBe(0);
    // After switching to pyannoteAI, workers fingerprint with the CPU model: the old fingerprint is redone.
    await admin.req("PUT", "/api/admin/transcriber", {
      json: { engine: "api", diarization: "pyannoteai", api: { provider: "openrouter", baseUrl: "", model: "qwen/qwen3-asr-1.7b" } },
    });
    scan = (await (await owner.post("/api/voices/scan")).json()) as any;
    expect(scan.outcome.queued).toBe(1);
    const vp = await claimAs(id, cloud, ["voiceprint"]);
    expect(vp.kind).toBe("voiceprint");
    expect(vp.diarization).toEqual({ engine: "pyannoteai" });
  });
});

describe("speaker separation on the CPU", () => {
  afterAll(async () => {
    await (await adminClient()).del("/api/admin/transcriber");
  });

  test("a GPU-free worker takes jobs with CPU separation and the transcription API; nothing is uploaded", async () => {
    const admin = await adminClient();
    const cpuWorker = { asr: ["api"], diarization: ["cpu", "pyannoteai"] };
    const settings = { engine: "api", diarization: "cpu", api: { provider: "openrouter", baseUrl: "", model: "qwen/qwen3-asr-1.7b" } };
    expect((await admin.req("PUT", "/api/admin/transcriber", { json: settings })).status).toBe(200);
    const id = await upload(admin);
    let job = null;
    for (let i = 0; i < 30 && !job; i++) {
      const res = await worker.call("/jobs/claim", { workerId: "cpu-1", capabilities: cpuWorker });
      if (res.status === 204) break;
      const got = ((await res.json()) as any).job;
      if (got.meetingId === id) job = got;
      else await worker.call(`/jobs/${got.jobId}/fail`, { workerId: "cpu-1", error: "not this test", retryable: false });
    }
    expect(job.diarization).toEqual({ engine: "cpu" });
    // A worker from before CPU separation is not handed it.
    const id2 = await upload(admin);
    const legacy = await worker.call("/jobs/claim", { workerId: "old-1", capabilities: { asr: ["local", "api"], diarization: ["local", "pyannoteai"] } });
    if (legacy.status === 200) expect(((await legacy.json()) as any).job.meetingId).not.toBe(id2);
    const state = (await (await (await memberClient("cpu-reader")).get("/api/auth/state")).json()) as any;
    expect(state.transcriber.diarization).toBe("cpu");
  });
});
