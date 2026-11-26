import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Coins, Mail, Plus, Receipt, RefreshCw, Store, Trash2, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { AdminOrder, BillingSettings, CreditPackage, PaymentMethod } from "../api/types";
import { useConfirm } from "../components/Modal";
import { useToast } from "../components/Toast";
import { useI18n } from "../i18n";
import { useAuth } from "../lib/auth";
import { dateTime, minutesText, relative, twd } from "../lib/format";

const METHODS: PaymentMethod[] = ["Credit", "ATM", "CVS"];
const METHOD_LABEL = { Credit: "billing.methodCredit", ATM: "billing.methodATM", CVS: "billing.methodCVS" } as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** "m60", "m60-2"…: a package id nobody has to type. */
function packageId(minutes: number, taken: string[]): string {
  const base = `m${minutes}`;
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
}

/**
 * Admin → Sales: whether people may sign up on their own, the minutes on sale
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
  const packagesOk = form.packages.every((p) => Number.isInteger(p.minutes) && p.minutes > 0 && Number.isInteger(p.price) && p.price > 0);
  const termsOk = !form.termsUrl || /^https?:\/\/\S+$/.test(form.termsUrl);
  const canSave = dirty && packagesOk && termsOk && form.methods.length > 0 && (!form.enabled || form.packages.length > 0);
  const live = data.ecpay.mode === "production";

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
      // Ids follow the minutes, so each package keeps one name in the orders.
      const packages = form.packages.map((p, i, all) => (p.id ? p : { ...p, id: packageId(p.minutes, all.map((x) => x.id)) }));
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

        <div className="sales-packages">
          <div className="sales-packages-head faint smallcaps">
            <span>{t("sales.minutes")}</span>
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
                aria-label={t("sales.minutes")}
                value={Number.isFinite(p.minutes) ? p.minutes : ""}
                onChange={(e) => setPackage(i, { minutes: e.target.value === "" ? Number.NaN : Math.round(Number(e.target.value)) })}
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
              <span className="mono faint">{p.minutes > 0 && p.price > 0 ? `NT$${(p.price / p.minutes).toFixed(2)}` : "–"}</span>
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
                setForm({ ...form, packages: [...form.packages, { id: "", minutes: last ? last.minutes * 2 : 60, price: last ? last.price * 2 : 100 }] });
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
          <span className="field-hint">{t("sales.termsHint")}</span>
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
          <dd>{paidLive ? t("sales.revenueValue", { n: paidLive.orders, amount: twd(paidLive.amount), minutes: paidLive.minutes.toLocaleString() }) : t("storage.none")}</dd>
          {paidTest && (
            <>
              <dt>{t("sales.revenueTest")}</dt>
              <dd>{t("sales.revenueValue", { n: paidTest.orders, amount: twd(paidTest.amount), minutes: paidTest.minutes.toLocaleString() })}</dd>
            </>
          )}
          <dt>{t("sales.prepaidAccounts")}</dt>
          <dd>{t("sales.prepaidValue", { n: data.stats.prepaidAccounts, minutes: minutesText(data.stats.outstandingSec, locale) })}</dd>
        </dl>
        <Orders />
      </section>
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
          <div className="sales-test-mail">
            <input className="input" type="email" value={to} placeholder={t("sales.testTo")} aria-label={t("sales.testTo")} onChange={(e) => setTo(e.target.value)} />
            <button type="button" className="btn btn-sm" onClick={send} disabled={busy || !to.trim()}>
              {busy ? <span className="spinner" /> : <Mail />} {t("sales.sendTest")}
            </button>
          </div>
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
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t("billing.when")}</th>
                <th>{t("sales.buyer")}</th>
                <th className="num">{t("sales.minutes")}</th>
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
                  <td className="num mono">{o.minutes.toLocaleString()}</td>
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
