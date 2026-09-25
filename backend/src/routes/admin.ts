import { Hono } from "hono";
import { statfsSync } from "node:fs";
import { z } from "zod";
import { config } from "../config";
import { requireAdmin, requireUser } from "../auth/middleware";
import { createInvite, type InviteRow } from "../auth/invites";
import { deleteUserSessions, findUserById, publicUser } from "../auth/service";
import { db, now } from "../db";
import { httpError, parseJson } from "../lib/util";
import { codexStatus } from "../services/codex";
import { deleteMeeting, queueStats } from "../services/meetings";
import { summarizerStats } from "../services/summarizer";
import type { AppEnv, MeetingRow, UserRow } from "../types";
import { body } from "./validate";

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use(requireUser, requireAdmin);

function linkFor(c: any, token: string) {
  const base = config.publicUrl || new URL(c.req.url).origin;
  return `${base}/invite/${token}`;
}

function activeAdminCount(): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get()?.n ?? 0;
}

adminRoutes.get("/users", (c) => {
  const rows = db.query<UserRow & { meetings: number }, []>(
    `SELECT u.*, (SELECT COUNT(*) FROM meetings m WHERE m.owner_id = u.id) AS meetings
     FROM users u ORDER BY u.created_at ASC`,
  ).all();
  return c.json({ users: rows.map((u) => ({ ...publicUser(u), meetings: u.meetings })) });
});

adminRoutes.patch("/users/:id", async (c) => {
  const me = c.get("user");
  const target = findUserById(c.req.param("id"));
  if (!target) httpError(404, "User not found.", "not_found");
  const input = await body(
    c,
    z.object({
      role: z.enum(["admin", "member"]).optional(),
      disabled: z.boolean().optional(),
      displayName: z.string().trim().min(1).max(80).optional(),
    }),
  );
  const demoting = target.role === "admin" && ((input.role && input.role !== "admin") || input.disabled === true);
  if (demoting && !target.disabled && activeAdminCount() <= 1) {
    httpError(409, "At least one active administrator is required.", "last_admin");
  }
  if (target.id === me.id && input.disabled) httpError(409, "You cannot disable your own account.", "self");
  db.query(
    `UPDATE users SET role = COALESCE($role, role), disabled = COALESCE($disabled, disabled),
       display_name = COALESCE($dn, display_name), updated_at = $t WHERE id = $id`,
  ).run({
    id: target.id,
    role: input.role ?? null,
    disabled: input.disabled === undefined ? null : input.disabled ? 1 : 0,
    dn: input.displayName ?? null,
    t: now(),
  });
  if (input.disabled) deleteUserSessions(target.id);
  return c.json({ user: publicUser(findUserById(target.id)!) });
});

adminRoutes.delete("/users/:id", async (c) => {
  const me = c.get("user");
  const target = findUserById(c.req.param("id"));
  if (!target) httpError(404, "User not found.", "not_found");
  if (target.id === me.id) httpError(409, "You cannot delete your own account.", "self");
  if (target.role === "admin" && !target.disabled && activeAdminCount() <= 1) {
    httpError(409, "At least one active administrator is required.", "last_admin");
  }
  const meetings = db.query<MeetingRow, { u: string }>("SELECT * FROM meetings WHERE owner_id = $u").all({ u: target.id });
  for (const m of meetings) await deleteMeeting(m);
  db.query("DELETE FROM users WHERE id = $id").run({ id: target.id });
  return c.json({ ok: true });
});

adminRoutes.post("/users/:id/reset-link", (c) => {
  const target = findUserById(c.req.param("id"));
  if (!target) httpError(404, "User not found.", "not_found");
  const { token, invite } = createInvite({
    kind: "reset",
    role: target.role,
    targetUserId: target.id,
    createdBy: c.get("user").id,
    ttlHours: 24,
  });
  return c.json({ url: linkFor(c, token), expiresAt: invite.expires_at });
});

adminRoutes.get("/invites", (c) => {
  const rows = db
    .query<InviteRow & { used_by_name: string | null }, { t: number }>(
      `SELECT i.*, u.username AS used_by_name FROM invites i LEFT JOIN users u ON u.id = i.used_by
       WHERE i.kind = 'invite' AND (i.used_at IS NOT NULL OR i.expires_at > $t)
       ORDER BY i.created_at DESC LIMIT 100`,
    )
    .all({ t: now() });
  return c.json({
    invites: rows.map((i) => ({
      id: i.id,
      role: i.role,
      note: i.note,
      createdAt: i.created_at,
      expiresAt: i.expires_at,
      usedAt: i.used_at,
      usedBy: i.used_by_name,
    })),
  });
});

adminRoutes.post("/invites", async (c) => {
  const input = await body(
    c,
    z.object({
      role: z.enum(["admin", "member"]).default("member"),
      note: z.string().trim().max(200).nullable().default(null),
      ttlHours: z.number().int().min(1).max(24 * 30).default(72),
    }),
  );
  const { token, invite } = createInvite({ kind: "invite", role: input.role, note: input.note, createdBy: c.get("user").id, ttlHours: input.ttlHours });
  return c.json({ url: linkFor(c, token), invite: { id: invite.id, role: invite.role, note: invite.note, expiresAt: invite.expires_at } }, 201);
});

adminRoutes.delete("/invites/:id", (c) => {
  db.query("DELETE FROM invites WHERE id = $id AND used_at IS NULL").run({ id: c.req.param("id") });
  return c.json({ ok: true });
});

adminRoutes.get("/system", async (c) => {
  const workers = db
    .query<{ id: string; name: string; info: string; last_seen_at: number }, []>("SELECT * FROM workers ORDER BY last_seen_at DESC")
    .all();
  let disk: { freeBytes: number; totalBytes: number } | null = null;
  try {
    const s = statfsSync(config.dataDir);
    disk = { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    disk = null;
  }
  const t = now();
  return c.json({
    workers: workers.map((w) => ({
      id: w.id,
      name: w.name,
      info: parseJson<Record<string, unknown>>(w.info, {}),
      lastSeenAt: w.last_seen_at,
      online: t - w.last_seen_at < 60_000,
    })),
    jobs: queueStats(),
    summaries: summarizerStats(),
    codex: await codexStatus(),
    disk,
    stats: {
      users: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get()?.n ?? 0,
      meetings: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM meetings").get()?.n ?? 0,
      audioHours: (db.query<{ s: number | null }, []>("SELECT SUM(duration_sec) AS s FROM meetings").get()?.s ?? 0) / 3600,
    },
  });
});
