import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { clientIp } from "../src/auth/middleware";
import { validateEmail } from "../src/auth/accounts";
import { config } from "../src/config";
import { db, now } from "../src/db";
import { redirectLocation } from "../src/redirect";
import { html } from "../src/services/mail";
import { ABANDONED_UPLOAD_MS, MAX_PENDING_UPLOADS, purgeAbandonedUploads } from "../src/services/meetings";
import { baseUrl, isForbiddenHost } from "../src/services/summarySettings";
import { wakeUrlSchema } from "../src/services/workerWake";
import { adminClient, app, memberClient } from "./helpers";

/** What Bun.serve passes as the second argument of fetch: the connection's address. */
const from = (address: string) => ({ requestIP: () => ({ address, family: address.includes(":") ? "IPv6" : "IPv4", port: 40000 }) });

const mutable = config as unknown as { trustProxy: boolean; trustedProxies: string[]; publicUrl: string; allowedHosts: string[] };
const saved = { ...mutable, trustedProxies: [...config.trustedProxies], allowedHosts: [...config.allowedHosts] };
afterAll(() => {
  Object.assign(mutable, saved);
});

describe("request sizes", () => {
  test("a signed-in person cannot make the server validate millions of array entries", async () => {
    const member = await memberClient("big-body");
    const ids = new Array(200_000).fill(0);
    const res = await member.post("/api/announcements/seen", { ids });
    expect(res.status).toBe(413);
  });

  test("payment notifications are read only so far, whatever length they declare (or none)", async () => {
    const chunk = new TextEncoder().encode("a=" + "x".repeat(8 * 1024));
    const body = new ReadableStream({
      start(ctrl) {
        // Chunked: no Content-Length to look at.
        for (let i = 0; i < 4; i++) ctrl.enqueue(chunk);
        ctrl.close();
      },
    });
    const res = await app.fetch(
      new Request("http://mm.test/api/billing/ecpay/notify", { method: "POST", headers: { host: "mm.test", "content-type": "application/x-www-form-urlencoded" }, body, duplex: "half" } as RequestInit),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toStartWith("0|");
  });

  test("a signature that is not hexadecimal is refused, not an error", async () => {
    const form = new URLSearchParams({ MerchantID: config.ecpay.merchantId, MerchantTradeNo: "MMx", RtnCode: "1", CheckMacValue: "é".repeat(64) }).toString();
    for (const path of ["notify", "result"]) {
      const res = await app.fetch(
        new Request(`http://mm.test/api/billing/ecpay/${path}`, { method: "POST", headers: { host: "mm.test", "content-type": "application/x-www-form-urlencoded" }, body: form }),
      );
      expect(res.status).toBeLessThan(500);
    }
  });
});

describe("the visitor's address", () => {
  const probe = new Hono();
  probe.get("/", (c) => c.text(clientIp(c)));
  const ask = async (peer: string, forwarded?: string) =>
    (await probe.fetch(new Request("http://mm.test/", { headers: forwarded ? { "x-forwarded-for": forwarded } : {} }), from(peer))).text();

  beforeAll(() => {
    mutable.trustProxy = true;
    mutable.trustedProxies = [];
  });

  test("is the last X-Forwarded-For entry, the one the proxy added; the client's own entries are ignored", async () => {
    expect(await ask("127.0.0.1", "6.6.6.6, 198.51.100.4")).toBe("198.51.100.4");
    expect(await ask("10.0.0.2", "198.51.100.5")).toBe("198.51.100.5");
    expect(await ask("::ffff:127.0.0.1", "2001:db8::7")).toBe("2001:db8::7");
  });

  test("is the connection's own when it does not come from the proxy, or the header is not an address", async () => {
    expect(await ask("203.0.113.5", "1.2.3.4")).toBe("203.0.113.5");
    expect(await ask("127.0.0.1", "not-an-address")).toBe("127.0.0.1");
    expect(await ask("::ffff:203.0.113.6")).toBe("203.0.113.6");
    mutable.trustedProxies = ["203.0.113.5"];
    expect(await ask("203.0.113.5", "1.2.3.4")).toBe("1.2.3.4");
    mutable.trustedProxies = [];
    mutable.trustProxy = false;
    expect(await ask("127.0.0.1", "1.2.3.4")).toBe("127.0.0.1");
    mutable.trustProxy = true;
  });
});

describe("links in email", () => {
  test("without PUBLIC_URL, a site that answers to any name sends none (the Host header is the sender's)", async () => {
    mutable.publicUrl = "";
    mutable.allowedHosts = [];
    const state = (await (await app.fetch(new Request("http://mm.test/api/auth/state", { headers: { host: "evil.example" } }))).json()) as any;
    expect(state.passwordReset).toBe(false);
    const res = await app.fetch(
      new Request("http://evil.example/api/auth/forgot-password", {
        method: "POST",
        headers: { host: "evil.example", "content-type": "application/json", "x-mm-client": "1" },
        body: JSON.stringify({ email: "someone@example.com" }),
      }),
    );
    expect(res.status).toBe(503);
    // Limited to its own names, the address a request came to is the site's.
    mutable.allowedHosts = ["mm.test"];
    const ok = (await (await app.fetch(new Request("http://mm.test/api/auth/state", { headers: { host: "mm.test" } }))).json()) as any;
    expect(ok.passwordReset).toBe(true);
    Object.assign(mutable, { publicUrl: saved.publicUrl, allowedHosts: [...saved.allowedHosts] });
  });

  test("only the site's own links are clickable; text someone typed stays text", () => {
    const out = html("Hello http://evil.example/login now\n\nhttps://minutes.example.com/verify-email/abc", ["https://minutes.example.com/verify-email/abc"]);
    expect(out).toContain('<a href="https://minutes.example.com/verify-email/abc">');
    expect(out).not.toContain('href="http://evil.example');
    expect(out.match(/<a /g)).toHaveLength(1);
    // Not inside a longer address that merely starts the same way.
    expect(html("https://minutes.example.com/a.evil", ["https://minutes.example.com/a"])).not.toContain("<a ");
  });

  test("addresses are plain mailboxes, so one mailbox cannot pass as many", () => {
    for (const ok of ["amy@example.com", "a.b+tag@mail.example.co.uk", "x@xn--fiqs8s.xn--kpry57d"]) expect(validateEmail(ok)).toBeNull();
    for (const bad of ["a<victim@example.com>", '"a b"@example.com', "victim@example.com,b@c.de", "a@b", "a@-x.com", "a b@example.com"]) {
      expect(validateEmail(bad)).not.toBeNull();
    }
  });
});

describe("redirects", () => {
  test("a path that starts with // stays on the site", () => {
    const req = (path: string) => new Request(`http://minutes.example.com${path}`);
    expect(redirectLocation("https://minutes.example.com", req("//evil.example/login"))).toBe("https://minutes.example.com/evil.example/login");
    expect(redirectLocation("https://minutes.example.com", req("/%5Cevil.example"))).toStartWith("https://minutes.example.com/");
    expect(redirectLocation("https://minutes.example.com/", req("/m/abc?x=1"))).toBe("https://minutes.example.com/m/abc?x=1");
  });
});

describe("addresses administrators set", () => {
  test("never the cloud metadata service or link-local addresses", () => {
    for (const bad of ["http://169.254.169.254/latest", "https://[fe80::1]/", "http://metadata.google.internal/", "http://0.0.0.0:11434", "http://[::ffff:169.254.169.254]/"]) {
      expect(isForbiddenHost(bad)).toBe(true);
      expect(baseUrl.safeParse(bad).success).toBe(false);
    }
    expect(isForbiddenHost("https://api.openai.com/v1")).toBe(false);
    expect(baseUrl.safeParse("http://127.0.0.1:11434").success).toBe(true);
  });

  test("a wake-up address is https on another machine", () => {
    expect(wakeUrlSchema.safeParse("https://me--meetingminutes-worker-wake.modal.run").success).toBe(true);
    for (const bad of ["https://127.0.0.1:11434/api/pull", "https://localhost/x", "https://169.254.169.254/", "https://user:pw@x.modal.run/", "http://x.modal.run/"]) {
      expect(wakeUrlSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("the shared worker token", () => {
  const heartbeat = (env?: object, headers: Record<string, string> = {}) =>
    app.fetch(
      new Request("http://mm.test/internal/worker/heartbeat", {
        method: "POST",
        headers: { host: "mm.test", authorization: "Bearer test-worker-token", "content-type": "application/json", ...headers },
        body: JSON.stringify({ workerId: "server-gpu0" }),
      }),
      env,
    );

  test("works only on a direct connection from this machine", async () => {
    expect((await heartbeat(from("127.0.0.1"))).status).toBe(200);
    expect((await heartbeat(from("203.0.113.9"))).status).toBe(401);
    // Through the proxy (which adds X-Forwarded-For), even though the proxy is on this machine.
    expect((await heartbeat(from("127.0.0.1"), { "x-forwarded-for": "203.0.113.9" })).status).toBe(401);
  });
});

describe("announcements", () => {
  test("a member cannot mark one for administrators, or a scheduled one, as seen", async () => {
    const admin = await adminClient();
    const mk = async (extra: object) =>
      ((await (await admin.post("/api/admin/announcements", { title: "Internal", body: "", level: "info", ...extra })).json()) as any).id as string;
    const adminsOnly = await mk({ audience: "admins" });
    const later = await mk({ audience: "users", startsAt: now() + 86_400_000 });
    const member = await memberClient("seen-probe");
    const me = ((await (await member.get("/api/me")).json()) as any).user;
    expect((await member.post("/api/announcements/seen", { ids: [adminsOnly, later] })).status).toBe(200);
    const rows = db.query<{ n: number }, { u: string }>("SELECT COUNT(*) AS n FROM announcement_seen WHERE user_id = $u").get({ u: me.id })!.n;
    expect(rows).toBe(0);
    await admin.del(`/api/admin/announcements/${adminsOnly}`);
    await admin.del(`/api/admin/announcements/${later}`);
  });
});

describe("unfinished uploads", () => {
  test("a few at a time per person, and those left for a day are removed", async () => {
    const member = await memberClient("pending-uploads");
    const create = () => member.post("/api/meetings", { title: "Never sent", file: { name: "a.m4a", size: 1024 * 1024, type: "audio/mp4" } });
    for (let i = 0; i < MAX_PENDING_UPLOADS; i++) expect((await create()).status).toBe(201);
    const refused = await create();
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as any).code).toBe("too_many_uploads");
    const me = ((await (await member.get("/api/me")).json()) as any).user;
    db.query("UPDATE meetings SET updated_at = $t WHERE owner_id = $u AND status = 'uploading'").run({ u: me.id, t: now() - ABANDONED_UPLOAD_MS - 1000 });
    expect(await purgeAbandonedUploads()).toBeGreaterThanOrEqual(MAX_PENDING_UPLOADS);
    expect((await create()).status).toBe(201);
  });
});
