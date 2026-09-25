import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/middleware";
import { db, now } from "../db";
import { httpError, newId } from "../lib/util";
import { listTemplatesFor, publicTemplate } from "../services/templates";
import type { AppEnv, TemplateRow } from "../types";
import { body } from "./validate";

export const templateRoutes = new Hono<AppEnv>();
templateRoutes.use(requireUser);

const templateInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(""),
  body: z.string().trim().min(1).max(20000),
});

templateRoutes.get("/", (c) => c.json({ templates: listTemplatesFor(c.get("user").id).map(publicTemplate) }));

templateRoutes.post("/", async (c) => {
  const input = await body(c, templateInput);
  const id = newId(9);
  const t = now();
  const count = db.query<{ n: number }, { u: string }>("SELECT COUNT(*) AS n FROM templates WHERE owner_id = $u").get({ u: c.get("user").id })?.n ?? 0;
  if (count >= 200) httpError(409, "Template limit reached.", "limit");
  db.query(
    `INSERT INTO templates (id, owner_id, builtin, name, description, body, created_at, updated_at)
     VALUES ($id, $u, 0, $name, $description, $body, $t, $t)`,
  ).run({ id, u: c.get("user").id, ...input, t });
  const row = db.query<TemplateRow, { id: string }>("SELECT * FROM templates WHERE id = $id").get({ id })!;
  return c.json({ template: publicTemplate(row) }, 201);
});

templateRoutes.patch("/:id", async (c) => {
  const input = await body(c, templateInput.partial());
  const r = db
    .query(
      `UPDATE templates SET name = COALESCE($name, name), description = COALESCE($description, description),
         body = COALESCE($body, body), updated_at = $t WHERE id = $id AND owner_id = $u AND builtin = 0`,
    )
    .run({
      id: c.req.param("id"),
      u: c.get("user").id,
      name: input.name ?? null,
      description: input.description ?? null,
      body: input.body ?? null,
      t: now(),
    });
  if (r.changes === 0) httpError(404, "Template not found or not editable.", "not_found");
  const row = db.query<TemplateRow, { id: string }>("SELECT * FROM templates WHERE id = $id").get({ id: c.req.param("id") })!;
  return c.json({ template: publicTemplate(row) });
});

templateRoutes.delete("/:id", (c) => {
  const r = db
    .query("DELETE FROM templates WHERE id = $id AND owner_id = $u AND builtin = 0")
    .run({ id: c.req.param("id"), u: c.get("user").id });
  if (r.changes === 0) httpError(404, "Template not found or not editable.", "not_found");
  return c.json({ ok: true });
});
