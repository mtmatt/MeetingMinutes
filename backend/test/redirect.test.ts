import { describe, expect, test } from "bun:test";
import { bindHelp, redirectHandler, redirectLocation } from "../src/redirect";

const PUBLIC = "https://minutes.example.com";
const seen: string[] = [];
const app = { fetch: (req: Request) => (seen.push(new URL(req.url).pathname), new Response("worker api")) };

function on(serveWorkerApi: boolean) {
  return redirectHandler({ serveWorkerApi, app, publicUrl: PUBLIC, allowedHosts: ["minutes.example.com"] });
}

const req = (url: string, init: RequestInit & { host?: string } = {}) =>
  new Request(url, { ...init, headers: { host: init.host ?? new URL(url).host, ...(init.headers as Record<string, string>) } });

describe("ports that send people to the site's address", () => {
  test("the old HTTPS port redirects pages, keeping the path and query", async () => {
    const res = await on(true)(req("https://minutes.example.com:8443/m/abc?t=12.5"), null);
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://minutes.example.com/m/abc?t=12.5");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(redirectLocation(PUBLIC + "/", req("https://minutes.example.com:8443/"))).toBe("https://minutes.example.com/");
  });

  test("the worker API is still answered there, so enrolled workers keep working", async () => {
    const res = await on(true)(req("https://minutes.example.com:8443/internal/jobs/claim", { method: "POST", body: "{}" }), null);
    expect(await res.text()).toBe("worker api");
    expect(seen).toContain("/internal/jobs/claim");
  });

  test("plain HTTP redirects everything, the worker API included", async () => {
    const res = await on(false)(req("http://minutes.example.com/internal/jobs/claim", { method: "POST", body: "{}" }), null);
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://minutes.example.com/internal/jobs/claim");
  });

  test("another host name (the bare IP address) is refused, as on the main port", async () => {
    const res = await on(true)(req("https://203.0.113.10:8443/", { host: "203.0.113.10:8443" }), null);
    expect(res.status).toBe(421);
    expect((await on(false)(req("http://scanner.example.net/"), null)).status).toBe(421);
  });

  test("a port that cannot be opened says what to do", () => {
    const denied = Object.assign(new Error("listen EACCES: permission denied 0.0.0.0:443"), { code: "EACCES" });
    expect(bindHelp(443, denied)).toContain("net.ipv4.ip_unprivileged_port_start=443");
    expect(bindHelp(443, Object.assign(new Error("in use"), { code: "EADDRINUSE" }))).toContain("already in use");
  });
});

describe("the old port while the site moves (handoff)", () => {
  const { handoffHandler } = require("../src/redirect");
  const handoff = handoffHandler({ app, publicUrl: PUBLIC, allowedHosts: ["minutes.example.com"] });
  const page = (path: string, headers: Record<string, string> = {}) =>
    handoff(req(`https://minutes.example.com:8443${path}`, { headers: { accept: "text/html", ...headers } }), null);

  test("a page gets a tiny page whose inline script, allowed by its hash alone, decides where to go", async () => {
    const res = await page("/m/abc?t=3");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('var target = "https://minutes.example.com"');
    expect(html).toContain('indexedDB.open("mm-recordings")');
    expect(html.length).toBeLessThan(4000);
    const csp = res.headers.get("content-security-policy")!;
    const script = html.split("<script>")[1]!.split("</script>")[0]!;
    const hash = new Bun.CryptoHasher("sha256").update(script).digest("base64");
    expect(csp).toContain(`script-src 'sha256-${hash}'`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("with recordings left (the cookie its script sets), the site itself is served", async () => {
    seen.length = 0;
    await page("/new", { cookie: "mm_session=x; mm_handoff=stay" });
    expect(seen).toEqual(["/new"]);
  });

  test("the API, assets, files and the worker API are the site's, as on the main port", async () => {
    seen.length = 0;
    for (const p of ["/api/auth/state", "/assets/index-abc.js", "/favicon.svg", "/internal/jobs/claim"]) await page(p);
    expect(seen).toEqual(["/api/auth/state", "/assets/index-abc.js", "/favicon.svg", "/internal/jobs/claim"]);
  });

  test("another host name is passed to the site, whose own check refuses it", async () => {
    seen.length = 0;
    await handoff(req("https://203.0.113.10:8443/", { host: "203.0.113.10:8443", headers: { accept: "text/html" } }), null);
    expect(seen).toEqual(["/"]);
  });
});
