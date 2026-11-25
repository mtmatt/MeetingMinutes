import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_ANTHROPIC_KEY, startFakeAnthropic } from "./fixtures/fakeAnthropic";

// Isolated data directory and a stand-in for the Anthropic API for every test run.
process.env.NODE_ENV = "test";
process.env.MM_SKIP_DOTENV = "1";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "mm-test-"));
process.env.WORKER_TOKEN = "test-worker-token";
process.env.UPLOAD_CHUNK_MB = "1";
process.env.MAX_UPLOAD_MB = "10";
process.env.FAKE_ANTHROPIC_PROMPT_FILE = join(process.env.DATA_DIR, "anthropic-prompt.txt");
const anthropic = startFakeAnthropic({ promptFile: process.env.FAKE_ANTHROPIC_PROMPT_FILE });
// The real SDK, pointed at the stand-in.
process.env.ANTHROPIC_BASE_URL = anthropic.url;
process.env.ANTHROPIC_API_KEY = FAKE_ANTHROPIC_KEY;
// Summaries go to the hosted API (the stand-in above); local-model tests choose "local" themselves.
process.env.SUMMARY_PROVIDER = "api";
process.env.SUMMARY_API_PROVIDER = "anthropic";
process.env.SUMMARY_API_MODEL = "claude-haiku-5-5";
process.env.LLM_API_KEY = "test-llm-key-0123456789abcdef";
