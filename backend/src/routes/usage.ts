import { Hono } from "hono";
import { requireUser } from "../auth/middleware";
import { db } from "../db";
import { httpError } from "../lib/util";
import { USAGE_RANGES, type UsageRange, usageReport } from "../services/usage";
import type { AppEnv } from "../types";

export const usageRoutes = new Hono<AppEnv>();
usageRoutes.use(requireUser);

/**
 * The usage dashboard: `range` = 30d | 90d | 12m | all. People see their own;
 * an administrator may add `user` = a person's id, or "all" for the whole site.
 */
usageRoutes.get("/", (c) => {
  const me = c.get("user");
  const range = (USAGE_RANGES as readonly string[]).includes(c.req.query("range") ?? "") ? (c.req.query("range") as UsageRange) : "30d";
  const who = c.req.query("user") ?? "";
  let userId: string | null = me.id;
  if (who && who !== me.id) {
    if (me.role !== "admin") httpError(403, "Only administrators can see other people's usage.", "forbidden");
    if (who === "all") userId = null;
    else {
      const exists = db.query<{ id: string }, { id: string }>("SELECT id FROM users WHERE id = $id").get({ id: who });
      if (!exists) httpError(404, "No such user.", "not_found");
      userId = who;
    }
  }
  return c.json(usageReport(userId, range));
});
