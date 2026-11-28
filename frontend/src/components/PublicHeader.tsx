import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";
import { useI18n } from "../i18n";
import { useAuth } from "../lib/auth";
import { Wordmark } from "./Seal";

/**
 * The header of the public pages next to the landing page (prices, terms):
 * the brand, which goes to the front page, then sign-up and sign-in for a
 * visitor, or the way back for someone signed in.
 */
export function PublicHeader({ back }: { back: { to: string; label: string } }) {
  const { t } = useI18n();
  const { user, registration } = useAuth();
  return (
    <header className="terms-head">
      <Link to="/" reloadDocument={!user} className="terms-brand">
        <Wordmark />
      </Link>
      {user ? (
        <Link to={back.to} className="btn btn-sm btn-ghost">
          <ArrowLeft /> {back.label}
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
  );
}
