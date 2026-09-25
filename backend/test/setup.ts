import { mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated data directory and fake codex binary for every test run.
process.env.NODE_ENV = "test";
process.env.MM_SKIP_DOTENV = "1";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "mm-test-"));
process.env.WORKER_TOKEN = "test-worker-token";
process.env.UPLOAD_CHUNK_MB = "1";
process.env.MAX_UPLOAD_MB = "10";
const fake = join(import.meta.dir, "fixtures", "fake-codex.ts");
chmodSync(fake, 0o755);
process.env.CODEX_BIN = fake;
process.env.FAKE_CODEX_ARGS_FILE = join(process.env.DATA_DIR, "codex-args.json");
process.env.FAKE_CODEX_PROMPT_FILE = join(process.env.DATA_DIR, "codex-prompt.txt");
