import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Link } from "react-router";
import { api } from "../api/client";
import { METHOD_LABEL, PackageCard, Pitch, Rates } from "../components/Pricing";
import { Wordmark } from "../components/Seal";
import { useI18n } from "../i18n";
import { useAuth } from "../lib/auth";
import { pointsPerMeetingHour } from "../lib/format";
import { useForceNewUi } from "../lib/newUi";

/**
 * What the site sells and for how much, in NT$: open to anyone, signed in or
 * not, so visitors and payment providers reviewing the shop can read the
 * service, its packages and prices, how payment works, the terms and how to
 * get in touch, without an account.
 */
export function PricingPage() {
  // The landing page's look, for everyone: this page is where it sends visitors.
  useForceNewUi();
  const { t } = useI18n();
  const { user, registration, helpContact } = useAuth();
  const q = useQuery({ queryKey: ["pricing"], queryFn: api.pricing, retry: false });
  const p = q.data;
  const contact = p?.contact ?? helpContact;

  const action = user
    ? { to: "/billing", label: t("pricing.buyNow") }
    : registration
      ? { to: "/register", label: t("pricing.buyAfterSignUp") }
      : { to: "/login", label: t("pricing.buyAfterSignIn") };
  const cheapest = p && p.packages.length > 0 ? Math.min(...p.packages.map((x) => x.price / x.points)) : null;
  const hourPoints = p ? pointsPerMeetingHour(p.rates) : 0;

  return (
    <div className="terms-page">
      <header className="terms-head">
        <Link to="/" reloadDocument={!user} className="terms-brand" aria-label="Minutes">
          <Wordmark />
        </Link>
        {user ? (
          <Link to="/" className="btn btn-sm btn-ghost">
            <ArrowLeft /> {t("pricing.backToApp")}
          </Link>
        ) : (
          <div className="pricing-head-actions">
            {registration && (
              <Link to="/register" className="btn btn-sm btn-ghost">
                {t("auth.createAccount")}
              </Link>
            )}
            <Link to="/login" className="btn btn-sm btn-primary">
              {t("auth.signIn")}
            </Link>
          </div>
        )}
      </header>
      <main className="terms-body pricing">
        <p className="smallcaps pricing-kicker">{t("pricing.kicker")}</p>
        <h1 className="pricing-title">{t("pricing.title")}</h1>
        <p className="pricing-intro">{t("pricing.intro")}</p>

        <section className="pricing-section">
          <h2>{t("pricing.serviceTitle")}</h2>
          <ul className="pricing-features">
            <li>{t("pricing.featureTranscript")}</li>
            <li>{t("pricing.featureSpeakers")}</li>
            <li>{t("pricing.featureSummary")}</li>
            <li>{t("pricing.featureSearch")}</li>
          </ul>
        </section>

        {q.isLoading ? (
          <div className="skeleton" style={{ height: 320 }} />
        ) : p ? (
          <>
            <section className="pricing-section">
              <h2>{t("pricing.howTitle")}</h2>
              <p>{t("pricing.howBody")}</p>
              <Rates rates={p.rates} />
            </section>

            <section className="pricing-section">
              <h2>{t("pricing.packagesTitle")}</h2>
              {p.packages.length === 0 ? (
                <p className="muted">{t("pricing.none")}</p>
              ) : (
                <>
                  <Pitch b={p} lowest={hourPoints > 0 && cheapest != null ? hourPoints * cheapest : null} />
                  {!p.onSale && <p className="pill pricing-soon">{t("pricing.comingSoon")}</p>}
                  <div className="billing-packages">
                    {p.packages.map((pkg) => (
                      <PackageCard key={pkg.id} p={pkg} packages={p.packages} rates={p.rates}>
                        {p.onSale && (
                          <Link to={action.to} className="btn btn-primary btn-block">
                            {action.label}
                          </Link>
                        )}
                      </PackageCard>
                    ))}
                  </div>
                </>
              )}
              <p className="pricing-currency">{t("pricing.currencyNote")}</p>
            </section>

            <section className="pricing-section">
              <h2>{t("pricing.payTitle")}</h2>
              <p>{t("pricing.payBody", { methods: p.methods.map((m) => t(METHOD_LABEL[m])).join(t("billing.listSep")) })}</p>
            </section>

            {p.termsUrl && (
              <section className="pricing-section">
                <h2>{t("pricing.termsTitle")}</h2>
                <p>
                  <a href={p.termsUrl} target={p.termsUrl.startsWith("/") ? undefined : "_blank"} rel="noopener noreferrer">
                    {t("pricing.termsLink")}
                    {!p.termsUrl.startsWith("/") && <ExternalLink className="inline-icon" />}
                  </a>
                </p>
              </section>
            )}
          </>
        ) : (
          <p className="muted">{t("pricing.none")}</p>
        )}

        {contact && (
          <section className="pricing-section">
            <h2>{t("pricing.contactTitle")}</h2>
            <p>{/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) ? <a href={`mailto:${contact}`}>{contact}</a> : contact}</p>
          </section>
        )}
      </main>
    </div>
  );
}
