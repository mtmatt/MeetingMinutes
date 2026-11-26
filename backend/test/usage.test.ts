import { describe, expect, test } from "bun:test";
import { db, now } from "../src/db";
import { usageReport } from "../src/services/usage";
import { adminClient, memberClient } from "./helpers";

const DAY = 86_400_000;
let n = 0;

/** A recording with one finished transcription `daysAgo`, and its summaries. */
function seed(owner: string, opts: { daysAgo: number; sec: number; lang?: string; charged?: number; summaries?: { template: string | null; input: number | null; output: number; charged?: number; by?: string }[] }) {
  const id = `usage-m${++n}`;
  const t = now() - opts.daysAgo * DAY;
  db.query(
    `INSERT INTO meetings (id, owner_id, title, status, media_name, media_mime, media_size, media_ext, duration_sec, language, created_at, updated_at, occurred_at)
     VALUES ($id, $o, $title, 'ready', 'a.wav', 'audio/wav', 1000, 'wav', $sec, $lang, $t, $t, $t)`,
  ).run({ id, o: owner, title: `Meeting ${n}`, sec: opts.sec, lang: opts.lang ?? "Chinese", t });
  db.query(`INSERT INTO jobs (id, meeting_id, status, created_at, finished_at, kind, charged) VALUES ($id, $m, 'done', $t, $t, 'transcribe', $c)`).run({
    id: `${id}-j`,
    m: id,
    t,
    c: opts.charged ?? null,
  });
  (opts.summaries ?? []).forEach((s, i) =>
    db
      .query(
        `INSERT INTO summaries (id, meeting_id, created_by, template_name, prompt, output_language, status, created_at, finished_at, usage, charged, model)
         VALUES ($id, $m, $by, $tpl, 'p', 'zh-TW', 'done', $t, $t, $usage, $c, 'haiku')`,
      )
      .run({
        id: `${id}-s${i}`,
        m: id,
        by: s.by ?? owner,
        tpl: s.template,
        t,
        usage: s.input == null ? null : JSON.stringify({ input_tokens: s.input, output_tokens: s.output }),
        c: s.charged ?? null,
      }),
  );
  return id;
}

async function userId(c: Awaited<ReturnType<typeof memberClient>>) {
  return ((await (await c.get("/api/me")).json()) as any).user.id as string;
}

describe("usage dashboard", () => {
  test("totals, days and kinds of one person's work in the period", async () => {
    const c = await memberClient("usage-amy");
    const amy = await userId(c);
    seed(amy, { daysAgo: 1, sec: 600, charged: 10_000, summaries: [{ template: "Standard", input: 20_000, output: 3_000, charged: 3_500 }] });
    seed(amy, { daysAgo: 3, sec: 5400, lang: "English", summaries: [{ template: null, input: null, output: 0 }] });
    // Outside the last 30 days.
    seed(amy, { daysAgo: 45, sec: 3600 });

    const r = (await (await c.get("/api/usage?range=30d")).json()) as any;
    expect(r.by).toBe("day");
    expect(r.series).toHaveLength(30);
    expect(r.totals).toMatchObject({
      sec: 6000,
      transcriptions: 2,
      meetings: 2,
      summaries: 2,
      inputTokens: 20_000,
      outputTokens: 3_000,
      unknownTokens: 1,
      pointsTranscription: 10_000,
      pointsSummary: 3_500,
    });
    expect(r.series.reduce((a: number, b: any) => a + b.sec, 0)).toBe(6000);
    expect(r.languages.map((g: any) => g.key)).toEqual(["English", "Chinese"]);
    expect(r.lengths.find((g: any) => g.key === "lt15").count).toBe(1);
    expect(r.lengths.find((g: any) => g.key === "lt120").count).toBe(1);
    expect(r.templates.map((g: any) => [g.key, g.count])).toEqual(expect.arrayContaining([["Standard", 1], ["", 1]]));
    expect(r.top[0].points).toBe(13_500);
    expect(r.byUser).toBeNull();

    const all = (await (await c.get("/api/usage?range=all")).json()) as any;
    expect(all.by).toBe("month");
    expect(all.totals.sec).toBe(9600);
  });

  test("only administrators see other people, or the whole site by person", async () => {
    const bob = await memberClient("usage-bob");
    const bobId = await userId(bob);
    seed(bobId, { daysAgo: 2, sec: 1200 });
    const amy = await memberClient("usage-amy2");
    expect((await amy.get(`/api/usage?user=${bobId}`)).status).toBe(403);
    expect((await amy.get("/api/usage?user=all")).status).toBe(403);

    const admin = await adminClient();
    const one = (await (await admin.get(`/api/usage?user=${bobId}`)).json()) as any;
    expect(one.totals.sec).toBe(1200);
    const site = (await (await admin.get("/api/usage?user=all&range=90d")).json()) as any;
    expect(site.byUser.find((u: any) => u.username === "usage-bob").sec).toBe(1200);
    expect((await admin.get("/api/usage?user=nobody")).status).toBe(404);
  });

  test("months run back from the current one, and days are Taiwan days", () => {
    // 2026-03-31 20:00 UTC is already 1 April in Taiwan.
    const at = Date.UTC(2026, 2, 31, 20);
    const r = usageReport(null, "12m", at);
    expect(r.series.map((b) => b.key)).toEqual(["2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04"]);
    const d = usageReport(null, "30d", at);
    expect(d.series.at(-1)!.key).toBe("2026-04-01");
    expect(d.series).toHaveLength(30);
  });
});
