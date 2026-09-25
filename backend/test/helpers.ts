import { createApp } from "../src/app";
import { ensureSetupToken } from "../src/auth/setup";
import { seedBuiltinTemplates } from "../src/services/templates";

seedBuiltinTemplates();
export const app = createApp();

export class Client {
  cookie = "";
  constructor(private readonly base = "http://mm.test") {}

  async req(method: string, path: string, init: { json?: unknown; body?: ConstructorParameters<typeof Request>[1] extends infer I ? I extends { body?: infer B } ? B : never : never; headers?: Record<string, string>; csrf?: boolean } = {}) {
    const headers: Record<string, string> = { host: "mm.test", ...(init.headers ?? {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (init.csrf !== false && method !== "GET") headers["x-mm-client"] = "1";
    let body = init.body;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    const res = await app.fetch(new Request(this.base + path, { method, headers, body }));
    const set = res.headers.get("set-cookie");
    if (set) {
      const pair = set.split(";")[0]!;
      this.cookie = pair.endsWith("=") ? "" : pair;
    }
    return res;
  }

  get(path: string) {
    return this.req("GET", path);
  }
  post(path: string, json?: unknown) {
    return this.req("POST", path, { json: json ?? {} });
  }
  patch(path: string, json: unknown) {
    return this.req("PATCH", path, { json });
  }
  del(path: string) {
    return this.req("DELETE", path);
  }
}

export const worker = {
  async call(path: string, json: unknown, token = "test-worker-token") {
    return app.fetch(
      new Request("http://mm.test/internal" + path, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(json),
      }),
    );
  },
};

let adminPromise: Promise<Client> | null = null;
/** A signed-in administrator, created once through the real setup flow. */
export function adminClient(): Promise<Client> {
  adminPromise ??= (async () => {
    const c = new Client();
    const token = ensureSetupToken();
    if (token) {
      const res = await c.post("/api/auth/setup", {
        setupToken: token,
        username: "admin",
        displayName: "Admin",
        password: "correct horse battery",
      });
      if (res.status !== 200) throw new Error("setup failed: " + (await res.text()));
    } else {
      await c.post("/api/auth/login", { username: "admin", password: "correct horse battery" });
    }
    return c;
  })();
  return adminPromise;
}

/** Create a member through an invite link and return a signed-in client. */
export async function memberClient(username: string): Promise<Client> {
  const admin = await adminClient();
  const inv = (await (await admin.post("/api/admin/invites", { role: "member" })).json()) as { url: string };
  const token = inv.url.split("/invite/")[1]!;
  const c = new Client();
  const res = await c.post(`/api/auth/invites/${token}/accept`, { username, displayName: username, password: "member password 123" });
  if (res.status !== 200) throw new Error("invite accept failed: " + (await res.text()));
  return c;
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(40);
  }
  throw new Error("waitFor timed out");
}
