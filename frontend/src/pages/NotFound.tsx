import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";
import { Seal } from "../components/Seal";
import { useI18n } from "../i18n";

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <div className="notfound">
      <Seal size={52} />
      <div className="notfound-code mono">404</div>
      <h1>{t("errors.notFound")}</h1>
      <p className="muted">{t("errors.notFoundBody")}</p>
      <Link to="/" className="btn btn-ink">
        <ArrowLeft /> {t("nav.library")}
      </Link>
    </div>
  );
}
