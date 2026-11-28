/**
 * Stand-in for the Anthropic API, for tests: the real SDK talks to it through
 * ANTHROPIC_BASE_URL. POST /v1/messages answers as a server-sent event stream,
 * GET /v1/models/{id} with the model's limits. Words in the prompt choose the
 * behaviour:
 *   FAIL_PLEASE           400 "usage limit reached"
 *   SLOW_PLEASE           answers after 5 s (time to cancel)
 *   LEAK_PLEASE           repeats the worker token
 *   REFUSE_PLEASE         stop_reason "refusal"
 *   ECHO_SPEAKERS_PLEASE  writes the transcript lines back
 *   NO_PICTURES_PLEASE    400 "image input is not supported" when pictures are sent
 * Every request's prompt (system + user text) is written to FAKE_ANTHROPIC_PROMPT_FILE.
 */
import { writeFileSync } from "node:fs";

export const FAKE_ANTHROPIC_KEY = "test-anthropic-key-0123456789abcdef";

export interface FakeAnthropicOptions {
  promptFile: string;
  /** Models it knows, with their limits. */
  models?: Record<string, { max_input_tokens: number; max_tokens: number }>;
}

function sse(events: { type: string; [k: string]: unknown }[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

export function startFakeAnthropic(opts: FakeAnthropicOptions) {
  const models = opts.models ?? { "claude-haiku-5-5": { max_input_tokens: 1_000_000, max_tokens: 128_000 } };
  const error = (status: number, type: string, message: string) =>
    Response.json({ type: "error", error: { type, message } }, { status, headers: { "x-should-retry": "false" } });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url);
      // The SDK sends the key as x-api-key or as a bearer token, depending on its version.
      const key = req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer /, "");
      if (key !== FAKE_ANTHROPIC_KEY) return error(401, "authentication_error", "invalid x-api-key");
      const model = /^\/v1\/models\/(.+)$/.exec(url.pathname);
      if (req.method === "GET" && model) {
        const id = decodeURIComponent(model[1]!);
        const m = models[id];
        if (!m) return error(404, "not_found_error", `model: ${id}`);
        return Response.json({ type: "model", id, display_name: id, created_at: "2026-01-01T00:00:00Z", ...m });
      }
      if (req.method !== "POST" || url.pathname !== "/v1/messages") return error(404, "not_found_error", "Not found");

      type Block = { type: string; text?: string; source?: { media_type: string; data: string } };
      const body = (await req.json()) as { model: string; system?: string; messages: { content: string | Block[] }[]; stream?: boolean };
      if (!models[body.model]) return error(404, "not_found_error", `model: ${body.model}`);
      // Pictures are written as <<image type bytes>>, so tests can see which were sent and where.
      const flatten = (c: string | Block[]) =>
        typeof c === "string"
          ? c
          : c.map((b) => (b.type === "text" ? b.text : b.type === "image" ? `<<image ${b.source?.media_type} ${b.source?.data.length}>>` : `<<${b.type}>>`)).join("\n");
      const user = body.messages.map((m) => flatten(m.content)).join("\n\n");
      const prompt = `${body.system ?? ""}\n\n${user}`;
      writeFileSync(opts.promptFile, prompt);
      if (prompt.includes("FAIL_PLEASE")) return error(400, "invalid_request_error", "usage limit reached");
      if (prompt.includes("NO_PICTURES_PLEASE") && prompt.includes("<<image ")) return error(400, "invalid_request_error", "image input is not supported by this model");
      if (prompt.includes("SLOW_PLEASE")) {
        await Bun.sleep(5000);
        if (req.signal.aborted) return new Response(null, { status: 499 });
      }
      const echo = prompt.includes("ECHO_SPEAKERS_PLEASE") ? (prompt.split("<transcript>\n")[1] ?? "").split("\n</transcript>")[0]! : null;
      const text = prompt.includes("LEAK_PLEASE")
        ? "Here is the token: test-worker-token"
        : echo != null
          ? `# Minutes\n\n${echo}`
          : `# Fake minutes\n\nPrompt length ${prompt.length}.`;
      const refuse = prompt.includes("REFUSE_PLEASE");
      const stream = sse([
        {
          type: "message_start",
          message: { id: "msg_fake", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } },
        },
        ...(refuse
          ? []
          : [
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
              { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, 10) } },
              { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(10) } },
              { type: "content_block_stop", index: 0 },
            ]),
        {
          type: "message_delta",
          delta: refuse
            ? { stop_reason: "refusal", stop_sequence: null, stop_details: { type: "refusal", category: "cyber", explanation: "not allowed in this test" } }
            : { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 20 },
        },
        { type: "message_stop" },
      ]);
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  server.unref();
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
