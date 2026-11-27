import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api/client";
import { PublicHeader } from "../components/PublicHeader";
import { useI18n } from "../i18n";
import { dateLong } from "../lib/format";
import { useForceNewUi } from "../lib/newUi";

/** The terms of sale, as the administrator wrote them; open to anyone, signed in or not. */
export function TermsPage() {
  // The landing page's look, for everyone, like the price list beside it.
  useForceNewUi();
  const { t, locale } = useI18n();
  const terms = useQuery({ queryKey: ["terms"], queryFn: api.terms, retry: false });
  return (
    <div className="terms-page">
      <PublicHeader back={{ to: "/billing", label: t("terms.backToPoints") }} />
      <main className="terms-body terms">
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
