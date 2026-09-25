import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";
import { newId, safeEqual } from "../lib/util";
import { countUsers } from "./service";

const TOKEN_PATH = join(config.dataDir, "setup.token");

/**
 * First-run bootstrap. While no user exists, creating the first (admin)
 * account requires a one-time token that is only visible to whoever can read
 * the server log or the data directory, so a publicly reachable fresh install
 * cannot be claimed by a stranger.
 */
export function ensureSetupToken(): string | null {
  if (countUsers() > 0) {
    clearSetupToken();
    return null;
  }
  if (existsSync(TOKEN_PATH)) return readFileSync(TOKEN_PATH, "utf8").trim();
  const token = newId(18);
  writeFileSync(TOKEN_PATH, token + "\n", { mode: 0o600 });
  return token;
}

export function checkSetupToken(candidate: string): boolean {
  if (!existsSync(TOKEN_PATH)) return false;
  return safeEqual(candidate.trim(), readFileSync(TOKEN_PATH, "utf8").trim());
}

export function clearSetupToken() {
  rmSync(TOKEN_PATH, { force: true });
}
