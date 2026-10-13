import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/middleware";
import { db, now } from "../db";
import { httpError } from "../lib/util";
import {
  deleteProfile,
  deleteSample,
  getProfile,
  mergeProfiles,
  profileList,
  recognitionEnabled,
  renameProfile,
  scanPastMeetings,
  scanStatus,
} from "../services/voices";
import { config } from "../config";
import type { AppEnv, VoiceProfileRow } from "../types";
import { body } from "./validate";

/** The people each user has named, remembered by voice. Everything here is the signed-in user's own. */
export const voiceRoutes = new Hono<AppEnv>();
voiceRoutes.use(requireUser);

function state(userId: string) {
  return {
    enabled: recognitionEnabled(userId),
    minSpeechSec: config.voice.minSpeechSec,
    profiles: profileList(userId),
    scan: scanStatus(userId),
  };
}

voiceRoutes.get("/", (c) => c.json(state(c.get("user").id)));

voiceRoutes.patch("/settings", async (c) => {
  const input = await body(c, z.object({ enabled: z.boolean() }));
  const user = c.get("user");
  db.query("UPDATE users SET voice_recognition = $v, updated_at = $t WHERE id = $id").run({ id: user.id, v: input.enabled ? 1 : 0, t: now() });
  return c.json(state(user.id));
});

/** Remember everyone already named in past recordings, and recognise the rest. */
voiceRoutes.post("/scan", (c) => {
  const user = c.get("user");
  if (!recognitionEnabled(user.id)) httpError(409, "Voice recognition is turned off.", "voice_off");
  const outcome = scanPastMeetings(user.id);
  return c.json({ ...state(user.id), outcome });
});

function ownedProfile(userId: string, id: string): VoiceProfileRow {
  const p = getProfile(userId, id);
  if (!p) httpError(404, "Voice profile not found.", "not_found");
  return p;
}

voiceRoutes.patch("/:id", async (c) => {
  const user = c.get("user");
  const p = ownedProfile(user.id, c.req.param("id"));
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(80) }));
  const other = db
    .query<{ id: string }, { o: string; n: string; id: string }>("SELECT id FROM voice_profiles WHERE owner_id = $o AND name = $n AND id != $id")
    .get({ o: user.id, n: input.name, id: p.id });
  if (other) {
    return c.json({ error: "Another voice profile has this name.", code: "name_taken", profileId: other.id }, 409);
  }
  renameProfile(user.id, p.id, input.name);
  return c.json(state(user.id));
});

/** The same person under two names: keep `into`, and move this profile's voices and speakers to it. */
voiceRoutes.post("/:id/merge", async (c) => {
  const user = c.get("user");
  const from = ownedProfile(user.id, c.req.param("id"));
  const input = await body(c, z.object({ into: z.string().min(1).max(64) }));
  const into = ownedProfile(user.id, input.into);
  if (into.id === from.id) httpError(422, "A voice profile cannot be merged into itself.", "invalid_input");
  mergeProfiles(user.id, from.id, into.id);
  return c.json(state(user.id));
});

voiceRoutes.delete("/:id", (c) => {
  const user = c.get("user");
  const p = ownedProfile(user.id, c.req.param("id"));
  deleteProfile(user.id, p.id);
  return c.json(state(user.id));
});

voiceRoutes.delete("/:id/samples/:sampleId", (c) => {
  const user = c.get("user");
  const p = ownedProfile(user.id, c.req.param("id"));
  const sampleId = Number(c.req.param("sampleId"));
  if (!Number.isSafeInteger(sampleId) || !deleteSample(user.id, p.id, sampleId)) httpError(404, "Voice sample not found.", "not_found");
  return c.json(state(user.id));
});
