import { describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { BUCKETS_MS, bucketOf, flushPerf, percentile, perfReport, recordRequest } from "../src/services/perf";
import { Client, adminClient, memberClient } from "./helpers";

describe("performance statistics", () => {
  test("percentiles come from the time buckets", () => {
    const hist = new Array(BUCKETS_MS.length + 1).fill(0);
    // 100 requests: 50 in (5, 10] ms, 45 in (50, 75], 5 in (300, 500].
    hist[bucketOf(8)] = 50;
    hist[bucketOf(60)] = 45;
    hist[bucketOf(400)] = 5;
    expect(percentile(hist, 0.5)).toBe(10);
    expect(percentile(hist, 0.95)).toBe(75);
    expect(percentile(hist, 0.99)).toBeGreaterThan(300);
    expect(percentile(hist, 0.99)).toBeLessThanOrEqual(500);
    expect(percentile(new Array(BUCKETS_MS.length + 1).fill(0), 0.5)).toBeNull();
  });

  test("API requests are counted by route, never by id; the event stream and pages are not", async () => {
    const c = await memberClient("perf-member");
    await c.get("/api/meetings");
    await c.get("/api/meetings/abc123");
    await c.get("/api/meetings/def456");
    await c.get("/api/nope");
    await c.get("/");
    flushPerf();
    const routes = db.query<{ route: string; count: number }, []>("SELECT route, SUM(count) AS count FROM request_stats GROUP BY route").all();
    const names = routes.map((r) => r.route);
    expect(names).toContain("GET /api/meetings");
    expect(names).toContain("GET /api/meetings/:id");
    expect(names.some((n) => n.includes("abc123"))).toBe(false);
    expect(names).toContain("GET (not found)");
    expect(names.some((n) => n.includes("/api/events"))).toBe(false);
    expect(names.some((n) => n === "GET /" || n.endsWith(" /*"))).toBe(false);
    const byId = routes.find((r) => r.route === "GET /api/meetings/:id")!;
    expect(byId.count).toBeGreaterThanOrEqual(2);
  });

  test("workers' polling is not counted, and rows kept from before are left out of the report", async () => {
    await new Client().post("/internal/jobs/claim", {});
    await new Client().post("/internal/worker/heartbeat", {});
    flushPerf();
    const stored = db.query<{ route: string }, []>("SELECT DISTINCT route FROM request_stats").all().map((r) => r.route);
    expect(stored.some((r) => r.includes("/internal/"))).toBe(false);
    // As stored by an earlier version.
    recordRequest("POST /internal/jobs/claim", 200, 3);
    flushPerf();
    const report = perfReport("1h");
    expect(report.routes.some((r) => r.route.includes("/internal/"))).toBe(false);
  });

  test("a percentile never reads above the slowest request seen", () => {
    for (let i = 0; i < 100; i++) recordRequest("GET /api/clamp-test", 200, 12);
    flushPerf();
    const route = perfReport("1h").routes.find((r) => r.route === "GET /api/clamp-test")!;
    expect(route.maxMs).toBe(12);
    for (const p of [route.p50, route.p95, route.p99]) expect(p!).toBeLessThanOrEqual(12);
  });

  test("the report: overall, a series over the window, routes, and 4xx/5xx kept apart", () => {
    const t = Date.now();
    for (let i = 0; i < 20; i++) recordRequest("GET /api/test-report", 200, 40, t - 5 * 60_000);
    recordRequest("GET /api/test-report", 500, 900, t - 5 * 60_000);
    recordRequest("GET /api/test-report", 404, 3, t - 5 * 60_000);
    // Outside the hour.
    recordRequest("GET /api/test-report", 200, 9000, t - 3 * 3600_000);
    const r = perfReport("1h", t);
    const row = r.routes.find((x) => x.route === "GET /api/test-report")!;
    expect(row.count).toBe(22);
    expect(row.errors).toBe(1);
    expect(row.clientErrors).toBe(1);
    expect(row.p50).toBeGreaterThan(35);
    expect(row.p50).toBeLessThanOrEqual(50);
    expect(row.maxMs).toBe(900);
    expect(r.series.length).toBeGreaterThanOrEqual(59);
    expect(r.series.length).toBeLessThanOrEqual(61);
    expect(r.series.some((p) => p.count >= 22)).toBe(true);
    expect(perfReport("24h", t).routes.find((x) => x.route === "GET /api/test-report")!.count).toBe(23);
  });

  test("only administrators read it, for a known window", async () => {
    const admin = await adminClient();
    const res = await admin.get("/api/admin/perf?window=7d");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.window).toBe("7d");
    expect(body.pipeline.transcription).toHaveProperty("waitSec");
    expect(body.pipeline.summary).toHaveProperty("writeSec");
    expect((await admin.get("/api/admin/perf?window=1y")).status).toBe(422);
    const member = await memberClient("perf-other");
    expect((await member.get("/api/admin/perf")).status).toBe(403);
  });
});

describe("performance statistics and a busy database", () => {
  test("while another program holds the database, timings wait (nothing thrown, nothing lost)", async () => {
    const { Database } = await import("bun:sqlite");
    const { config } = await import("../src/config");
    recordRequest("GET /api/test-locked", 200, 12);
    const other = new Database(config.dbPath);
    other.exec("PRAGMA busy_timeout = 0;");
    other.exec("BEGIN IMMEDIATE");
    try {
      expect(() => flushPerf()).not.toThrow();
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
    flushPerf();
    const row = db.query<{ count: number }, []>("SELECT SUM(count) AS count FROM request_stats WHERE route = 'GET /api/test-locked'").get();
    expect(row?.count).toBe(1);
  }, 15_000);
});
