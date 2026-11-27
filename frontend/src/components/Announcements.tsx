import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Info, OctagonAlert, X } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router";
import { api } from "../api/client";
import type { Announcement, AnnouncementLevel } from "../api/types";
import { useI18n } from "../i18n";
import { useAnnouncements, useMarkSeen } from "../lib/announcements";

const ICON: Record<AnnouncementLevel, typeof Info> = { info: Info, warning: AlertTriangle, critical: OctagonAlert };
/** Banners shown at once; the rest are counted, with a link to the announcements page. */
const MAX_BANNERS = 2;

export function AnnouncementMarkdown({ body }: { body: string }) {
  return (
    <div className="announce-body prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
    </div>
  );
}

function Banner({ a, onClose, more }: { a: Announcement; onClose?: () => void; more?: boolean }) {
  const { t } = useI18n();
  const Icon = ICON[a.level];
  return (
    <div className={`announce announce-${a.level}`} role={a.level === "critical" ? "alert" : "status"}>
      <Icon className="announce-icon" aria-hidden="true" />
      <div className="announce-text">
        <strong className="announce-title">{a.title}</strong>
        {a.body.trim() && <AnnouncementMarkdown body={a.body} />}
        {more && (
          <Link to={`/announcements#${a.id}`} className="announce-more">
            {t("announce.readMore")} <ArrowRight className="inline-icon" />
          </Link>
        )}
      </div>
      {onClose && (
        <button type="button" className="icon-btn announce-close" onClick={onClose} aria-label={t("announce.close")} title={t("announce.close")}>
          <X />
        </button>
      )}
    </div>
  );
}

/** Below the masthead: announcements in effect that the person has not closed (and those that cannot be closed). */
export function AnnouncementBanners() {
  const { t } = useI18n();
  const { data } = useAnnouncements();
  const markSeen = useMarkSeen();
  const showing = (data?.active ?? []).filter((a) => !a.seen || !a.dismissible);
  if (!showing.length) return null;
  const shown = showing.slice(0, MAX_BANNERS);
  const rest = showing.length - shown.length;
  return (
    <div className="announce-stack">
      {shown.map((a) => (
        <Banner key={a.id} a={a} more={a.body.length > 280} onClose={a.dismissible ? () => void markSeen([a.id]) : undefined} />
      ))}
      {rest > 0 && (
        <Link to="/announcements" className="announce-rest">
          {t("announce.moreN", { n: rest })} <ArrowRight className="inline-icon" />
        </Link>
      )}
    </div>
  );
}

const DISMISSED = "mm.announcements.dismissed";

function readDismissed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** On the sign-in page: those for everyone (maintenance, outages). Closing is remembered in this browser. */
export function PublicAnnouncements() {
  const { data } = useQuery({ queryKey: ["announcements", "public"], queryFn: api.publicAnnouncements, staleTime: 60_000 });
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  const showing = (data?.announcements ?? []).filter((a) => !a.dismissible || !dismissed.includes(a.id));
  if (!showing.length) return null;
  const close = (id: string) => {
    const next = [...dismissed, id].slice(-50);
    setDismissed(next);
    try {
      localStorage.setItem(DISMISSED, JSON.stringify(next));
    } catch {
      /* private mode: closed for this visit only */
    }
  };
  return (
    <div className="announce-stack announce-public">
      {showing.slice(0, 3).map((a) => (
        <Banner key={a.id} a={a} onClose={a.dismissible ? () => close(a.id) : undefined} />
      ))}
    </div>
  );
}
