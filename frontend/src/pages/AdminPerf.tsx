import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { api } from "../api/client";
import type { PerfReport, PerfSpread, PerfSummary, PerfWindow } from "../api/types";
import { useI18n, type TFn } from "../i18n";

const WINDOWS: PerfWindow[] = ["1h", "24h", "7d", "30d"];

/** "38 ms", "1.2 s" */
function ms(v: number | null | undefined): string {
  if (v == null) return "–";
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)} s`;
}

/** "45 秒", "3 分 20 秒", "1 小時 5 分" */
function secs(v: number | null | undefined, t: TFn): string {
  if (v == null) return "–";
  if (v < 60) return t("perf.sec", { n: v < 10 ? v.toFixed(1) : Math.round(v) });
  if (v < 3600) return t("perf.minSec", { m: Math.floor(v / 60), s: Math.round(v % 60) });
  return t("perf.hourMin", { h: Math.floor(v / 3600), m: Math.round((v % 3600) / 60) });
}

const pct = (part: number, total: number) => (total ? `${((part / total) * 100).toFixed(part / total < 0.01 ? 2 : 1)}%` : "–");

/**
 * Admin → Performance: how fast the site answers (p50, p95, p99 of API
 * requests, over time and by route) and how long the work people wait for
 * takes (transcriptions and summaries, in the queue and running).
 */
export function AdminPerf() {
  const { t } = useI18n();
  const [window, setWindow] = useState<PerfWindow>("24h");
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin", "perf", window],
    queryFn: () => api.adminPerf(window),
    refetchInterval: 60_000,
  });

  return (
    <div className="perf">
      <div className="perf-head">
        <p className="muted">{t("perf.lede")}</p>
        <div className="segmented" role="group" aria-label={t("perf.window")}>
          {WINDOWS.map((w) => (
            <button key={w} type="button" aria-pressed={window === w} onClick={() => setWindow(w)}>
              {t(`perf.w${w}`)}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="callout danger">{String((error as Error).message)}</p>}
      {isLoading || !data ? (
        <div className="skeleton" style={{ height: 420 }} />
      ) : (
        <>
          <Tiles s={data.overall} />
          <section className="card perf-card">
            <h2 className="perf-h">{t("perf.chartTitle")}</h2>
            <LatencyChart report={data} />
          </section>
          <Pipeline p={data.pipeline} />
          <Routes routes={data.routes} />
        </>
      )}
    </div>
  );
}

function Tiles({ s }: { s: PerfSummary }) {
  const { t, locale } = useI18n();
  const tiles: [string, string, string?][] = [
    [t("perf.requests"), s.count.toLocaleString(locale)],
    ["p50", ms(s.p50)],
    ["p95", ms(s.p95)],
    ["p99", ms(s.p99)],
    [t("perf.errorRate"), pct(s.errors, s.count), t("perf.errorHint", { n: s.errors.toLocaleString(locale), c: s.clientErrors.toLocaleString(locale) })],
  ];
  return (
    <div className="perf-tiles">
      {tiles.map(([label, value, hint]) => (
        <div key={label} className="perf-tile">
          <span className="perf-tile-value mono">{value}</span>
          <span className="perf-tile-label">{label}</span>
          {hint && <span className="perf-tile-hint">{hint}</span>}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ chart

const H = 240;
const PAD = { top: 16, right: 52, bottom: 28, left: 56 };

/** Round numbers for the time axis: 0, 25, 50, 75, 100 ms; 0, 0.5, 1 s... */
function niceTicks(max: number): number[] {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1]! < max) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}

function timeLabel(at: number, window: PerfWindow, locale: string): string {
  const d = new Date(at);
  if (window === "1h" || window === "24h") return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toLocaleDateString(locale, { month: "numeric", day: "numeric" });
}

/** p50 and p95 over the window: two lines on one axis (both are milliseconds), hover for the figures. */
function LatencyChart({ report }: { report: PerfReport }) {
  const { t, locale } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const pts = report.series;
  const max = Math.max(1, ...pts.map((p) => p.p95 ?? 0));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1]!;
  const iw = Math.max(10, w - PAD.left - PAD.right);
  const ih = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (pts.length <= 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const y = (v: number) => PAD.top + ih - (v / top) * ih;

  /** A line that breaks where there were no requests. */
  const path = (key: "p50" | "p95") => {
    let d = "";
    let pen = false;
    pts.forEach((p, i) => {
      const v = p[key];
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  /** Single points (a request in an otherwise empty stretch) as dots, so they are not lost. */
  const lonely = (key: "p50" | "p95") =>
    pts.map((p, i) => ({ i, v: p[key] })).filter(({ i, v }) => v != null && pts[i - 1]?.[key] == null && pts[i + 1]?.[key] == null);

  const labels = useMemo(() => {
    const n = Math.max(2, Math.min(7, Math.floor(iw / 110)));
    const out: number[] = [];
    for (let k = 0; k < n; k++) out.push(Math.round((k / (n - 1)) * (pts.length - 1)));
    return [...new Set(out)];
  }, [iw, pts.length]);

  const lastIdx = (key: "p50" | "p95") => {
    for (let i = pts.length - 1; i >= 0; i--) if (pts[i]![key] != null) return i;
    return -1;
  };
  const empty = pts.every((p) => p.count === 0);

  const onMove = (e: ReactPointerEvent<SVGRectElement>) => {
    const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - box.left;
    const i = Math.round(((px - PAD.left) / iw) * (pts.length - 1));
    setHover(Math.max(0, Math.min(pts.length - 1, i)));
  };
  const hp = hover != null ? pts[hover] : null;

  return (
    <div className="perf-chart" ref={ref}>
      <div className="perf-legend" aria-hidden="true">
        <span className="perf-key">
          <span className="perf-swatch s1" /> p50
        </span>
        <span className="perf-key">
          <span className="perf-swatch s2" /> p95
        </span>
      </div>
      {empty ? (
        <p className="faint perf-empty">{t("perf.noRequests")}</p>
      ) : (
        <svg width={w} height={H} role="img" aria-label={t("perf.chartAria")}>
          {ticks.map((v) => (
            <g key={v}>
              <line className="perf-grid" x1={PAD.left} x2={PAD.left + iw} y1={y(v)} y2={y(v)} />
              <text className="perf-axis" x={PAD.left - 8} y={y(v)} dy="0.32em" textAnchor="end">
                {ms(v)}
              </text>
            </g>
          ))}
          {labels.map((i) => (
            <text key={i} className="perf-axis" x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle"}>
              {timeLabel(pts[i]!.at, report.window, locale)}
            </text>
          ))}
          <path className="perf-line s2" d={path("p95")} />
          <path className="perf-line s1" d={path("p50")} />
          {(["p95", "p50"] as const).map((k) =>
            lonely(k).map(({ i, v }) => <circle key={`${k}${i}`} className={`perf-dot ${k === "p50" ? "s1" : "s2"}`} cx={x(i)} cy={y(v!)} r={3} />),
          )}
          {/* Direct labels at the end of each line. */}
          {(["p50", "p95"] as const).map((k) => {
            const i = lastIdx(k);
            if (i < 0) return null;
            return (
              <text key={k} className="perf-end" x={x(i) + 6} y={y(pts[i]![k]!)} dy="0.32em">
                {k}
              </text>
            );
          })}
          {hp && (
            <g pointerEvents="none">
              <line className="perf-cross" x1={x(hover!)} x2={x(hover!)} y1={PAD.top} y2={PAD.top + ih} />
              {hp.p95 != null && <circle className="perf-dot s2 ring" cx={x(hover!)} cy={y(hp.p95)} r={4.5} />}
              {hp.p50 != null && <circle className="perf-dot s1 ring" cx={x(hover!)} cy={y(hp.p50)} r={4.5} />}
            </g>
          )}
          <rect x={PAD.left} y={PAD.top} width={iw} height={ih} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {hp && (
        <div className="perf-tip" style={{ left: Math.min(Math.max(x(hover!), 90), w - 90) }} role="status">
          <strong>{new Date(hp.at).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</strong>
          <span>
            <span className="perf-swatch s1" /> p50 <span className="mono">{ms(hp.p50)}</span>
          </span>
          <span>
            <span className="perf-swatch s2" /> p95 <span className="mono">{ms(hp.p95)}</span>
          </span>
          <span className="faint">{t("perf.tipCount", { n: hp.count.toLocaleString(locale) })}</span>
        </div>
      )}
      {/* The figures as a table, for screen readers. */}
      <div className="visually-hidden">
      <table>
        <caption>{t("perf.chartAria")}</caption>
        <thead>
          <tr>
            <th>{t("perf.time")}</th>
            <th>p50</th>
            <th>p95</th>
            <th>{t("perf.requests")}</th>
          </tr>
        </thead>
        <tbody>
          {pts
            .filter((p) => p.count)
            .map((p) => (
              <tr key={p.at}>
                <td>{new Date(p.at).toLocaleString(locale)}</td>
                <td>{ms(p.p50)}</td>
                <td>{ms(p.p95)}</td>
                <td>{p.count}</td>
              </tr>
            ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

// --------------------------------------------------------------- pipeline

function Pipeline({ p }: { p: PerfReport["pipeline"] }) {
  const { t, locale } = useI18n();
  const row = (label: string, s: PerfSpread, fmt: (v: number | null) => string) => (
    <tr key={label}>
      <th scope="row">{label}</th>
      <td className="mono">{fmt(s.p50)}</td>
      <td className="mono">{fmt(s.p95)}</td>
      <td className="mono">{fmt(s.max)}</td>
    </tr>
  );
  const sec = (v: number | null) => secs(v, t);
  const factor = (v: number | null) => (v == null ? "–" : t("perf.perMinute", { s: Math.round(v * 60) }));
  const block = (title: string, done: number, failed: number, rows: ReactNode) => (
    <section className="card perf-card">
      <h2 className="perf-h">
        {title}
        <span className="faint perf-h-sub">{t("perf.doneFailed", { done: done.toLocaleString(locale), failed: failed.toLocaleString(locale) })}</span>
      </h2>
      <div className="perf-scroll" tabIndex={0} data-scroll-x>
      <table className="perf-table">
        <thead>
          <tr>
            <th />
            <th>p50</th>
            <th>p95</th>
            <th>{t("perf.max")}</th>
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
      </div>
    </section>
  );
  return (
    <div className="perf-pipeline">
      {block(
        t("perf.transcription"),
        p.transcription.done,
        p.transcription.failed,
        <>
          {row(t("perf.queueWait"), p.transcription.waitSec, sec)}
          {row(t("perf.processing"), p.transcription.processSec, sec)}
          {row(t("perf.speed"), p.transcription.realtimeFactor, factor)}
        </>,
      )}
      {block(
        t("perf.summary"),
        p.summary.done,
        p.summary.failed,
        <>
          {row(t("perf.queueWait"), p.summary.waitSec, sec)}
          {row(t("perf.writing"), p.summary.writeSec, sec)}
        </>,
      )}
    </div>
  );
}

// ----------------------------------------------------------------- routes

type SortKey = "count" | "p50" | "p95" | "p99" | "maxMs" | "errors";

function Routes({ routes }: { routes: (PerfSummary & { route: string })[] }) {
  const { t, locale } = useI18n();
  const [sort, setSort] = useState<SortKey>("count");
  const [all, setAll] = useState(false);
  const sorted = [...routes].sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1));
  const shown = all ? sorted : sorted.slice(0, 15);
  const head = (k: SortKey, label: string) => (
    <th aria-sort={sort === k ? "descending" : "none"}>
      <button type="button" className={`perf-sort ${sort === k ? "on" : ""}`} onClick={() => setSort(k)}>
        {label}
      </button>
    </th>
  );
  return (
    <section className="card perf-card">
      <h2 className="perf-h">{t("perf.routes")}</h2>
      {routes.length === 0 ? (
        <p className="faint">{t("perf.noRequests")}</p>
      ) : (
        <div className="perf-scroll" tabIndex={0} data-scroll-x>
          <table className="perf-table perf-routes">
            <thead>
              <tr>
                <th>{t("perf.route")}</th>
                {head("count", t("perf.requests"))}
                {head("p50", "p50")}
                {head("p95", "p95")}
                {head("p99", "p99")}
                {head("maxMs", t("perf.max"))}
                {head("errors", "5xx")}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.route}>
                  <td className="mono perf-route">{r.route}</td>
                  <td className="mono">{r.count.toLocaleString(locale)}</td>
                  <td className="mono">{ms(r.p50)}</td>
                  <td className="mono">{ms(r.p95)}</td>
                  <td className="mono">{ms(r.p99)}</td>
                  <td className="mono">{ms(r.maxMs)}</td>
                  <td className={`mono ${r.errors ? "perf-bad" : ""}`}>{r.errors ? r.errors.toLocaleString(locale) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {routes.length > 15 && (
        <button type="button" className="link-btn perf-more" onClick={() => setAll(!all)}>
          {all ? t("perf.showFewer") : t("perf.showAll", { n: routes.length })}
        </button>
      )}
    </section>
  );
}
