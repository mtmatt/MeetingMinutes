import { createHmac } from "node:crypto";
import { z } from "zod";
import { db, now } from "../db";
import { parseJson } from "../lib/util";
import { deleteSetting, readSetting, writeSetting } from "./settingsStore";
import { config } from "../config";
import { isForbiddenHost, isLoopbackUrl } from "./summarySettings";
import { type WorkerCapabilities, canRun } from "./transcriberSettings";
import { effectiveSettings, fallbackDelaySec } from "./workerProfiles";

/**
 * Workers started on demand (a serverless GPU such as Modal).
 *
 * Such a worker is not running while there is nothing to do, so it cannot poll
 * for work. Instead, its remote-worker entry has a wake-up address: when a job
 * it could take is queued (and, for a fallback, has waited its turn) while it is
 * offline, the server POSTs there, and the platform starts the worker, which
 * claims the job like any other and exits once the queue is empty
 * (`mm_worker run --exit-when-idle`).
 *
 * The call carries `X-MM-Wake: t=<ms>,sig=<HMAC-SHA256 over "<t>.<key ID">`,
 * keyed by the SHA-256 (hex) of the worker's token: the server keeps only that
 * hash, and the worker can compute it from its token, so nothing more has to be
 * set up and nobody else can make the worker spend GPU time.
 */

const KEY = "workerWake";

/** After a wake-up call, how long to wait for the worker to come online before calling again. */
export const WAKE_RETRY_MS = 2 * 60_000;
/** Calls for the same job before giving up on it (the worker evidently cannot take it). */
export const WAKE_TRIES_PER_JOB = 3;
/** A worker seen this recently is running (it reports every 20 s). */
const ONLINE_MS = 60_000;

/**
 * An https address on another machine, without a user name or password in it.
 * Not this machine (http or https: the server's own ports and Ollama are not for
 * this), nor the cloud metadata service. Plain http to this machine only in tests.
 */
export const wakeUrlSchema = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((u) => {
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      return false;
    }
    if (url.username || url.password || isForbiddenHost(u)) return false;
    if (config.isTest && url.protocol === "http:" && isLoopbackUrl(u)) return true;
    return url.protocol === "https:" && !isLoopbackUrl(u);
  }, "The wake-up address must be https:// on another machine, such as https://…-wake.modal.run.");

interface WakeState {
  /** Last call: when, and how it went. */
  at: number | null;
  ok: boolean | null;
  status: number | null;
  error: string | null;
  /** The job the last calls were for, and how many there were. */
  jobId: string | null;
  tries: number;
}

const states = new Map<string, WakeState>();
const blank = (): WakeState => ({ at: null, ok: null, status: null, error: null, jobId: null, tries: 0 });

function all(): Record<string, string> {
  const saved = parseJson<Record<string, unknown>>(readSetting(KEY), {});
  const out: Record<string, string> = {};
  for (const [id, v] of Object.entries(saved)) {
    const url = (v as { url?: unknown })?.url;
    if (typeof url === "string" && wakeUrlSchema.safeParse(url).success) out[id] = url;
  }
  return out;
}

export function wakeUrl(keyId: string): string | null {
  return all()[keyId] ?? null;
}

export function setWakeUrl(keyId: string, url: string | null, userId: string | null) {
  const urls = all();
  if (url) urls[keyId] = url;
  else delete urls[keyId];
  states.delete(keyId);
  const value = Object.fromEntries(Object.entries(urls).map(([id, u]) => [id, { url: u }]));
  if (Object.keys(value).length) writeSetting(KEY, value, userId);
  else deleteSetting(KEY);
}

/** Every worker woken on demand: its address and how the last call went. */
export function listWakeState(): Record<string, { url: string } & Omit<WakeState, "jobId" | "tries">> {
  return Object.fromEntries(
    Object.entries(all()).map(([id, url]) => {
      const s = states.get(id) ?? blank();
      return [id, { url, at: s.at, ok: s.ok, status: s.status, error: s.error }];
    }),
  );
}

/** The header value for a call to `keyId`, whose token hashes to `tokenHash`. */
export function wakeSignature(tokenHash: string, keyId: string, t: number): string {
  const sig = createHmac("sha256", tokenHash).update(`${t}.${keyId}`).digest("hex");
  return `t=${t},sig=${sig}`;
}

/**
 * Calls the worker's wake-up address now, or `tryUrl` (an address not saved yet, to test it).
 * Only calls to the saved address are remembered as "the last call".
 */
export async function wakeWorker(
  keyId: string,
  reason: "queued" | "test",
  jobId: string | null = null,
  tryUrl?: string,
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const saved = wakeUrl(keyId);
  const url = tryUrl ?? saved;
  const remember = url === saved;
  const key = db
    .query<{ token_hash: string | null; revoked_at: number | null }, { id: string }>("SELECT token_hash, revoked_at FROM worker_keys WHERE id = $id")
    .get({ id: keyId });
  if (!url) return { ok: false, status: null, error: "No wake-up address is set." };
  if (!key || key.revoked_at || !key.token_hash) return { ok: false, status: null, error: "The worker is not enrolled." };
  const state = remember ? (states.get(keyId) ?? blank()) : blank();
  if (jobId && state.jobId === jobId) state.tries += 1;
  else if (jobId) {
    state.jobId = jobId;
    state.tries = 1;
  }
  const t = now();
  state.at = t;
  if (remember) states.set(keyId, state);
  let result: { ok: boolean; status: number | null; error: string | null };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-MM-Wake": wakeSignature(key.token_hash, keyId, t) },
      body: JSON.stringify({ worker: keyId, reason }),
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    // Only the status: what the other side answers is not read, so it cannot be echoed to the page or the log.
    await res.body?.cancel().catch(() => {});
    result = { ok: res.ok, status: res.status, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    result = { ok: false, status: null, error: (e instanceof Error ? e.message : String(e)).replace(/[^\x20-\x7e]/g, "?").slice(0, 200) };
  }
  Object.assign(state, result);
  if (result.ok) console.log(`[workers] woke ${keyId} (${reason})`);
  else console.warn(`[workers] could not wake ${keyId}: ${result.error}`);
  return result;
}

function online(keyId: string, t: number): boolean {
  return (
    (db
      .query<{ n: number }, { a: string; b: string; since: number }>(
        "SELECT COUNT(*) AS n FROM workers WHERE (id = $a OR id LIKE $b) AND last_seen_at > $since",
      )
      .get({ a: keyId, b: `${keyId}-%`, since: t - ONLINE_MS })?.n ?? 0) > 0
  );
}

/** What the worker reported it can run when it last ran (it is offline now), if it ever did. */
function lastCapabilities(keyId: string): WorkerCapabilities | undefined {
  const row = db
    .query<{ info: string }, { a: string; b: string }>("SELECT info FROM workers WHERE id = $a OR id LIKE $b ORDER BY last_seen_at DESC LIMIT 1")
    .get({ a: keyId, b: `${keyId}-%` });
  const caps = parseJson<{ capabilities?: Partial<WorkerCapabilities> & { keys?: WorkerCapabilities["keys"] } }>(row?.info, {}).capabilities;
  if (!caps || !Array.isArray(caps.asr) || !Array.isArray(caps.diarization)) return undefined;
  return caps as WorkerCapabilities;
}

/**
 * Wakes each on-demand worker that is offline while a job it could take is
 * waiting for it: at most one call per WAKE_RETRY_MS, and WAKE_TRIES_PER_JOB
 * for any one job. Returns the workers called.
 */
export async function wakeSweep(t = now()): Promise<string[]> {
  const urls = all();
  const woken: string[] = [];
  for (const keyId of Object.keys(urls)) {
    if (online(keyId, t)) continue;
    const state = states.get(keyId);
    if (state?.at && t - state.at < WAKE_RETRY_MS) continue;
    const caps = lastCapabilities(keyId);
    const can = caps ? canRun(caps, effectiveSettings(keyId)) : { transcribe: true, voiceprint: true };
    const before = t - fallbackDelaySec(keyId) * 1000;
    const job = db
      .query<{ id: string }, { t: number; v: number; before: number }>(
        `SELECT id FROM jobs WHERE status = 'queued' AND created_at <= $before
           AND ((kind = 'transcribe' AND $t) OR (kind = 'voiceprint' AND $v))
         ORDER BY kind = 'voiceprint', created_at ASC LIMIT 1`,
      )
      .get({ t: can.transcribe ? 1 : 0, v: can.voiceprint ? 1 : 0, before });
    if (!job) continue;
    if (state?.jobId === job.id && state.tries >= WAKE_TRIES_PER_JOB) continue;
    woken.push(keyId);
    await wakeWorker(keyId, "queued", job.id);
  }
  return woken;
}

let pending: ReturnType<typeof setTimeout> | null = null;

/** After a job is queued: look soon (a worker already running usually claims it first). */
export function scheduleWakeCheck(delayMs = 3000) {
  if (pending) return;
  if (!Object.keys(all()).length) return;
  pending = setTimeout(() => {
    pending = null;
    wakeSweep().catch((e) => console.error("[workers] wake-up check failed:", e));
  }, delayMs);
}

/** Tests: forget past calls. */
export function resetWakeState() {
  states.clear();
}
