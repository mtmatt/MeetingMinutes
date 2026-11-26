import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Bell, ListFilter, Radar, ShieldAlert, ShieldCheck, Unlock } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { SecurityEventKind, SecuritySettings, SecurityState } from "../api/types";
import { useConfirm } from "../components/Modal";
import { useToast } from "../components/Toast";
import { useI18n, type TKey } from "../i18n";
import { dateTime, monthDay, relative } from "../lib/format";

const KIND_LABEL: Record<SecurityEventKind, TKey> = {
  login_failed: "security.kind_login_failed",
  rate_limited: "security.kind_rate_limited",
  bad_token: "security.kind_bad_token",
  csrf: "security.kind_csrf",
  probe: "security.kind_probe",
  worker_auth: "security.kind_worker_auth",
  payment_signature: "security.kind_payment_signature",
  wrong_host: "security.kind_wrong_host",
  blocked: "security.kind_blocked",
  account: "security.kind_account",
  admin_new_ip: "security.kind_admin_new_ip",
};
/** Kinds that count towards blocking, in the order the day tooltips list them. */
const HOSTILE: SecurityEventKind[] = ["login_failed", "rate_limited", "probe", "bad_token", "csrf", "worker_auth", "payment_signature"];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** "auto:login_failed=8,rate_limited=11" → "Automatic: 8 wrong passwords, 11 too many attempts in 15 minutes". */
function blockReason(reason: string, t: (k: TKey, v?: Record<string, string | number>) => string): string {
  if (!reason.startsWith("auto:")) return reason;
  const parts = reason
    .slice(5)
    .split(",")
    .map((p) => p.split("="))
    .filter(([k, n]) => k && n && k in KIND_LABEL)
    .map(([k, n]) => `${t(KIND_LABEL[k as SecurityEventKind])} ${n}`);
  return t("security.autoReason", { what: parts.join(t("billing.listSep")) });
}

/**
 * Admin → Security: what looks like an attack on the site (failed sign-ins,
 * scanners, forged payments…), from where, what is blocked, and the settings
 * for blocking and email alerts.
 */
export function AdminSecurity() {
  const { t } = useI18n();
  const { data } = useQuery({ queryKey: ["admin", "security"], queryFn: api.adminSecurity, refetchInterval: 30_000 });
  if (!data) return <div className="skeleton" style={{ height: 320 }} />;
  const h = data.last24h;
  const n = (k: SecurityEventKind) => h[k]?.count ?? 0;
  const hostile24 = HOSTILE.reduce((sum, k) => sum + n(k), 0);
  return (
    <div className="admin-security">
      <section className="security-tiles" aria-label={t("security.last24h")}>
        <Tile label={t("security.tileSignIns")} value={n("login_failed") + n("rate_limited")} sub={t("security.addresses", { n: (h.login_failed?.addresses ?? 0) })} />
        <Tile label={t("security.tileProbes")} value={n("probe")} sub={t("security.addresses", { n: h.probe?.addresses ?? 0 })} />
        <Tile label={t("security.tileBlocked")} value={n("blocked")} sub={t("security.activeBlocks", { n: data.blocks.length })} />
        <Tile
          label={t("security.tilePayments")}
          value={n("payment_signature")}
          sub={n("payment_signature") ? t("security.paymentsSub") : t("security.none")}
          serious={n("payment_signature") > 0}
        />
      </section>
      <p className="faint security-caption">
        {hostile24 === 0 ? t("security.quiet") : t("security.last24hNote")} {t("security.scope")}
      </p>

      <section className="card system-card">
        <h3 className="system-h">
          <Radar /> {t("security.chartTitle")}
        </h3>
        <DailyChart daily={data.daily} />
      </section>

      <TopAddresses data={data} />
      <Blocks data={data} />
      <RecentEvents />
      <Settings data={data} />
    </div>
  );
}

function Tile({ label, value, sub, serious = false }: { label: string; value: number; sub: string; serious?: boolean }) {
  return (
    <div className={`security-tile ${serious ? "is-serious" : ""}`}>
      <span className="security-tile-label">{label}</span>
      <span className="security-tile-value">{value.toLocaleString()}</span>
      <span className="security-tile-sub">
        {serious && <ShieldAlert />}
        {sub}
      </span>
    </div>
  );
}

/** Suspicious requests per day (Taiwan time), one bar each; hovering a bar lists its kinds. */
function DailyChart({ daily }: { daily: SecurityState["daily"] }) {
  const { t, locale } = useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...daily.map((d) => d.total));
  // A round top value for the one axis label.
  const step = 10 ** Math.floor(Math.log10(max));
  const top = Math.ceil(max / step) * step;
  const active = hover != null ? daily[hover] : null;
  return (
    <div className="security-chart">
      <div className="security-chart-axis faint" aria-hidden="true">
        <span>{top.toLocaleString()}</span>
        <span>0</span>
      </div>
      <div className="security-chart-plot" onMouseLeave={() => setHover(null)}>
        <div className="security-chart-grid" aria-hidden="true" />
        {daily.map((d, i) => (
          <button
            type="button"
            key={d.date}
            className={`security-bar ${hover === i ? "is-hover" : ""}`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            aria-label={t("security.barLabel", { day: monthDay(d.date, locale), n: d.total })}
          >
            <span className="security-bar-fill" style={{ height: `${(d.total / top) * 100}%` }} />
          </button>
        ))}
        {active && hover != null && (
          <div
            className={`security-tip ${hover > daily.length * 0.7 ? "tip-left" : hover < daily.length * 0.3 ? "tip-right" : ""}`}
            role="status"
            style={{ left: `${((hover + 0.5) / daily.length) * 100}%` }}
          >
            <strong>{monthDay(active.date, locale)}</strong>
            <span>{t("security.tipTotal", { n: active.total })}</span>
            {HOSTILE.filter((k) => active.kinds[k]).map((k) => (
              <span key={k} className="security-tip-row">
                <span>{t(KIND_LABEL[k])}</span>
                <span className="mono">{active.kinds[k]}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="security-chart-x faint" aria-hidden="true">
        <span>{daily[0] ? monthDay(daily[0].date, locale) : ""}</span>
        <span>{t("security.today")}</span>
      </div>
    </div>
  );
}

function useBlockActions() {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "security"] });
  return {
    block: async (ip: string, minutes: number | null, reason = "") => {
      try {
        await api.adminBlockIp(ip, minutes, reason);
        toast.show(t("security.blockedToast", { ip }));
        await refresh();
        return true;
      } catch (e) {
        toast.error(e);
        return false;
      }
    },
    unblock: async (ip: string) => {
      try {
        await api.adminUnblockIp(ip);
        toast.show(t("security.unblockedToast", { ip }));
        await refresh();
      } catch (e) {
        toast.error(e);
      }
    },
  };
}

function TopAddresses({ data }: { data: SecurityState }) {
  const { t, locale } = useI18n();
  const confirm = useConfirm();
  const { block, unblock } = useBlockActions();
  if (!data.topIps.length) return null;
  const askBlock = async (ip: string) => {
    const ok = await confirm({ title: t("security.blockTitle", { ip }), body: t("security.blockBody"), confirmLabel: t("security.block24h"), danger: true });
    if (ok) await block(ip, 24 * 60);
  };
  return (
    <section className="card system-card">
      <h3 className="system-h">
        <ListFilter /> {t("security.topTitle")}
      </h3>
      <div className="table-wrap">
        <table className="table security-table">
          <thead>
            <tr>
              <th>{t("security.address")}</th>
              <th className="num">{t("security.events")}</th>
              <th>{t("security.what")}</th>
              <th>{t("security.lastSeen")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.topIps.map((r) => (
              <tr key={r.ip}>
                <td className="mono">
                  {r.ip}
                  {r.ip === data.yourIp && <span className="pill info security-you">{t("security.you")}</span>}
                </td>
                <td className="num mono">{r.count.toLocaleString()}</td>
                <td>
                  <div className="security-kinds">
                    {r.kinds.map((k) => (
                      <span key={k} className={`pill ${k === "payment_signature" ? "danger" : "neutral"}`}>
                        {t(KIND_LABEL[k] ?? "security.kind_account")}
                      </span>
                    ))}
                  </div>
                  {r.usernames.length > 0 && <div className="faint security-tried">{t("security.tried", { names: r.usernames.join(", ") })}</div>}
                </td>
                <td className="faint nowrap">{relative(r.lastAt, t, locale)}</td>
                <td style={{ textAlign: "right" }}>
                  {r.blocked ? (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => unblock(r.ip)}>
                      <Unlock /> {t("security.unblock")}
                    </button>
                  ) : (
                    r.ip !== data.yourIp && (
                      <button type="button" className="btn btn-sm btn-ghost btn-danger" onClick={() => askBlock(r.ip)}>
                        <Ban /> {t("security.block")}
                      </button>
                    )
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const DURATIONS: { minutes: number | null; key: TKey }[] = [
  { minutes: 60, key: "security.dur1h" },
  { minutes: 24 * 60, key: "security.dur24h" },
  { minutes: 7 * 24 * 60, key: "security.dur7d" },
  { minutes: null, key: "security.durForever" },
];

function Blocks({ data }: { data: SecurityState }) {
  const { t, locale } = useI18n();
  const { block, unblock } = useBlockActions();
  const [ip, setIp] = useState("");
  const [minutes, setMinutes] = useState<number | null>(24 * 60);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    if (await block(ip.trim(), minutes, reason.trim())) {
      setIp("");
      setReason("");
    }
    setBusy(false);
  };
  return (
    <section className="card system-card">
      <h3 className="system-h">
        <Ban /> {t("security.blocksTitle")}
      </h3>
      {data.blocks.length === 0 ? (
        <p className="faint security-empty">{t("security.noBlocks")}</p>
      ) : (
        <ul className="security-blocks">
          {data.blocks.map((b) => (
            <li key={b.ip}>
              <div>
                <span className="mono security-block-ip">{b.ip}</span>
                <span className={`pill ${b.auto ? "warn" : "neutral"}`}>{b.auto ? t("security.auto") : t("security.manual")}</span>
                <div className="faint security-block-why">
                  {blockReason(b.reason, t)} · {b.expiresAt ? t("security.until", { when: dateTime(b.expiresAt, locale) }) : t("security.untilRemoved")}
                  {b.createdBy && <> · {b.createdBy}</>}
                </div>
              </div>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => unblock(b.ip)}>
                <Unlock /> {t("security.unblock")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="security-block-form">
        <input className="input mono" placeholder={t("security.ipPlaceholder")} aria-label={t("security.address")} value={ip} onChange={(e) => setIp(e.target.value)} />
        <select className="select" aria-label={t("security.duration")} value={minutes ?? ""} onChange={(e) => setMinutes(e.target.value === "" ? null : Number(e.target.value))}>
          {DURATIONS.map((d) => (
            <option key={d.key} value={d.minutes ?? ""}>
              {t(d.key)}
            </option>
          ))}
        </select>
        <input className="input" placeholder={t("security.reasonPlaceholder")} aria-label={t("security.reason")} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
        <button type="button" className="btn btn-sm" onClick={submit} disabled={busy || !ip.trim()}>
          <Ban /> {t("security.block")}
        </button>
      </div>
    </section>
  );
}

function RecentEvents() {
  const { t, locale } = useI18n();
  const [kind, setKind] = useState<"" | SecurityEventKind>("");
  const { data } = useQuery({ queryKey: ["admin", "security", "events", kind], queryFn: () => api.adminSecurityEvents(kind, "", 100), refetchInterval: 30_000 });
  return (
    <section className="card system-card">
      <div className="security-events-head">
        <h3 className="system-h">
          <ShieldCheck /> {t("security.eventsTitle")}
        </h3>
        <select className="select" aria-label={t("security.filter")} value={kind} onChange={(e) => setKind(e.target.value as "" | SecurityEventKind)}>
          <option value="">{t("security.allKinds")}</option>
          {(Object.keys(KIND_LABEL) as SecurityEventKind[]).map((k) => (
            <option key={k} value={k}>
              {t(KIND_LABEL[k])}
            </option>
          ))}
        </select>
      </div>
      {data && data.events.length === 0 ? (
        <p className="faint security-empty">{t("security.noEvents")}</p>
      ) : (
        <div className="table-wrap">
          <table className="table security-table">
            <thead>
              <tr>
                <th>{t("billing.when")}</th>
                <th>{t("security.kind")}</th>
                <th>{t("security.address")}</th>
                <th>{t("security.detail")}</th>
                <th className="num">{t("security.times")}</th>
              </tr>
            </thead>
            <tbody>
              {data?.events.map((e) => (
                <tr key={e.id}>
                  <td className="faint nowrap">{dateTime(e.lastAt, locale)}</td>
                  <td>
                    <span className={`pill ${e.severity === "high" ? "danger" : e.severity === "warn" ? "warn" : "neutral"}`}>{t(KIND_LABEL[e.kind] ?? "security.kind_account")}</span>
                  </td>
                  <td className="mono">{e.ip}</td>
                  <td className="security-detail">
                    {e.username && <span className="mono">{e.username} · </span>}
                    <span className="faint">{e.detail}</span>
                  </td>
                  <td className="num mono">{e.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Settings({ data }: { data: SecurityState }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<SecuritySettings>(data.settings);
  const [allow, setAllow] = useState(data.settings.allowlist.join("\n"));
  const [emails, setEmails] = useState(data.settings.alertEmails.join(", "));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setForm(data.settings);
    setAllow(data.settings.allowlist.join("\n"));
    setEmails(data.settings.alertEmails.join(", "));
    // Only when the saved settings change, not on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(data.settings)]);
  const next: SecuritySettings = {
    ...form,
    allowlist: allow.split(/[\s,]+/).filter(Boolean),
    alertEmails: emails.split(/[\s,;]+/).filter(Boolean),
  };
  const dirty = !same(next, data.settings);
  const minutesOk = Number.isInteger(form.blockMinutes) && form.blockMinutes >= 5;

  const save = async () => {
    setBusy(true);
    try {
      await api.adminSaveSecurity(next);
      await qc.invalidateQueries({ queryKey: ["admin", "security"] });
      toast.show(t("common.saved"));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card system-card">
      <h3 className="system-h">
        <Bell /> {t("security.settingsTitle")}
      </h3>
      <label className="switch">
        <input type="checkbox" checked={form.autoBlock} onChange={(e) => setForm({ ...form, autoBlock: e.target.checked })} />
        <span className="switch-track" />
        <span className="switch-label">{t("security.autoBlock")}</span>
      </label>
      <p className="faint security-hint">{t("security.autoBlockHint")}</p>
      <div className="field security-minutes">
        <label htmlFor="block-minutes">{t("security.blockMinutes")}</label>
        <input
          id="block-minutes"
          className="input mono"
          type="number"
          min={5}
          step={5}
          value={Number.isFinite(form.blockMinutes) ? form.blockMinutes : ""}
          aria-invalid={!minutesOk}
          disabled={!form.autoBlock}
          onChange={(e) => setForm({ ...form, blockMinutes: e.target.value === "" ? Number.NaN : Math.round(Number(e.target.value)) })}
        />
      </div>
      <div className="field">
        <label htmlFor="allowlist">{t("security.allowlist")}</label>
        <textarea id="allowlist" className="textarea mono" rows={3} value={allow} placeholder={"203.0.113.0/24\n2001:db8::/32"} onChange={(e) => setAllow(e.target.value)} />
        <span className="field-hint">{t("security.allowlistHint", { ip: data.yourIp })}</span>
      </div>
      <label className="switch">
        <input type="checkbox" checked={form.alerts} onChange={(e) => setForm({ ...form, alerts: e.target.checked })} />
        <span className="switch-track" />
        <span className="switch-label">{t("security.alerts")}</span>
      </label>
      <div className="field">
        <label htmlFor="alert-emails">{t("security.alertEmails")}</label>
        <input id="alert-emails" className="input" value={emails} placeholder={t("security.alertEmailsPlaceholder")} disabled={!form.alerts} onChange={(e) => setEmails(e.target.value)} />
        <span className="field-hint">
          {!data.alerts.mail
            ? t("security.alertsNeedMail")
            : data.alerts.recipients.length
              ? t("security.alertsTo", { to: data.alerts.recipients.join(", ") })
              : t("security.alertsNobody")}
        </span>
      </div>
      {!data.trustProxy && <p className="faint security-hint">{t("security.proxyNote")}</p>}
      <div className="model-actions">
        <button className="btn btn-primary" onClick={save} disabled={busy || !dirty || !minutesOk}>
          {busy && <span className="spinner" />} {t("common.save")}
        </button>
        {dirty && (
          <button
            className="btn btn-ghost"
            onClick={() => {
              setForm(data.settings);
              setAllow(data.settings.allowlist.join("\n"));
              setEmails(data.settings.alertEmails.join(", "));
            }}
          >
            {t("model.discard")}
          </button>
        )}
        <span className="faint model-saved">
          {data.meta.saved && data.meta.updatedAt ? t("model.savedBy", { who: data.meta.updatedBy ?? "–", when: relative(data.meta.updatedAt, t, locale) }) : ""}
        </span>
      </div>
    </section>
  );
}
