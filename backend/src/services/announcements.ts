import { z } from "zod";
import { db, now } from "../db";
import { newId } from "../lib/util";
import type { UserRow } from "../types";
import { publishAll } from "./events";

/**
 * Announcements from the administrators (maintenance, new features, price changes).
 *
 * Each is for an audience: everyone, including people on the sign-in page; every
 * signed-in person; prepaid or free accounts; or administrators only. It shows
 * between its start and end (either may be open) as a banner at the top of the
 * site, until the person closes it, unless it may not be closed; and it stays on
 * the announcements page after that. Who has closed (seen) each is kept, so the
 * banner stays closed on every device.
 */

export const LEVELS = ["info", "warning", "critical"] as const;
export const AUDIENCES = ["everyone", "users", "prepaid", "exempt", "admins"] as const;
export type Audience = (typeof AUDIENCES)[number];

export const TITLE_MAX = 120;
export const BODY_MAX = 10_000;
/** Ended announcements stay on the announcements page this long. */
const PAST_MS = 180 * 86_400_000;

export const announcementInput = z
  .object({
    title: z.string().trim().min(1).max(TITLE_MAX),
    body: z.string().max(BODY_MAX).default(""),
    level: z.enum(LEVELS).default("info"),
    audience: z.enum(AUDIENCES).default("users"),
    startsAt: z.number().int().nullable().default(null),
    endsAt: z.number().int().nullable().default(null),
    dismissible: z.boolean().default(true),
    /** On an edit: show it again to people who had closed it. */
    notifyAgain: z.boolean().default(false),
  })
  .refine((a) => a.startsAt == null || a.endsAt == null || a.endsAt > a.startsAt, { message: "The end must be after the start.", path: ["endsAt"] });
export type AnnouncementInput = z.infer<typeof announcementInput>;

export interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  level: (typeof LEVELS)[number];
  audience: Audience;
  starts_at: number | null;
  ends_at: number | null;
  dismissible: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/** The audiences a person belongs to. */
function audiencesOf(user: Pick<UserRow, "role" | "billing">): Audience[] {
  const out: Audience[] = ["everyone", "users", user.billing === "prepaid" ? "prepaid" : "exempt"];
  if (user.role === "admin") out.push("admins");
  return out;
}

function publicAnnouncement(a: AnnouncementRow, seen: boolean | null = null) {
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    level: a.level,
    startsAt: a.starts_at,
    endsAt: a.ends_at,
    dismissible: !!a.dismissible,
    /** When it took effect: its start, or when it was written. */
    publishedAt: a.starts_at ?? a.created_at,
    updatedAt: a.updated_at,
    /** Changed after it was written. */
    edited: a.updated_at > a.created_at + 60_000,
    ...(seen == null ? {} : { seen }),
  };
}
export type PublicAnnouncement = ReturnType<typeof publicAnnouncement>;

const ACTIVE = "(starts_at IS NULL OR starts_at <= $t) AND (ends_at IS NULL OR ends_at > $t)";

/** What a signed-in person sees: those in effect (with whether they closed each), and recent past ones. */
export function announcementsFor(user: Pick<UserRow, "id" | "role" | "billing">, t = now()) {
  const audiences = audiencesOf(user);
  const list = `(${audiences.map((a) => `'${a}'`).join(",")})`;
  const rows = db
    .query<AnnouncementRow & { seen_at: number | null }, { t: number; u: string; past: number }>(
      `SELECT a.*, s.seen_at FROM announcements a
         LEFT JOIN announcement_seen s ON s.announcement_id = a.id AND s.user_id = $u
        WHERE a.audience IN ${list} AND (a.starts_at IS NULL OR a.starts_at <= $t) AND (a.ends_at IS NULL OR a.ends_at > $past)
        ORDER BY COALESCE(a.starts_at, a.created_at) DESC`,
    )
    .all({ t, u: user.id, past: t - PAST_MS });
  const active = rows.filter((a) => a.ends_at == null || a.ends_at > t);
  const past = rows.filter((a) => a.ends_at != null && a.ends_at <= t);
  const order = { critical: 0, warning: 1, info: 2 } as const;
  return {
    // The most serious first, then the newest.
    active: active
      .sort((a, b) => order[a.level] - order[b.level] || (b.starts_at ?? b.created_at) - (a.starts_at ?? a.created_at))
      .map((a) => publicAnnouncement(a, a.seen_at != null)),
    past: past.map((a) => publicAnnouncement(a, true)),
    /** In effect and not yet closed: the count on the menu. */
    unseen: active.filter((a) => a.seen_at == null).length,
  };
}

/** For the sign-in page: those for everyone, in effect now. */
export function publicAnnouncements(t = now()) {
  return db
    .query<AnnouncementRow, { t: number }>(`SELECT * FROM announcements WHERE audience = 'everyone' AND ${ACTIVE} ORDER BY COALESCE(starts_at, created_at) DESC`)
    .all({ t })
    .map((a) => publicAnnouncement(a));
}

/** Closed (or read on the announcements page): it stops showing as a banner, where it may be closed. */
export function markSeen(userId: string, ids: string[], t = now()) {
  const insert = db.query("INSERT OR IGNORE INTO announcement_seen (announcement_id, user_id, seen_at) SELECT id, $u, $t FROM announcements WHERE id = $id");
  db.transaction(() => {
    for (const id of ids) insert.run({ id, u: userId, t });
  })();
}

// ------------------------------------------------------------ administrators

function audienceSize(audience: Audience): number {
  const where =
    audience === "prepaid"
      ? "billing = 'prepaid'"
      : audience === "exempt"
        ? "billing = 'exempt'"
        : audience === "admins"
          ? "role = 'admin'"
          : "1 = 1";
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM users WHERE disabled = 0 AND ${where}`).get()?.n ?? 0;
}

export function adminAnnouncements(t = now()) {
  const rows = db
    .query<AnnouncementRow & { seen: number; by_name: string | null }, []>(
      `SELECT a.*, (SELECT COUNT(*) FROM announcement_seen s WHERE s.announcement_id = a.id) AS seen, u.display_name AS by_name
         FROM announcements a LEFT JOIN users u ON u.id = a.created_by
        ORDER BY COALESCE(a.starts_at, a.created_at) DESC`,
    )
    .all();
  return rows.map((a) => ({
    ...publicAnnouncement(a),
    audience: a.audience,
    createdAt: a.created_at,
    createdBy: a.by_name,
    status: a.starts_at != null && a.starts_at > t ? ("scheduled" as const) : a.ends_at != null && a.ends_at <= t ? ("ended" as const) : ("active" as const),
    seenBy: a.seen,
    audienceSize: audienceSize(a.audience),
  }));
}

export function createAnnouncement(input: AnnouncementInput, userId: string): string {
  const id = newId(10);
  const t = now();
  db.query(
    `INSERT INTO announcements (id, title, body, level, audience, starts_at, ends_at, dismissible, created_by, created_at, updated_at)
     VALUES ($id, $title, $body, $level, $audience, $starts, $ends, $dismissible, $by, $t, $t)`,
  ).run({
    id,
    title: input.title,
    body: input.body,
    level: input.level,
    audience: input.audience,
    starts: input.startsAt,
    ends: input.endsAt,
    dismissible: input.dismissible ? 1 : 0,
    by: userId,
    t,
  });
  publishAll({ type: "announcements.updated" });
  return id;
}

export function updateAnnouncement(id: string, input: AnnouncementInput): boolean {
  const changed = db
    .query(
      `UPDATE announcements SET title = $title, body = $body, level = $level, audience = $audience, starts_at = $starts,
         ends_at = $ends, dismissible = $dismissible, updated_at = $t WHERE id = $id`,
    )
    .run({
      id,
      title: input.title,
      body: input.body,
      level: input.level,
      audience: input.audience,
      starts: input.startsAt,
      ends: input.endsAt,
      dismissible: input.dismissible ? 1 : 0,
      t: now(),
    }).changes;
  if (!changed) return false;
  if (input.notifyAgain) db.query("DELETE FROM announcement_seen WHERE announcement_id = $id").run({ id });
  publishAll({ type: "announcements.updated" });
  return true;
}

export function deleteAnnouncement(id: string): boolean {
  const changed = db.query("DELETE FROM announcements WHERE id = $id").run({ id }).changes;
  if (changed) publishAll({ type: "announcements.updated" });
  return changed > 0;
}
