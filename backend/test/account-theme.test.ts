import { describe, expect, test } from "bun:test";
import { Client, memberClient } from "./helpers";

describe("the colour theme follows the account", () => {
  test("saved with the account, returned with the user, and checked", async () => {
    const c = await memberClient("theme-person");
    const before = ((await (await c.get("/api/auth/state")).json()) as any).user;
    expect(before.theme).toBeNull();
    const saved = ((await (await c.patch("/api/me", { theme: "dark" })).json()) as any).user;
    expect(saved.theme).toBe("dark");
    // Other fields are left alone, and the next visit (any browser, any address) gets it back.
    expect(saved.displayName).toBe(before.displayName);
    expect(((await (await c.get("/api/auth/state")).json()) as any).user.theme).toBe("dark");
    expect(((await (await c.patch("/api/me", { locale: "en" })).json()) as any).user.theme).toBe("dark");
    expect((await c.patch("/api/me", { theme: "purple" })).status).toBe(422);
    expect(((await (await c.patch("/api/me", { theme: null })).json()) as any).user.theme).toBeNull();
  });

  test("the site's address is public (pages at an earlier address move there before anyone signs in)", async () => {
    const state = (await (await new Client().get("/api/auth/state")).json()) as any;
    // Tests run without PUBLIC_URL.
    expect(state).toHaveProperty("siteOrigin", null);
  });
});
