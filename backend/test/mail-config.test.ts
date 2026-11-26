import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The mail settings the server reads from `env` (config is read once per process, so each case runs in its own). */
function mailConfig(env: Record<string, string>): { ok: true; mail: any } | { ok: false; error: string } {
  const res = Bun.spawnSync(["bun", "-e", 'const { config } = await import("./src/config.ts"); console.log(JSON.stringify(config.mail));'], {
    cwd: join(import.meta.dir, ".."),
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", MM_SKIP_DOTENV: "1", DATA_DIR: mkdtempSync(join(tmpdir(), "mm-mail-")), WORKER_TOKEN: "x".repeat(20), ...env },
  });
  if (res.exitCode !== 0) return { ok: false, error: res.stderr.toString() };
  return { ok: true, mail: JSON.parse(res.stdout.toString().trim().split("\n").pop()!) };
}

describe("mail settings", () => {
  test("piece by piece, as Gmail's help pages give them", () => {
    const r = mailConfig({
      SMTP_HOST: "smtp.gmail.com",
      SMTP_PORT: "587",
      SMTP_USER: "someone@gmail.com",
      SMTP_PASS: "abcd efgh ijkl mnop",
      SMTP_FROM: "Matt <matt@example.com>",
    });
    expect(r).toEqual({
      ok: true,
      mail: {
        transport: "smtp",
        server: { host: "smtp.gmail.com", port: 587, secure: false, user: "someone@gmail.com", pass: "abcd efgh ijkl mnop" },
        from: "Matt <matt@example.com>",
      },
    });
  });

  test("port 465 is TLS from the start; SMTP_URL still works", () => {
    const a = mailConfig({ SMTP_HOST: "smtp.example.com", SMTP_PORT: "465", SMTP_USER: "u", SMTP_PASS: "p", MAIL_FROM: "x@example.com" });
    expect(a.ok && a.mail.server.secure).toBe(true);
    const b = mailConfig({ SMTP_URL: "smtps://you%40gmail.com:pw@smtp.gmail.com:465", MAIL_FROM: "x@example.com" });
    expect(b.ok && b.mail.server).toEqual({ host: "smtp.gmail.com", port: 465, secure: true, user: "you@gmail.com", pass: "pw" });
  });

  test("mistakes stop the server with a message saying what to fix", () => {
    const noFrom = mailConfig({ SMTP_HOST: "smtp.gmail.com", SMTP_USER: "u", SMTP_PASS: "p" });
    expect(!noFrom.ok && noFrom.error).toContain("MAIL_FROM");
    const halfLogin = mailConfig({ SMTP_HOST: "smtp.gmail.com", SMTP_USER: "u", MAIL_FROM: "x@example.com" });
    expect(!halfLogin.ok && halfLogin.error).toContain("SMTP_USER and SMTP_PASS together");
    const both = mailConfig({ SMTP_HOST: "smtp.gmail.com", SMTP_URL: "smtp://a:b@c", MAIL_FROM: "x@example.com" });
    expect(!both.ok && both.error).toContain("not both");
    const none = mailConfig({});
    expect(none.ok && none.mail.server).toBeNull();
  });
});
