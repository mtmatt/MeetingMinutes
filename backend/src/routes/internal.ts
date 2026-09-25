import { Hono } from "hono";
import { z } from "zod";
import { requireWorker } from "../auth/middleware";
import { db, now } from "../db";
import { claimJob, completeJob, failJob, reportProgress } from "../services/meetings";
import { body } from "./validate";

/** API used by GPU workers. Authenticated with the shared WORKER_TOKEN. */
export const internalRoutes = new Hono();
internalRoutes.use(requireWorker);

const workerId = z.string().min(1).max(128);

function seen(id: string, name?: string, info?: unknown) {
  db.query(
    `INSERT INTO workers (id, name, info, last_seen_at) VALUES ($id, $name, $info, $t)
     ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at,
       name = CASE WHEN $hasName THEN excluded.name ELSE workers.name END,
       info = CASE WHEN $hasInfo THEN excluded.info ELSE workers.info END`,
  ).run({
    id,
    name: name ?? id,
    info: JSON.stringify(info ?? {}),
    hasName: name ? 1 : 0,
    hasInfo: info ? 1 : 0,
    t: now(),
  });
}

internalRoutes.post("/worker/heartbeat", async (c) => {
  const input = await body(c, z.object({ workerId, name: z.string().max(128).optional(), info: z.record(z.string(), z.unknown()).optional() }));
  seen(input.workerId, input.name, input.info);
  return c.json({ ok: true });
});

internalRoutes.post("/jobs/claim", async (c) => {
  const input = await body(c, z.object({ workerId }));
  seen(input.workerId);
  const job = claimJob(input.workerId);
  if (!job) return c.body(null, 204);
  return c.json({ job });
});

internalRoutes.post("/jobs/:id/progress", async (c) => {
  const input = await body(c, z.object({ workerId, stage: z.string().max(64), progress: z.number().min(0).max(1) }));
  seen(input.workerId);
  const ok = reportProgress(c.req.param("id"), input.workerId, input.stage, input.progress);
  return c.json({ continue: ok });
});

const resultSchema = z.object({
  durationSec: z.number().nonnegative(),
  language: z.string().max(64).nullable(),
  hasVideo: z.boolean(),
  hasPlayback: z.boolean(),
  hasPeaks: z.boolean(),
  speakers: z.array(z.string().max(64)).max(64),
  segments: z
    .array(
      z.object({
        start: z.number().nonnegative(),
        end: z.number().nonnegative(),
        speaker: z.string().max(64).nullable(),
        text: z.string().max(20000),
      }),
    )
    .max(200000),
});

internalRoutes.post("/jobs/:id/complete", async (c) => {
  const input = await body(c, z.object({ workerId, result: resultSchema }));
  seen(input.workerId);
  const ok = completeJob(c.req.param("id"), input.workerId, input.result);
  return c.json({ accepted: ok }, ok ? 200 : 409);
});

internalRoutes.post("/jobs/:id/fail", async (c) => {
  const input = await body(c, z.object({ workerId, error: z.string().max(4000), retryable: z.boolean().default(false) }));
  seen(input.workerId);
  const ok = failJob(c.req.param("id"), input.workerId, input.error, input.retryable);
  return c.json({ accepted: ok }, ok ? 200 : 409);
});
