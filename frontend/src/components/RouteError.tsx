import { RefreshCw } from "lucide-react";
import { isRouteErrorResponse, useRouteError } from "react-router";
import { useI18n } from "../i18n";

const RELOADED_AT = "mm.reloadedForUpdate";

/** A page's script could not be fetched: usually the site was updated while this tab was open. */
export function isChunkLoadError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Unable to preload CSS/i.test(msg);
}

/**
 * Reload this address once to pick up the new version. Returns false when it
 * just did (within a minute), so a page that keeps failing shows the error
 * instead of reloading forever.
 */
export function reloadForUpdate(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(RELOADED_AT, String(Date.now()));
  } catch {
    /* storage blocked: reload anyway, once per page load */
  }
  window.location.reload();
  return true;
}

/** What a route shows when it fails to load or render. */
export function RouteError() {
  const error = useRouteError();
  const { t } = useI18n();
  const update = isChunkLoadError(error);
  // The site was updated: reload into the new version (the address is already the one being opened).
  if (update && reloadForUpdate()) return null;
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <div className="empty route-error">
      <h3>{update ? t("errors.updatedTitle") : notFound ? t("errors.notFound") : t("errors.pageTitle")}</h3>
      <p>{update ? t("errors.updatedBody") : notFound ? t("errors.notFoundBody") : t("errors.pageBody")}</p>
      <button className="btn btn-primary" onClick={() => window.location.reload()}>
        <RefreshCw /> {t("errors.reload")}
      </button>
    </div>
  );
}
