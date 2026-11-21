import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { chunkTranscript, cleanModelOutput, contextBudget, estimateTokens } from "../src/services/localSummary";
import { openaiUrl } from "../src/services/llm";
import { hasSimplified, toTaiwanTraditional } from "../src/services/zhTW";
import { Client, adminClient, memberClient, waitFor, worker } from "./helpers";

// ---------------------------------------------------------------- fakes

interface Recorded {
  path: string;
  body: any;
  headers: Headers;
}

/** A stand-in Ollama server: records requests, answers according to the prompt. */
function fakeOllama(opts: { installed?: string[]; thinking?: boolean; contextLength?: number } = {}) {
  const requests: Recorded[] = [];
  const installed = opts.installed ?? ["qwen3:14b"];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body: any = req.method === "POST" ? await req.json().catch(() => null) : null;
      requests.push({ path: url.pathname, body, headers: req.headers });
      const ndjson = (events: unknown[], delayMs = 0) =>
        new Response(
          new ReadableStream({
            async start(ctrl) {
              for (const e of events) {
                if (delayMs) await Bun.sleep(delayMs);
                ctrl.enqueue(new TextEncoder().encode(JSON.stringify(e) + "\n"));
              }
              ctrl.close();
            },
          }),
          { headers: { "content-type": "application/x-ndjson" } },
        );
      switch (url.pathname) {
        case "/api/version":
          return Response.json({ version: "0.13.0" });
        case "/api/tags":
          return Response.json({ models: installed.map((name) => ({ name, size: 9_300_000_000, details: { parameter_size: "14.8B", quantization_level: "Q4_K_M" } })) });
        case "/api/ps":
          return Response.json({ models: [] });
        case "/api/show":
          if (!installed.includes(body.model)) return Response.json({ error: `model '${body.model}' not found` }, { status: 404 });
          return Response.json({
            capabilities: opts.thinking === false ? ["completion"] : ["completion", "tools", "thinking"],
            model_info: { "general.architecture": "qwen3", "qwen3.context_length": opts.contextLength ?? 40960 },
          });
        case "/api/pull":
          return ndjson([{ status: "pulling manifest" }, { status: "pulling abc", total: 100, completed: 40 }, { status: "pulling abc", total: 100, completed: 100 }, { status: "success" }]);
        case "/api/chat": {
          if (!installed.includes(body.model)) return Response.json({ error: `model "${body.model}" not found, try pulling it first` }, { status: 404 });
          const user: string = body.messages.at(-1).content;
          const done = { done: true, done_reason: "stop", prompt_eval_count: 1200, eval_count: 80, model: body.model };
          if (user.includes("<transcript_part>")) {
            const part = user.match(/This is part (\d+) of (\d+)/)!;
            return ndjson([{ message: { role: "assistant", content: `- notes on part ${part[1]} [00:00:01]` } }, done]);
          }
          if (user.includes("SLOW_PLEASE")) {
            return ndjson(Array.from({ length: 200 }, () => ({ message: { role: "assistant", content: "." } })), 50);
          }
          if (user.includes("CUTOFF_PLEASE")) return ndjson([{ message: { content: "# Partial" } }, { ...done, done_reason: "length" }]);
          const text = user.includes("<notes>")
            ? `# 會議紀錄\n\n${(user.match(/notes on part \d+/g) ?? []).join("\n")}`
            : // Qwen3 lapsing into Simplified Chinese, with a reasoning block and a code fence.
              "<think>\nThe user wants minutes.\n</think>\n```markdown\n# 会议纪要\n\n- 王小明说我们下周三前要补齐软件测试 [00:00:09]\n- 會議決定下週發佈新版本，避免干擾使用者 [00:00:04]\n```";
          return ndjson([{ message: { role: "assistant", content: text.slice(0, 20) } }, { message: { role: "assistant", content: text.slice(20) } }, done]);
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, requests, url: `http://127.0.0.1:${server.port}` };
}

/** A stand-in OpenAI-compatible server (vLLM): server-sent events. */
function fakeOpenAI() {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body: any = req.method === "POST" ? await req.json().catch(() => null) : null;
      requests.push({ path: url.pathname, body, headers: req.headers });
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "Qwen/Qwen3-14B-AWQ", max_model_len: 32768 }] });
      if (url.pathname === "/v1/chat/completions") {
        // A model that thinks although asked not to, and needs more than 10,000 tokens for it.
        if (body.messages.at(-1).content.includes("THINK_LONG") && body.max_tokens >= 10_000) {
          const events = [
            { model: body.model, choices: [{ delta: { reasoning_content: "Thinking. ".repeat(50) } }] },
            { model: body.model, choices: [{ delta: { content: "# Minutes after thinking" }, finish_reason: "stop" }] },
          ];
          return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
        }
        if (/THINK_FOREVER|THINK_LONG/.test(body.messages.at(-1).content)) {
          // A reasoning model that thinks until the answer budget runs out.
          const events = [
            { model: body.model, choices: [{ delta: { reasoning_content: "Let me think about this meeting. ".repeat(50) } }] },
            { model: body.model, choices: [{ delta: {}, finish_reason: "length" }] },
          ];
          return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
        }
        const sse = [
          { model: body.model, choices: [{ delta: { reasoning_content: "thinking..." } }] },
          { model: body.model, choices: [{ delta: { content: "# Minutes\n\n" } }] },
          { model: body.model, choices: [{ delta: { content: "- Release shipped [00:00:04]" }, finish_reason: "stop" }] },
          { model: body.model, choices: [], usage: { prompt_tokens: 900, completion_tokens: 30 } },
        ]
          .map((e) => `data: ${JSON.stringify(e)}\n\n`)
          .join("");
        return new Response(sse + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, requests, url: `http://127.0.0.1:${server.port}` };
}

// ------------------------------------------------------------- helpers

async function readyMeeting(c: Client, segments: { start: number; end: number; speaker: string; text: string }[], title = "Weekly sync") {
  const res = await c.post("/api/meetings", { title, file: { name: "sync.wav", size: 64, type: "audio/wav" } });
  const { meeting } = (await res.json()) as any;
  await c.req("PUT", `/api/meetings/${meeting.id}/upload?offset=0`, { body: new Uint8Array(64), headers: { "content-type": "application/octet-stream" } });
  await c.post(`/api/meetings/${meeting.id}/upload/complete`);
  for (let i = 0; i < 20; i++) {
    const claim = await worker.call("/jobs/claim", { workerId: "gpu0", info: {} });
    if (claim.status === 204) break;
    const { job } = (await claim.json()) as any;
    if (job.meetingId !== meeting.id) {
      await worker.call(`/jobs/${job.jobId}/fail`, { workerId: "gpu0", error: "not this test", retryable: false });
      continue;
    }
    const result = {
      durationSec: segments.at(-1)!.end,
      language: "Chinese",
      hasVideo: false,
      hasPlayback: true,
      hasPeaks: false,
      speakers: [...new Set(segments.map((s) => s.speaker))],
      segments,
    };
    expect((await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu0", result })).status).toBe(200);
    return meeting.id as string;
  }
  throw new Error("could not complete the transcription job");
}

const SHORT = [
  { start: 0.5, end: 4.2, speaker: "SPEAKER_00", text: "大家好，我們開始今天的 weekly sync。" },
  { start: 4.4, end: 9.0, speaker: "SPEAKER_01", text: "上週的 release 已經部署完成。" },
  { start: 9.1, end: 12.0, speaker: "SPEAKER_00", text: "下週三前要補齊測試。" },
];

async function summarize(c: Client, id: string, prompt = "Write minutes.", outputLanguage = "zh-TW") {
  const res = await c.post(`/api/meetings/${id}/summaries`, { templateId: null, prompt, outputLanguage });
  expect(res.status).toBe(201);
  const { summary } = (await res.json()) as any;
  return waitFor(async () => {
    const d = (await (await c.get(`/api/meetings/${id}`)).json()) as any;
    const s = d.meeting.summaries.find((x: any) => x.id === summary.id);
    return s && ["done", "failed", "canceled"].includes(s.status) ? s : null;
  }, 15_000);
}

const local = (url: string, extra: Record<string, unknown> = {}) => ({
  provider: "local",
  local: { api: "ollama", baseUrl: url, model: "qwen3:14b", contextTokens: 32768, think: false, keepAliveSec: 0, ...extra },
  codex: { model: null, reasoningEffort: null },
});

// --------------------------------------------------------------- tests

describe("Taiwan Traditional Chinese", () => {
  test("converts only the clauses written in Simplified", () => {
    // Already Traditional: OpenCC would turn 干擾 into 幹擾 and 發佈 into 釋出.
    const trad = "會議決定下週發佈新版本，避免干擾使用者；後台很穩定。";
    expect(hasSimplified(trad)).toBe(false);
    expect(toTaiwanTraditional(trad)).toBe(trad);
    // Simplified, with Taiwan phrasing (软件 → 軟體), next to an untouched Traditional clause.
    expect(toTaiwanTraditional("我们讨论了软件质量，會議決定下週發佈新版本")).toBe("我們討論了軟體質量，會議決定下週發佈新版本");
    expect(toTaiwanTraditional("Plain English, unchanged.")).toBe("Plain English, unchanged.");
  });

  test("keeps speaker names, code and links exactly as written", () => {
    const out = toTaiwanTraditional("张伟说后台要改，见 https://example.com/后台 与 `backend_svc`。\n```\n后台\n```", ["张伟"]);
    expect(out).toBe("张伟說後臺要改，見 https://example.com/后台 與 `backend_svc`。\n```\n后台\n```");
    // Chinese in inline code is a term the model highlighted, not code.
    expect(toTaiwanTraditional("改用 `软件` 一词")).toBe("改用 `軟體` 一詞");
  });
});

describe("local model prompts", () => {
  test("token estimates err on the high side for Chinese, digits and timestamps", () => {
    expect(estimateTokens("大家好")).toBeGreaterThanOrEqual(3);
    expect(estimateTokens("[01:23:45] Speaker 1: hello")).toBeGreaterThanOrEqual(12);
    const { answer, input } = contextBudget(32768, false);
    expect(answer + input).toBe(32768);
    expect(answer).toBe(8192);
    // A larger window gives the answer more room too.
    expect(contextBudget(65536, false).answer).toBe(16384);
    expect(contextBudget(65536, true).answer).toBe(32768);
    expect(contextBudget(32768, true).answer).toBeGreaterThan(answer);
  });

  test("long transcripts are split into parts that fit, without losing a line", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `[00:${String(i % 60).padStart(2, "0")}:00] 王小明: ${"這是一段很長的發言內容。".repeat(5)}`);
    const chunks = chunkTranscript(lines, 2000);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.flat()).toEqual(lines);
    for (const c of chunks) expect(estimateTokens(c.join("\n"))).toBeLessThanOrEqual(2000 + c.length * 2);
    // One turn longer than a part is split, keeping its time and speaker.
    const huge = chunkTranscript([`[00:00:01] 王小明: ${"很長".repeat(3000)}`], 1000);
    expect(huge.length).toBeGreaterThan(3);
    for (const c of huge) expect(c[0]!.startsWith("[00:00:01] 王小明: ")).toBe(true);
  });

  test("reasoning and a wrapping code fence are removed from answers", () => {
    expect(cleanModelOutput("<think>hmm</think>\n\n# Title")).toBe("# Title");
    expect(cleanModelOutput("still thinking</think># Title")).toBe("# Title");
    expect(cleanModelOutput("```markdown\n# Title\n\nBody\n```")).toBe("# Title\n\nBody");
    expect(cleanModelOutput("# Title\n\n```js\ncode\n```")).toBe("# Title\n\n```js\ncode\n```");
    expect(openaiUrl("http://h:8000/v1", "/models")).toBe("http://h:8000/v1/models");
    expect(openaiUrl("http://h:8000", "/models")).toBe("http://h:8000/v1/models");
  });
});

describe("summaries with a local model", () => {
  let ollama: ReturnType<typeof fakeOllama>;
  beforeAll(() => {
    ollama = fakeOllama();
  });
  afterAll(() => ollama.server.stop(true));
  afterEach(async () => {
    // Settings are server-wide: put the defaults back for the other test files.
    await (await adminClient()).del("/api/admin/summarizer");
  });

  test("only administrators can change the summary model, and input is checked", async () => {
    const member = await memberClient("llm-member");
    expect((await member.get("/api/admin/summarizer")).status).toBe(403);
    expect((await member.req("PUT", "/api/admin/summarizer", { json: local(ollama.url) })).status).toBe(403);

    const admin = await adminClient();
    const bad = await admin.req("PUT", "/api/admin/summarizer", { json: local("file:///etc/passwd") });
    expect(bad.status).toBe(422);
    const badModel = await admin.req("PUT", "/api/admin/summarizer", { json: local(ollama.url, { model: "qwen3; rm -rf /" }) });
    expect(badModel.status).toBe(422);
    const badEffort = await admin.req("PUT", "/api/admin/summarizer", { json: { ...local(ollama.url), codex: { model: null, reasoningEffort: 'high" -c x="y' } } });
    expect(badEffort.status).toBe(422);
  });

  test("defaults come from .env until saved; reset brings them back; secrets never leave", async () => {
    const admin = await adminClient();
    const before = (await (await admin.get("/api/admin/summarizer")).json()) as any;
    expect(before.saved).toBe(false);
    expect(before.defaults.local).toMatchObject({ api: "ollama", baseUrl: "http://127.0.0.1:11434", model: "batiai/qwen3.8-27b:q3", contextTokens: 65536 });
    expect(JSON.stringify(before)).not.toContain(process.env.LLM_API_KEY!);

    const saved = (await (await admin.req("PUT", "/api/admin/summarizer", { json: local(ollama.url + "/") })).json()) as any;
    expect(saved.saved).toBe(true);
    expect(saved.updatedBy).toBe("Admin");
    expect(saved.settings.provider).toBe("local");
    expect(saved.settings.local.baseUrl).toBe(ollama.url);

    const state = (await (await admin.get("/api/auth/state")).json()) as any;
    expect(state.summarizer).toEqual({ provider: "local", model: "qwen3:14b", onServer: true, host: null });
    // Not before signing in.
    expect(((await (await new Client().get("/api/auth/state")).json()) as any).summarizer).toBeNull();

    const reset = (await (await admin.del("/api/admin/summarizer")).json()) as any;
    expect(reset.saved).toBe(false);
    expect(reset.settings.provider).toBe("codex");
  });

  test("a summary is written by the local model, in Taiwan Traditional Chinese", async () => {
    const admin = await adminClient();
    await admin.req("PUT", "/api/admin/summarizer", { json: local(ollama.url) });
    const id = await readyMeeting(admin, SHORT);
    // A speaker name in Simplified stays as the user wrote it.
    await admin.patch(`/api/meetings/${id}/speakers/SPEAKER_00`, { name: "王小明" });
    ollama.requests.length = 0;
    const s = await summarize(admin, id);
    expect(s.status).toBe("done");
    expect(s.provider).toBe("local");
    expect(s.model).toBe("qwen3:14b");
    expect(s.usage).toMatchObject({ input_tokens: 1200, output_tokens: 80 });
    // Reasoning and the code fence are gone; Simplified became Taiwan Traditional;
    // the Traditional line kept 發佈 and 干擾 as written.
    expect(s.content).toBe("# 會議紀要\n\n- 王小明說我們下週三前要補齊軟體測試 [00:00:09]\n- 會議決定下週發佈新版本，避免干擾使用者 [00:00:04]");

    const call = ollama.requests.find((r) => r.path === "/api/chat")!;
    expect(call.body.stream).toBe(true);
    expect(call.body.think).toBe(false);
    expect(call.body.keep_alive).toBe(0);
    expect(call.body.options.num_ctx).toBe(16384);
    expect(call.body.options.num_predict).toBe(8192);
    expect(call.body.tools).toBeUndefined();
    const [system, user] = call.body.messages;
    expect(system.role).toBe("system");
    expect(system.content).toContain("請全程使用臺灣繁體中文");
    expect(user.content).toContain("<transcript>\n[00:00:00] 王小明: 大家好");
    expect(user.content).toContain("<instructions>\nWrite minutes.\n</instructions>");
  });

  test("a transcript longer than the context window is summarised in parts", async () => {
    const admin = await adminClient();
    await admin.req("PUT", "/api/admin/summarizer", { json: local(ollama.url, { contextTokens: 8192 }) });
    const long = Array.from({ length: 120 }, (_, i) => ({
      start: i * 30,
      end: i * 30 + 29,
      speaker: i % 2 ? "SPEAKER_01" : "SPEAKER_00",
      text: "我們討論這一季的產品路線圖，以及每個團隊要負責的工作項目與時程。".repeat(3),
    }));
    const id = await readyMeeting(admin, long, "Quarterly planning");
    ollama.requests.length = 0;
    const s = await summarize(admin, id);
    expect(s.status).toBe("done");
    const chats = ollama.requests.filter((r) => r.path === "/api/chat");
    const parts = chats.filter((r) => r.body.messages[1].content.includes("<transcript_part>"));
    expect(parts.length).toBeGreaterThan(1);
    expect(chats.length).toBe(parts.length + 1);
    // Every line of the transcript was read in exactly one part.
    const seen = parts.flatMap((r) => r.body.messages[1].content.split("<transcript_part>\n")[1].split("\n</transcript_part>")[0].split("\n"));
    expect(seen.length).toBe(120);
    for (const r of chats) expect(r.body.options.num_ctx).toBeLessThanOrEqual(8192);
    // The model stays loaded between the parts, and is released after the last call.
    expect(parts.every((r) => r.body.keep_alive >= 120)).toBe(true);
    expect(chats.at(-1)!.body.keep_alive).toBe(0);
    expect(chats.at(-1)!.body.messages[1].content).toContain("<notes>");
    expect(s.content).toContain(`notes on part ${parts.length}`);
    expect(s.usage.calls).toBe(chats.length);
  });

  test("a model that is not downloaded fails with how to get it; the admin page can download it", async () => {
    const admin = await adminClient();
    await admin.req("PUT", "/api/admin/summarizer", { json: local(ollama.url, { model: "qwen3:32b" }) });
    const id = await readyMeeting(admin, SHORT);
    const s = await summarize(admin, id);
    expect(s.status).toBe("failed");
    expect(s.error).toContain('"qwen3:32b" is not available');
    expect(s.error).toContain("scripts/llm.sh pull qwen3:32b");

    const probe = (await (await admin.post("/api/admin/summarizer/probe", { api: "ollama", baseUrl: ollama.url, model: "qwen3:32b" })).json()) as any;
    expect(probe.status).toMatchObject({ reachable: true, server: "Ollama 0.13.0", installed: false });
    expect(probe.status.models[0]).toMatchObject({ name: "qwen3:14b", details: "14.8B · Q4_K_M" });
    const ok = (await (await admin.post("/api/admin/summarizer/probe", { api: "ollama", baseUrl: ollama.url, model: "qwen3:14b" })).json()) as any;
    expect(ok.status).toMatchObject({ installed: true, contextLength: 40960, thinking: true });

    const pull = await admin.post("/api/admin/summarizer/pull", { api: "ollama", baseUrl: ollama.url, model: "qwen3:32b" });
    expect(pull.status).toBe(202);
    const finished = await waitFor(async () => {
      const p = (await (await admin.post("/api/admin/summarizer/probe", { api: "ollama", baseUrl: ollama.url, model: "qwen3:32b" })).json()) as any;
      return p.pull?.done ? p.pull : null;
    });
    expect(finished).toMatchObject({ model: "qwen3:32b", status: "success", completed: 100, total: 100, error: null });
    expect(ollama.requests.some((r) => r.path === "/api/pull" && r.body.model === "qwen3:32b")).toBe(true);
  });

  test("an unreachable server, a cut-off answer and a canceled summary are reported", async () => {
    const admin = await adminClient();
    await admin.req("PUT", "/api/admin/summarizer", { json: local("http://127.0.0.1:9") });
    const id = await readyMeeting(admin, SHORT);
    const down = await summarize(admin, id);
    expect(down.status).toBe("failed");
    expect(down.error).toContain("Cannot reach the local model server at http://127.0.0.1:9");
    const probe = (await (await admin.post("/api/admin/summarizer/probe", { api: "ollama", baseUrl: "http://127.0.0.1:9", model: "qwen3:14b" })).json()) as any;
    expect(probe.status.reachable).toBe(false);

    await admin.req("PUT", "/api/admin/summarizer", { json: local(ollama.url) });
    const cut = await summarize(admin, id, "CUTOFF_PLEASE");
    expect(cut.status).toBe("failed");
    expect(cut.error).toContain("length limit");
    expect(cut.error).toContain("repeating");

    const res = await admin.post(`/api/meetings/${id}/summaries`, { templateId: null, prompt: "SLOW_PLEASE", outputLanguage: "en" });
    const { summary } = (await res.json()) as any;
    await waitFor(async () => {
      const d = (await (await admin.get(`/api/meetings/${id}`)).json()) as any;
      return d.meeting.summaries.find((x: any) => x.id === summary.id)?.status === "running";
    });
    await Bun.sleep(150);
    await admin.post(`/api/meetings/${id}/summaries/${summary.id}/cancel`);
    const canceled = await waitFor(async () => {
      const d = (await (await admin.get(`/api/meetings/${id}`)).json()) as any;
      const x = d.meeting.summaries.find((y: any) => y.id === summary.id);
      return x?.status === "canceled" ? x : null;
    }, 3000);
    expect(canceled.error).toBeNull();
  });

  test("a model without thinking is not sent the think flag", async () => {
    const plain = fakeOllama({ installed: ["llama3.1:8b"], thinking: false });
    try {
      const admin = await adminClient();
      await admin.req("PUT", "/api/admin/summarizer", { json: local(plain.url, { model: "llama3.1:8b" }) });
      const id = await readyMeeting(admin, SHORT);
      expect((await summarize(admin, id, "Write minutes.", "en")).status).toBe("done");
      expect(plain.requests.find((r) => r.path === "/api/chat")!.body.think).toBeUndefined();
    } finally {
      plain.server.stop(true);
    }
  });

  test("an OpenAI-compatible server (vLLM) works too, with its API key", async () => {
    const vllm = fakeOpenAI();
    try {
      const admin = await adminClient();
      await admin.req("PUT", "/api/admin/summarizer", { json: local(vllm.url + "/v1", { api: "openai", model: "Qwen/Qwen3-14B-AWQ", think: true }) });
      const id = await readyMeeting(admin, SHORT);
      const s = await summarize(admin, id, "Write minutes.", "en");
      expect(s.status).toBe("done");
      // The reasoning stream is not part of the summary.
      expect(s.content).toBe("# Minutes\n\n- Release shipped [00:00:04]");
      expect(s.usage).toMatchObject({ input_tokens: 900, output_tokens: 30 });
      const call = vllm.requests.find((r) => r.path === "/v1/chat/completions")!;
      expect(call.headers.get("authorization")).toBe(`Bearer ${process.env.LLM_API_KEY}`);
      expect(call.body.chat_template_kwargs).toEqual({ enable_thinking: true, thinking: true });

      // Thinking used up the answer budget: say so, rather than "raise the context window".
      await admin.req("PUT", "/api/admin/summarizer", { json: local(vllm.url + "/v1", { api: "openai", model: "Qwen/Qwen3-14B-AWQ", think: false }) });
      // A model that thinks anyway (GLM on NVIDIA): retried once with the thinking budget, which is then kept.
      vllm.requests.length = 0;
      const long = await summarize(admin, id, "THINK_LONG", "en");
      expect(long.status).toBe("done");
      expect(long.content).toBe("# Minutes after thinking");
      const tries = vllm.requests.filter((r) => r.path === "/v1/chat/completions");
      expect(tries.map((r) => r.body.max_tokens)).toEqual([8192, 16384]);
      expect(tries.every((r) => r.body.chat_template_kwargs.enable_thinking === false)).toBe(true);
      vllm.requests.length = 0;
      expect((await summarize(admin, id, "THINK_LONG", "en")).status).toBe("done");
      expect(vllm.requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body.max_tokens)).toEqual([16384]);

      // Even the larger budget is not enough: say so, rather than "raise the context window" alone.
      const thought = await summarize(admin, id, "THINK_FOREVER", "en");
      expect(thought.status).toBe("failed");
      expect(thought.error).toContain("thinks even with thinking off");
      expect(call.body.max_tokens).toBe(16384);
      const probe = (await (await admin.post("/api/admin/summarizer/probe", { api: "openai", baseUrl: vllm.url, model: "Qwen/Qwen3-14B-AWQ" })).json()) as any;
      expect(probe.status).toMatchObject({ reachable: true, installed: true, contextLength: 32768 });
    } finally {
      vllm.server.stop(true);
    }
  });

  test("Codex can be chosen instead, with an administrator's model choice", async () => {
    const admin = await adminClient();
    await admin.req("PUT", "/api/admin/summarizer", {
      json: { ...local(ollama.url), provider: "codex", codex: { model: "gpt-5.1-codex", reasoningEffort: "high" } },
    });
    const id = await readyMeeting(admin, SHORT);
    const s = await summarize(admin, id, "Write minutes.", "en");
    expect(s.status).toBe("done");
    expect(s.provider).toBe("codex");
    const args = JSON.parse(await Bun.file(process.env.FAKE_CODEX_ARGS_FILE!).text()) as string[];
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.1-codex");
    expect(args).toContain('model_reasoning_effort="high"');
  });

  test("a cloud API entered as Ollama, with its full endpoint pasted, is explained and fixed up", async () => {
    const api = fakeOpenAI();
    try {
      const admin = await adminClient();
      // What NVIDIA's documentation shows: the whole chat endpoint.
      const saved = (await (await admin.req("PUT", "/api/admin/summarizer", { json: local(api.url + "/v1/chat/completions", { model: "Qwen/Qwen3-14B-AWQ" }) })).json()) as any;
      expect(saved.settings.local.baseUrl).toBe(api.url + "/v1");
      expect(saved.apiKeyConfigured).toBe(true);

      const id = await readyMeeting(admin, SHORT);
      const wrongType = await summarize(admin, id, "Write minutes.", "en");
      expect(wrongType.status).toBe("failed");
      expect(wrongType.error).toContain("does not answer like Ollama");
      expect(wrongType.error).toContain("OpenAI-compatible");
      expect(wrongType.error).not.toContain("scripts/llm.sh pull");
      const probe = (await (await admin.post("/api/admin/summarizer/probe", { api: "ollama", baseUrl: api.url + "/v1", model: "Qwen/Qwen3-14B-AWQ" })).json()) as any;
      expect(probe.status.error).toContain("does not answer like Ollama");

      await admin.req("PUT", "/api/admin/summarizer", { json: local(api.url + "/v1/chat/completions", { api: "openai", model: "Qwen/Qwen3-14B-AWQ" }) });
      const ok = await summarize(admin, id, "Write minutes.", "en");
      expect(ok.status).toBe("done");
      expect(api.requests.some((r) => r.path === "/v1/chat/completions")).toBe(true);
      expect(api.requests.some((r) => r.path.includes("/chat/completions/v1"))).toBe(false);
    } finally {
      api.server.stop(true);
    }
  });
});
