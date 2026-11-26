import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { config } from "../src/config";
import { db } from "../src/db";
import { inRange, isProbe, normalizeIp, sentAlerts, unblockIp } from "../src/services/security";
import { adminClient, app } from "./helpers";

// Requests here come from addresses given in X-Forwarded-For (tests have no real socket).
const mutable = config as { trustProxy: boolean };
const before = mutable.trustProxy;
beforeAll(() => {
  mutable.trustProxy = true;
});
afterAll(() => {
  mutable.trustProxy = before;
});

function from(ip: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", "mm.test");
  headers.set("x-forwarded-for", ip);
  return app.fetch(new Request("http://mm.test" + path, { ...init, headers }));
}

const login = (ip: string, username: string, password = "wrong password!") =>
  from(ip, "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-mm-client": "1" }, body: JSON.stringify({ username, password }) });

const events = (ip: string) =>
  db.query<{ kind: string; n: number }, { ip: string }>("SELECT kind, SUM(count) AS n FROM security_events WHERE ip = $ip GROUP BY kind").all({ ip });

describe("addresses", () => {
  test("ranges and normal forms", () => {
    expect(normalizeIp("::FFFF:203.0.113.9")).toBe("203.0.113.9");
    expect(inRange("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(inRange("11.1.2.3", "10.0.0.0/8")).toBe(false);
    expect(inRange("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(inRange("2001:db9::1", "2001:db8::/32")).toBe(false);
    expect(inRange("203.0.113.9", "203.0.113.9")).toBe(true);
    expect(inRange("203.0.113.9", "2001:db8::/32")).toBe(false);
  });

  test("scanner paths", () => {
    for (const p of ["/wp-login.php", "/.env", "/.git/config", "/phpmyadmin/", "/vendor/phpunit/x", "/cgi-bin/luci", "/index.php"]) expect(isProbe(p)).toBe(true);
    for (const p of ["/", "/m/abc123", "/admin", "/billing", "/assets/index-abc.js", "/invite/tok", "/verify-email/x"]) expect(isProbe(p)).toBe(false);
  });
});

describe("security monitor", () => {
  test("counts wrong passwords per address and account, and blocks an address that keeps guessing", async () => {
    const ip = "203.0.113.10";
    // 20 wrong passwords (1 point each), then refusals for too many (2 points each): blocked at 30 points.
    let attempts = 0;
    while ((await from(ip, "/api/auth/state")).status === 200 && attempts < 40) {
      const status = (await login(ip, `victim${attempts}`)).status;
      expect(status).toBe(attempts < 20 ? 401 : 429);
      attempts++;
    }
    expect(attempts).toBe(25);
    expect(events(ip).filter((e) => e.kind !== "blocked").sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { kind: "login_failed", n: 20 },
      { kind: "rate_limited", n: 5 },
    ]);
    const res = await from(ip, "/api/auth/state");
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden.\n");
    // Others are not affected.
    expect((await from("203.0.113.11", "/api/auth/state")).status).toBe(200);
    const admin = await adminClient();
    const overview = (await (await admin.get("/api/admin/security")).json()) as any;
    expect(overview.blocks.find((b: any) => b.ip === ip)).toMatchObject({ auto: true });
    expect(overview.topIps[0]).toMatchObject({ ip, count: 25, blocked: true });
    expect(overview.topIps[0].usernames).toHaveLength(5);
    expect(overview.last24h.login_failed.count).toBeGreaterThanOrEqual(20);
    // A blocked address's requests are counted, not stored one by one.
    await from(ip, "/");
    await from(ip, "/login");
    // (the loop's last check, the one above, and these two)
    expect(events(ip).find((e) => e.kind === "blocked")?.n).toBe(4);
    // Unblocked by an administrator.
    expect((await admin.del(`/api/admin/security/blocks/${encodeURIComponent(ip)}`)).status).toBe(200);
    expect((await from(ip, "/api/auth/state")).status).toBe(200);
  });

  test("scanner probes get a plain 404 and add up faster", async () => {
    const ip = "198.51.100.7";
    const res = await from(ip, "/wp-login.php");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found.");
    for (const p of ["/.env", "/.git/config", "/phpmyadmin/", "/xmlrpc.php", "/vendor/phpunit/src/Util/PHP/eval-stdin.php"]) await from(ip, p);
    expect(events(ip)).toEqual([{ kind: "probe", n: 6 }]);
    for (let i = 0; i < 9; i++) await from(ip, `/old${i}.php`);
    expect((await from(ip, "/")).status).toBe(403);
    unblockIp(ip);
  });

  test("CSRF attempts, bad links and wrong hosts are recorded; addresses on the allowlist are never blocked", async () => {
    const admin = await adminClient();
    const ip = "192.0.2.50";
    await from(ip, "/api/auth/logout", { method: "POST" });
    await from(ip, "/api/auth/invites/not-a-real-token");
    await from(ip, "/api/auth/state", { headers: { host: "203.0.113.200" } });
    const kinds = events(ip).map((e) => e.kind).sort();
    expect(kinds).toEqual(["bad_token", "csrf"]);

    const s = (await (await admin.get("/api/admin/security")).json()) as any;
    expect((await admin.req("PUT", "/api/admin/security", { json: { ...s.settings, allowlist: ["not an address"] } })).status).toBe(422);
    expect((await admin.req("PUT", "/api/admin/security", { json: { ...s.settings, allowlist: ["192.0.2.0/24"] } })).status).toBe(200);
    for (let i = 0; i < 35; i++) await login(ip, "someone");
    expect((await from(ip, "/api/auth/state")).status).toBe(200);
    await admin.req("PUT", "/api/admin/security", { json: { ...s.settings, allowlist: [] } });
  });

  test("an account guessed at from many addresses raises an alert", async () => {
    const admin = await adminClient();
    // Alerts go to the administrators' confirmed addresses.
    db.query("UPDATE users SET email = 'admin@example.com', email_verified_at = 1 WHERE username = 'admin'").run();
    for (let i = 0; i < 10; i++) await login(`100.64.0.${i + 1}`, "ceo");
    expect(sentAlerts.some((a) => a.subject.includes('wrong passwords for "ceo"') && a.to.includes("admin@example.com"))).toBe(true);
    // None of the addresses was blocked: one wrong password each.
    expect((await from("100.64.0.1", "/api/auth/state")).status).toBe(200);
    const recent = (await (await admin.get("/api/admin/security/events?kind=login_failed&limit=5")).json()) as any;
    expect(recent.events[0]).toMatchObject({ kind: "login_failed", username: "ceo" });
  });

  test("administrators can block by hand, but not their own address", async () => {
    const admin = await adminClient();
    expect((await admin.post("/api/admin/security/blocks", { ip: "not-ip", minutes: 60 })).status).toBe(422);
    expect((await admin.post("/api/admin/security/blocks", { ip: "unknown", minutes: 60 })).status).toBe(422);
    expect((await admin.post("/api/admin/security/blocks", { ip: "203.0.113.77", minutes: null, reason: "Abuse" })).status).toBe(200);
    expect((await from("203.0.113.77", "/")).status).toBe(403);
    const s = (await (await admin.get("/api/admin/security")).json()) as any;
    expect(s.blocks.find((b: any) => b.ip === "203.0.113.77")).toMatchObject({ auto: false, expiresAt: null, reason: "Abuse" });
    unblockIp("203.0.113.77");
  });

  test("forged payment notifications are recorded as serious", async () => {
    const ip = "203.0.113.99";
    const form = new URLSearchParams({ MerchantID: "3002607", MerchantTradeNo: "MMFAKE", RtnCode: "1", TradeAmt: "1", CheckMacValue: "A".repeat(64) }).toString();
    const res = await from(ip, "/api/billing/ecpay/notify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
    expect(res.status).toBe(400);
    expect(events(ip)).toEqual([{ kind: "payment_signature", n: 1 }]);
  });
});
