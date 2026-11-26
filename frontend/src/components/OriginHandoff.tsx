import { ArrowRight, Mic } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { useAuth } from "../lib/auth";
import { countRecordings } from "../lib/recordingStore";

/**
 * The site moved to another address (port) of the same host: move there. A
 * browser keeps recordings not yet uploaded per address, so they can only be
 * reached here; while there are any, ask for them to be uploaded (or
 * downloaded) first, and move once they are gone.
 */
export function OriginHandoff() {
  const { t } = useI18n();
  const { siteOrigin } = useAuth();
  const [pending, setPending] = useState<number | null>(null);
  const [leaving, setLeaving] = useState(false);
  const sawPending = useRef(false);

  // Only another port (or scheme) of this same host name: not localhost, the dev server or another name.
  const target = (() => {
    if (!siteOrigin) return null;
    try {
      const site = new URL(siteOrigin);
      return site.origin !== window.location.origin && site.hostname === window.location.hostname ? site.origin : null;
    } catch {
      return null;
    }
  })();

  useEffect(() => {
    if (!target) return;
    const go = () => {
      setLeaving(true);
      const { pathname, search, hash } = window.location;
      window.location.replace(target + pathname + search + hash);
    };
    let stopped = false;
    const check = async () => {
      const n = await countRecordings();
      if (stopped) return;
      setPending(n);
      if (n > 0) {
        sawPending.current = true;
        return;
      }
      // Nothing left here: stop checking and go (after a moment, if the person just finished uploading, so they see why).
      stopped = true;
      if (sawPending.current) setTimeout(go, 1500);
      else go();
    };
    void check();
    const id = window.setInterval(check, 4000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [target]);

  if (!target || pending === null || (pending === 0 && !sawPending.current)) return null;
  const host = new URL(target).host;
  return (
    <div className="handoff" role="status">
      <div className="handoff-inner">
        {pending > 0 ? (
          <>
            <p>
              <strong>{t("handoff.moved", { host })}</strong> {t("handoff.pending", { n: pending, old: window.location.host })}
            </p>
            <div className="handoff-actions">
              <a className="btn btn-sm btn-ink" href="/new?mode=record">
                <Mic /> {t("handoff.handle")}
              </a>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setLeaving(true);
                  window.location.replace(target + window.location.pathname + window.location.search);
                }}
                disabled={leaving}
              >
                {t("handoff.goAnyway")} <ArrowRight />
              </button>
            </div>
          </>
        ) : (
          <p>
            <strong>{t("handoff.done", { host })}</strong>
          </p>
        )}
      </div>
    </div>
  );
}
