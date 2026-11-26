import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowRight, CheckCircle2, Clock, Coins, CreditCard, ExternalLink, Landmark, RefreshCw, Store } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api/client";
import type { BillingInfo, CreditPackage, LedgerEntry, Order } from "../api/types";
import { useToast } from "../components/Toast";
import { useI18n } from "../i18n";
import { useAuth } from "../lib/auth";
import { paymentKind, submitCheckout, useBilling } from "../lib/billing";
import { dateTime, minutesText, twd } from "../lib/format";

/**
 * Prepaid minutes: the balance, the packages on sale (paid on ECPay's page),
 * orders waiting for an ATM transfer or a convenience-store payment, and every
 * purchase and transcription that changed the balance.
 */
export function BillingPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const billing = useBilling();
  const [params] = useSearchParams();
  const orderId = params.get("order");

  if (billing.isLoading) return <div className="skeleton" style={{ height: 240 }} />;
  if (!billing.data) return <p className="field-error">{t("common.error")}</p>;
  const b = billing.data;
  const prepaid = user?.billing === "prepaid";

  return (
    <div className="billing">
      <div className="page-head">
        <div>
          <h1>{t("billing.title")}</h1>
          <p className="muted">{prepaid ? t("billing.lede") : t("billing.ledeExempt")}</p>
        </div>
      </div>
      <hr className="rule-double" />

      {orderId && <OrderBanner id={orderId} />}
      {prepaid ? (
        <>
          <Balance b={b} />
          <PendingOrders orders={b.orders.filter((o) => o.status === "pending" && o.paymentInfo && o.id !== orderId)} />
          <Packages b={b} />
        </>
      ) : (
        <div className="callout">
          <CheckCircle2 />
          <span>{t("billing.exemptBody")}</span>
        </div>
      )}
      {b.ledger.length > 0 && <History ledger={b.ledger} />}
    </div>
  );
}

function Balance({ b }: { b: BillingInfo }) {
  const { t, locale } = useI18n();
  const available = b.availableSec ?? b.balanceSec;
  return (
    <section className="billing-balance" aria-label={t("billing.balance")}>
      <div className="billing-balance-main">
        <span className="smallcaps faint">{t("billing.available")}</span>
        <span className={`billing-balance-value ${available <= 0 ? "is-empty" : ""}`}>{minutesText(available, locale)}</span>
      </div>
      <div className="billing-balance-side">
        {b.heldSec > 0 && (
          <span>
            <Clock /> {t("billing.held", { held: minutesText(b.heldSec, locale), total: minutesText(b.balanceSec, locale) })}
          </span>
        )}
        <span className="faint">{t("billing.howCharged")}</span>
      </div>
    </section>
  );
}

function Packages({ b }: { b: BillingInfo }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  if (!b.onSale || b.packages.length === 0) {
    return (
      <section className="billing-section">
        <h2>{t("billing.buy")}</h2>
        <p className="muted">{t("billing.notOnSale")}</p>
      </section>
    );
  }
  const cheapest = Math.min(...b.packages.map((p) => p.price / p.minutes));

  const buy = async (p: CreditPackage) => {
    setBusy(p.id);
    try {
      const { checkout } = await api.createOrder(p.id, locale);
      submitCheckout(checkout);
      // The page is leaving for ECPay; keep the button busy until it does.
    } catch (e) {
      toast.error(e);
      setBusy(null);
    }
  };

  return (
    <section className="billing-section">
      <div className="billing-section-head">
        <h2>{t("billing.buy")}</h2>
        {b.testMode && <span className="pill warn">{t("billing.testMode")}</span>}
      </div>
      <div className="billing-packages">
        {b.packages.map((p) => {
          const unit = p.price / p.minutes;
          return (
            <div key={p.id} className="billing-package">
              <div className="billing-package-minutes">
                <span className="billing-package-number">{p.minutes.toLocaleString()}</span>
                <span className="billing-package-unit">{t("billing.minutesUnit")}</span>
              </div>
              <div className="billing-package-hours faint">{t("billing.hours", { h: (p.minutes / 60).toLocaleString(locale, { maximumFractionDigits: 1 }) })}</div>
              <div className="billing-package-price">{twd(p.price)}</div>
              <div className="billing-package-each faint">
                {t("billing.perMinute", { price: unit.toLocaleString("en", { maximumFractionDigits: 2 }) })}
                {b.packages.length > 1 && unit === cheapest && <span className="pill ok">{t("billing.bestValue")}</span>}
              </div>
              <button type="button" className="btn btn-primary btn-block" onClick={() => buy(p)} disabled={busy != null}>
                {busy === p.id ? <span className="spinner" /> : <CreditCard />} {t("billing.buyThis")}
              </button>
            </div>
          );
        })}
      </div>
      <p className="billing-pay-note faint">
        {t("billing.payNote", { methods: b.methods.map((m) => t(METHOD_LABEL[m])).join(t("billing.listSep")) })}
        {b.termsUrl && (
          <>
            {" "}
            <a href={b.termsUrl} target="_blank" rel="noopener noreferrer">
              {t("billing.terms")} <ExternalLink className="inline-icon" />
            </a>
          </>
        )}
      </p>
    </section>
  );
}

const METHOD_LABEL = { Credit: "billing.methodCredit", ATM: "billing.methodATM", CVS: "billing.methodCVS" } as const;

/** Back from ECPay: how the order stands, asking ECPay if no word came yet. */
function OrderBanner({ id }: { id: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const [order, setOrder] = useState<Order | null>(null);
  const [missing, setMissing] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let stop = false;
    let tries = 0;
    // ECPay's notification usually arrives within seconds: look again a few times.
    const load = async () => {
      try {
        const { order: o } = await api.order(id);
        if (stop) return;
        setOrder(o);
        if (o.status === "paid") void qc.invalidateQueries({ queryKey: ["billing"] });
        else if (o.status === "pending" && !o.paymentInfo && ++tries < 6) setTimeout(load, 2500);
      } catch {
        if (!stop) setMissing(true);
      }
    };
    void load();
    return () => {
      stop = true;
    };
  }, [id, qc]);

  const check = async () => {
    setChecking(true);
    try {
      const { order: o } = await api.refreshOrder(id);
      setOrder(o);
      if (o.status === "paid") await qc.invalidateQueries({ queryKey: ["billing"] });
      else toast.show(t("billing.stillPending"));
    } catch (e) {
      toast.error(e);
    } finally {
      setChecking(false);
    }
  };

  if (missing) return null;
  if (!order) return <div className="skeleton" style={{ height: 72, marginBottom: 24 }} />;
  if (order.status === "paid") {
    return (
      <div className="billing-banner ok" role="status">
        <CheckCircle2 />
        <div>
          <strong>{t("billing.paidTitle", { minutes: order.minutes })}</strong>
          <p>{t("billing.paidBody", { id: order.id })}</p>
        </div>
        <Link className="btn btn-sm btn-ink" to="/new">
          {t("billing.startUpload")} <ArrowRight />
        </Link>
      </div>
    );
  }
  if (order.status === "failed") {
    return (
      <div className="billing-banner danger" role="alert">
        <AlertCircle />
        <div>
          <strong>{t("billing.failedTitle")}</strong>
          <p>{t("billing.failedBody")}</p>
        </div>
      </div>
    );
  }
  if (order.paymentInfo) return <PaymentInstructions order={order} highlight />;
  return (
    <div className="billing-banner" role="status">
      <Clock />
      <div>
        <strong>{t("billing.waitingTitle")}</strong>
        <p>{t("billing.waitingBody")}</p>
      </div>
      <button type="button" className="btn btn-sm" onClick={check} disabled={checking}>
        {checking ? <span className="spinner" /> : <RefreshCw />} {t("billing.checkAgain")}
      </button>
    </div>
  );
}

function PendingOrders({ orders }: { orders: Order[] }) {
  if (!orders.length) return null;
  return (
    <>
      {orders.map((o) => (
        <PaymentInstructions key={o.id} order={o} />
      ))}
    </>
  );
}

/** Where to pay an ATM transfer or a convenience-store code, and by when. */
function PaymentInstructions({ order, highlight = false }: { order: Order; highlight?: boolean }) {
  const { t } = useI18n();
  const info = order.paymentInfo!;
  const atm = paymentKind(info.paymentType ?? order.paymentType) === "atm";
  return (
    <div className={`billing-banner billing-instructions ${highlight ? "info" : ""}`} role="status">
      {atm ? <Landmark /> : <Store />}
      <div>
        <strong>{atm ? t("billing.atmTitle", { amount: twd(order.amount) }) : t("billing.cvsTitle", { amount: twd(order.amount) })}</strong>
        <dl className="billing-codes">
          {atm ? (
            <>
              <dt>{t("billing.bankCode")}</dt>
              <dd className="mono">{info.bankCode}</dd>
              <dt>{t("billing.account")}</dt>
              <dd className="mono">{info.account}</dd>
            </>
          ) : (
            <>
              <dt>{t("billing.paymentNo")}</dt>
              <dd className="mono">{info.paymentNo}</dd>
            </>
          )}
          {info.expireDate && (
            <>
              <dt>{t("billing.payBy")}</dt>
              <dd>{info.expireDate}</dd>
            </>
          )}
        </dl>
        <p className="faint">{t("billing.instructionsNote", { minutes: order.minutes })}</p>
      </div>
    </div>
  );
}

function History({ ledger }: { ledger: LedgerEntry[] }) {
  const { t, locale } = useI18n();
  return (
    <section className="billing-section">
      <h2>{t("billing.history")}</h2>
      <div className="table-wrap">
        <table className="table billing-history">
          <thead>
            <tr>
              <th>{t("billing.when")}</th>
              <th>{t("billing.what")}</th>
              <th className="num">{t("billing.change")}</th>
              <th className="num">{t("billing.after")}</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((e) => (
              <tr key={e.id}>
                <td className="nowrap faint">{dateTime(e.createdAt, locale)}</td>
                <td>
                  <span className="billing-history-kind">
                    {e.kind === "purchase" ? <Coins /> : e.kind === "usage" ? <Clock /> : <RefreshCw />}
                    {e.kind === "usage" ? (
                      e.meetingId ? (
                        <Link to={`/m/${e.meetingId}`}>{e.title ?? t("billing.usage")}</Link>
                      ) : (
                        (e.title ?? t("billing.usage"))
                      )
                    ) : e.kind === "purchase" ? (
                      t("billing.purchase", { note: e.note ?? "" })
                    ) : (
                      t("billing.adjust", { note: e.note ?? "" })
                    )}
                  </span>
                </td>
                <td className={`num mono ${e.deltaSec < 0 ? "" : "billing-plus"}`}>
                  {e.deltaSec > 0 ? "+" : ""}
                  {minutesText(e.deltaSec, locale)}
                </td>
                <td className="num mono faint">{minutesText(e.balanceSec, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
