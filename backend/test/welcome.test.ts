import { describe, expect, test } from "bun:test";
import { Client, adminClient } from "./helpers";

describe("the front page", () => {
  test("a visitor who is not signed in gets the landing page, other addresses the app", async () => {
    await adminClient(); // the site has accounts, so it is past its first-run setup
    const visitor = new Client();
    const front = await visitor.get("/");
    expect(front.status).toBe(200);
    expect(front.headers.get("content-type")).toContain("text/html");
    expect(await front.text()).toContain("<title>welcome</title>");
    expect(await (await visitor.get("/login")).text()).toContain("<title>app</title>");
    expect(await (await visitor.get("/pricing")).text()).toContain("<title>app</title>");
    // The landing page's own files are served from its folder.
    expect(await (await visitor.get("/welcome/index.html")).text()).toContain("<title>welcome</title>");
  });

  test("a signed-in person gets the app, and a stale cookie counts as signed out", async () => {
    const admin = await adminClient();
    expect(await (await admin.get("/")).text()).toContain("<title>app</title>");
    const stale = new Client();
    stale.cookie = "mm_session=not-a-session";
    expect(await (await stale.get("/")).text()).toContain("<title>welcome</title>");
  });
});
