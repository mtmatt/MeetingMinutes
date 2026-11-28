/**
 * The site with fixed sample data, for the UI check (uicheck/run.ts starts it).
 *
 *   bun uicheck/server.ts <port> <slides-dir>
 *
 * Uses a throwaway data directory and the built frontend (frontend/dist).
 * Every account the check signs in as has the same meetings, lists and
 * settings, so the pages look the same in every variant. Prints one JSON line,
 * {"ready": true, ...}, once it is listening.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const port = Number(process.argv[2] ?? 8790);
const slidesSrc = process.argv[3] ?? "";

process.env.MM_SKIP_DOTENV = "1";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "mm-uicheck-"));
process.env.FRONTEND_DIST = join(ROOT, "frontend", "dist");
process.env.HOST = "127.0.0.1";
process.env.PORT = String(port);
process.env.MAIL_TRANSPORT = "log";
process.env.WORKER_TOKEN = "uicheck-worker-token-0123456789";
// A summary provider that looks configured (nothing is summarised here).
process.env.SUMMARY_PROVIDER = "api";
process.env.SUMMARY_API_PROVIDER = "anthropic";
process.env.SUMMARY_API_MODEL = "claude-haiku-5-5";
process.env.ANTHROPIC_API_KEY = "uicheck-not-a-real-key";
process.env.SMTP_HOST = "smtp.example.com";
process.env.MAIL_FROM = "minutes@example.com";

const { createApp } = await import("../backend/src/app");
const { db, now } = await import("../backend/src/db");
const { seedBuiltinTemplates } = await import("../backend/src/services/templates");
const { hashPassword, insertUser } = await import("../backend/src/auth/service");
const { createInvite } = await import("../backend/src/auth/invites");
const { createAnnouncement } = await import("../backend/src/services/announcements");
const { addCredits } = await import("../backend/src/services/credits");
const { defaultBillingSettings, saveBillingSettings } = await import("../backend/src/services/billingSettings");
const { createWorkerKey } = await import("../backend/src/services/workerKeys");
const { recordEvent } = await import("../backend/src/services/security");
const { flushPerf, recordRequest } = await import("../backend/src/services/perf");
const { meetingDir } = await import("../backend/src/services/meetings");
const { slidesDir } = await import("../backend/src/services/slides");
const { newId, shortId } = await import("../backend/src/lib/util");
const { saveTerms } = await import("../backend/src/services/terms");

seedBuiltinTemplates();
const app = createApp();
export const PASSWORD = "uicheck password 1";
const hash = await hashPassword(PASSWORD);
const T = now();
const DAY = 86_400_000;

// ------------------------------------------------------------- site settings

const admin0 = insertUser({ username: "admin", displayName: "Site Admin", passwordHash: hash, role: "admin" });
saveBillingSettings(
  {
    ...defaultBillingSettings(),
    registrationOpen: true,
    enabled: true,
    noExpiry: true,
    packages: [
      { id: "small", name: "入門 120 點", points: 120, price: 150 },
      { id: "large", name: "團隊 1,200 點（附贈 10%）", points: 1320, price: 1500 },
    ],
  } as never,
  admin0.id,
);
saveTerms(
  `# 點數購買條款\n\n1. 點數用於語音轉錄與摘要，依管理員設定的費率扣除。\n2. 點數不會過期；已使用的點數不予退還。\n3. 付款由綠界科技處理，本站不會取得您的信用卡資料。\n`,
  admin0.id,
);
createAnnouncement(
  {
    title: "系統維護通知：12 月 3 日 22:00–23:00 暫停轉錄服務",
    body: "維護期間仍可瀏覽與匯出既有的會議紀錄。",
    level: "warning",
    audience: "users",
    startsAt: null,
    endsAt: T + 7 * DAY,
    dismissible: true,
    notifyAgain: false,
  } as never,
  admin0.id,
);
createInvite({ kind: "invite", role: "member", note: "資訊系 2026 秋季專題組", createdBy: admin0.id, ttlHours: 72, maxUses: 20 });
createInvite({ kind: "invite", role: "admin", note: null, createdBy: admin0.id, ttlHours: 24 });
createWorkerKey("實驗室 GPU 工作站（RTX 4090 ×2）", admin0.id);
for (const [kind, ip, detail] of [
  ["login_failed", "203.0.113.24", "POST /api/auth/login"],
  ["probe", "198.51.100.7", "GET /wp-login.php"],
  ["bad_token", "198.51.100.7", "GET /api/auth/invites/AbCd…"],
  ["rate_limited", "203.0.113.24", "POST /api/auth/login"],
] as const) {
  for (let i = 0; i < 3; i++) recordEvent(kind, { ip, username: kind === "login_failed" ? "admin" : null, detail });
}
// A day of request timings for the performance page.
for (let m = 0; m < 24 * 60; m += 7) {
  const at = T - m * 60_000;
  for (const [route, base] of [
    ["GET /api/meetings", 12],
    ["GET /api/meetings/:id", 35],
    ["POST /api/meetings/:id/summaries", 180],
    ["GET /api/me", 3],
  ] as const) {
    for (let i = 0; i < 6; i++) recordRequest(route, i === 5 && m % 140 === 0 ? 500 : 200, base * (0.6 + ((m * 7 + i * 13) % 17) / 10), at);
  }
}
flushPerf();

// ------------------------------------------------------------- per account

/** A WAV file of `seconds` of near silence (8 kHz, 8-bit): enough for the player. */
function wav(seconds: number): Uint8Array {
  const rate = 8000;
  const n = rate * seconds;
  const buf = new Uint8Array(44 + n);
  const v = new DataView(buf.buffer);
  const text = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  text(36, "data");
  v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) buf[44 + i] = 128 + Math.round(6 * Math.sin(i / 9) * Math.sin(i / 4000));
  return buf;
}
const AUDIO_SEC = 180;
const audio = wav(AUDIO_SEC);
const slideFiles = slidesSrc ? readdirSync(slidesSrc).filter((f) => f.endsWith(".jpg")).sort() : [];

const LINES = [
  "好，那我們開始今天的產品週會，先請小明報告一下上週的進度。",
  "上週主要完成了登入流程的改版，另外修了三個和上傳有關的問題。",
  "客戶回饋說手機上的播放器有時候會被擠到畫面外面，這個要再確認。",
  "我這邊可以補充，測試環境已經準備好，下週三前可以完成整合測試。",
  "預算的部分維持原案，不過雲端 GPU 的費用要另外列成風險項目。",
  "那摘要匯出成 PDF 的功能，簡報截圖會一起放進去嗎？",
  "會，摘要模型會挑跟內容有關的截圖，逐字稿則是全部都放。",
  "好，那最後確認一下分工：美玲負責更新部署文件，志豪負責壓力測試。",
];
const SPEAKERS = ["王小明", "陳美玲", "林志豪", "Alexandra Konstantinopoulou（外部顧問）"];

function summaryText(slideIds: string[]): string {
  const pic = slideIds[1] ? `\n\n![第二張投影片：時程與里程碑](slide:${slideIds[1]})\n` : "";
  return `# 產品週會

## 摘要
本次會議確認了上線時程與測試範圍，並討論客戶回饋與預算調整。手機版播放器的版面問題列為優先處理項目。${pic}
## 決議
1. 下週三前完成整合測試 [00:01:12]
2. 預算維持原案，雲端 GPU 費用另列風險 [00:01:36]

## 待辦事項
| 負責人 | 事項 | 期限 |
| --- | --- | --- |
| 王小明 | 整理客戶回饋，確認手機播放器問題 | 下週一 |
| 陳美玲 | 更新部署文件（systemd 與憑證更新流程） | 下週三 |
| 林志豪 | 10、50、100 人壓力測試 | 下週五 |
`;
}

const insertMeeting = db.query(
  `INSERT INTO meetings (id, owner_id, title, occurred_at, status, stage, progress, error, media_name, media_mime, media_size,
     media_received, media_ext, duration_sec, language, options, created_at, updated_at, transcribed_at, media_deleted_at)
   VALUES ($id, $u, $title, $occ, $status, $stage, $progress, $error, $name, 'audio/wav', $size, $size, 'wav', $dur, 'Chinese', '{}',
     $t, $t, $done, $deleted)`,
);
const insertSpeaker = db.query("INSERT INTO speakers (meeting_id, key, name, color) VALUES ($m, $k, $n, $c)");
const insertSegment = db.query("INSERT INTO segments (meeting_id, idx, start_sec, end_sec, speaker, text) VALUES ($m, $i, $s, $e, $sp, $text)");
const insertSummary = db.query(
  `INSERT INTO summaries (id, meeting_id, created_by, template_id, template_name, prompt, output_language, status, content, created_at, started_at, finished_at)
   VALUES ($id, $m, $u, 'builtin-minutes', NULL, '', 'zh-TW', 'done', $content, $t, $t, $t)`,
);
const insertSlide = db.query(
  `INSERT INTO slides (id, meeting_id, client_key, at_sec, width, height, bytes, created_at) VALUES ($id, $m, $k, $at, 1280, 720, $b, $t)`,
);

interface Seeded {
  ready: string;
  processing: string;
  failed: string;
  deleted: string;
  silent: string;
}

function meeting(owner: string, o: { title: string; status: string; stage?: string; progress?: number; error?: string; deleted?: boolean; daysAgo: number }) {
  const id = shortId();
  const ready = o.status === "ready";
  insertMeeting.run({
    id,
    u: owner,
    title: o.title,
    occ: T - o.daysAgo * DAY,
    status: o.status,
    stage: o.stage ?? null,
    progress: o.progress ?? 0,
    error: o.error ?? null,
    name: "weekly-meeting.wav",
    size: audio.byteLength,
    dur: AUDIO_SEC,
    t: T - o.daysAgo * DAY,
    done: ready ? T - o.daysAgo * DAY : null,
    deleted: o.deleted ? T : null,
  });
  if (!o.deleted) {
    mkdirSync(meetingDir(id), { recursive: true });
    writeFileSync(join(meetingDir(id), "original.wav"), audio);
  }
  return id;
}

function seedAccount(owner: string): Seeded {
  const ready = meeting(owner, { title: "產品週會：上線時程、預算與客戶回饋", status: "ready", daysAgo: 0 });
  SPEAKERS.forEach((n, j) => insertSpeaker.run({ m: ready, k: `SPEAKER_0${j}`, n, c: j }));
  for (let i = 0; i < 24; i++) {
    insertSegment.run({ m: ready, i, s: i * 7, e: i * 7 + 6, sp: `SPEAKER_0${(i >> 1) % 4}`, text: LINES[i % LINES.length]! });
  }
  const slideIds: string[] = [];
  if (slideFiles.length) mkdirSync(slidesDir(ready), { recursive: true });
  slideFiles.forEach((f, i) => {
    const id = newId(12);
    const data = readFileSync(join(slidesSrc, f));
    writeFileSync(join(slidesDir(ready), `${id}.jpg`), data);
    insertSlide.run({ id, m: ready, k: `k${i}`, at: 10 + i * 55, b: data.byteLength, t: T });
    slideIds.push(id);
  });
  insertSummary.run({ id: newId(12), m: ready, u: owner, content: summaryText(slideIds), t: T });

  const processing = meeting(owner, { title: "研究所課程討論", status: "processing", stage: "diarizing", progress: 0.42, daysAgo: 1 });
  meeting(owner, { title: "排隊中的訪談錄音", status: "queued", daysAgo: 1 });
  const failed = meeting(owner, {
    title: "客戶訪談（錄音檔損毀）",
    status: "failed",
    error: "The recording could not be decoded: ffmpeg reported an invalid data stream at 00:12:31. Upload the file again, or convert it to WAV or MP3 first.",
    daysAgo: 2,
  });
  const deleted = meeting(owner, {
    title: "一場標題非常非常長的會議，用來確認標題在窄螢幕上換行時不會把旁邊的按鈕擠出畫面之外",
    status: "ready",
    deleted: true,
    daysAgo: 40,
  });
  insertSpeaker.run({ m: deleted, k: "SPEAKER_00", n: "王小明", c: 0 });
  insertSegment.run({ m: deleted, i: 0, s: 0, e: 6, sp: "SPEAKER_00", text: LINES[0]! });
  const silent = meeting(owner, { title: "螢幕錄影（沒有人說話）", status: "ready", daysAgo: 3 });
  slideFiles.slice(0, 2).forEach((f, i) => {
    const id = newId(12);
    mkdirSync(slidesDir(silent), { recursive: true });
    const data = readFileSync(join(slidesSrc, f));
    writeFileSync(join(slidesDir(silent), `${id}.jpg`), data);
    insertSlide.run({ id, m: silent, k: `k${i}`, at: 5 + i * 30, b: data.byteLength, t: T });
  });

  const t = now();
  db.query(
    `INSERT INTO templates (id, owner_id, builtin, name, description, body, created_at, updated_at)
     VALUES ($id, $u, 0, '研究室週會（附行動項目與負責人）', '每週研究進度報告用，條列決議與下週待辦', $b, $t, $t)`,
  ).run({ id: newId(9), u: owner, b: "請整理成：一、進度；二、決議；三、待辦（負責人、期限）。", t });
  db.query("INSERT INTO glossaries (id, owner_id, name, terms, created_at, updated_at) VALUES ($id, $u, $n, $terms, $t, $t)").run({
    id: newId(10),
    u: owner,
    n: "資訊系專有名詞",
    terms: "pyannote\nWhisper\nsystemd\nKubernetes\n王小明\n國科會",
    t,
  });
  return { ready, processing, failed, deleted, silent };
}

/** One member and one administrator per variant: settings such as the theme belong to the account. */
const accounts: Record<string, { member: string; admin: string; meetings: Seeded; resetToken: string }> = {};
const variants: string[] = JSON.parse(process.env.UICHECK_VARIANTS ?? '["v"]');
for (const v of variants) {
  const member = insertUser({ username: `member-${v}`, displayName: "陳美玲", passwordHash: hash, role: "member" });
  db.query("UPDATE users SET billing = 'prepaid', email = $e, email_verified_at = $t WHERE id = $id").run({
    id: member.id,
    e: `member-${v}@example.com`,
    t: T,
  });
  addCredits(member.id, 87_500, { kind: "adjust", note: "歡迎點數" });
  const adminUser = insertUser({ username: `admin-${v}`, displayName: "系統管理員", passwordHash: hash, role: "admin" });
  const meetings = seedAccount(member.id);
  seedAccount(adminUser.id);
  const { token } = createInvite({ kind: "reset", role: "member", targetUserId: member.id, createdBy: adminUser.id, ttlHours: 24 });
  accounts[v] = { member: `member-${v}`, admin: `admin-${v}`, meetings, resetToken: token };
}
const { token: inviteToken } = createInvite({ kind: "invite", role: "member", note: null, createdBy: admin0.id, ttlHours: 72, maxUses: 5 });

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: (req, srv) => app.fetch(req, { server: srv }),
  idleTimeout: 0,
});
console.log(JSON.stringify({ ready: true, port, password: PASSWORD, accounts, inviteToken }));
