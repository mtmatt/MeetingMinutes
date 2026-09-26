import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Runs the real server process with built-in HTTPS, as on a machine without a
// reverse proxy: HTTPS on PORT, the worker API on a loopback-only HTTP port.
const hasOpenssl = Bun.spawnSync(["openssl", "version"]).exitCode === 0;

describe.skipIf(!hasOpenssl)("built-in HTTPS", () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-tls-"));
  const cert = join(dir, "server.crt");
  const key = join(dir, "server.key");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const internalPort = port + 1;
  let proc: ReturnType<typeof Bun.spawn>;
  let ca: string;

  beforeAll(async () => {
    const made = Bun.spawnSync([
      "openssl", "req", "-x509", "-nodes", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
      "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1",
    ]);
    expect(made.exitCode).toBe(0);
    ca = readFileSync(cert, "utf8");
    proc = Bun.spawn(["bun", resolve(import.meta.dir, "../src/index.ts")], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATA_DIR: join(dir, "data"),
        HOST: "127.0.0.1",
        PORT: String(port),
        INTERNAL_PORT: String(internalPort),
        TLS_CERT_FILE: cert,
        TLS_KEY_FILE: key,
        PUBLIC_URL: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let i = 0; i < 100; i++) {
      const ok = await fetch(`http://127.0.0.1:${internalPort}/healthz`).then((r) => r.ok, () => false);
      if (ok) return;
      await Bun.sleep(100);
    }
    throw new Error("server did not start");
  });

  afterAll(() => {
    proc?.kill();
  });

  test("serves HTTPS with the configured certificate, with secure cookies and HSTS", async () => {
    const res = await fetch(`https://127.0.0.1:${port}/api/auth/state`, { tls: { ca } });
    expect(res.status).toBe(200);
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    // Without trusting the certificate, the connection is refused.
    await expect(fetch(`https://127.0.0.1:${port}/healthz`)).rejects.toThrow();
    // Session cookies use the __Host- prefix once the site is HTTPS.
    const login = await fetch(`https://127.0.0.1:${port}/api/auth/login`, {
      method: "POST",
      tls: { ca },
      headers: { "content-type": "application/json", "x-mm-client": "1" },
      body: JSON.stringify({ username: "nobody", password: "wrong password" }),
    });
    expect(login.status).toBe(401);
    const logout = await fetch(`https://127.0.0.1:${port}/api/auth/logout`, {
      method: "POST",
      tls: { ca },
      headers: { "x-mm-client": "1" },
    });
    expect(logout.headers.get("set-cookie") ?? "").toContain("__Host-mm_session");
  });

  test("the loopback port serves only the token-protected worker API", async () => {
    const base = `http://127.0.0.1:${internalPort}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/api/auth/state`)).status).toBe(404);
    const noToken = await fetch(`${base}/internal/jobs/claim`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(noToken.status).toBe(401);
    const token = process.env.WORKER_TOKEN!; // passed through to the server by the test setup
    const claim = await fetch(`${base}/internal/jobs/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ workerId: "tls-test", info: {} }),
    });
    expect(claim.status).toBe(204); // authenticated, nothing queued
  });
});
