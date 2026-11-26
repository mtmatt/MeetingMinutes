import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowRight, CheckCircle2, Clock, Coins, CreditCard, ExternalLink, Eye, FileText, Landmark, RefreshCw, Store } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api/client";
import type { BillingInfo, CreditPackage, LedgerEntry, Order } from "../api/types";
import { useToast } from "../components/Toast";
import { useI18n } from "../i18n";
import { useAuth } from "../lib/auth";
import { paymentKind, submitCheckout, useBilling } from "../lib/billing";
import { TYPICAL_HOUR, clock, dateTime, meetingTimeFor, pointsNumber, pointsPerMeetingHour, pointsText, twd, twdApprox } from "../lib/format";

/**
 * Prepaid points: the balance and what it pays for, the packages on sale (paid on ECPay's page),
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
  // An administrator whose own account is free can look at the page as a buyer sees it
  // (a new account with no points; buying turned off).
  const canPreview = !prepaid && user?.role === "admin";
  const preview = canPreview && params.get("preview") === "1";

  return (
    <div className="billing">
      <div className="page-head">
        <div>
          <h1>{t("billing.title")}</h1>
          <p className="muted">{prepaid || preview ? t("billing.lede") : t("billing.ledeExempt")}</p>
        </div>
      </div>
      <hr className="rule-double" />

      {orderId && <OrderBanner id={orderId} />}
      {preview ? (
        <>
          <div className="billing-banner info billing-preview" role="status">
            <Eye />
            <div>
              <strong>{t("billing.previewTitle")}</strong>
              <p>{t("billing.previewBody")}</p>
            </div>
            <Link className="btn btn-sm" to="/billing">
              {t("billing.previewEnd")}
            </Link>
          </div>
          <Balance b={{ ...b, balance: 0, held: 0, available: 0 }} />
          <Packages b={b} preview />
        </>
      ) : prepaid ? (
        <>
          <Balance b={b} />
          <PendingOrders orders={b.orders.filter((o) => o.status === "pending" && o.paymentInfo && o.id !== orderId)} />
          <Packages b={b} />
        </>
      ) : (
        <div className="callout billing-exempt">
          <CheckCircle2 />
          <span>{t("billing.exemptBody")}</span>
          {canPreview && (
            <Link className="btn btn-sm" to="/billing?preview=1">
              <Eye /> {t("billing.previewAsBuyer")}
            </Link>
          )}
        </div>
      )}
      {!preview && b.ledger.length > 0 && <History ledger={b.ledger} />}
    </div>
  );
}

function Balance({ b }: { b: BillingInfo }) {
  const { t, locale } = useI18n();
  const available = b.available ?? b.balance;
  const hours = meetingTimeFor(available, b.rates, locale);
  return (
    <section className="billing-balance" aria-label={t("billing.balance")}>
      <div className="billing-balance-main">
        <span className="smallcaps faint">{t("billing.available")}</span>
        <span className={`billing-balance-value ${available <= 0 ? "is-empty" : ""}`}>{pointsText(available, locale)}</span>
        {hours && available > 0 && (
          <span className="faint billing-balance-hours">
            {t("billing.meetingsAbout", { time: hours })}
            {b.rates.perKInput > 0 || b.rates.perKOutput > 0 ? t("billing.summariesIncluded") : ""}
          </span>
        )}
      </div>
      <div className="billing-balance-side">
        {b.held > 0 && (
          <span>
            <Clock /> {t("billing.held", { held: pointsText(b.held, locale), total: pointsText(b.balance, locale) })}
          </span>
        )}
        <Rates rates={b.rates} />
        <span className="faint">{t("billing.howCharged")}</span>
      </div>
    </section>
  );
}

/** What each kind of work costs, in the reader's words. */
function Rates({ rates }: { rates: BillingInfo["rates"] }) {
  const { t, locale } = useI18n();
  const n = (x: number) => x.toLocaleString(locale === "zh-TW" ? "zh-TW" : "en", { maximumFractionDigits: 3 });
  const summaryFree = rates.perKInput <= 0 && rates.perKOutput <= 0;
  return (
    <dl className="billing-rates">
      <dt>{t("billing.rateTranscription")}</dt>
      <dd>{rates.perMinute > 0 ? t("billing.ratePerMinute", { n: n(rates.perMinute) }) : t("billing.rateFree")}</dd>
      <dt>{t("billing.rateSummary")}</dt>
      <dd>{summaryFree ? t("billing.rateFree") : t("billing.ratePerTokens", { input: n(rates.perKInput), output: n(rates.perKOutput) })}</dd>
    </dl>
  );
}

/** `preview`: an administrator looking as a buyer would; packages show even before the sale opens, and nothing can be bought. */
function Packages({ b, preview = false }: { b: BillingInfo; preview?: boolean }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  // With terms of sale, buying waits for the box to be ticked (it also waives the 7-day withdrawal).
  const [agreed, setAgreed] = useState(false);
  const needsAgreement = !!b.termsUrl;

  if (b.packages.length === 0 || (!b.onSale && !preview)) {
    return (
      <section className="billing-section">
        <h2>{t("billing.buy")}</h2>
        <p className="muted">{preview ? t("billing.previewNoPackages") : t("billing.notOnSale")}</p>
      </section>
    );
  }
  const cheapest = Math.min(...b.packages.map((p) => p.price / p.points));
  // A typical hour of meeting (recording and summary), in points and, at each package's price, in dollars.
  const hourPoints = pointsPerMeetingHour(b.rates);
  const summariesPriced = b.rates.perKInput > 0 || b.rates.perKOutput > 0;

  const buy = async (p: CreditPackage) => {
    if (preview) return;
    setBusy(p.id);
    try {
      const { checkout } = await api.createOrder(p.id, locale, agreed);
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
        {preview && !b.onSale && <span className="pill">{t("billing.previewNotOnSale")}</span>}
      </div>
      <Pitch b={b} lowest={hourPoints > 0 ? hourPoints * cheapest : null} />
      {needsAgreement && (
        <label className={`check billing-agree ${agreed ? "" : "is-open"}`}>
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>
            {t("billing.agreeBefore")}
            <a href={b.termsUrl!} target="_blank" rel="noopener noreferrer">
              {t("billing.terms")}
              {!b.termsUrl!.startsWith("/") && <ExternalLink className="inline-icon" />}
            </a>
            {t("billing.agreeAfter")}
          </span>
        </label>
      )}
      <div className="billing-packages">
        {b.packages.map((p) => {
          const unit = p.price / p.points;
          const hours = meetingTimeFor(p.points * 1000, b.rates, locale);
          return (
            <div key={p.id} className="billing-package">
              <div className="billing-package-minutes">
                <span className="billing-package-number">{p.points.toLocaleString()}</span>
                <span className="billing-package-unit">{t("billing.pointsUnit")}</span>
              </div>
              <div className="billing-package-hours">
                {hours ? (
                  <>
                    <span>{t("billing.meetingsAbout", { time: hours })}</span>
                    {summariesPriced && <span>{t("billing.summariesIncluded")}</span>}
                  </>
                ) : (
                  "\u00a0"
                )}
              </div>
              <div className="billing-package-price">{twd(p.price)}</div>
              <div className="billing-package-each">
                {hourPoints > 0 && <span className="billing-package-hourly">{t("billing.perHour", { price: twdApprox((hourPoints * p.price) / p.points) })}</span>}
                {b.packages.length > 1 && unit === cheapest && <span className="pill ok">{t("billing.bestValue")}</span>}
              </div>
              <div className="billing-package-point faint">{t("billing.perPoint", { price: unit.toLocaleString("en", { maximumFractionDigits: 2 }) })}</div>
              <button type="button" className="btn btn-primary btn-block" onClick={() => buy(p)} disabled={preview || busy != null || (needsAgreement && !agreed)}
                title={preview ? t("billing.previewBuyOff") : undefined}
              >
                {busy === p.id ? <span className="spinner" /> : <CreditCard />} {t("billing.buyThis")}
              </button>
            </div>
          );
        })}
      </div>
      {hourPoints > 0 && (
        <p className="billing-pay-note faint">
          {t("billing.hourBasis", { input: TYPICAL_HOUR.input.toLocaleString("en"), output: TYPICAL_HOUR.output.toLocaleString("en"), points: pointsText(hourPoints * 1000, locale) })}
        </p>
      )}
      <p className="billing-pay-note faint">{t("billing.payNote", { methods: b.methods.map((m) => t(METHOD_LABEL[m])).join(t("billing.listSep")) })}</p>
    </section>
  );
}

/**
 * Why prepaid points: no subscription, pay for what is used, by the second; points that never
 * expire when the administrator says so; and the lowest price of an hour's meeting.
 */
function Pitch({ b, lowest }: { b: BillingInfo; lowest: number | null }) {
  const { t } = useI18n();
  const parts = [t("billing.pitchNoSubscription")];
  if (b.rates.perMinute > 0) parts.push(t("billing.pitchBySecond"));
  if (b.noExpiry) parts.push(t("billing.pitchNoExpiry"));
  return (
    <div className="billing-pitch">
      <p className="billing-pitch-points">{parts.join(t("billing.pitchSep"))}</p>
      {lowest != null && <p className="billing-pitch-price">{t("billing.pitchFrom", { price: twdApprox(lowest) })}</p>}
    </div>
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
          <strong>{t("billing.paidTitle", { points: order.points.toLocaleString() })}</strong>
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
        <p className="faint">{t("billing.instructionsNote", { points: order.points.toLocaleString() })}</p>
      </div>
    </div>
  );
}

function History({ ledger }: { ledger: LedgerEntry[] }) {
  const { t, locale } = useI18n();
  const n = (x: number) => x.toLocaleString(locale === "zh-TW" ? "zh-TW" : "en");
  /** What the work was: "Transcription · 1:31" / "Summary · 12,000 tokens read, 900 written". */
  const what = (e: LedgerEntry): string => {
    if (e.kind === "purchase") return t("billing.purchase", { note: e.note ?? "" });
    if (e.kind === "adjust") return t("billing.adjust", { note: e.note ?? "" });
    const q = e.quantity;
    if (e.kind === "transcription") return q?.sec != null ? t("billing.usedTranscription", { time: clock(q.sec) }) : t("billing.usage");
    return q?.input != null ? t("billing.usedSummary", { input: n(q.input), output: n(q.output ?? 0) }) : t("billing.usageSummary");
  };
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
                    {e.kind === "purchase" ? <Coins /> : e.kind === "transcription" ? <Clock /> : e.kind === "summary" ? <FileText /> : <RefreshCw />}
                    <span>
                      {(e.kind === "transcription" || e.kind === "summary") && e.title && (
                        <span className="billing-history-title">
                          {e.meetingId ? <Link to={`/m/${e.meetingId}`}>{e.title}</Link> : e.title}
                        </span>
                      )}
                      <span className={e.kind === "transcription" || e.kind === "summary" ? "faint billing-history-what" : ""}>{what(e)}</span>
                    </span>
                  </span>
                </td>
                <td className={`num mono ${e.delta < 0 ? "" : "billing-plus"}`}>
                  {e.delta > 0 ? "+" : ""}
                  {pointsNumber(e.delta, locale, true)}
                </td>
                <td className="num mono faint">{pointsNumber(e.balance, locale, true)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
