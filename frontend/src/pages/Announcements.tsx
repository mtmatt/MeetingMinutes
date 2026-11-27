import { AlertTriangle, Info, Megaphone, OctagonAlert } from "lucide-react";
import { useEffect } from "react";
import type { Announcement, AnnouncementLevel } from "../api/types";
import { AnnouncementMarkdown } from "../components/Announcements";
import { useI18n } from "../i18n";
import { useAnnouncements, useMarkSeen } from "../lib/announcements";
import { dateTime } from "../lib/format";

const ICON: Record<AnnouncementLevel, typeof Info> = { info: Info, warning: AlertTriangle, critical: OctagonAlert };

/** Every announcement for this person: those in effect, then recent past ones. Opening the page marks them read. */
export function AnnouncementsPage() {
  const { t } = useI18n();
  const { data, isLoading } = useAnnouncements();
  const markSeen = useMarkSeen();
  const unseen = (data?.active ?? []).filter((a) => !a.seen).map((a) => a.id);
  const key = unseen.join(",");

  useEffect(() => {
    // Read here: the banners (that can be closed) go away.
    if (key) void markSeen(key.split(","));
  }, [key, markSeen]);

  useEffect(() => {
    // A link to one announcement (#id) scrolls to it once the list is there.
    const id = window.location.hash.slice(1);
    if (id && data) document.getElementById(`announcement-${id}`)?.scrollIntoView({ block: "start" });
  }, [data]);

  return (
    <div className="announcements">
      <div className="page-head">
        <div>
          <h1>{t("announce.title")}</h1>
          <p className="muted">{t("announce.lede")}</p>
        </div>
      </div>
      <hr className="rule-double" />
      {isLoading ? (
        <div className="skeleton" style={{ height: 200 }} />
      ) : !data || data.active.length + data.past.length === 0 ? (
        <div className="announce-empty">
          <Megaphone />
          <p>{t("announce.none")}</p>
        </div>
      ) : (
        <>
          {data.active.length > 0 && (
            <section className="announce-section">
              {data.active.map((a) => (
                <Item key={a.id} a={a} isNew={unseen.includes(a.id)} />
              ))}
            </section>
          )}
          {data.past.length > 0 && (
            <section className="announce-section">
              <h2 className="announce-past-h">{t("announce.past")}</h2>
              {data.past.map((a) => (
                <Item key={a.id} a={a} past />
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Item({ a, isNew = false, past = false }: { a: Announcement; isNew?: boolean; past?: boolean }) {
  const { t, locale } = useI18n();
  const Icon = ICON[a.level];
  return (
    <article id={`announcement-${a.id}`} className={`announce-item announce-item-${a.level} ${past ? "is-past" : ""}`}>
      <header>
        <Icon className="announce-icon" aria-hidden="true" />
        <h2>{a.title}</h2>
        {isNew && <span className="pill accent">{t("announce.new")}</span>}
      </header>
      <p className="faint announce-when">
        {dateTime(a.publishedAt, locale)}
        {a.endsAt && (past ? ` · ${t("announce.endedAt", { when: dateTime(a.endsAt, locale) })}` : ` · ${t("announce.until", { when: dateTime(a.endsAt, locale) })}`)}
        {a.edited && ` · ${t("announce.edited")}`}
      </p>
      {a.body.trim() && <AnnouncementMarkdown body={a.body} />}
    </article>
  );
}
