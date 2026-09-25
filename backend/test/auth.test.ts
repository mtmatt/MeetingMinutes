import { describe, expect, test } from "bun:test";
import { Client, adminClient, memberClient } from "./helpers";

describe("first-run setup", () => {
  test("reports that setup is needed and rejects a wrong token", async () => {
    const c = new Client();
    const state = (await (await c.get("/api/auth/state")).json()) as any;
    expect(state.needsSetup).toBe(true);
    const bad = await c.post("/api/auth/setup", {
      setupToken: "nope",
      username: "mallory",
      displayName: "M",
      password: "long enough password",
    });
    expect(bad.status).toBe(403);
  });

  test("creates the admin with the setup token, then setup is closed", async () => {
    const admin = await adminClient();
    const me = (await (await admin.get("/api/me")).json()) as any;
    expect(me.user.role).toBe("admin");
    const again = await new Client().post("/api/auth/setup", {
      setupToken: "whatever",
      username: "second",
      displayName: "S",
      password: "long enough password",
    });
    expect([403, 409]).toContain(again.status);
    const state = (await (await new Client().get("/api/auth/state")).json()) as any;
    expect(state.needsSetup).toBe(false);
  });
});

describe("sessions and CSRF", () => {
  test("rejects state-changing requests without the client header", async () => {
    const admin = await adminClient();
    const res = await admin.req("POST", "/api/admin/invites", { json: {}, csrf: false });
    expect(res.status).toBe(403);
  });

  test("rejects a cross-origin Origin header", async () => {
    const admin = await adminClient();
    const res = await admin.req("POST", "/api/admin/invites", { json: {}, headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  test("unauthenticated API calls get 401", async () => {
    expect((await new Client().get("/api/meetings")).status).toBe(401);
    expect((await new Client().get("/api/me")).status).toBe(401);
  });

  test("login, logout", async () => {
    const c = new Client();
    const wrong = await c.post("/api/auth/login", { username: "admin", password: "wrong password!!" });
    expect(wrong.status).toBe(401);
    const ok = await c.post("/api/auth/login", { username: "ADMIN", password: "correct horse battery" });
    expect(ok.status).toBe(200);
    expect(c.cookie).toContain("mm_session=");
    expect((await c.get("/api/me")).status).toBe(200);
    await c.post("/api/auth/logout");
    expect((await c.get("/api/me")).status).toBe(401);
  });

  test("locks out a username after repeated failures", async () => {
    await memberClient("locky");
    const c = new Client();
    let last = 0;
    for (let i = 0; i < 10; i++) {
      last = (await c.post("/api/auth/login", { username: "locky", password: "definitely wrong" })).status;
    }
    expect(last).toBe(429);
    // Even the right password is refused while locked.
    const right = await c.post("/api/auth/login", { username: "locky", password: "member password 123" });
    expect(right.status).toBe(429);
  });
});

describe("invites and accounts", () => {
  test("members cannot reach admin endpoints", async () => {
    const m = await memberClient("bob");
    expect((await m.get("/api/admin/users")).status).toBe(403);
  });

  test("an invite link works only once", async () => {
    const admin = await adminClient();
    const { url } = (await (await admin.post("/api/admin/invites", { role: "member" })).json()) as any;
    const token = url.split("/invite/")[1];
    const info = (await (await new Client().get(`/api/auth/invites/${token}`)).json()) as any;
    expect(info.kind).toBe("invite");
    const first = await new Client().post(`/api/auth/invites/${token}/accept`, {
      username: "carol",
      displayName: "Carol",
      password: "carol password 1",
    });
    expect(first.status).toBe(200);
    const second = await new Client().post(`/api/auth/invites/${token}/accept`, {
      username: "carol2",
      displayName: "Carol",
      password: "carol password 1",
    });
    expect(second.status).toBe(404);
  });

  test("weak passwords and bad usernames are rejected", async () => {
    const admin = await adminClient();
    const { url } = (await (await admin.post("/api/admin/invites", {})).json()) as any;
    const token = url.split("/invite/")[1];
    expect((await new Client().post(`/api/auth/invites/${token}/accept`, { username: "dave", displayName: "D", password: "short" })).status).toBe(422);
    expect((await new Client().post(`/api/auth/invites/${token}/accept`, { username: "no spaces", displayName: "D", password: "long enough pass" })).status).toBe(422);
  });

  test("password reset link sets a new password and revokes sessions", async () => {
    const admin = await adminClient();
    const erin = await memberClient("erin");
    const users = (await (await admin.get("/api/admin/users")).json()) as any;
    const erinId = users.users.find((u: any) => u.username === "erin").id;
    const { url } = (await (await admin.post(`/api/admin/users/${erinId}/reset-link`)).json()) as any;
    const token = url.split("/invite/")[1];
    const res = await new Client().post(`/api/auth/invites/${token}/accept`, { password: "brand new password" });
    expect(res.status).toBe(200);
    expect((await erin.get("/api/me")).status).toBe(401);
    expect((await new Client().post("/api/auth/login", { username: "erin", password: "brand new password" })).status).toBe(200);
  });

  test("change password keeps the current session and ends others", async () => {
    const a = await memberClient("frank");
    const b = new Client();
    await b.post("/api/auth/login", { username: "frank", password: "member password 123" });
    const res = await a.post("/api/me/password", { current: "member password 123", next: "another password 456" });
    expect(res.status).toBe(200);
    expect((await a.get("/api/me")).status).toBe(200);
    expect((await b.get("/api/me")).status).toBe(401);
  });

  test("the last administrator cannot be demoted or deleted", async () => {
    const admin = await adminClient();
    const me = (await (await admin.get("/api/me")).json()) as any;
    expect((await admin.patch(`/api/admin/users/${me.user.id}`, { role: "member" })).status).toBe(409);
    expect((await admin.del(`/api/admin/users/${me.user.id}`)).status).toBe(409);
  });

  test("disabling a user signs them out", async () => {
    const admin = await adminClient();
    const g = await memberClient("gina");
    const users = (await (await admin.get("/api/admin/users")).json()) as any;
    const id = users.users.find((u: any) => u.username === "gina").id;
    expect((await admin.patch(`/api/admin/users/${id}`, { disabled: true })).status).toBe(200);
    expect((await g.get("/api/me")).status).toBe(401);
    expect((await new Client().post("/api/auth/login", { username: "gina", password: "member password 123" })).status).toBe(401);
  });
});

describe("worker auth", () => {
  test("internal API requires the worker token", async () => {
    const { worker } = await import("./helpers");
    expect((await worker.call("/jobs/claim", { workerId: "w" }, "bad")).status).toBe(401);
    expect([200, 204]).toContain((await worker.call("/jobs/claim", { workerId: "w" })).status);
  });
});
