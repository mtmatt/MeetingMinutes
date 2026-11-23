import { z } from "zod";
import { db, now } from "../db";
import { parseJson } from "../lib/util";
import { deleteSetting, readSetting, writeSetting } from "./settingsStore";
import {
  ASR_ENGINES,
  type AsrEngine,
  type AsrProvider,
  DIARIZATION_ENGINES,
  type DiarizationEngine,
  type TranscriberSettings,
  apiAddress,
  transcriberSettings,
} from "./transcriberSettings";
import { isLoopbackUrl } from "./summarySettings";

/**
 * Settings per worker machine, over the site-wide ones (Admin → Transcription).
 *
 * A machine is "local" (the workers on this server, sharing WORKER_TOKEN) or a
 * remote worker's key ID. Each may recognise speech and separate speakers its
 * own way (a Mac on its GPU, the server through the API and its CPU), and may
 * be a fallback: it takes a job only once the job has waited `fallbackSec`
 * while another worker is online. Fields left out follow the site-wide settings.
 */

export const LOCAL_PROFILE = "local";
export const DEFAULT_FALLBACK_SEC = 120;

export const workerProfileSchema = z.object({
  engine: z.enum(ASR_ENGINES).nullable(),
  diarization: z.enum(DIARIZATION_ENGINES).nullable(),
  /** null: not a fallback. */
  fallbackSec: z.number().int().min(10).max(86_400).nullable(),
});

export type WorkerProfile = z.infer<typeof workerProfileSchema>;

const KEY = "workerProfiles";
const EMPTY: WorkerProfile = { engine: null, diarization: null, fallbackSec: null };

function allProfiles(): Record<string, WorkerProfile> {
  const value = readSetting(KEY);
  if (value === null) return {};
  const saved = parseJson<Record<string, unknown>>(value, {});
  const out: Record<string, WorkerProfile> = {};
  for (const [id, p] of Object.entries(saved)) {
    const parsed = workerProfileSchema.safeParse({ ...EMPTY, ...(p as object) });
    if (parsed.success) out[id] = parsed.data;
  }
  return out;
}

export function workerProfile(id: string): WorkerProfile {
  return allProfiles()[id] ?? EMPTY;
}

export function listWorkerProfiles(): Record<string, WorkerProfile> {
  return allProfiles();
}

export function saveWorkerProfile(id: string, profile: WorkerProfile, userId: string): WorkerProfile {
  const all = allProfiles();
  const value = workerProfileSchema.parse(profile);
  if (value.engine === null && value.diarization === null && value.fallbackSec === null) delete all[id];
  else all[id] = value;
  if (Object.keys(all).length) writeSetting(KEY, all, userId);
  else deleteSetting(KEY);
  return workerProfile(id);
}

export function deleteWorkerProfile(id: string) {
  const all = allProfiles();
  if (!(id in all)) return;
  delete all[id];
  if (Object.keys(all).length) writeSetting(KEY, all, null);
  else deleteSetting(KEY);
}

/** The machine a worker ID belongs to: its key's ID for a remote worker, else "local". */
export function profileIdFor(keyId: string | null): string {
  return keyId ?? LOCAL_PROFILE;
}

/** The settings a machine works under: its own choices over the site-wide ones. */
export function effectiveSettings(profileId: string, global: TranscriberSettings = transcriberSettings()): TranscriberSettings {
  const p = workerProfile(profileId);
  return { ...global, engine: p.engine ?? global.engine, diarization: p.diarization ?? global.diarization };
}

/** The profile of a worker ID as stored in the workers table (remote IDs start with their key ID). */
function profileOfWorkerId(workerId: string, keyIds: string[]): string {
  const key = keyIds.find((k) => workerId === k || workerId.startsWith(`${k}-`));
  return key ?? LOCAL_PROFILE;
}

/**
 * Seconds a fallback machine lets a job wait before taking it: its setting,
 * but 0 when no other machine that is not a fallback is online, so a lone
 * fallback never sits on work.
 */
export function fallbackDelaySec(profileId: string): number {
  const fallback = workerProfile(profileId).fallbackSec;
  if (!fallback) return 0;
  const keys = db.query<{ id: string }, []>("SELECT id FROM worker_keys WHERE revoked_at IS NULL").all().map((r) => r.id);
  const online = db
    .query<{ id: string }, { since: number }>("SELECT id FROM workers WHERE last_seen_at > $since")
    .all({ since: now() - 60_000 });
  const others = online.map((w) => profileOfWorkerId(w.id, keys)).filter((p) => p !== profileId && !workerProfile(p).fallbackSec);
  return others.length ? fallback : 0;
}

/** Machines whose settings matter for what people are told: this server's workers and every enrolled one. */
function activeProfileIds(): string[] {
  const keys = db
    .query<{ id: string }, []>("SELECT id FROM worker_keys WHERE revoked_at IS NULL AND enrolled_at IS NOT NULL")
    .all()
    .map((r) => r.id);
  return [LOCAL_PROFILE, ...keys];
}

/**
 * What people uploading a recording are told about where it is transcribed,
 * over every machine that may take it: speech may go to the transcription API
 * if any of them uses it, and the whole recording to pyannoteAI likewise.
 */
export function publicTranscriberInfo(global: TranscriberSettings = transcriberSettings()): {
  engine: AsrEngine;
  diarization: DiarizationEngine;
  provider: AsrProvider | null;
  model: string | null;
  onServer: boolean;
  host: string | null;
  /** Some machines recognise speech locally and others through the API: say "may". */
  mixed: boolean;
  /** Some machines separate speakers with pyannoteAI and others do not. */
  diarizationMixed: boolean;
} {
  const all = activeProfileIds().map((id) => effectiveSettings(id, global));
  const api = all.some((s) => s.engine === "api");
  const local = all.some((s) => s.engine === "local");
  const cloud = all.some((s) => s.diarization === "pyannoteai");
  const notCloud = all.some((s) => s.diarization !== "pyannoteai");
  const diarization: DiarizationEngine = cloud ? "pyannoteai" : all.some((s) => s.diarization === "local") ? "local" : "cpu";
  if (!api) return { engine: "local", diarization, provider: null, model: null, onServer: true, host: null, mixed: false, diarizationMixed: cloud && notCloud };
  const address = apiAddress(global.api);
  const onServer = isLoopbackUrl(address);
  return {
    engine: "api",
    diarization,
    provider: global.api.provider,
    model: global.api.model,
    onServer,
    host: onServer ? null : new URL(address).host,
    mixed: local,
    diarizationMixed: cloud && notCloud,
  };
}
