import { describe, expect, test } from "bun:test";
import { db, now } from "../src/db";
import { Client, adminClient, memberClient } from "./helpers";

const DAY = 86_400_000;

async function post(admin: Client, json: Record<string, unknown>) {
  const res = await admin.post("/api/admin/announcements", json);
  expect(res.status).toBe(201);
  return ((await res.json()) as any).id as string;
}

async function mine(c: Client) {
  return (await (await c.get("/api/announcements")).json()) as any;
}

describe("announcements", () => {
  test("each person sees those for them, in effect, until they close one", async () => {
    const admin = await adminClient();
    const amy = await memberClient("ann-amy");
    const t = now();
    const all = await post(admin, { title: "Maintenance tonight", body: "**22:00–23:00**", level: "warning", audience: "users" });
    const admins = await post(admin, { title: "For admins", audience: "admins" });
    const later = await post(admin, { title: "Next week", startsAt: t + 7 * DAY });
    const over = await post(admin, { title: "Last month", startsAt: t - 40 * DAY, endsAt: t - 30 * DAY });
    const critical = await post(admin, { title: "Outage", level: "critical", dismissible: false });

    const a = await mine(amy);
    const ids = a.active.map((x: any) => x.id);
    expect(ids).toContain(all);
    expect(ids).toContain(critical);
    expect(ids).not.toContain(admins);
    expect(ids).not.toContain(later);
    expect(a.past.map((x: any) => x.id)).toContain(over);
    // The most serious first.
    expect(a.active[0].id).toBe(critical);
    expect(a.active.find((x: any) => x.id === all)).toMatchObject({ title: "Maintenance tonight", body: "**22:00–23:00**", level: "warning", dismissible: true, seen: false });
    const unseen = a.unseen;

    const after = (await (await amy.post("/api/announcements/seen", { ids: [all] })).json()) as any;
    expect(after.active.find((x: any) => x.id === all).seen).toBe(true);
    expect(after.unseen).toBe(unseen - 1);
    expect((await mine(admin)).active.map((x: any) => x.id)).toContain(admins);

    // An edit can show it again to those who closed it.
    expect((await admin.req("PUT", `/api/admin/announcements/${all}`, { json: { title: "Maintenance moved", level: "warning", audience: "users", notifyAgain: true } })).status).toBe(200);
    expect((await mine(amy)).active.find((x: any) => x.id === all)).toMatchObject({ title: "Maintenance moved", seen: false });

    const list = ((await (await admin.get("/api/admin/announcements")).json()) as any).announcements;
    expect(list.find((x: any) => x.id === later).status).toBe("scheduled");
    expect(list.find((x: any) => x.id === over).status).toBe("ended");
    expect(list.find((x: any) => x.id === all)).toMatchObject({ status: "active", audience: "users" });

    for (const id of [all, admins, later, over, critical]) expect((await admin.req("DELETE", `/api/admin/announcements/${id}`)).status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS n FROM announcement_seen WHERE announcement_id = $id").get({ id: all })).toEqual({ n: 0 });
  });

  test("those for everyone show on the sign-in page; only administrators write them", async () => {
    const admin = await adminClient();
    const id = await post(admin, { title: "Down for upgrade at 23:00", audience: "everyone", level: "warning" });
    const users = await post(admin, { title: "Members only", audience: "users" });
    const pub = (await (await new Client().get("/api/auth/announcements")).json()) as any;
    expect(pub.announcements.map((x: any) => x.title)).toContain("Down for upgrade at 23:00");
    expect(pub.announcements.map((x: any) => x.id)).not.toContain(users);
    expect((await new Client().get("/api/announcements")).status).toBe(401);

    const member = await memberClient("ann-member");
    expect((await member.post("/api/admin/announcements", { title: "x" })).status).toBe(403);
    expect((await admin.post("/api/admin/announcements", { title: "" })).status).toBe(422);
    expect((await admin.post("/api/admin/announcements", { title: "Bad", startsAt: 2000, endsAt: 1000 })).status).toBe(422);
    expect((await admin.req("PUT", "/api/admin/announcements/nope", { json: { title: "x" } })).status).toBe(404);
    await admin.req("DELETE", `/api/admin/announcements/${id}`);
    await admin.req("DELETE", `/api/admin/announcements/${users}`);
  });
});
