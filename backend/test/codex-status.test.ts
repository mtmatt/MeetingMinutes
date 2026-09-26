import { expect, test } from "bun:test";
import { parseCodexStatus } from "../src/services/codex";

test("codex status ignores housekeeping warnings", () => {
  const warn = "WARNING: failed to clean up stale arg0 temp dirs: Directory not empty (os error 39)";
  expect(parseCodexStatus(`codex-cli 0.157.0\n${warn}\n`, `${warn}\nLogged in using ChatGPT\n`, 0)).toEqual({
    loggedIn: true,
    version: "codex-cli 0.157.0",
    detail: "Logged in using ChatGPT",
  });
  expect(parseCodexStatus(`${warn}\ncodex-cli 0.157.0`, "Not logged in", 1)).toEqual({
    loggedIn: false,
    version: "codex-cli 0.157.0",
    detail: "Not logged in",
  });
});
