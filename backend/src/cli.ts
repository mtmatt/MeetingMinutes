/**
 * Administrative command line.
 *
 *   bun run admin create-admin <username> [display name]   create an administrator (prompts for password)
 *   bun run admin reset-password <username>                  set a new password (prompts)
 *   bun run admin list-users
 *   bun run admin setup-token                                print the first-run setup token
 *   bun run admin worker-token                               print the worker token
 *   bun run admin export-asr-eval <dir> [meeting id …] [--min-edited N] [--playback]
 *                                                            corrected segments and recordings, for comparing
 *                                                            speech recognition models (scripts/worker.sh compare-asr)
 *   bun run admin media-check [meeting id …]                 which file the player gets for each meeting (the 10
 *                                                            latest without ids), whether it is there, and its codec
 */
import { config } from "./config";
import {
  createUser,
  deleteUserSessions,
  findUserByUsername,
  setPassword,
  validatePassword,
  validateUsername,
} from "./auth/service";
import { ensureSetupToken } from "./auth/setup";
import { db } from "./db";
import { exportAsrEval } from "./services/asrEval";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { PLAYBACK_FILE, mediaTypeFor, meetingDir, originalPath } from "./services/meetings";
import type { MeetingRow } from "./types";

async function readPassword(label: string): Promise<string> {
  if (process.env.MM_PASSWORD) return process.env.MM_PASSWORD;
  process.stdout.write(label);
  const isTty = process.stdin.isTTY;
  if (isTty) Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
  try {
    for await (const line of console) return line.trim();
    return "";
  } finally {
    if (isTty) Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
    process.stdout.write("\n");
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "create-admin": {
    const username = args[0] ?? fail("Usage: create-admin <username> [display name]");
    const err = validateUsername(username);
    if (err) fail(err);
    if (findUserByUsername(username)) fail(`User "${username}" already exists.`);
    const password = await readPassword("Password: ");
    const perr = validatePassword(password);
    if (perr) fail(perr);
    await createUser({ username, displayName: args.slice(1).join(" ") || username, password, role: "admin" });
    ensureSetupToken();
    console.log(`Administrator "${username}" created.`);
    break;
  }
  case "reset-password": {
    const username = args[0] ?? fail("Usage: reset-password <username>");
    const user = findUserByUsername(username) ?? fail(`No user "${username}".`);
    const password = await readPassword("New password: ");
    const perr = validatePassword(password);
    if (perr) fail(perr);
    await setPassword(user.id, password);
    deleteUserSessions(user.id);
    console.log(`Password updated for "${username}"; existing sessions were signed out.`);
    break;
  }
  case "list-users": {
    const rows = db
      .query<{ username: string; role: string; disabled: number }, []>("SELECT username, role, disabled FROM users ORDER BY created_at")
      .all();
    for (const r of rows) console.log(`${r.username}\t${r.role}${r.disabled ? "\t(disabled)" : ""}`);
    if (!rows.length) console.log("(no users)");
    break;
  }
  case "setup-token": {
    const token = ensureSetupToken();
    console.log(token ?? "Setup already completed; no token needed.");
    break;
  }
  case "worker-token":
    console.log(config.workerToken);
    break;
  case "export-asr-eval": {
    const usage = "Usage: export-asr-eval <dir> [meeting id …] [--min-edited N] [--playback]";
    const flags = new Set(["--playback"]);
    let minEdited: number | undefined;
    const ids: string[] = [];
    let dir: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--min-edited") {
        minEdited = Number(args[++i]);
        if (!Number.isInteger(minEdited) || minEdited < 1) fail(usage);
      } else if (flags.has(a)) continue;
      else if (a.startsWith("--")) fail(usage);
      else if (!dir) dir = a;
      else ids.push(a);
    }
    if (!dir) fail(usage);
    let exported;
    try {
      exported = exportAsrEval(dir, { meetingIds: ids, minEdited, playback: args.includes("--playback") });
    } catch (e) {
      fail((e as Error).message);
    }
    if (!exported.length) {
      fail(`No meeting has at least ${minEdited ?? 5} corrected segments. Correct some transcript lines on the site first, or name meetings, or lower --min-edited.`);
    }
    for (const m of exported) console.log(`${m.id}\t${m.edited} corrected of ${m.segments} segments\t${m.title}`);
    const corrected = exported.reduce((n, m) => n + m.edited, 0);
    console.log(`\nExported ${exported.length} meeting(s), ${corrected} corrected segments, to ${dir}.`);
    console.log("Copy the folder to a GPU machine and run there:  scripts/worker.sh compare-asr <dir>");
    break;
  }
  case "media-check": {
    // The same choice as GET /api/meetings/:id/media/audio (routes/meetings.ts).
    const rows = args.length
      ? args.map((id) => db.query<MeetingRow, { id: string }>("SELECT * FROM meetings WHERE id = $id").get({ id }) ?? fail(`No meeting "${id}".`))
      : db.query<MeetingRow, []>("SELECT * FROM meetings ORDER BY created_at DESC LIMIT 10").all();
    const ffprobe = Bun.which("ffprobe");
    const probe = (path: string) => {
      if (!ffprobe) return "(ffprobe not installed)";
      const r = Bun.spawnSync([ffprobe, "-v", "error", "-show_entries", "stream=codec_type,codec_name:format=duration", "-of", "compact=p=0:nk=1", path]);
      return r.exitCode === 0 ? r.stdout.toString().trim().split("\n").join(" | ") : `ffprobe could not read it: ${r.stderr.toString().trim().slice(0, 200)}`;
    };
    const size = (path: string) => (existsSync(path) ? `${(statSync(path).size / 1e6).toFixed(1)} MB` : "MISSING");
    for (const m of rows) {
      console.log(`\n${m.id}  ${m.title}`);
      console.log(`  status ${m.status}${m.stage ? ` (${m.stage})` : ""}, video ${m.has_video ? "yes" : "no"}, playback copy ${m.has_playback ? "yes" : "no"}`);
      const playback = join(meetingDir(m.id), PLAYBACK_FILE);
      const original = originalPath(m);
      console.log(`  playback.m4a       ${m.has_playback || existsSync(playback) ? size(playback) : "(none)"}`);
      console.log(`  original.${m.media_ext.padEnd(10)} ${size(original)}${m.compacted_at ? " (compacted to Opus)" : ""}`);
      let verdict: string;
      if (m.media_deleted_at != null) verdict = "deleted after its retention period: the player shows that, nothing to play";
      else if (m.has_playback) {
        verdict = existsSync(playback) ? `gets playback.m4a (audio/mp4): ${probe(playback)}` : "gets playback.m4a, but THE FILE IS MISSING (404): nothing plays";
      } else if (m.status === "uploading") verdict = "still uploading: nothing to play yet";
      else {
        verdict = existsSync(original)
          ? `gets the original as ${mediaTypeFor(m.media_ext)}: ${probe(original)}`
          : "gets the original, but THE FILE IS MISSING (404): nothing plays";
      }
      console.log(`  the player ${verdict}`);
    }
    break;
  }
  default:
    console.log(`Commands: create-admin, reset-password, list-users, setup-token, worker-token, export-asr-eval, media-check`);
    process.exit(cmd ? 1 : 0);
}
process.exit(0);
