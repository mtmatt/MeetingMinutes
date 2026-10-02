import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// First-run setup needs a database without any administrator. The other test
// files share one database (and bun does not run them in a fixed order), so
// this runs against its own server process with a fresh data directory.
describe("first-run setup", () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-first-run-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  let proc: ReturnType<typeof Bun.spawn>;

  beforeAll(async () => {
    proc = Bun.spawn(["bun", resolve(import.meta.dir, "../src/index.ts")], {
      env: { ...process.env, NODE_ENV: "test", MM_SKIP_DOTENV: "1", DATA_DIR: join(dir, "data"), HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/healthz`).then((r) => r.ok, () => false)) return;
      await Bun.sleep(100);
    }
    throw new Error("server did not start");
  });

  afterAll(() => {
    proc?.kill();
  });

  const post = (path: string, json: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-mm-client": "1" }, body: JSON.stringify(json) });
  const state = async () => ((await (await fetch(`${base}/api/auth/state`)).json()) as any).needsSetup;

  // One test, in order: each step depends on the one before.
  test("needs setup, rejects a wrong token, creates the admin with the right one, then closes", async () => {
    expect(await state()).toBe(true);
    const bad = await post("/api/auth/setup", { setupToken: "nope", username: "mallory", displayName: "M", password: "long enough password" });
    expect(bad.status).toBe(403);

    const token = readFileSync(join(dir, "data", "setup.token"), "utf8").trim();
    const ok = await post("/api/auth/setup", { setupToken: token, username: "admin", displayName: "Admin", password: "correct horse battery" });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
    const me = (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as any;
    expect(me.user.role).toBe("admin");
    const again = await post("/api/auth/setup", { setupToken: token, username: "second", displayName: "S", password: "long enough password" });
    expect([403, 409]).toContain(again.status);
    expect(await state()).toBe(false);
  });
});
