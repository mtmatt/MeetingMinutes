import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowUp, CheckCircle2, Coins, ExternalLink, Eye, FileText, Plus, Receipt, RefreshCw, Store, Trash2, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import type { AdminOrder, BillingSettings, CreditPackage, PaymentMethod } from "../api/types";
import { useConfirm } from "../components/Modal";
import { useToast } from "../components/Toast";
import { useI18n, type TKey } from "../i18n";
import { useAuth } from "../lib/auth";
import { TYPICAL_HOUR, dateTime, pointsPerMeetingHour, pointsText, relative, twd, twdApprox } from "../lib/format";
import { termsTemplate } from "../lib/termsTemplate";
import { VENDOR_NAMES } from "../lib/summaryEngine";

const METHODS: PaymentMethod[] = ["Credit", "ATM", "CVS"];
const METHOD_LABEL = { Credit: "billing.methodCredit", ATM: "billing.methodATM", CVS: "billing.methodCVS" } as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** "m60", "m60-2"…: a package id nobody has to type. */
function packageId(points: number, taken: string[]): string {
  const base = `p${points}`;
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
}

/**
 * Admin → Sales: whether people may sign up on their own, what work costs in points, the points on sale
 * and how they are paid, with what email and ECPay need, and the orders.
 */
export function AdminBilling() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["admin", "billing"], queryFn: api.adminBilling });
  const [form, setForm] = useState<BillingSettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data && !form) setForm(data.settings);
  }, [data, form]);

  if (!data || !form) return <div className="skeleton" style={{ height: 320 }} />;
  const dirty = !same(form, data.settings);
  const packagesOk = form.packages.every((p) => Number.isInteger(p.points) && p.points > 0 && Number.isInteger(p.price) && p.price > 0);
  const rate = (x: number) => Number.isFinite(x) && x >= 0 && x <= 1000;
  const ratesOk = rate(form.rates.perMinute) && rate(form.rates.perKInput) && rate(form.rates.perKOutput);
  const termsOk = !form.termsUrl || /^https?:\/\/\S+$/.test(form.termsUrl);
  const canSave = dirty && packagesOk && ratesOk && termsOk && form.methods.length > 0 && (!form.enabled || form.packages.length > 0);
  const live = data.ecpay.mode === "production";
  const hourPoints = ratesOk ? pointsPerMeetingHour(form.rates) : 0;

  const setPackage = (i: number, patch: Partial<CreditPackage>) =>
    setForm({ ...form, packages: form.packages.map((p, j) => (j === i ? { ...p, ...patch } : p)) });

  const save = async () => {
    // Selling for real is a decision worth a second look.
    if (form.enabled && !data.settings.enabled && live) {
      const ok = await confirm({ title: t("sales.confirmLiveTitle"), body: t("sales.confirmLiveBody"), confirmLabel: t("sales.confirmLive") });
      if (!ok) return;
    }
    setBusy(true);
    try {
      // Ids follow the points, so each package keeps one name in the orders.
      const packages = form.packages.map((p, i, all) => (p.id ? p : { ...p, id: packageId(p.points, all.map((x) => x.id)) }));
      const next = await api.adminSaveBilling({ ...form, packages });
      qc.setQueryData(["admin", "billing"], { ...data, ...next });
      setForm(next.settings);
      await qc.invalidateQueries({ queryKey: ["auth"] });
      toast.show(t("common.saved"));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const paidLive = data.stats.paid.find((p) => p.mode === "production");
  const paidTest = data.stats.paid.find((p) => p.mode === "stage");

  return (
    <div className="admin-billing">
      <section className="card system-card">
        <h3 className="system-h">
          <Store /> {t("sales.readiness")}
        </h3>
        <MailStatus mail={data.mail} />
        <div className="sales-status-row">
          {live ? <CheckCircle2 className="ok-icon" /> : <AlertTriangle className="warn-icon" />}
          <div>
            <strong>{live ? t("sales.ecpayLive", { id: data.ecpay.merchantId }) : t("sales.ecpayTest", { id: data.ecpay.merchantId })}</strong>
            <p className="faint">{live ? t("sales.ecpayLiveHint") : data.ecpay.testShop ? t("sales.ecpayTestShopHint") : t("sales.ecpayTestHint")}</p>
          </div>
        </div>
        {!live && data.ecpay.testShop && (
          <div className="sales-status-row">
            <AlertTriangle className="warn-icon" />
            <div>
              <strong>{t("sales.testShopForgeable")}</strong>
              <p className="faint">{t("sales.testShopForgeableHint")}</p>
            </div>
          </div>
        )}
        {!data.ecpay.publicUrl && (
          <div className="sales-status-row">
            <AlertTriangle className="warn-icon" />
            <div>
              <strong>{t("sales.noPublicUrl")}</strong>
              <p className="faint">{t("sales.noPublicUrlHint")}</p>
            </div>
          </div>
        )}
      </section>

      <section className="card system-card">
        <h3 className="system-h">
          <UserPlus /> {t("sales.signUp")}
        </h3>
        <label className="switch">
          <input
            type="checkbox"
            checked={form.registrationOpen}
            disabled={!data.mail.configured && !form.registrationOpen}
            onChange={(e) => setForm({ ...form, registrationOpen: e.target.checked })}
          />
          <span className="switch-track" />
          <span className="switch-label">{t("sales.registrationOpen")}</span>
        </label>
        <p className="faint sales-hint">{data.mail.configured ? t("sales.registrationHint") : t("sales.registrationNeedsMail")}</p>
      </section>

      <section className="card system-card">
        <h3 className="system-h">
          <Coins /> {t("sales.selling")}
        </h3>
        <label className="switch">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          <span className="switch-track" />
          <span className="switch-label">{t("sales.enabled")}</span>
        </label>

        <RatesEditor rates={form.rates} onChange={(rates) => setForm({ ...form, rates })} />

        <div className="sales-packages">
          <div className="sales-packages-head faint smallcaps">
            <span>{t("sales.points")}</span>
            <span>{t("sales.price")}</span>
            <span>{t("sales.perMinute")}</span>
            <span />
          </div>
          {form.packages.map((p, i) => (
            <div className="sales-package" key={i}>
              <input
                className="input mono"
                type="number"
                min={1}
                step={1}
                aria-label={t("sales.points")}
                value={Number.isFinite(p.points) ? p.points : ""}
                onChange={(e) => setPackage(i, { points: e.target.value === "" ? Number.NaN : Math.round(Number(e.target.value)) })}
              />
              <input
                className="input mono"
                type="number"
                min={1}
                step={1}
                aria-label={t("sales.price")}
                value={Number.isFinite(p.price) ? p.price : ""}
                onChange={(e) => setPackage(i, { price: e.target.value === "" ? Number.NaN : Math.round(Number(e.target.value)) })}
              />
              <span className="mono faint sales-package-unit">
                {p.points > 0 && p.price > 0 ? (
                  <>
                    {`NT$${(p.price / p.points).toFixed(2)}`}
                    {hourPoints > 0 && <small>{t("sales.perHour", { price: twdApprox((hourPoints * p.price) / p.points) })}</small>}
                  </>
                ) : (
                  "–"
                )}
              </span>
              <button
                type="button"
                className="icon-btn"
                aria-label={t("common.delete")}
                title={t("common.delete")}
                onClick={() => setForm({ ...form, packages: form.packages.filter((_, j) => j !== i) })}
              >
                <Trash2 />
              </button>
            </div>
          ))}
          {form.packages.length === 0 && <p className="faint">{t("sales.noPackages")}</p>}
          {form.packages.length < 8 && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const last = form.packages[form.packages.length - 1];
                setForm({ ...form, packages: [...form.packages, { id: "", points: last ? last.points * 2 : 100, price: last ? last.price * 2 : 100 }] });
              }}
            >
              <Plus /> {t("sales.addPackage")}
            </button>
          )}
        </div>

        <fieldset className="sales-methods">
          <legend className="field-label">{t("sales.methods")}</legend>
          {METHODS.map((m) => (
            <label key={m} className="check">
              <input
                type="checkbox"
                checked={form.methods.includes(m)}
                onChange={(e) => setForm({ ...form, methods: e.target.checked ? METHODS.filter((x) => x === m || form.methods.includes(x)) : form.methods.filter((x) => x !== m) })}
              />
              {t(METHOD_LABEL[m])}
            </label>
          ))}
          <span className="field-hint">{t("sales.methodsHint")}</span>
        </fieldset>

        <div className="field">
          <label className="check">
            <input type="checkbox" checked={form.noExpiry} onChange={(e) => setForm({ ...form, noExpiry: e.target.checked })} />
            {t("sales.noExpiry")}
          </label>
          <span className="field-hint">{t("sales.noExpiryHint")}</span>
        </div>

        <TermsEditor rates={form.rates} noExpiry={form.noExpiry} />

        <div className="field">
          <label htmlFor="terms-url">{t("sales.termsUrl")}</label>
          <input
            id="terms-url"
            className="input"
            type="url"
            placeholder="https://"
            value={form.termsUrl}
            aria-invalid={!termsOk}
            onChange={(e) => setForm({ ...form, termsUrl: e.target.value.trim() })}
          />
          <span className="field-hint">{t("sales.termsUrlHint")}</span>
        </div>

        <div className="model-actions">
          <button className="btn btn-primary" onClick={save} disabled={busy || !canSave}>
            {busy && <span className="spinner" />} {t("common.save")}
          </button>
          {dirty && (
            <button className="btn btn-ghost" onClick={() => setForm(data.settings)}>
              {t("model.discard")}
            </button>
          )}
          <Link className="btn btn-ghost" to="/billing?preview=1" title={dirty ? t("sales.previewSavedOnly") : undefined}>
            <Eye /> {t("billing.previewAsBuyer")}
          </Link>
          {form.enabled && form.packages.length === 0 && <span className="field-error">{t("sales.needPackage")}</span>}
          <span className="faint model-saved">
            {data.meta.saved && data.meta.updatedAt ? t("model.savedBy", { who: data.meta.updatedBy ?? "–", when: relative(data.meta.updatedAt, t, locale) }) : ""}
          </span>
        </div>
      </section>

      <section className="card system-card">
        <h3 className="system-h">
          <Receipt /> {t("sales.orders")}
        </h3>
        <dl className="kv">
          <dt>{t("sales.revenue")}</dt>
          <dd>{paidLive ? t("sales.revenueValue", { n: paidLive.orders, amount: twd(paidLive.amount), points: paidLive.points.toLocaleString() }) : t("storage.none")}</dd>
          {paidTest && (
            <>
              <dt>{t("sales.revenueTest")}</dt>
              <dd>{t("sales.revenueValue", { n: paidTest.orders, amount: twd(paidTest.amount), points: paidTest.points.toLocaleString() })}</dd>
            </>
          )}
          <dt>{t("sales.prepaidAccounts")}</dt>
          <dd>{t("sales.prepaidValue", { n: data.stats.prepaidAccounts, points: pointsText(data.stats.outstanding, locale) })}</dd>
        </dl>
        <Orders />
      </section>
    </div>
  );
}

/** Points per minute of recording and per thousand summary tokens, with what typical work then costs. */
function RatesEditor({ rates, onChange }: { rates: BillingSettings["rates"]; onChange: (r: BillingSettings["rates"]) => void }) {
  const { t, locale } = useI18n();
  const field = (key: keyof BillingSettings["rates"], label: TKey, hint: TKey) => (
    <div className="field">
      <label htmlFor={`rate-${key}`}>{t(label)}</label>
      <input
        id={`rate-${key}`}
        className="input mono"
        type="number"
        min={0}
        step="any"
        value={Number.isFinite(rates[key]) ? rates[key] : ""}
        aria-invalid={!(Number.isFinite(rates[key]) && rates[key] >= 0)}
        onChange={(e) => onChange({ ...rates, [key]: e.target.value === "" ? Number.NaN : Number(e.target.value) })}
      />
      <span className="field-hint">{t(hint)}</span>
    </div>
  );
  // An hour's meeting and one summary of it (TYPICAL_HOUR tokens read and written).
  const hour = rates.perMinute * 60 * 1000;
  const summary = (TYPICAL_HOUR.input / 1000) * rates.perKInput * 1000 + (TYPICAL_HOUR.output / 1000) * rates.perKOutput * 1000;
  return (
    <div className="sales-rates">
      <div className="sales-rates-fields">
        {field("perMinute", "sales.ratePerMinute", "sales.ratePerMinuteHint")}
        {field("perKInput", "sales.ratePerKInput", "sales.ratePerKInputHint")}
        {field("perKOutput", "sales.ratePerKOutput", "sales.ratePerKOutputHint")}
      </div>
      {Number.isFinite(hour) && Number.isFinite(summary) && (
        <p className="faint sales-hint">
          {t("sales.rateExample", {
            transcription: pointsText(hour, locale),
            summary: pointsText(summary, locale),
            input: TYPICAL_HOUR.input.toLocaleString("en"),
            output: TYPICAL_HOUR.output.toLocaleString("en"),
          })}
        </p>
      )}
    </div>
  );
}

/** The terms of sale shown at /terms: written here in Markdown, saved on their own. */
function TermsEditor({ rates, noExpiry }: { rates: BillingSettings["rates"]; noExpiry: boolean }) {
  const { t, locale } = useI18n();
  // The site's own practice, filled into the template's section on recordings.
  const { siteRetentionDays, mediaPolicy, summarizer } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["admin", "terms"], queryFn: api.adminTerms });
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data && text == null) setText(data.markdown);
  }, [data, text]);
  if (!data || text == null) return <div className="skeleton" style={{ height: 120 }} />;
  const dirty = text !== data.markdown;

  const insertTemplate = async () => {
    if (text.trim()) {
      const ok = await confirm({ title: t("sales.templateReplaceTitle"), body: t("sales.templateReplaceBody"), confirmLabel: t("sales.templateReplace") });
      if (!ok) return;
    }
    setText(
      termsTemplate(locale, rates, noExpiry, {
        retentionDays: siteRetentionDays,
        videoAudioOnly: mediaPolicy?.videoAudioOnly ?? true,
        summaryVendor: summarizer?.provider === "api" && summarizer.vendor ? VENDOR_NAMES[summarizer.vendor] : null,
      }),
    );
  };
  const save = async () => {
    setBusy(true);
    try {
      const saved = await api.adminSaveTerms(text);
      qc.setQueryData(["admin", "terms"], saved);
      await Promise.all([qc.invalidateQueries({ queryKey: ["auth"] }), qc.invalidateQueries({ queryKey: ["terms"] })]);
      toast.show(t("common.saved"));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field sales-terms">
      <div className="sales-terms-head">
        <label htmlFor="terms-text">{t("sales.terms")}</label>
        <span className="sales-terms-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={insertTemplate}>
            <FileText /> {t("sales.insertTemplate")}
          </button>
          {data.markdown.trim() && (
            <a className="btn btn-sm btn-ghost" href="/terms" target="_blank" rel="noopener">
              <ExternalLink /> {t("sales.viewTerms")}
            </a>
          )}
        </span>
      </div>
      <textarea id="terms-text" className="textarea sales-terms-text" rows={14} value={text} placeholder={t("sales.termsPlaceholder")} onChange={(e) => setText(e.target.value)} />
      <span className="field-hint">{t("sales.termsHint")}</span>
      <div className="model-actions">
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !dirty}>
          {busy && <span className="spinner" />} {t("sales.saveTerms")}
        </button>
        {dirty && (
          <button type="button" className="btn btn-ghost" onClick={() => setText(data.markdown)}>
            {t("model.discard")}
          </button>
        )}
        <span className="faint model-saved">{data.updatedAt ? t("sales.termsSaved", { when: relative(data.updatedAt, t, locale) }) : ""}</span>
      </div>
    </div>
  );
}

function MailStatus({ mail }: { mail: { configured: boolean; transport: "smtp" | "log"; server: string | null; from: string } }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const [to, setTo] = useState(user?.email ?? "");
  const [busy, setBusy] = useState(false);

  const send = async () => {
    setBusy(true);
    try {
      await api.adminTestMail(to.trim());
      toast.show(t("sales.testSent", { to: to.trim() }));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sales-status-row">
      {mail.configured ? <CheckCircle2 className="ok-icon" /> : <AlertTriangle className="warn-icon" />}
      <div>
        <strong>
          {!mail.configured ? t("sales.mailMissing") : mail.transport === "log" ? t("sales.mailLog") : t("sales.mailReady", { server: mail.server ?? "", from: mail.from })}
        </strong>
        <p className="faint">{mail.configured ? t("sales.mailHint") : t("sales.mailMissingHint")}</p>
        {mail.configured && (
          <form
            className="sales-test-mail"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy && to.trim()) void send();
            }}
          >
            <input className="input" type="email" value={to} placeholder={t("sales.testTo")} aria-label={t("sales.testTo")} onChange={(e) => setTo(e.target.value)} />
            {/* Round, like a chat's send button, as tall as the field. */}
            <button type="submit" className="send-round" disabled={busy || !to.trim()} aria-label={t("sales.sendTest")} title={t("sales.sendTest")}>
              {busy ? <span className="spinner" /> : <ArrowUp />}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function Orders() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState<"" | "pending" | "paid" | "failed">("");
  const { data } = useQuery({ queryKey: ["admin", "orders", status], queryFn: () => api.adminOrders(status) });
  const [checking, setChecking] = useState<string | null>(null);

  const check = async (o: AdminOrder) => {
    setChecking(o.id);
    try {
      const { order } = await api.adminRefreshOrder(o.id);
      toast.show(order.status === "paid" ? t("sales.nowPaid", { id: o.id }) : t("billing.stillPending"));
      await qc.invalidateQueries({ queryKey: ["admin"] });
    } catch (e) {
      toast.error(e);
    } finally {
      setChecking(null);
    }
  };

  return (
    <>
      <div className="segmented sales-filter" role="group" aria-label={t("admin.status")}>
        {(["", "paid", "pending", "failed"] as const).map((s) => (
          <button key={s} aria-pressed={status === s} onClick={() => setStatus(s)}>
            {s ? t(`sales.status_${s}`) : t("sales.all")}
          </button>
        ))}
      </div>
      {data && data.orders.length === 0 ? (
        <p className="faint">{t("sales.noOrders")}</p>
      ) : (
        <div className="table-wrap" tabIndex={0}>
          <table className="table">
            <thead>
              <tr>
                <th>{t("billing.when")}</th>
                <th>{t("sales.buyer")}</th>
                <th className="num">{t("sales.points")}</th>
                <th className="num">{t("sales.price")}</th>
                <th>{t("admin.status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.orders.map((o) => (
                <tr key={o.id}>
                  <td className="nowrap">
                    <div>{dateTime(o.createdAt, locale)}</div>
                    <div className="faint mono sales-order-id">{o.id}</div>
                  </td>
                  <td>{o.user ? `${o.user.displayName} (@${o.user.username})` : <span className="faint">{t("sales.deletedUser")}</span>}</td>
                  <td className="num mono">{o.points.toLocaleString()}</td>
                  <td className="num mono">{twd(o.amount)}</td>
                  <td>
                    <span className={`pill ${o.status === "paid" ? "ok" : o.status === "failed" ? "danger" : "warn"}`}>{t(`sales.status_${o.status}`)}</span>
                    {o.mode === "stage" && <span className="pill neutral sales-test-pill">{t("sales.test")}</span>}
                    {o.paymentType && <div className="faint mono sales-order-id">{o.paymentType}</div>}
                    {o.error && <div className="faint sales-order-id">{o.error}</div>}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {o.status !== "paid" && (
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => check(o)} disabled={checking === o.id} title={t("sales.checkHint")}>
                        {checking === o.id ? <span className="spinner" /> : <RefreshCw />} {t("billing.checkAgain")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
