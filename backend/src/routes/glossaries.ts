import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/middleware";
import { db, now } from "../db";
import { httpError, newId } from "../lib/util";
import type { AppEnv, GlossaryRow } from "../types";
import { body } from "./validate";

/**
 * A person's lists of terms (names, products, acronyms): kept here, added to
 * a recording's vocabulary on the upload page, which is what the speech
 * recognition reads. The same limit as that field applies to each list.
 */
export const glossaryRoutes = new Hono<AppEnv>();
glossaryRoutes.use(requireUser);

const MAX_LISTS = 100;

/** Terms one to a line, whatever separators they were typed with; repeats dropped. */
export function normalizeTerms(raw: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,，、;；\n]+/)) {
    const term = part.trim().replace(/\s+/g, " ");
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    out.push(term);
  }
  return out.join("\n");
}

const input = z.object({
  name: z.string().trim().min(1).max(80),
  terms: z
    .string()
    .max(4000)
    .transform(normalizeTerms)
    .refine((s) => s.length > 0, "Add at least one term.")
    .refine((s) => s.split("\n").join(", ").length <= 2000, "A list can be at most 2,000 characters."),
});

function publicGlossary(g: GlossaryRow) {
  const terms = g.terms.split("\n").filter(Boolean);
  return { id: g.id, name: g.name, terms, createdAt: g.created_at, updatedAt: g.updated_at };
}

function owned(userId: string, id: string): GlossaryRow {
  const g = db.query<GlossaryRow, { id: string; u: string }>("SELECT * FROM glossaries WHERE id = $id AND owner_id = $u").get({ id, u: userId });
  if (!g) httpError(404, "List not found.", "not_found");
  return g;
}

glossaryRoutes.get("/", (c) => {
  const rows = db
    .query<GlossaryRow, { u: string }>("SELECT * FROM glossaries WHERE owner_id = $u ORDER BY name COLLATE NOCASE, created_at")
    .all({ u: c.get("user").id });
  return c.json({ glossaries: rows.map(publicGlossary) });
});

glossaryRoutes.post("/", async (c) => {
  const user = c.get("user");
  const v = await body(c, input);
  const count = db.query<{ n: number }, { u: string }>("SELECT COUNT(*) AS n FROM glossaries WHERE owner_id = $u").get({ u: user.id })?.n ?? 0;
  if (count >= MAX_LISTS) httpError(409, `You can keep at most ${MAX_LISTS} lists.`, "limit");
  const id = newId(10);
  const t = now();
  db.query("INSERT INTO glossaries (id, owner_id, name, terms, created_at, updated_at) VALUES ($id, $u, $name, $terms, $t, $t)").run({
    id,
    u: user.id,
    name: v.name,
    terms: v.terms,
    t,
  });
  return c.json({ glossary: publicGlossary(owned(user.id, id)) }, 201);
});

glossaryRoutes.put("/:id", async (c) => {
  const user = c.get("user");
  const g = owned(user.id, c.req.param("id"));
  const v = await body(c, input);
  db.query("UPDATE glossaries SET name = $name, terms = $terms, updated_at = $t WHERE id = $id").run({ id: g.id, name: v.name, terms: v.terms, t: now() });
  return c.json({ glossary: publicGlossary(owned(user.id, g.id)) });
});

glossaryRoutes.delete("/:id", (c) => {
  const g = owned(c.get("user").id, c.req.param("id"));
  db.query("DELETE FROM glossaries WHERE id = $id").run({ id: g.id });
  return c.json({ ok: true });
});
