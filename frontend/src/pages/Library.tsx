import { useQuery } from "@tanstack/react-query";
import { Clock, FileVideo, Languages, Search, Upload, Users, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api/client";
import type { MeetingSummary } from "../api/types";
import { Seal } from "../components/Seal";
import { MeetingStatus } from "../components/Status";
import { useI18n, type TKey } from "../i18n";
import { dayParts, duration, monthYear, time } from "../lib/format";
import { setPendingFile } from "../lib/pendingFile";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

function languageLabel(lang: string | null, tMaybe: (k: string) => string | undefined): string | null {
  if (!lang) return null;
  return lang
    .split(",")
    .map((l) => tMaybe(`lang.${l}`) ?? l)
    .join(" + ");
}

function Row({ m }: { m: MeetingSummary }) {
  const { t, tMaybe, locale } = useI18n();
  const when = m.occurredAt ?? m.createdAt;
  const { day, weekday } = dayParts(when, locale);
  const lang = languageLabel(m.language, tMaybe);
  return (
    <Link to={`/m/${m.id}`} className="ledger-row">
      <div className="ledger-date">
        <span className="ledger-day">{day}</span>
        <span className="smallcaps">{weekday}</span>
      </div>
      <div className="ledger-main">
        <div className="ledger-title-row">
          <h3 className="ledger-title">{m.title}</h3>
        </div>
        <div className="ledger-meta">
          <span>
            <Clock /> {time(when, locale)}
          </span>
          {m.durationSec != null && <span>{duration(m.durationSec, locale)}</span>}
          {m.speakerCount > 0 && (
            <span>
              <Users /> {m.speakerCount === 1 ? t("library.speakerOne") : t("library.speakers", { n: m.speakerCount })}
            </span>
          )}
          {lang && (
            <span>
              <Languages /> {lang}
            </span>
          )}
          {m.media.hasVideo && (
            <span>
              <FileVideo />
            </span>
          )}
        </div>
        {m.preview && <p className="ledger-preview">{m.preview}</p>}
        {m.status === "failed" && m.error && <p className="ledger-error">{m.error}</p>}
      </div>
      <div className="ledger-status">
        <MeetingStatus m={m} />
      </div>
    </Link>
  );
}

export function LibraryPage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const query = useDebounced(q.trim(), 250);
  const { data, isLoading } = useQuery({
    queryKey: ["meetings", query],
    queryFn: () => api.meetings(query),
    placeholderData: (prev) => prev,
  });
  const meetings = data?.meetings ?? [];

  const groups = useMemo(() => {
    const out: { label: string; items: MeetingSummary[] }[] = [];
    for (const m of meetings) {
      const label = monthYear(m.occurredAt ?? m.createdAt, locale);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(m);
      else out.push({ label, items: [m] });
    }
    return out;
  }, [meetings, locale]);

  // Drop a file anywhere on the page to start a new recording.
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const onDragEnter = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    depth.current++;
    setDragging(true);
  };
  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) {
      setPendingFile(f);
      navigate("/new");
    }
  };

  const total = meetings.length;
  return (
    <div
      className="library"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="page-head library-head">
        <div>
          <div className="smallcaps eyebrow">{query ? `“${query}”` : (total === 1 ? t("library.countOne") : t("library.count", { n: total }))}</div>
          <h1>{t("library.title")}</h1>
        </div>
        <div className="library-tools">
          <label className="input-line library-search">
            <Search />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("library.search")} aria-label={t("library.search")} />
            {q && (
              <button className="icon-btn sm" onClick={() => setQ("")} aria-label={t("common.close")}>
                <X />
              </button>
            )}
          </label>
        </div>
      </div>
      <hr className="rule-double" />

      {isLoading ? (
        <div className="ledger">
          {[0, 1, 2].map((i) => (
            <div className="ledger-row" key={i} style={{ pointerEvents: "none" }}>
              <div className="ledger-date">
                <div className="skeleton" style={{ width: 36, height: 34 }} />
              </div>
              <div className="ledger-main" style={{ gap: 10 }}>
                <div className="skeleton" style={{ width: "46%", height: 22 }} />
                <div className="skeleton" style={{ width: "30%", height: 14 }} />
                <div className="skeleton" style={{ width: "80%", height: 14 }} />
              </div>
            </div>
          ))}
        </div>
      ) : total === 0 && !query ? (
        <div className="library-empty">
          <Seal size={56} />
          <h2>{t("library.empty")}</h2>
          <p>{t("library.emptyBody")}</p>
          <Link to="/new" className="btn btn-primary btn-lg">
            <Upload /> {t("library.upload")}
          </Link>
        </div>
      ) : total === 0 ? (
        <div className="empty">
          <p>{t("library.noResults", { q: query })}</p>
        </div>
      ) : (
        <div className="ledger">
          {groups.map((g) => (
            <section key={g.label} className="ledger-group">
              <h2 className="ledger-month">
                <span>{g.label}</span>
                <span className="ledger-month-count mono">{String(g.items.length).padStart(2, "0")}</span>
              </h2>
              {g.items.map((m) => (
                <Row key={m.id} m={m} />
              ))}
            </section>
          ))}
        </div>
      )}

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-card">
            <Upload />
            <span>{t("library.dropHere" as TKey)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
