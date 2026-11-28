/**
 * Load test: how the site holds up with 10, 50, 100… people using it at once.
 *
 *   bun run loadtest 10 50 100            # each level in turn, 60 s each
 *   bun run loadtest 50 --duration 120    # one level, two minutes
 *   bun run loadtest 20 --url https://minutes.example.com   # through the proxy / domain
 *   bun run loadtest --cleanup            # remove test accounts left by an interrupted run
 *
 * Run it on the server (it reads the site's database to set up the test
 * accounts). It creates `loadtest-001`… accounts, each with three meetings of
 * about an hour (transcript, speakers, a summary; no recording), then has each
 * "person" do what people do, with a pause of a few seconds between steps:
 * open the library, open a meeting, search, look at templates and term lists,
 * now and then rename a meeting or correct a sentence. It reports each step's
 * response times (p50/p95/p99) and failures, and removes the accounts when it
 * is done. Nothing is transcribed or summarised: no GPU or API costs. The
 * requests also show in Admin → Performance.
 */
import { config } from "./config";
import { db, now } from "./db";
import { hashPassword, insertUser } from "./auth/service";
import { newId, shortId } from "./lib/util";

const PREFIX = "loadtest-";

interface Options {
  levels: number[];
  durationSec: number;
  rampSec: number;
  thinkScale: number;
  url: string;
  insecure: boolean;
  keep: boolean;
  cleanupOnly: boolean;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    levels: [],
    durationSec: 60,
    rampSec: 10,
    thinkScale: 1,
    url: "",
    insecure: false,
    keep: false,
    cleanupOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? fail(`${a} needs a value`);
    if (a === "--duration") o.durationSec = Number(next());
    else if (a === "--ramp") o.rampSec = Number(next());
    else if (a === "--think") o.thinkScale = Number(next());
    else if (a === "--url") o.url = next().replace(/\/+$/, "");
    else if (a === "--insecure") o.insecure = true;
    else if (a === "--keep") o.keep = true;
    else if (a === "--cleanup") o.cleanupOnly = true;
    else if (a === "-h" || a === "--help") usage(0);
    else if (/^\d+$/.test(a)) o.levels.push(Number(a));
    else fail(`Unknown argument: ${a}`);
  }
  if (!o.cleanupOnly && o.levels.length === 0) usage(1);
  if (o.levels.some((n) => n < 1 || n > 500)) fail("Each level must be between 1 and 500 people.");
  if (!(o.durationSec >= 5)) fail("--duration must be at least 5 seconds.");
  if (!o.url) {
    // The server on this machine, as it is reached locally (the host check lets localhost through from here).
    o.url = `${config.tls ? "https" : "http"}://localhost:${config.port}`;
    if (config.tls) o.insecure = true;
  }
  return o;
}

function usage(code: number): never {
  console.log(`Usage: bun run loadtest <people> [<people>…] [--duration 60] [--ramp 10] [--think 1] [--url URL] [--insecure] [--keep]
       bun run loadtest --cleanup

  <people>     how many people use the site at once (each level runs in turn)
  --duration   seconds each level runs (default 60)
  --ramp       seconds over which people arrive (default 10)
  --think      scale of the pause between steps (default 1: 2–6 s; 0.5 is twice as busy)
  --url        address to test (default: this server, http://localhost:PORT)
  --insecure   accept a self-signed certificate
  --keep       keep the test accounts afterwards (remove them later with --cleanup)`);
  process.exit(code);
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// ------------------------------------------------------------------ setup

const WORDS =
  "今天 我們 討論 一下 這個 專案 的 進度 預算 時程 客戶 回饋 下週 需要 確認 測試 結果 上線 會議 記錄 問題 解決 方案 資料 分析 報告 設計 架構 API 伺服器 前端 後端 部署 版本 功能 規格 優先 順序 負責 時間 成本 風險".split(" ");

function sentence(seed: number): string {
  let s = seed;
  const n = 8 + (s % 14);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out.push(WORDS[s % WORDS.length]!);
  }
  return out.join("") + "。";
}

const SUMMARY = `# 專案進度會議

## 摘要
本次會議確認了上線時程與測試範圍，並討論客戶回饋與預算調整。

## 決議
1. 下週三前完成整合測試 [00:12:40]
2. 預算維持原案，風險項目另列 [00:31:05]

## 待辦事項
| 負責人 | 事項 | 期限 |
| --- | --- | --- |
| 王小明 | 整理客戶回饋 | 下週一 |
| 陳美玲 | 更新部署文件 | 下週三 |
`;

/** Accounts loadtest-001…, each with three meetings of about an hour. All share one password. */
async function setup(people: number): Promise<string> {
  const password = `lt-${newId(16)}`;
  const hash = await hashPassword(password);
  const existing = new Set(
    db.query<{ username: string }, []>(`SELECT username FROM users WHERE username LIKE '${PREFIX}%'`).all().map((r) => r.username.toLowerCase()),
  );
  db.query(`UPDATE users SET password_hash = $h, disabled = 0 WHERE username LIKE '${PREFIX}%'`).run({ h: hash });
  const t = now();
  const insertMeeting = db.query(
    `INSERT INTO meetings (id, owner_id, title, occurred_at, status, media_name, media_mime, media_size, media_received, media_ext,
       duration_sec, language, options, created_at, updated_at, transcribed_at, media_deleted_at)
     VALUES ($id, $u, $title, $occ, 'ready', 'loadtest.m4a', 'audio/mp4', 0, 0, 'm4a', 3600, 'Chinese', '{}', $t, $t, $t, $t)`,
  );
  const insertSpeaker = db.query("INSERT INTO speakers (meeting_id, key, name, color) VALUES ($m, $k, $n, $c)");
  const insertSegment = db.query(
    "INSERT INTO segments (meeting_id, idx, start_sec, end_sec, speaker, text) VALUES ($m, $i, $s, $e, $sp, $text)",
  );
  const insertSummary = db.query(
    `INSERT INTO summaries (id, meeting_id, created_by, template_id, template_name, prompt, output_language, status, content, created_at, started_at, finished_at)
     VALUES ($id, $m, $u, 'builtin-minutes', NULL, '', 'zh-TW', 'done', $content, $t, $t, $t)`,
  );
  const names = ["王小明", "陳美玲", "林志豪", "張雅婷"];
  let created = 0;
  for (let n = 1; n <= people; n++) {
    const username = `${PREFIX}${String(n).padStart(3, "0")}`;
    if (existing.has(username)) continue;
    db.transaction(() => {
      const user = insertUser({ username, displayName: `Load test ${n}`, passwordHash: hash, role: "member" });
      for (let k = 0; k < 3; k++) {
        const id = shortId();
        insertMeeting.run({ id, u: user.id, title: `壓力測試會議 ${n}-${k + 1}`, occ: t - k * 86_400_000, t });
        names.forEach((name, j) => insertSpeaker.run({ m: id, k: `SPEAKER_0${j}`, n: name, c: j }));
        // About an hour: a sentence every 9 seconds.
        for (let i = 0; i < 400; i++) {
          insertSegment.run({ m: id, i, s: i * 9, e: i * 9 + 7.5, sp: `SPEAKER_0${(i >> 3) % 4}`, text: sentence(n * 1000 + k * 400 + i) });
        }
        insertSummary.run({ id: newId(12), m: id, u: user.id, content: SUMMARY, t });
      }
    })();
    created++;
    // A breath between accounts: the site's own writes get their turn (one writer at a time).
    await Bun.sleep(5);
  }
  console.log(`Test accounts: ${people} ready (${created} created), each with 3 meetings of about an hour.`);
  return password;
}

/** One account at a time, so the site's own writes are never held up for long. */
async function cleanup() {
  const ids = db.query<{ id: string }, []>(`SELECT id FROM users WHERE username LIKE '${PREFIX}%'`).all();
  // Meetings, transcripts, summaries and sessions go with each account (ON DELETE CASCADE).
  for (const { id } of ids) {
    db.query("DELETE FROM users WHERE id = $id").run({ id });
    await Bun.sleep(5);
  }
  console.log(`Removed ${ids.length} test account${ids.length === 1 ? "" : "s"} and their meetings.`);
}

// ------------------------------------------------------------------ the run

interface Stat {
  times: number[];
  errors: number;
  samples: string[];
}

class Recorder {
  stats = new Map<string, Stat>();
  add(step: string, ms: number, error?: string) {
    let s = this.stats.get(step);
    if (!s) this.stats.set(step, (s = { times: [], errors: 0, samples: [] }));
    s.times.push(ms);
    if (error) {
      s.errors++;
      if (s.samples.length < 3 && !s.samples.includes(error)) s.samples.push(error);
    }
  }
}

function pct(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

class Person {
  private cookie = "";
  private meetings: { id: string; segments: number[] }[] = [];

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly o: Options,
    private readonly rec: Recorder,
  ) {}

  private async call(step: string, method: string, path: string, json?: unknown): Promise<any> {
    const headers: Record<string, string> = { "X-MM-Client": "1", Accept: "application/json" };
    if (this.cookie) headers.Cookie = this.cookie;
    if (json !== undefined) headers["Content-Type"] = "application/json";
    const start = performance.now();
    let res: Response;
    try {
      res = await fetch(this.o.url + path, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
        redirect: "manual",
        ...(this.o.insecure ? { tls: { rejectUnauthorized: false } } : {}),
      } as RequestInit);
    } catch (e) {
      this.rec.add(step, performance.now() - start, `network: ${(e as Error).message}`);
      return null;
    }
    const text = await res.text();
    const ms = performance.now() - start;
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!;
    if (!res.ok) {
      this.rec.add(step, ms, `HTTP ${res.status} ${text.slice(0, 80).replace(/\s+/g, " ")}`);
      return null;
    }
    this.rec.add(step, ms);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  }

  private think() {
    return Bun.sleep((2000 + Math.random() * 4000) * this.o.thinkScale);
  }

  private pick<T>(list: T[]): T | undefined {
    return list[Math.floor(Math.random() * list.length)];
  }

  async run(until: number) {
    if (!(await this.call("sign in", "POST", "/api/auth/login", { username: this.username, password: this.password }))) return;
    // Opening the site.
    await this.call("open site (auth state)", "GET", "/api/auth/state");
    const lib = await this.call("library", "GET", "/api/meetings");
    this.meetings = (lib?.meetings ?? []).map((m: { id: string }) => ({ id: m.id, segments: [] }));
    while (performance.now() < until) {
      await this.think();
      if (performance.now() >= until) break;
      const r = Math.random();
      const m = this.pick(this.meetings);
      if (r < 0.35 && m) {
        const d = await this.call("open meeting", "GET", `/api/meetings/${m.id}`);
        if (d?.meeting?.segments) m.segments = d.meeting.segments.map((s: { id: number }) => s.id);
      } else if (r < 0.55) {
        await this.call("library", "GET", "/api/meetings");
      } else if (r < 0.65) {
        await this.call("search", "GET", `/api/meetings?q=${encodeURIComponent(this.pick(WORDS)!)}`);
      } else if (r < 0.72) {
        await this.call("templates", "GET", "/api/templates");
      } else if (r < 0.77) {
        await this.call("term lists", "GET", "/api/glossaries");
      } else if (r < 0.82) {
        await this.call("open site (auth state)", "GET", "/api/auth/state");
      } else if (r < 0.87) {
        await this.call("usage", "GET", "/api/usage");
      } else if (r < 0.93 && m && m.segments.length) {
        const seg = this.pick(m.segments)!;
        await this.call("correct a sentence", "PATCH", `/api/meetings/${m.id}/segments/${seg}`, { text: sentence(Math.floor(Math.random() * 1e6)) });
      } else if (m) {
        await this.call("rename meeting", "PATCH", `/api/meetings/${m.id}`, { title: `壓力測試會議 ${Math.floor(Math.random() * 1000)}` });
      }
    }
    await this.call("sign out", "POST", "/api/auth/logout");
  }
}

async function runLevel(people: number, password: string, o: Options) {
  const rec = new Recorder();
  const start = performance.now();
  const until = start + o.durationSec * 1000;
  console.log(`\n== ${people} people, ${o.durationSec} s (arriving over ${Math.min(o.rampSec, o.durationSec)} s) → ${o.url}`);
  // A running count, on a terminal only (in a log file it would repeat).
  const tick = setInterval(() => {
    if (!process.stdout.isTTY) return;
    const done = [...rec.stats.values()].reduce((n, s) => n + s.times.length, 0);
    process.stdout.write(`\r   ${Math.round((performance.now() - start) / 1000)} s, ${done} requests…   `);
  }, 1000);
  const runs: Promise<void>[] = [];
  for (let i = 0; i < people; i++) {
    const delay = (i / people) * Math.min(o.rampSec, o.durationSec) * 1000;
    const name = `${PREFIX}${String(i + 1).padStart(3, "0")}`;
    runs.push(Bun.sleep(delay).then(() => new Person(name, password, o, rec).run(until)));
  }
  await Promise.all(runs);
  clearInterval(tick);
  const secs = (performance.now() - start) / 1000;
  if (process.stdout.isTTY) process.stdout.write("\r" + " ".repeat(40) + "\r");

  const rows = [...rec.stats.entries()].sort((a, b) => b[1].times.length - a[1].times.length);
  const all = rows.flatMap(([, s]) => s.times).sort((a, b) => a - b);
  const errors = rows.reduce((n, [, s]) => n + s.errors, 0);
  const f = (v: number) => (Number.isNaN(v) ? "-" : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`);
  const table = [
    ["step", "requests", "errors", "p50", "p95", "p99", "max"],
    ...rows.map(([step, s]) => {
      const t = [...s.times].sort((a, b) => a - b);
      return [step, String(t.length), String(s.errors), f(pct(t, 0.5)), f(pct(t, 0.95)), f(pct(t, 0.99)), f(t[t.length - 1] ?? NaN)];
    }),
    ["all", String(all.length), String(errors), f(pct(all, 0.5)), f(pct(all, 0.95)), f(pct(all, 0.99)), f(all[all.length - 1] ?? NaN)],
  ];
  const widths = table[0]!.map((_, c) => Math.max(...table.map((r) => [...r[c]!].length)));
  for (const [i, r] of table.entries()) {
    console.log("   " + r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!))).join("   "));
    if (i === 0 || i === table.length - 2) console.log("   " + widths.map((w) => "-".repeat(w)).join("   "));
  }
  console.log(`   ${(all.length / secs).toFixed(1)} requests/s · ${errors ? `${((errors / all.length) * 100).toFixed(2)}% failed` : "no failures"}`);
  for (const [step, s] of rows) for (const e of s.samples) console.log(`   ! ${step}: ${e}`);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.cleanupOnly) {
    await cleanup();
    return;
  }
  // The server must be up before anything is created.
  try {
    await fetch(`${o.url}/healthz`, o.insecure ? ({ tls: { rejectUnauthorized: false } } as RequestInit) : undefined);
  } catch (e) {
    fail(`Cannot reach ${o.url} (${(e as Error).message}). Start the server, or give its address with --url.`);
  }
  const password = await setup(Math.max(...o.levels));
  let interrupted = false;
  const stop = async () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log("\nStopping…");
    if (!o.keep) await cleanup();
    process.exit(130);
  };
  process.on("SIGINT", () => void stop());
  try {
    for (const n of o.levels) await runLevel(n, password, o);
  } finally {
    if (!o.keep) await cleanup();
    else console.log(`\nKept the test accounts (${PREFIX}…). Remove them with: bun run loadtest --cleanup`);
  }
}

await main();
