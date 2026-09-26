import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config";
import { CodexError, codexEnv, containsSecret, parseFeatures, resetCodexFeatureCache, runCodex } from "../src/services/codex";

// Summaries run a model on text written by users and meeting participants, so a
// prompt injection must never get a tool that reads the server's files.
describe("codex isolation", () => {
  afterEach(() => {
    delete process.env.FAKE_CODEX_FEATURES;
    resetCodexFeatureCache();
  });

  test("the real codex 0.157.0 feature list is verified as isolated", () => {
    const real = readFileSync(join(import.meta.dir, "fixtures", "codex-0.157.0-features.txt"), "utf8");
    expect(parseFeatures(real, config.codex.disableFeatures).isolationError).toBeNull();
  });

  test("unverifiable tool isolation stops summaries instead of running with tools", async () => {
    const d = config.codex.disableFeatures;
    expect(parseFeatures("", d).isolationError).toContain("Could not read");
    // A codex update renamed the shell tool.
    const renamed = "shell_command   stable   true\nunified_exec   stable   true\nview_image   stable   true";
    expect(parseFeatures(renamed, d).isolationError).toContain("shell_tool");
    // Removed tools are fine: they no longer exist.
    const removed = "shell_tool   removed   false\nunified_exec   stable   true\nview_image   stable   true";
    expect(parseFeatures(removed, d).isolationError).toBeNull();
    // The admin shortened CODEX_DISABLE_FEATURES.
    expect(parseFeatures(removed, ["unified_exec"]).isolationError).toContain("view_image");

    process.env.FAKE_CODEX_FEATURES = "";
    resetCodexFeatureCache();
    await expect(runCodex("hello")).rejects.toThrow("Summaries are paused");
  });

  test("a tool call stops the run before its result can be used", async () => {
    const t0 = performance.now();
    const err = await runCodex("TOOL_PLEASE").catch((e) => e);
    expect(err).toBeInstanceOf(CodexError);
    expect(String(err.message)).toContain("command_execution");
    // Killed on the spot, not after the fake's 5 s "command".
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  test("output containing server credentials is discarded", async () => {
    await expect(runCodex("LEAK_PLEASE")).rejects.toThrow("credentials");
    expect(containsSecret("nothing to see here")).toBe(false);
  });

  test("codex does not receive server secrets in its environment", async () => {
    process.env.HF_TOKEN = "hf_test_secret_value_1234567890";
    const envFile = join(process.env.DATA_DIR!, "codex-env.json");
    process.env.FAKE_CODEX_ENV_FILE = envFile;
    try {
      expect(Object.keys(codexEnv())).not.toContain("HF_TOKEN");
      await runCodex("hello");
      const keys = JSON.parse(readFileSync(envFile, "utf8")) as string[];
      expect(keys).not.toContain("HF_TOKEN");
      expect(keys).not.toContain("WORKER_TOKEN");
      expect(keys).not.toContain("DATA_DIR");
    } finally {
      delete process.env.HF_TOKEN;
      delete process.env.FAKE_CODEX_ENV_FILE;
    }
  });
});
