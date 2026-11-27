import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/middleware";
import { announcementsFor, markSeen } from "../services/announcements";
import type { AppEnv } from "../types";
import { body } from "./validate";

export const announcementRoutes = new Hono<AppEnv>();
announcementRoutes.use(requireUser);

/** Announcements for the signed-in person: those in effect (and which they closed), and recent past ones. */
announcementRoutes.get("/", (c) => c.json(announcementsFor(c.get("user"))));

/** Closed a banner, or read them on the announcements page. */
announcementRoutes.post("/seen", async (c) => {
  const input = await body(c, z.object({ ids: z.array(z.string().max(40)).min(1).max(50) }));
  markSeen(c.get("user"), input.ids);
  return c.json(announcementsFor(c.get("user")));
});
