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
