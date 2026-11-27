import type { ReactNode } from "react";
import type { CreditPackage, PaymentMethod, Rates as RateTable } from "../api/types";
import { useI18n } from "../i18n";
import { meetingTimeFor, pointsPerMeetingHour, twd, twdApprox } from "../lib/format";

/**
 * The pieces of a price list shared by the purchase page and the public
 * pricing page: what each kind of work costs, why prepaid points, and one
 * package's card (its points, roughly how much meeting they cover, and its
 * price in NT$). `children` is the card's action.
 */

/** What each kind of work costs, in the reader's words. */
export function Rates({ rates }: { rates: RateTable }) {
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

/**
 * Why prepaid points: no subscription, pay for what is used, by the second; points that never
 * expire when the administrator says so; and the lowest price of an hour's meeting.
 */
export function Pitch({ b, lowest }: { b: { rates: RateTable; noExpiry: boolean }; lowest: number | null }) {
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

export const METHOD_LABEL: Record<PaymentMethod, "billing.methodCredit" | "billing.methodATM" | "billing.methodCVS"> = { Credit: "billing.methodCredit", ATM: "billing.methodATM", CVS: "billing.methodCVS" };


export function PackageCard({ p, packages, rates, children }: { p: CreditPackage; packages: CreditPackage[]; rates: RateTable; children?: ReactNode }) {
  const { t, locale } = useI18n();
  const unit = p.price / p.points;
  const cheapest = Math.min(...packages.map((x) => x.price / x.points));
  const hours = meetingTimeFor(p.points * 1000, rates, locale);
  const hourPoints = pointsPerMeetingHour(rates);
  const summariesPriced = rates.perKInput > 0 || rates.perKOutput > 0;
  return (
    <div className="billing-package">
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
        {packages.length > 1 && unit === cheapest && <span className="pill ok">{t("billing.bestValue")}</span>}
      </div>
      <div className="billing-package-point faint">{t("billing.perPoint", { price: unit.toLocaleString("en", { maximumFractionDigits: 2 }) })}</div>
      {children}
    </div>
  );
}
