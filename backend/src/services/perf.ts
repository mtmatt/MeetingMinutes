import type { MiddlewareHandler } from "hono";
import { matchedRoutes, routePath } from "hono/route";
import { db, now } from "../db";
import type { AppEnv } from "../types";

/**
 * How fast the site answers, for the administrators' statistics page.
 *
 * Every API request's time (from arriving to the response being ready) is
 * counted per minute and per route ("GET /api/meetings/:id", never the ids
 * themselves) into fixed time buckets. Percentiles (p50, p95, p99) for any
 * period are read from the summed buckets, so nothing per request is kept:
 * a few hundred bytes per route and minute, kept for RETENTION_DAYS.
 */

/** Upper bounds of the time buckets, in milliseconds; one more bucket holds everything slower. */
export const BUCKETS_MS = [2, 5, 10, 20, 35, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, 30000];
const RETENTION_DAYS = 30;
const MINUTE = 60_000;

interface Agg {
  count: number;
  /** 5xx answers. */
  errors: number;
  /** 4xx answers. */
  clientErrors: number;
  sumMs: number;
  maxMs: number;
  hist: number[];
}

const emptyAgg = (): Agg => ({ count: 0, errors: 0, clientErrors: 0, sumMs: 0, maxMs: 0, hist: new Array(BUCKETS_MS.length + 1).fill(0) });

/** Requests not yet written, by minute and route. */
let pending = new Map<string, Agg>();

export function bucketOf(ms: number): number {
  for (let i = 0; i < BUCKETS_MS.length; i++) if (ms <= BUCKETS_MS[i]!) return i;
  return BUCKETS_MS.length;
}

export function recordRequest(route: string, status: number, ms: number, at = now()) {
  const minute = Math.floor(at / MINUTE) * MINUTE;
  const key = `${minute}\u0000${route}`;
  let a = pending.get(key);
  if (!a) {
    a = emptyAgg();
    pending.set(key, a);
  }
  a.count++;
  if (status >= 500) a.errors++;
  else if (status >= 400) a.clientErrors++;
  a.sumMs += ms;
  a.maxMs = Math.max(a.maxMs, ms);
  a.hist[bucketOf(ms)]!++;
}

/** Write what was counted (every minute, and before reading). */
export function flushPerf() {
  if (pending.size === 0) return;
  const batch = pending;
  pending = new Map();
  const read = db.query<{ count: number; errors: number; client_errors: number; sum_ms: number; max_ms: number; hist: string }, { m: number; r: string }>(
    "SELECT count, errors, client_errors, sum_ms, max_ms, hist FROM request_stats WHERE minute = $m AND route = $r",
  );
  const write = db.query(
    `INSERT OR REPLACE INTO request_stats (minute, route, count, errors, client_errors, sum_ms, max_ms, hist)
     VALUES ($m, $r, $count, $errors, $client, $sum, $max, $hist)`,
  );
  db.transaction(() => {
    for (const [key, a] of batch) {
      const [m, r] = key.split("\u0000") as [string, string];
      const old = read.get({ m: Number(m), r });
      const hist = old ? (JSON.parse(old.hist) as number[]).map((n, i) => n + (a.hist[i] ?? 0)) : a.hist;
      write.run({
        m: Number(m),
        r,
        count: a.count + (old?.count ?? 0),
        errors: a.errors + (old?.errors ?? 0),
        client: a.clientErrors + (old?.client_errors ?? 0),
        sum: a.sumMs + (old?.sum_ms ?? 0),
        max: Math.max(a.maxMs, old?.max_ms ?? 0),
        hist: JSON.stringify(hist),
      });
    }
  })();
}

export function prunePerf(t = now()) {
  db.query("DELETE FROM request_stats WHERE minute < $before").run({ before: t - RETENTION_DAYS * 24 * 3600 * 1000 });
}

/** The route a request matched, as registered ("/api/meetings/:id"); null for what is not counted. */
function routeOf(c: Parameters<MiddlewareHandler<AppEnv>>[0]): string | null {
  const path = c.req.path;
  if (!path.startsWith("/api/") && !path.startsWith("/internal/")) return null;
  // A stream that stays open as long as the page does: its "time" says nothing.
  if (path === "/api/events" || path.startsWith("/api/events/")) return null;
  // The route whose handler answered (Hono leaves its index on the request once it has run).
  const index = (c.req as unknown as { routeIndex?: number }).routeIndex;
  const r = index != null ? matchedRoutes(c)[index] : undefined;
  let pattern = r ? routePath(c, index) : null;
  // Middleware and catch-alls ("*", "/api/*") answer only what nothing else did.
  if (!pattern || /(^|\/)\*$/.test(pattern)) pattern = null;
  return `${c.req.method} ${pattern ?? "(not found)"}`;
}

/** Times every API request; mounted first, so the time includes everything after it. */
export const perfTimer: MiddlewareHandler<AppEnv> = async (c, next) => {
  const start = performance.now();
  try {
    await next();
  } finally {
    const route = routeOf(c);
    if (route) recordRequest(route, c.res?.status ?? 500, performance.now() - start);
  }
};

// ------------------------------------------------------------------ reading

export function percentile(hist: number[], q: number): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const rank = q * total;
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    const n = hist[i]!;
    if (seen + n >= rank && n > 0) {
      const lo = i === 0 ? 0 : BUCKETS_MS[i - 1]!;
      // Everything slower than the last bound: report the bound (a lower limit).
      if (i === BUCKETS_MS.length) return lo;
      const hi = BUCKETS_MS[i]!;
      return lo + ((rank - seen) / n) * (hi - lo);
    }
    seen += n;
  }
  return BUCKETS_MS[BUCKETS_MS.length - 1]!;
}

interface Row {
  minute: number;
  route: string;
  count: number;
  errors: number;
  client_errors: number;
  sum_ms: number;
  max_ms: number;
  hist: string;
}

function summarize(rows: Row[]) {
  const hist = new Array(BUCKETS_MS.length + 1).fill(0) as number[];
  let count = 0;
  let errors = 0;
  let clientErrors = 0;
  let sum = 0;
  let max = 0;
  for (const r of rows) {
    count += r.count;
    errors += r.errors;
    clientErrors += r.client_errors;
    sum += r.sum_ms;
    max = Math.max(max, r.max_ms);
    (JSON.parse(r.hist) as number[]).forEach((n, i) => (hist[i]! += n));
  }
  return {
    count,
    errors,
    clientErrors,
    meanMs: count ? sum / count : null,
    maxMs: count ? max : null,
    p50: percentile(hist, 0.5),
    p90: percentile(hist, 0.9),
    p95: percentile(hist, 0.95),
    p99: percentile(hist, 0.99),
  };
}

export const PERF_WINDOWS = { "1h": 3600_000, "24h": 24 * 3600_000, "7d": 7 * 24 * 3600_000, "30d": 30 * 24 * 3600_000 } as const;
export type PerfWindow = keyof typeof PERF_WINDOWS;
/** Points on the chart for each window: a minute, 15 minutes, an hour, four hours. */
const STEP: Record<PerfWindow, number> = { "1h": MINUTE, "24h": 15 * MINUTE, "7d": 60 * MINUTE, "30d": 4 * 60 * MINUTE };

/** p-th percentile of plain values (exact). */
function exact(values: number[], q: number): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo]! + (v[hi]! - v[lo]!) * (pos - lo);
}

function spread(values: number[]) {
  return { count: values.length, p50: exact(values, 0.5), p95: exact(values, 0.95), max: values.length ? Math.max(...values) : null };
}

/**
 * How long the work people wait for took, in the window: transcriptions (in
 * the queue, then processing, and processing per minute of recording) and
 * summaries (in the queue, then writing), in seconds.
 */
function pipeline(since: number) {
  const jobs = db
    .query<{ created_at: number; claimed_at: number | null; finished_at: number; duration_sec: number | null }, { since: number }>(
      `SELECT j.created_at, j.claimed_at, j.finished_at, m.duration_sec FROM jobs j JOIN meetings m ON m.id = j.meeting_id
        WHERE j.kind = 'transcribe' AND j.status = 'done' AND j.finished_at >= $since`,
    )
    .all({ since });
  const failedJobs =
    db
      .query<{ n: number }, { since: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'transcribe' AND status = 'failed' AND finished_at >= $since")
      .get({ since })?.n ?? 0;
  const sums = db
    .query<{ created_at: number; started_at: number | null; finished_at: number }, { since: number }>(
      "SELECT created_at, started_at, finished_at FROM summaries WHERE status = 'done' AND finished_at >= $since",
    )
    .all({ since });
  const failedSums =
    db.query<{ n: number }, { since: number }>("SELECT COUNT(*) AS n FROM summaries WHERE status = 'failed' AND finished_at >= $since").get({ since })?.n ?? 0;
  const s = (ms: number) => ms / 1000;
  const claimed = jobs.filter((j) => j.claimed_at != null);
  return {
    transcription: {
      done: jobs.length,
      failed: failedJobs,
      waitSec: spread(claimed.map((j) => s(j.claimed_at! - j.created_at))),
      processSec: spread(claimed.map((j) => s(j.finished_at - j.claimed_at!))),
      // Processing time per second of recording (0.1: an hour takes six minutes).
      realtimeFactor: spread(claimed.filter((j) => (j.duration_sec ?? 0) > 0).map((j) => s(j.finished_at - j.claimed_at!) / j.duration_sec!)),
    },
    summary: {
      done: sums.length,
      failed: failedSums,
      waitSec: spread(sums.filter((x) => x.started_at != null).map((x) => s(x.started_at! - x.created_at))),
      writeSec: spread(sums.filter((x) => x.started_at != null).map((x) => s(x.finished_at - x.started_at!))),
    },
  };
}

export function perfReport(window: PerfWindow, t = now()) {
  flushPerf();
  const span = PERF_WINDOWS[window];
  const step = STEP[window];
  const since = Math.floor((t - span) / step) * step + step;
  const rows = db.query<Row, { since: number }>("SELECT * FROM request_stats WHERE minute >= $since ORDER BY minute").all({ since });

  const byRoute = new Map<string, Row[]>();
  const byStep = new Map<number, Row[]>();
  for (const r of rows) {
    (byRoute.get(r.route) ?? byRoute.set(r.route, []).get(r.route)!).push(r);
    const at = Math.floor(r.minute / step) * step;
    (byStep.get(at) ?? byStep.set(at, []).get(at)!).push(r);
  }
  const series: { at: number; count: number; errors: number; p50: number | null; p95: number | null }[] = [];
  for (let at = since; at <= t; at += step) {
    const sm = summarize(byStep.get(at) ?? []);
    series.push({ at, count: sm.count, errors: sm.errors, p50: sm.p50, p95: sm.p95 });
  }
  return {
    window,
    stepMs: step,
    since,
    until: t,
    overall: summarize(rows),
    series,
    routes: [...byRoute.entries()].map(([route, rs]) => ({ route, ...summarize(rs) })).sort((a, b) => b.count - a.count),
    pipeline: pipeline(t - span),
  };
}
