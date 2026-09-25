#!/usr/bin/env bun
/**
 * Stand-in for the codex CLI used by tests. Mimics the subcommands and the
 * JSONL event stream of `codex exec --json`.
 */
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("codex-cli 0.0.0-fake");
  process.exit(0);
}
if (args[0] === "features" && args[1] === "list") {
  console.log("shell_tool                               stable             true");
  console.log("unified_exec                             stable             true");
  console.log("apply_patch_freeform                     removed            false");
  console.log("plugins                                  stable             true");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  console.log("Logged in using ChatGPT");
  process.exit(0);
}
if (args[0] === "exec") {
  if (process.env.FAKE_CODEX_ARGS_FILE) writeFileSync(process.env.FAKE_CODEX_ARGS_FILE, JSON.stringify(args));
  const prompt = await new Response(Bun.stdin.stream()).text();
  if (process.env.FAKE_CODEX_PROMPT_FILE) writeFileSync(process.env.FAKE_CODEX_PROMPT_FILE, prompt);
  const out = args[args.indexOf("--output-last-message") + 1]!;
  console.log(JSON.stringify({ type: "thread.started", thread_id: "t1" }));
  console.log(JSON.stringify({ type: "turn.started" }));
  if (prompt.includes("FAIL_PLEASE")) {
    console.log(JSON.stringify({ type: "turn.failed", error: { message: "usage limit reached" } }));
    process.exit(1);
  }
  if (prompt.includes("SLOW_PLEASE")) await Bun.sleep(5000);
  const text = `# Fake minutes\n\nPrompt length ${prompt.length}.`;
  writeFileSync(out, text);
  console.log(JSON.stringify({ type: "item.completed", item: { id: "i0", type: "agent_message", text } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } }));
  process.exit(0);
}
console.error("fake codex: unsupported args " + args.join(" "));
process.exit(2);
