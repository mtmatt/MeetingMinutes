import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router";
import { api } from "../api/client";
import { Wordmark } from "../components/Seal";
import { useI18n } from "../i18n";
import { useAuth } from "../lib/auth";
import { dateLong } from "../lib/format";

/** The terms of sale, as the administrator wrote them; open to anyone, signed in or not. */
export function TermsPage() {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const terms = useQuery({ queryKey: ["terms"], queryFn: api.terms, retry: false });
  return (
    <div className="terms-page">
      <header className="terms-head">
        <Link to="/" className="terms-brand" aria-label="Minutes">
          <Wordmark />
        </Link>
        <Link to={user ? "/billing" : "/login"} className="btn btn-sm btn-ghost">
          <ArrowLeft /> {user ? t("terms.backToPoints") : t("auth.backToSignIn")}
        </Link>
      </header>
      <main className="terms-body">
        {terms.isLoading ? (
          <div className="skeleton" style={{ height: 320 }} />
        ) : terms.data ? (
          <>
            <article className="prose terms-prose">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{terms.data.markdown}</ReactMarkdown>
            </article>
            {terms.data.updatedAt && <p className="faint terms-updated">{t("terms.savedOn", { date: dateLong(terms.data.updatedAt, locale) })}</p>}
          </>
        ) : (
          <p className="muted">{t("terms.none")}</p>
        )}
      </main>
    </div>
  );
}
