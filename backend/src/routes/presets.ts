import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/middleware";
import { db, now } from "../db";
import { httpError, newId, parseJson } from "../lib/util";
import type { AppEnv, SummaryRequest, TranscribeOptions } from "../types";
import { optionsSchema, summaryRequestSchema } from "./meetings";
import { SMALL_JSON_LIMIT_BYTES, body } from "./validate";

/**
 * Presets: a person's named settings for adding a recording (language,
 * speakers, vocabulary, script, and whether and how to summarise), applied in
 * one click on the upload page. The default one is applied by itself.
 */
export const presetRoutes = new Hono<AppEnv>();
presetRoutes.use(requireUser);

const MAX_PRESETS = 30;

interface PresetRow {
  id: string;
  owner_id: string;
  name: string;
  options: string;
  summary: string | null;
  is_default: number;
  created_at: number;
  updated_at: number;
}

const presetInput = z.object({
  name: z.string().trim().min(1, "Give the preset a name.").max(60),
  options: optionsSchema,
  /** The automatic summary: null for none. */
  summary: summaryRequestSchema.nullable(),
  isDefault: z.boolean().default(false),
});

function publicPreset(r: PresetRow) {
  return {
    id: r.id,
    name: r.name,
    options: parseJson<TranscribeOptions>(r.options, optionsSchema.parse({})),
    summary: parseJson<SummaryRequest | null>(r.summary, null),
    isDefault: !!r.is_default,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function list(userId: string) {
  return db
    .query<PresetRow, { u: string }>("SELECT * FROM transcribe_presets WHERE owner_id = $u ORDER BY is_default DESC, name COLLATE NOCASE")
    .all({ u: userId })
    .map(publicPreset);
}

function owned(userId: string, id: string): PresetRow {
  const row = db.query<PresetRow, { id: string; u: string }>("SELECT * FROM transcribe_presets WHERE id = $id AND owner_id = $u").get({ id, u: userId });
  if (!row) httpError(404, "Preset not found.", "not_found");
  return row!;
}

function nameTaken(userId: string, name: string, except?: string): boolean {
  return !!db
    .query<{ id: string }, { u: string; n: string; e: string }>(
      "SELECT id FROM transcribe_presets WHERE owner_id = $u AND name = $n AND id != $e",
    )
    .get({ u: userId, n: name, e: except ?? "" });
}

/** Write a preset, keeping at most one default per person. */
function save(userId: string, id: string, input: z.infer<typeof presetInput>, created: boolean) {
  const t = now();
  db.transaction(() => {
    if (input.isDefault) db.query("UPDATE transcribe_presets SET is_default = 0 WHERE owner_id = $u").run({ u: userId });
    const values = {
      id,
      u: userId,
      name: input.name,
      options: JSON.stringify(input.options),
      summary: input.summary ? JSON.stringify(input.summary) : null,
      d: input.isDefault ? 1 : 0,
      t,
    };
    if (created) {
      db.query(
        `INSERT INTO transcribe_presets (id, owner_id, name, options, summary, is_default, created_at, updated_at)
         VALUES ($id, $u, $name, $options, $summary, $d, $t, $t)`,
      ).run(values);
    } else {
      db.query(
        `UPDATE transcribe_presets SET name = $name, options = $options, summary = $summary, is_default = $d, updated_at = $t
         WHERE id = $id AND owner_id = $u`,
      ).run(values);
    }
  })();
}

presetRoutes.get("/", (c) => c.json({ presets: list(c.get("user").id) }));

presetRoutes.post("/", async (c) => {
  const user = c.get("user");
  const input = await body(c, presetInput, SMALL_JSON_LIMIT_BYTES);
  const count = db.query<{ n: number }, { u: string }>("SELECT COUNT(*) AS n FROM transcribe_presets WHERE owner_id = $u").get({ u: user.id })!.n;
  if (count >= MAX_PRESETS) httpError(409, `You can keep up to ${MAX_PRESETS} presets; delete one first.`, "limit");
  if (nameTaken(user.id, input.name)) httpError(409, "You already have a preset with this name.", "name_taken");
  const id = newId(10);
  save(user.id, id, input, true);
  return c.json({ preset: publicPreset(owned(user.id, id)), presets: list(user.id) }, 201);
});

presetRoutes.put("/:id", async (c) => {
  const user = c.get("user");
  const row = owned(user.id, c.req.param("id"));
  const input = await body(c, presetInput, SMALL_JSON_LIMIT_BYTES);
  if (nameTaken(user.id, input.name, row.id)) httpError(409, "You already have a preset with this name.", "name_taken");
  save(user.id, row.id, input, false);
  return c.json({ preset: publicPreset(owned(user.id, row.id)), presets: list(user.id) });
});

presetRoutes.delete("/:id", (c) => {
  const user = c.get("user");
  const row = owned(user.id, c.req.param("id"));
  db.query("DELETE FROM transcribe_presets WHERE id = $id").run({ id: row.id });
  return c.json({ presets: list(user.id) });
});
