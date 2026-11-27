import { isIP } from "node:net";
import { z } from "zod";
import { config } from "../config";
import { db, now } from "../db";
import { parseJson } from "../lib/util";
import { mailConfigured, sendMailLater } from "./mail";
import { readSetting, settingMeta, writeSetting } from "./settingsStore";

/**
 * Security monitor: what looks like an attack on the site, who it comes from,
 * blocking those addresses, and telling the administrators.
 *
 * Events are counted per kind, address (and account tried) and minute, so a
 * flood is a few rows, not one per request. An address whose recent events add
 * up past a threshold is blocked for a while (unless it is on the allowlist);
 * a blocked address gets 403 for everything. Administrators get an email when
 * an address is blocked, an account is being guessed at, someone becomes an
 * administrator, an administrator signs in from a new address, or payment
 * notifications arrive with a forged signature.
 *
 * This sees only what reaches this web server: attacks on SSH or other services
 * of the machine need the machine's own tools (a firewall, fail2ban).
 */

export const EVENT_KINDS = {
  /** Wrong username or password. */
  login_failed: { severity: "warn", points: 1 },
  /** A limit was hit (sign-ins, links, sign-ups, mail). */
  rate_limited: { severity: "warn", points: 2 },
  /** An invitation, reset, setup, confirmation or enrollment code that does not exist. */
  bad_token: { severity: "warn", points: 1 },
  /** A state-changing request without the site's own header, or from another origin. */
  csrf: { severity: "warn", points: 1 },
  /** A path only vulnerability scanners ask for (/wp-login.php, /.env…). */
  probe: { severity: "warn", points: 2 },
  /** A worker API call with a wrong token. */
  worker_auth: { severity: "warn", points: 2 },
  /** A payment notification whose signature does not check out: someone trying to fake a payment. */
  payment_signature: { severity: "high", points: 10 },
  /** A request naming another host (the bare IP address): mostly internet-wide scanning. */
  wrong_host: { severity: "info", points: 0 },
  /** A request from a blocked address. */
  blocked: { severity: "info", points: 0 },
  /** Account changes worth a trail: password changed, administrator granted, account disabled. */
  account: { severity: "info", points: 0 },
  /** An administrator signed in from an address not seen for that account before. */
  admin_new_ip: { severity: "info", points: 0 },
} as const;
export type EventKind = keyof typeof EVENT_KINDS;

/** Points within WINDOW that block an address: 30 wrong passwords, or 15 scanner probes, or 3 forged payments. */
const BLOCK_POINTS = 30;
const WINDOW_MS = 15 * 60 * 1000;
/** Wrong passwords for one account within WINDOW, from any addresses, that mean it is being guessed at. */
const ACCOUNT_ATTACK = 10;
const RETENTION_MS = 90 * 24 * 3600 * 1000;

// ------------------------------------------------------------------ settings

const KEY = "security";
export const securitySettingsSchema = z.object({
  /** Block addresses whose events pass the threshold. */
  autoBlock: z.boolean(),
  blockMinutes: z.number().int().min(5).max(30 * 24 * 60),
  /** Addresses (or CIDR ranges) never blocked: the office, a monitoring service. */
  allowlist: z.array(z.string().trim().min(1).max(64)).max(50),
  /** Email alerts; recipients, or empty for the administrators' confirmed addresses. */
  alerts: z.boolean(),
  alertEmails: z.array(z.email().max(254)).max(10),
});
export type SecuritySettings = z.infer<typeof securitySettingsSchema>;

export function defaultSecuritySettings(): SecuritySettings {
  return { autoBlock: true, blockMinutes: 60, allowlist: [], alerts: true, alertEmails: [] };
}

let settingsCache: SecuritySettings | null = null;
export function securitySettings(): SecuritySettings {
  if (settingsCache) return settingsCache;
  const saved = parseJson<Partial<SecuritySettings> | null>(readSetting(KEY), null);
  const ok = securitySettingsSchema.safeParse({ ...defaultSecuritySettings(), ...(saved ?? {}) });
  settingsCache = ok.success ? ok.data : defaultSecuritySettings();
  return settingsCache;
}

export function saveSecuritySettings(s: SecuritySettings, userId: string) {
  for (const entry of s.allowlist) if (!parseRange(entry)) throw new Error(`"${entry}" is not an IP address or range.`);
  writeSetting(KEY, s, userId);
  settingsCache = null;
}

export function securitySettingsMeta() {
  return settingMeta(KEY);
}

// ---------------------------------------------------------------- addresses

/** "::ffff:1.2.3.4" → "1.2.3.4"; anything else as it is, lower-cased. */
export function normalizeIp(ip: string): string {
  const a = ip.trim().toLowerCase();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  return m ? m[1]! : a;
}

function ipToBigInt(ip: string): { v: 4 | 6; n: bigint } | null {
  const kind = isIP(ip);
  if (kind === 4) return { v: 4, n: ip.split(".").reduce((acc, p) => (acc << 8n) | BigInt(Number(p)), 0n) };
  if (kind !== 6) return null;
  let [head, tail] = ip.includes("::") ? ip.split("::") : [ip, ""];
  // An embedded IPv4 tail ("::ffff:1.2.3.4") as two groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(tail || head!);
  const toGroups = (s: string) => (s ? s.split(":") : []);
  let h = toGroups(head!);
  let t = toGroups(tail!);
  if (v4) {
    const parts = v4[1]!.split(".").map(Number);
    const groups = [((parts[0]! << 8) | parts[1]!).toString(16), ((parts[2]! << 8) | parts[3]!).toString(16)];
    if (tail) t = [...t.slice(0, -1), ...groups];
    else h = [...h.slice(0, -1), ...groups];
  }
  const fill = ip.includes("::") ? 8 - h.length - t.length : 0;
  const all = [...h, ...Array(fill).fill("0"), ...t];
  if (all.length !== 8) return null;
  return { v: 6, n: all.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || "0", 16)), 0n) };
}

/** "10.0.0.0/8", "2001:db8::/32" or a single address, as a range; null when not one. */
function parseRange(entry: string): { v: 4 | 6; base: bigint; bits: number } | null {
  const [addr, len] = entry.trim().toLowerCase().split("/");
  const ip = ipToBigInt(normalizeIp(addr ?? ""));
  if (!ip) return null;
  const max = ip.v === 4 ? 32 : 128;
  const bits = len === undefined ? max : Number(len);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  const shift = BigInt(max - bits);
  return { v: ip.v, base: (ip.n >> shift) << shift, bits };
}

export function inRange(ip: string, entry: string): boolean {
  const range = parseRange(entry);
  const addr = ipToBigInt(normalizeIp(ip));
  if (!range || !addr || range.v !== addr.v) return false;
  const shift = BigInt((addr.v === 4 ? 32 : 128) - range.bits);
  return (addr.n >> shift) << shift === range.base;
}

/** Programs on this machine (workers, health checks) and unknown sources are never blocked. */
function neverBlocked(ip: string): boolean {
  const a = normalizeIp(ip);
  if (a === "unknown" || a === "::1" || a.startsWith("127.")) return true;
  return securitySettings().allowlist.some((e) => inRange(a, e));
}

// ------------------------------------------------------------------- blocks

interface BlockRow {
  ip: string;
  reason: string;
  auto: number;
  created_at: number;
  expires_at: number | null;
  created_by: string | null;
}

/** Address → when its block ends (null: until removed). Read on every request, so kept in memory. */
let blocks: Map<string, number | null> | null = null;
function loadBlocks(): Map<string, number | null> {
  if (!blocks) {
    blocks = new Map(
      db
        .query<BlockRow, { t: number }>("SELECT * FROM ip_blocks WHERE expires_at IS NULL OR expires_at > $t")
        .all({ t: now() })
        .map((b) => [b.ip, b.expires_at]),
    );
  }
  return blocks;
}

export function isBlocked(ip: string): boolean {
  const map = loadBlocks();
  if (map.size === 0) return false;
  const a = normalizeIp(ip);
  if (!map.has(a)) return false;
  const until = map.get(a);
  if (until != null && until <= now()) {
    map.delete(a);
    return false;
  }
  return !neverBlocked(a);
}

export function blockIp(ip: string, input: { reason: string; minutes: number | null; auto: boolean; by: string | null }): void {
  const a = normalizeIp(ip);
  const t = now();
  const expires = input.minutes == null ? null : t + input.minutes * 60_000;
  db.query(
    `INSERT INTO ip_blocks (ip, reason, auto, created_at, expires_at, created_by) VALUES ($ip, $r, $auto, $t, $x, $by)
     ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, auto = excluded.auto, created_at = excluded.created_at,
       expires_at = excluded.expires_at, created_by = excluded.created_by`,
  ).run({ ip: a, r: input.reason.slice(0, 300), auto: input.auto ? 1 : 0, t, x: expires, by: input.by });
  loadBlocks().set(a, expires);
}

export function unblockIp(ip: string): boolean {
  const a = normalizeIp(ip);
  loadBlocks().delete(a);
  return db.query("DELETE FROM ip_blocks WHERE ip = $ip").run({ ip: a }).changes > 0;
}

export function activeBlocks() {
  return db
    .query<BlockRow & { by_name: string | null }, { t: number }>(
      `SELECT b.*, u.display_name AS by_name FROM ip_blocks b LEFT JOIN users u ON u.id = b.created_by
       WHERE b.expires_at IS NULL OR b.expires_at > $t ORDER BY b.created_at DESC`,
    )
    .all({ t: now() })
    .map((b) => ({ ip: b.ip, reason: b.reason, auto: !!b.auto, createdAt: b.created_at, expiresAt: b.expires_at, createdBy: b.by_name }));
}

// ------------------------------------------------------------------- events

export interface EventInput {
  ip: string;
  /** The account a sign-in tried, or the one changed. */
  username?: string | null;
  userId?: string | null;
  /** The path asked for, or what changed. */
  detail?: string | null;
}

/** Record an event; may block its address and send an alert. Never throws (monitoring must not break requests). */
export function recordEvent(kind: EventKind, input: EventInput): void {
  try {
    const t = now();
    const ip = normalizeIp(input.ip || "unknown");
    const username = (input.username ?? "").slice(0, 64).toLowerCase();
    db.query(
      `INSERT INTO security_events (kind, severity, ip, username, user_id, detail, count, first_at, last_at, bucket)
       VALUES ($k, $s, $ip, $u, $uid, $d, 1, $t, $t, $b)
       ON CONFLICT(kind, ip, username, bucket) DO UPDATE SET count = count + 1, last_at = excluded.last_at,
         detail = COALESCE(excluded.detail, detail), user_id = COALESCE(excluded.user_id, user_id)`,
    ).run({ k: kind, s: EVENT_KINDS[kind].severity, ip, u: username, uid: input.userId ?? null, d: input.detail?.slice(0, 300) ?? null, t, b: Math.floor(t / 60_000) });
    react(kind, ip, username, input);
  } catch (e) {
    console.error("[security] could not record an event:", e);
  }
}

function react(kind: EventKind, ip: string, username: string, input: EventInput) {
  const s = securitySettings();
  const since = now() - WINDOW_MS;
  if (EVENT_KINDS[kind].points > 0 && s.autoBlock && !neverBlocked(ip) && !isBlocked(ip)) {
    const rows = db
      .query<{ kind: EventKind; n: number }, { ip: string; since: number }>(
        "SELECT kind, SUM(count) AS n FROM security_events WHERE ip = $ip AND last_at >= $since GROUP BY kind",
      )
      .all({ ip, since });
    const points = rows.reduce((sum, r) => sum + (EVENT_KINDS[r.kind]?.points ?? 0) * r.n, 0);
    if (points >= BLOCK_POINTS) {
      const counted = rows.filter((r) => EVENT_KINDS[r.kind]?.points);
      const what = counted.map((r) => `${r.n} ${r.kind.replace("_", " ")}`).join(", ");
      // "auto:login_failed=8,rate_limited=11": the admin page words it in the reader's language.
      blockIp(ip, { reason: `auto:${counted.map((r) => `${r.kind}=${r.n}`).join(",")}`, minutes: s.blockMinutes, auto: true, by: null });
      console.warn(`[security] blocked ${ip} for ${s.blockMinutes} min (${what})`);
      alert(`block:${ip}`, {
        subject: `Blocked ${ip}`,
        zh: `已封鎖 ${ip}`,
        body: `The address ${ip} was blocked for ${s.blockMinutes} minutes after ${what} in 15 minutes.`,
        bodyZh: `${ip} 在 15 分鐘內出現 ${what}，已自動封鎖 ${s.blockMinutes} 分鐘。`,
      });
    }
  }
  if ((kind === "login_failed" || kind === "rate_limited") && username) {
    // Refused attempts count too: after 8 wrong passwords an account's sign-ins are refused for a while.
    const n =
      db
        .query<{ n: number | null }, { u: string; since: number }>(
          "SELECT SUM(count) AS n FROM security_events WHERE kind IN ('login_failed', 'rate_limited') AND username = $u AND last_at >= $since",
        )
        .get({ u: username, since })?.n ?? 0;
    if (n >= ACCOUNT_ATTACK) {
      alert(`account:${username}`, {
        subject: `Repeated wrong passwords for "${username}"`,
        zh: `帳號「${username}」密碼連續輸入錯誤`,
        body: `${n} wrong passwords for the account "${username}" in 15 minutes (the latest from ${ip}). Sign-ins for it are being slowed down. Make sure its owner uses a long password.`,
        bodyZh: `帳號「${username}」在 15 分鐘內有 ${n} 次密碼錯誤（最近一次來自 ${ip}），系統已減緩這個帳號的登入嘗試。請提醒帳號擁有者使用夠長的密碼。`,
      });
    }
  }
  if (kind === "payment_signature") {
    alert(`payment:${ip}`, {
      subject: `Forged payment notification from ${ip}`,
      zh: `收到偽造的付款通知（${ip}）`,
      body: `A payment notification from ${ip} did not carry ECPay's signature and was refused. No minutes were added. ${input.detail ?? ""}`,
      bodyZh: `來自 ${ip} 的付款通知沒有綠界的有效簽章，已拒絕，沒有加值任何分鐘數。${input.detail ?? ""}`,
    });
  }
  if (kind === "account" && input.detail?.startsWith("admin granted")) {
    alert(`admin:${username}:${now()}`, {
      subject: `"${username}" is now an administrator`,
      zh: `「${username}」成為管理員`,
      body: `${input.detail} (from ${ip}).`,
      bodyZh: `${input.detail}（來自 ${ip}）。`,
    });
  }
  if (kind === "admin_new_ip") {
    alert(`adminip:${username}:${ip}`, {
      subject: `Administrator "${username}" signed in from a new address`,
      zh: `管理員「${username}」從新的位址登入`,
      body: `The administrator account "${username}" signed in from ${ip}, an address it has not used before. If that was not them, change its password and sign out its other sessions.`,
      bodyZh: `管理員帳號「${username}」從 ${ip} 登入，這是它以前沒用過的位址。如果不是本人，請立即更改密碼並登出其他裝置。`,
    });
  }
}

/** Whether `userId` has signed in from `ip` before (sessions and earlier events). */
export function knownAddress(userId: string, ip: string): boolean {
  const a = normalizeIp(ip);
  const session = db.query<{ n: number }, { u: string; ip: string }>("SELECT COUNT(*) AS n FROM sessions WHERE user_id = $u AND ip = $ip").get({ u: userId, ip: a })!.n;
  if (session > 0) return true;
  const seen = db
    .query<{ n: number }, { u: string; ip: string }>("SELECT COUNT(*) AS n FROM security_events WHERE kind IN ('admin_new_ip', 'account') AND user_id = $u AND ip = $ip")
    .get({ u: userId, ip: a })!.n;
  return seen > 0;
}

// ------------------------------------------------------------------- alerts

/** Alert key → when it was last sent: the same thing is mailed at most once an hour. */
const lastAlert = new Map<string, number>();
export const sentAlerts: { subject: string; to: string[] }[] = [];

function alertRecipients(): string[] {
  const s = securitySettings();
  if (s.alertEmails.length) return s.alertEmails;
  return db
    .query<{ email: string }, []>("SELECT email FROM users WHERE role = 'admin' AND disabled = 0 AND email IS NOT NULL AND email_verified_at IS NOT NULL")
    .all()
    .map((r) => r.email);
}

function alert(key: string, msg: { subject: string; zh: string; body: string; bodyZh: string }) {
  const s = securitySettings();
  if (!s.alerts || !mailConfigured()) return;
  const t = now();
  if ((lastAlert.get(key) ?? 0) > t - 3600_000) return;
  lastAlert.set(key, t);
  if (lastAlert.size > 5000) lastAlert.clear();
  const to = alertRecipients();
  if (!to.length) return;
  const url = config.publicUrl ? `${config.publicUrl}/admin?tab=security` : null;
  const link = url ? `\n\n${url}` : "";
  for (const addr of to) {
    sendMailLater({
      to: addr,
      subject: `[Minutes] ${msg.zh} / ${msg.subject}`,
      text: `${msg.bodyZh}\n\n${msg.body}${link}`,
      links: url ? [url] : [],
    });
  }
  sentAlerts.push({ subject: msg.subject, to });
  if (sentAlerts.length > 100) sentAlerts.shift();
}

// ---------------------------------------------------------------- dashboard

/** What the admin page shows: totals, a day-by-day count, the busiest addresses, recent events. */
export function securityOverview(days = 14) {
  const t = now();
  const since = t - days * 24 * 3600_000;
  const hostile = Object.entries(EVENT_KINDS)
    .filter(([, k]) => k.points > 0)
    .map(([name]) => `'${name}'`)
    .join(",");
  const last24 = db
    .query<{ kind: EventKind; n: number; ips: number }, { s: number }>(
      "SELECT kind, SUM(count) AS n, COUNT(DISTINCT ip) AS ips FROM security_events WHERE last_at >= $s GROUP BY kind",
    )
    .all({ s: t - 24 * 3600_000 });
  // Days in Taiwan time, oldest first, with each kind's count.
  const daily = db
    .query<{ day: number; kind: EventKind; n: number }, { s: number }>(
      `SELECT CAST((last_at + 8 * 3600000) / 86400000 AS INTEGER) AS day, kind, SUM(count) AS n
       FROM security_events WHERE last_at >= $s AND kind IN (${hostile}) GROUP BY day, kind`,
    )
    .all({ s: since });
  const today = Math.floor((t + 8 * 3600_000) / 86_400_000);
  const series = Array.from({ length: days }, (_, i) => {
    const day = today - (days - 1 - i);
    const kinds: Record<string, number> = {};
    for (const r of daily) if (r.day === day) kinds[r.kind] = r.n;
    // Noon of that day in Taiwan: the same calendar date in any browser's time zone.
    return { date: day * 86_400_000 + 4 * 3600_000, total: Object.values(kinds).reduce((a, b) => a + b, 0), kinds };
  });
  const topIps = db
    .query<{ ip: string; n: number; kinds: string; last: number; usernames: string }, { s: number }>(
      `SELECT ip, SUM(count) AS n, GROUP_CONCAT(DISTINCT kind) AS kinds, MAX(last_at) AS last, GROUP_CONCAT(DISTINCT NULLIF(username, '')) AS usernames
       FROM security_events WHERE last_at >= $s AND kind IN (${hostile}) GROUP BY ip ORDER BY n DESC LIMIT 15`,
    )
    .all({ s: t - 7 * 24 * 3600_000 })
    .map((r) => ({
      ip: r.ip,
      count: r.n,
      kinds: r.kinds.split(","),
      lastAt: r.last,
      usernames: r.usernames ? r.usernames.split(",").slice(0, 5) : [],
      blocked: isBlocked(r.ip),
    }));
  return {
    last24h: Object.fromEntries(last24.map((r) => [r.kind, { count: r.n, addresses: r.ips }])),
    daily: series,
    topIps,
    blocks: activeBlocks(),
  };
}

/**
 * Kinds that are background noise on any public server: requests naming another host
 * (internet-wide scanners trying the bare IP address) and requests from addresses
 * already blocked. Recorded and counted, but left out of the event list unless asked for.
 */
export const NOISE_KINDS: EventKind[] = ["wrong_host", "blocked"];

/** `noise`: include NOISE_KINDS (always, when one of them is asked for by `kind`). */
export function recentEvents(input: { kind?: string; ip?: string; limit?: number; noise?: boolean }) {
  const kind = input.kind ?? "";
  const hideNoise = !kind && !input.noise ? 1 : 0;
  return db
    .query<
      { id: number; kind: EventKind; severity: string; ip: string; username: string; detail: string | null; count: number; first_at: number; last_at: number },
      { k: string; ip: string; n: number; hide: number }
    >(
      `SELECT * FROM security_events WHERE ($k = '' OR kind = $k) AND ($ip = '' OR ip = $ip)
         AND NOT ($hide AND kind IN (${NOISE_KINDS.map((k) => `'${k}'`).join(",")}))
       ORDER BY last_at DESC LIMIT $n`,
    )
    .all({ k: kind, ip: input.ip ? normalizeIp(input.ip) : "", n: Math.min(500, input.limit ?? 100), hide: hideNoise })
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      severity: e.severity,
      ip: e.ip,
      username: e.username || null,
      detail: e.detail,
      count: e.count,
      firstAt: e.first_at,
      lastAt: e.last_at,
    }));
}

/** Noise requests in the last 24 hours (see NOISE_KINDS). */
export function noiseCount24h(): number {
  return (
    db
      .query<{ n: number | null }, { s: number }>(
        `SELECT SUM(count) AS n FROM security_events WHERE last_at >= $s AND kind IN (${NOISE_KINDS.map((k) => `'${k}'`).join(",")})`,
      )
      .get({ s: now() - 24 * 3600_000 })?.n ?? 0
  );
}

export function purgeSecurityEvents() {
  db.query("DELETE FROM security_events WHERE last_at < $c").run({ c: now() - RETENTION_MS });
  db.query("DELETE FROM ip_blocks WHERE expires_at IS NOT NULL AND expires_at < $t").run({ t: now() });
  blocks = null;
}

/** Recipients alerts would go to (for the admin page). */
export function publicAlertInfo() {
  return { mail: mailConfigured(), recipients: alertRecipients() };
}

// ------------------------------------------------------------------ probes

/** Paths that only vulnerability scanners ask this site for. */
const PROBE =
  /(^|\/)(wp-admin|wp-login\.php|wp-content|wp-includes|xmlrpc\.php|phpmyadmin|pma|myadmin|\.env(\.|$)|\.git|\.svn|\.hg|\.ds_store|\.aws|\.ssh|cgi-bin|vendor\/phpunit|boaform|hnap1|actuator|server-status|solr|jenkins|manager\/html|owa|autodiscover|ecp|remote\/login|geoserver|telescope|_ignition|config\.(php|json|yml|yaml)|web\.config|id_rsa|shell|eval-stdin\.php)(\/|$)|\.(php\d?|asp|aspx|jsp|cgi|pl|env|bak|sql|ini|old|swp)$/i;

export function isProbe(path: string): boolean {
  return PROBE.test(path);
}
