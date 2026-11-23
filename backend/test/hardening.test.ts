import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { meetingDir } from "../src/services/meetings";
import { Client, adminClient, app, memberClient } from "./helpers";

const SHARED = "test-worker-token";

/** A call to the worker API with a given token. */
function internal(token: string, method: string, path: string, opts: { json?: unknown; body?: string | Uint8Array; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(opts.headers ?? {}) };
  let body = opts.body;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  return app.fetch(new Request(`http://mm.test/internal${path}`, { method, headers, body }));
}

/** Valid JSON of about `bytes` bytes: the fields a route expects, and padding it would ignore. */
function padded(fields: Record<string, unknown>, bytes: number): string {
  return JSON.stringify({ ...fields, pad: "x".repeat(bytes) });
}

describe("request sizes", () => {
  test("requests anyone can send are refused when large, before they are parsed", async () => {
    const anyone = new Client();
    // Counted as it arrives (no length declared) ...
    const login = await anyone.req("POST", "/api/auth/login", {
      body: padded({ username: "nobody", password: "not the password" }, 200_000),
      headers: { "content-type": "application/json" },
    });
    expect(login.status).toBe(413);
    expect(((await login.json()) as any).code).toBe("too_large");
    // ... and refused on the declared length alone.
    const declared = await anyone.req("POST", "/api/auth/login", {
      body: "{}",
      headers: { "content-type": "application/json", "content-length": String(30 * 1024 * 1024) },
    });
    expect(declared.status).toBe(413);
    const setup = await anyone.req("POST", "/api/auth/setup", {
      body: padded({ setupToken: "x", username: "a", displayName: "a", password: "b" }, 200_000),
      headers: { "content-type": "application/json" },
    });
    expect(setup.status).toBe(413);
    const enroll = await internal("", "POST", "/enroll", { body: padded({ code: "mme_guess" }, 200_000), headers: { "content-type": "application/json" } });
    expect(enroll.status).toBe(413);
    // An ordinary sign-in attempt is answered as before.
    expect((await anyone.post("/api/auth/login", { username: "nobody", password: "not the password" })).status).toBe(401);
  });

  test("a worker's status report cannot store megabytes; a signed-in person's JSON has a limit too", async () => {
    const big = await internal(SHARED, "POST", "/worker/heartbeat", { json: { workerId: "hard-1", info: { note: "x".repeat(200_000) } } });
    expect(big.status).toBe(413);
    expect((await internal(SHARED, "POST", "/worker/heartbeat", { json: { workerId: "hard-1", info: { gpu: "RTX 4090" } } })).status).toBe(200);
    const admin = await adminClient();
    const system = (await (await admin.get("/api/admin/system")).json()) as any;
    expect(system.workers.find((w: any) => w.id === "hard-1").info).toEqual({ gpu: "RTX 4090" });

    const member = await memberClient("hard-sizes");
    // A long template (the largest ordinary field) still fits ...
    expect((await member.post("/api/templates", { name: "Long", body: "字".repeat(20_000) })).status).toBe(201);
    // ... five megabytes of JSON do not.
    const huge = await member.req("PATCH", "/api/me", { body: padded({ displayName: "Me" }, 5 * 1024 * 1024), headers: { "content-type": "application/json" } });
    expect(huge.status).toBe(413);
  });
});

describe("files a remote worker sends", () => {
  test("only the listed names are accepted, not names every object has", async () => {
    const admin = await adminClient();
    const created = (await (await admin.post("/api/admin/worker-keys", { name: "Names" })).json()) as any;
    const got = (await (await internal("", "POST", "/enroll", { json: { code: created.code } })).json()) as any;
    const token = got.token as string;
    const wid = got.workerId as string;

    const owner = await memberClient("hard-names");
    const bytes = new Uint8Array(2000).fill(7);
    const { meeting } = (await (await owner.post("/api/meetings", { title: "Names", file: { name: "n.wav", size: bytes.length } })).json()) as any;
    await owner.req("PUT", `/api/meetings/${meeting.id}/upload?offset=0`, { body: bytes, headers: { "content-type": "application/octet-stream" } });
    expect((await owner.post(`/api/meetings/${meeting.id}/upload/complete`)).status).toBe(200);
    let job: any = null;
    for (let i = 0; i < 40 && !job; i++) {
      const res = await internal(token, "POST", "/jobs/claim", { json: { workerId: wid } });
      if (res.status === 204) break;
      const claimed = ((await res.json()) as any).job;
      if (claimed.meetingId === meeting.id) job = claimed;
      else await internal(token, "POST", `/jobs/${claimed.jobId}/fail`, { json: { workerId: wid, error: "not this test", retryable: false } });
    }
    expect(job).not.toBeNull();

    const put = (name: string) => internal(token, "PUT", `/jobs/${job.jobId}/files/${name}?workerId=${wid}&offset=0`, { body: new Uint8Array([1, 2, 3]) });
    // These are properties of every object: they passed an `in` check, and had no size limit.
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect((await put(name)).status).toBe(404);
    }
    expect((await put("playback.m4a")).status).toBe(200);
    expect(readdirSync(meetingDir(meeting.id)).sort()).toEqual([`incoming-${job.jobId}-playback.m4a`, "original.wav"]);
    await internal(token, "POST", `/jobs/${job.jobId}/fail`, { json: { workerId: wid, error: "done testing", retryable: false } });
    expect(existsSync(`${meetingDir(meeting.id)}/incoming-${job.jobId}-playback.m4a`)).toBe(false);
  });
});

describe("static files", () => {
  test("a malformed path is a bad request, not a server error", async () => {
    for (const path of ["/%E0%A4%A", "/assets/%"]) {
      const res = await app.fetch(new Request(`http://mm.test${path}`, { headers: { host: "mm.test" } }));
      expect(res.status).toBe(400);
    }
    // Climbing out of the built frontend never reaches a file outside it.
    const res = await app.fetch(new Request("http://mm.test/..%2f..%2f..%2f..%2fetc%2fpasswd", { headers: { host: "mm.test" } }));
    expect(await res.text()).not.toContain("root:");
  });
});
