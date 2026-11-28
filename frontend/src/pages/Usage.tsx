import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { BarChart3, Clock, Coins, FileText, Library } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api/client";
import type { Locale, UsageRange, UsageReport, UsageTokenGroup } from "../api/types";
import { useI18n, type TKey } from "../i18n";
import { useAuth } from "../lib/auth";
import { bytes, pointsText } from "../lib/format";

/**
 * The usage dashboard: how much recording was transcribed and how many summaries were
 * written over a period, by day or month, sorted into kinds (language, length, weekday,
 * template, model), with the points they cost on a prepaid account. Administrators can
 * look at one person or the whole site.
 */

const RANGES: { id: UsageRange; label: TKey }[] = [
  { id: "30d", label: "usage.range30d" },
  { id: "90d", label: "usage.range90d" },
  { id: "12m", label: "usage.range12m" },
  { id: "all", label: "usage.rangeAll" },
];

type Metric = "sec" | "summaries" | "points";

/** "12.5 小時" / "45 分鐘" / "12.5 hours". */
export function hoursText(sec: number, locale: Locale): string {
  const zh = locale === "zh-TW";
  if (sec < 3600) {
    const m = Math.round(sec / 60);
    return zh ? `${m} 分鐘` : `${m} min`;
  }
  const h = Math.round((sec / 3600) * 10) / 10;
  return zh ? `${h.toLocaleString("zh-TW")} 小時` : `${h.toLocaleString("en")} h`;
}

/** "2.2 萬" / "21.9K": token counts at a glance. */
function compact(n: number, locale: Locale): string {
  return n.toLocaleString(locale === "zh-TW" ? "zh-TW" : "en", { notation: "compact", maximumFractionDigits: 1 });
}

export function UsagePage() {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const isAdmin = user?.role === "admin";
  const range = (RANGES.some((r) => r.id === params.get("range")) ? params.get("range") : "30d") as UsageRange;
  const who = isAdmin ? (params.get("user") ?? "") : "";
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  const report = useQuery({ queryKey: ["usage", range, who], queryFn: () => api.usage(range, who), placeholderData: keepPreviousData });
  const users = useQuery({ queryKey: ["admin", "users"], queryFn: api.adminUsers, enabled: isAdmin });
  const r = report.data;
  const whoName = who === "all" ? t("usage.wholeSite") : who ? (users.data?.users.find((u) => u.id === who)?.displayName ?? users.data?.users.find((u) => u.id === who)?.username) : null;

  return (
    <div className="usage">
      <div className="page-head">
        <div>
          <h1>{t("usage.title")}</h1>
          <p className="muted">{whoName ? t("usage.ledeOf", { who: whoName }) : t("usage.lede")}</p>
        </div>
      </div>
      <hr className="rule-double" />

      <div className="usage-controls">
        <div className="segmented" role="group" aria-label={t("usage.period")}>
          {RANGES.map((x) => (
            <button key={x.id} type="button" aria-pressed={range === x.id} onClick={() => set({ range: x.id === "30d" ? "" : x.id })}>
              {t(x.label)}
            </button>
          ))}
        </div>
        {isAdmin && (
          <select className="select usage-who" aria-label={t("usage.whose")} value={who} onChange={(e) => set({ user: e.target.value })}>
            <option value="">{t("usage.me")}</option>
            <option value="all">{t("usage.wholeSite")}</option>
            {users.data && (
              <optgroup label={t("usage.people")}>
                {users.data.users
                  .filter((u) => u.id !== user?.id)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.displayName ? `${u.displayName} (${u.username})` : u.username}
                    </option>
                  ))}
              </optgroup>
            )}
          </select>
        )}
      </div>

      {report.isLoading ? (
        <div className="skeleton" style={{ height: 360 }} />
      ) : !r ? (
        <p className="field-error">{t("common.error")}</p>
      ) : (
        <div className={`usage-body ${report.isFetching ? "is-fetching" : ""}`}>
          <Tiles r={r} />
          {r.totals.failedTranscriptions + r.totals.failedSummaries > 0 && (
            <p className="faint usage-failed">{t("usage.failed", {
                what: [
                  r.totals.failedTranscriptions ? t("usage.failedTranscriptions", { n: r.totals.failedTranscriptions }) : "",
                  r.totals.failedSummaries ? t("usage.failedSummaries", { n: r.totals.failedSummaries }) : "",
                ]
                  .filter(Boolean)
                  .join(t("billing.listSep")),
              })}</p>
          )}
          {r.totals.transcriptions + r.totals.summaries === 0 ? (
            <div className="usage-empty card">
              <BarChart3 />
              <p>{t("usage.empty")}</p>
              {!who && (
                <Link className="btn btn-sm" to="/new">
                  {t("nav.add")}
                </Link>
              )}
            </div>
          ) : (
            <>
              <OverTime r={r} />
              <div className="usage-grid">
                <Breakdown title={t("usage.byLanguage")} hint={t("usage.byRecordingHint")}>
                  <Bars rows={r.languages.map((g) => ({ label: languageLabel(g.key, i18n), value: g.points, text: pointsText(g.points, locale), sub: `${hoursText(g.sec, locale)} · ${t("usage.times", { n: g.count })}` }))} />
                </Breakdown>
                <Breakdown title={t("usage.byLength")} hint={t("usage.byLengthHint")}>
                  <Bars rows={r.lengths.map((g) => ({ label: t(`usage.len.${g.key}` as TKey), value: g.points, text: pointsText(g.points, locale), sub: g.count ? `${t("usage.times", { n: g.count })} · ${hoursText(g.sec, locale)}` : t("usage.times", { n: 0 }) }))} />
                </Breakdown>
                <Breakdown title={t("usage.byWeekday")} hint={t("usage.byWeekdayHint")}>
                  <Bars rows={r.weekdays.map((g) => ({ label: t(`usage.wd.${g.key}` as TKey), value: g.points, text: pointsText(g.points, locale), sub: `${hoursText(g.sec, locale)} · ${t("usage.times", { n: g.count })}` }))} />
                </Breakdown>
                <Breakdown title={t("usage.byTemplate")} hint={t("usage.byTemplateHint")}>
                  {r.templates.length ? <Bars rows={tokenRows(r.templates, (k) => k || t("usage.customPrompt"), t, locale)} /> : <p className="faint usage-none">{t("usage.noSummaries")}</p>}
                </Breakdown>
                {r.models.length > 0 && user?.role === "admin" && (
                  <Breakdown title={t("usage.byModel")} hint={t("usage.byModelHint")}>
                    <Bars rows={tokenRows(r.models, (k) => k || t("usage.unknown"), t, locale)} />
                  </Breakdown>
                )}
                {r.showPoints && (
                  <Breakdown title={t("usage.pointsWhere")} hint={t("usage.pointsWhereHint")}>
                    <Bars
                      rows={[
                        { label: t("billing.rateTranscription"), value: r.totals.pointsTranscription, text: pointsText(r.totals.pointsTranscription, locale), sub: hoursText(r.totals.sec, locale) },
                        { label: t("billing.rateSummary"), value: r.totals.pointsSummary, text: pointsText(r.totals.pointsSummary, locale), sub: t("usage.summariesN", { n: r.totals.summaries }) },
                      ]}
                    />
                  </Breakdown>
                )}
              </div>
              <TopMeetings r={r} own={!who} />
              {r.byUser && <ByUser r={r} onPick={(id) => set({ user: id })} />}
            </>
          )}
          <p className="faint usage-note">
            {(r.totals.estimatedItems ?? 0) > 0 && r.rates && (
              <>
                {t(r.prepaid ? "usage.estimatedSome" : "usage.estimatedAll", {
                  perMinute: r.rates.perMinute,
                  perKInput: r.rates.perKInput,
                  perKOutput: r.rates.perKOutput,
                })}{" "}
              </>
            )}
            {t("usage.note")}
            {user?.billing === "prepaid" && !who && (
              <>
                {" "}
                <Link to="/billing">{t("usage.ledgerLink")}</Link>
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

function languageLabel(key: string, i18n: ReturnType<typeof useI18n>): string {
  if (!key) return i18n.t("usage.unknown");
  return key
    .split(",")
    .map((l) => i18n.tMaybe(`lang.${l}`) ?? l)
    .join(" + ");
}

function tokenRows(groups: UsageTokenGroup[], label: (k: string) => string, t: ReturnType<typeof useI18n>["t"], locale: Locale) {
  return groups.map((g) => ({
    label: label(g.key),
    value: g.points,
    text: pointsText(g.points, locale),
    sub: [t("usage.summariesN", { n: g.count }), g.input + g.output ? t("usage.tokensShort", { input: compact(g.input, locale), output: compact(g.output, locale) }) : ""]
      .filter(Boolean)
      .join(" · "),
  }));
}

function Tiles({ r }: { r: UsageReport }) {
  const { t, locale } = useI18n();
  const x = r.totals;
  const retranscribed = x.transcriptions - x.meetings;
  // Nothing here was charged (a free account): the figure is what the work comes to at the rates.
  const estimated = !r.prepaid && (x.estimatedItems ?? 0) > 0;
  return (
    <div className="usage-tiles">
      <Tile icon={<Coins />} label={estimated ? t("usage.pointsEstimated") : t("usage.points")} value={pointsText(x.pointsTranscription + x.pointsSummary, locale)}>
        {t("usage.pointsSplit", { transcription: pointsText(x.pointsTranscription, locale), summary: pointsText(x.pointsSummary, locale) })}
      </Tile>
      <Tile icon={<Clock />} label={t("usage.recorded")} value={hoursText(x.sec, locale)}>
        {t("usage.meetingsN", { n: x.meetings })}
        {retranscribed > 0 && ` · ${t("usage.retranscribedN", { n: retranscribed })}`}
      </Tile>
      <Tile icon={<FileText />} label={t("usage.summaries")} value={x.summaries.toLocaleString()}>
        {x.inputTokens + x.outputTokens > 0 ? t("usage.tokensShort", { input: compact(x.inputTokens, locale), output: compact(x.outputTokens, locale) }) : t("usage.noTokens")}
      </Tile>
      <Tile icon={<Library />} label={t("usage.library")} value={t("usage.meetingsN", { n: r.library.meetings })}>
        {t("usage.librarySub", { time: hoursText(r.library.sec, locale), size: bytes(r.library.bytes) })}
      </Tile>
    </div>
  );
}

function Tile({ icon, label, value, children }: { icon: ReactNode; label: string; value: string; children: ReactNode }) {
  return (
    <div className="usage-tile">
      <span className="usage-tile-label">
        {icon} {label}
      </span>
      <span className="usage-tile-value">{value}</span>
      <span className="usage-tile-sub">{children}</span>
    </div>
  );
}

/** One measure at a time over the period, a bar a day or a month; hovering a bar shows all of them. */
function OverTime({ r }: { r: UsageReport }) {
  const { t, locale } = useI18n();
  const [metric, setMetric] = useState<Metric>("points");
  const [hover, setHover] = useState<number | null>(null);
  const m: Metric = metric === "points" && !r.showPoints ? "sec" : metric;
  const value = (b: UsageReport["series"][number]) => (m === "sec" ? b.sec : m === "summaries" ? b.summaries : b.points);
  const max = Math.max(...r.series.map(value), 0);
  // A round top for the one axis label, in the measure's own unit.
  const unit = m === "sec" ? (max >= 3600 * 2 ? 3600 : 60) : m === "points" ? 1000 : 1;
  const scaled = max / unit;
  const step = scaled > 0 ? 10 ** Math.floor(Math.log10(scaled)) : 1;
  const top = Math.max(1, Math.ceil(scaled / step) * step) * unit;
  const topText = m === "sec" ? hoursText(top, locale) : m === "points" ? pointsText(top, locale) : top.toLocaleString();
  const label = (key: string) => {
    if (r.by === "month") {
      const [y, mo] = key.split("-");
      return locale === "zh-TW" ? `${y} 年 ${Number(mo)} 月` : new Date(Date.UTC(Number(y), Number(mo) - 1, 1)).toLocaleDateString("en", { year: "numeric", month: "short", timeZone: "UTC" });
    }
    const [, mo, d] = key.split("-");
    return locale === "zh-TW" ? `${Number(mo)} 月 ${Number(d)} 日` : new Date(`${key}T00:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
  };
  const active = hover != null ? r.series[hover] : null;
  const n = r.series.length;
  const metrics: { id: Metric; label: TKey }[] = [
    { id: "points", label: "usage.points" },
    { id: "sec", label: "usage.recorded" },
    { id: "summaries", label: "usage.summaries" },
  ];

  return (
    <section className="card usage-card">
      <div className="usage-card-head">
        <h2 className="system-h">{r.by === "month" ? t("usage.byMonth") : t("usage.byDay")}</h2>
        <div className="segmented" role="group" aria-label={t("usage.measure")}>
          {metrics.map((x) => (
            <button key={x.id} type="button" aria-pressed={m === x.id} onClick={() => setMetric(x.id)}>
              {t(x.label)}
            </button>
          ))}
        </div>
      </div>
      <div className="usage-chart">
        <div className="usage-chart-axis faint" aria-hidden="true">
          <span>{topText}</span>
          <span>0</span>
        </div>
        {/* One target for the whole plot (bars a few pixels wide are too small to aim at):
            the pointer picks the bar under it, and the arrow keys step through them;
            the tip below is a live region, so a screen reader hears each one. */}
        <div
          className={`usage-chart-plot ${n > 45 ? "is-dense" : ""}`}
          role="group"
          tabIndex={0}
          aria-label={`${r.by === "month" ? t("usage.byMonth") : t("usage.byDay")}. ${t("common.chartKeys")}`}
          onPointerMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            setHover(Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - box.left) / box.width) * n))));
          }}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover((h) => h ?? n - 1)}
          onBlur={() => setHover(null)}
          onKeyDown={(e) => {
            const next =
              e.key === "ArrowLeft" ? (hover ?? n) - 1 : e.key === "ArrowRight" ? (hover ?? -1) + 1 : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
            if (next == null) return;
            e.preventDefault();
            setHover(Math.max(0, Math.min(n - 1, next)));
          }}
        >
          <div className="usage-chart-grid" aria-hidden="true" />
          {r.series.map((b, i) => (
            <span key={b.key} className={`usage-bar ${hover === i ? "is-hover" : ""}`} aria-hidden="true">
              <span className="usage-bar-fill" style={{ height: `${(value(b) / top) * 100}%` }} />
            </span>
          ))}
          {active && hover != null && (
            <div className={`usage-tip ${hover > n * 0.7 ? "tip-left" : hover < n * 0.3 ? "tip-right" : ""}`} role="status" style={{ left: `${((hover + 0.5) / n) * 100}%` }}>
              <strong>{label(active.key)}</strong>
              <span className="usage-tip-row">
                <span>{t("usage.recorded")}</span>
                <span>{hoursText(active.sec, locale)}</span>
              </span>
              <span className="usage-tip-row">
                <span>{t("usage.transcriptions")}</span>
                <span>{active.transcriptions}</span>
              </span>
              <span className="usage-tip-row">
                <span>{t("usage.summaries")}</span>
                <span>{active.summaries}</span>
              </span>
              {r.showPoints && (
                <span className="usage-tip-row">
                  <span>{t("usage.points")}</span>
                  <span>{pointsText(active.points, locale)}</span>
                </span>
              )}
            </div>
          )}
        </div>
        <div className="usage-chart-x faint" aria-hidden="true">
          <span>{r.series[0] ? label(r.series[0].key) : ""}</span>
          <span>{r.series.at(-1) ? label(r.series.at(-1)!.key) : ""}</span>
        </div>
      </div>
    </section>
  );
}

function Breakdown({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="card usage-card">
      <h2 className="system-h">{title}</h2>
      <p className="faint usage-hint">{hint}</p>
      {children}
    </section>
  );
}

/** A ranked list with a bar for each row's share of the largest. */
function Bars({ rows }: { rows: { label: string; value: number; text: string; sub?: string }[] }) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  return (
    <ul className="usage-bars">
      {rows.map((row, i) => (
        <li key={`${row.label}-${i}`}>
          <div className="usage-bars-line">
            <span className="usage-bars-label">{row.label}</span>
            <span className="usage-bars-value">
              {row.text}
              {row.sub && <span className="faint"> · {row.sub}</span>}
            </span>
          </div>
          <span className="usage-bars-track" aria-hidden="true">
            <span className="usage-bars-fill" style={{ width: max ? `${(row.value / max) * 100}%` : 0 }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function TopMeetings({ r, own }: { r: UsageReport; own: boolean }) {
  const { t, locale } = useI18n();
  if (!r.top.length) return null;
  return (
    <section className="card usage-card">
      <h2 className="system-h">{r.showPoints ? t("usage.topByPoints") : t("usage.topByLength")}</h2>
      <div className="table-wrap" tabIndex={0}>
        <table className="table usage-table">
          <thead>
            <tr>
              <th>{t("usage.meeting")}</th>
              <th className="num">{t("usage.recorded")}</th>
              <th className="num usage-opt">{t("usage.transcriptions")}</th>
              <th className="num usage-opt">{t("usage.summaries")}</th>
              {r.showPoints && <th className="num">{t("usage.points")}</th>}
            </tr>
          </thead>
          <tbody>
            {r.top.map((m, i) => (
              <tr key={m.id ?? i}>
                <td className="usage-title">
                  {own && m.id ? <Link to={`/m/${m.id}`}>{m.title}</Link> : (m.title ?? <span className="faint">{t("usage.titleHidden")}</span>)}
                </td>
                <td className="num">{hoursText(m.sec, locale)}</td>
                <td className="num mono usage-opt">{m.transcriptions}</td>
                <td className="num mono usage-opt">{m.summaries}</td>
                {r.showPoints && <td className="num">{pointsText(m.points, locale)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ByUser({ r, onPick }: { r: UsageReport; onPick: (id: string) => void }) {
  const { t, locale } = useI18n();
  if (!r.byUser?.length) return null;
  return (
    <section className="card usage-card">
      <h2 className="system-h">{t("usage.byUser")}</h2>
      <div className="table-wrap" tabIndex={0}>
        <table className="table usage-table">
          <thead>
            <tr>
              <th>{t("usage.person")}</th>
              <th className="num">{t("usage.recorded")}</th>
              <th className="num usage-opt">{t("usage.transcriptions")}</th>
              <th className="num usage-opt">{t("usage.summaries")}</th>
              <th className="num">{t("usage.points")}</th>
            </tr>
          </thead>
          <tbody>
            {r.byUser.map((u, i) => (
              <tr key={u.id ?? `gone-${i}`}>
                <td>
                  {u.id ? (
                    <button type="button" className="link-btn" onClick={() => onPick(u.id!)}>
                      {u.displayName ?? u.username}
                    </button>
                  ) : (
                    <span className="faint">{t("usage.deletedUser")}</span>
                  )}
                  {u.billing && <span className="faint usage-plan"> · {u.billing === "prepaid" ? t("usage.prepaid") : t("admin.freeAccount")}</span>}
                </td>
                <td className="num">{hoursText(u.sec, locale)}</td>
                <td className="num mono usage-opt">{u.transcriptions}</td>
                <td className="num mono usage-opt">{u.summaries}</td>
                <td className="num">{u.points ? pointsText(u.points, locale) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

