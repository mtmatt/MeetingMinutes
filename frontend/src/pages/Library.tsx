import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Clock, FileVideo, Languages, Mic, RefreshCw, Search, Trash2, Upload, Users, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api/client";
import type { MeetingSummary } from "../api/types";
import { Seal } from "../components/Seal";
import { MeetingStatus } from "../components/Status";
import { useI18n, type TKey } from "../i18n";
import { clock, dateLong, dayParts, duration, monthYear, time } from "../lib/format";
import { apiErrorMessage, describeFailure } from "../lib/errors";
import { useConfirm } from "../components/Modal";
import { useToast } from "../components/Toast";
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

function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

function Row({ m, query }: { m: MeetingSummary; query: string }) {
  const { t, tMaybe, locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const when = m.occurredAt ?? m.createdAt;
  const { day, weekday } = dayParts(when, locale);
  const lang = languageLabel(m.language, tMaybe);
  const failure = m.status === "failed" ? describeFailure(m.error) : null;

  // Buttons inside the row link must not trigger navigation.
  const act = (fn: () => Promise<void> | void) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void fn();
  };
  const retry = async () => {
    try {
      await api.retranscribe(m.id);
      await qc.invalidateQueries({ queryKey: ["meetings"] });
    } catch (err) {
      toast.error(apiErrorMessage(err, t));
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: t("meeting.deleteTitle"), body: t("meeting.deleteBody"), confirmLabel: t("common.delete"), danger: true }))) return;
    await api.deleteMeeting(m.id).catch((err) => toast.error(apiErrorMessage(err, t)));
    await qc.invalidateQueries({ queryKey: ["meetings"] });
  };

  let preview: ReactNode = null;
  if (m.match) {
    preview = (
      <p className="ledger-preview">
        <span className="ledger-preview-label">
          {t("library.foundAt", { t: clock(m.match.start) })}
        </span>
        {highlight(m.match.text, query)}
      </p>
    );
  } else if (m.summaryExcerpt) {
    preview = (
      <p className="ledger-preview">
        <span className="ledger-preview-label">{t("library.fromSummary")}</span>
        {m.summaryExcerpt}
      </p>
    );
  } else if (m.preview) {
    preview = (
      <p className="ledger-preview muted-preview">
        <span className="ledger-preview-label">{t("library.fromTranscript")}</span>
        {m.preview}
      </p>
    );
  }

  return (
    <Link to={m.match ? `/m/${m.id}?t=${Math.ceil(m.match.start * 10) / 10}` : `/m/${m.id}`} className={`ledger-row ${failure ? "is-failed" : ""}`}>
      <div className="ledger-date" aria-label={dateLong(when, locale)}>
        <span className="ledger-day">{day}</span>
        <span className="ledger-weekday">{weekday}</span>
      </div>
      <div className="ledger-main">
        <h3 className="ledger-title">{m.title}</h3>
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
              <FileVideo /> {t("library.video")}
            </span>
          )}
        </div>
        {failure ? (
          <div className="ledger-failure">
            <p>
              <AlertTriangle /> {t(failure.key)}
            </p>
            <div className="ledger-failure-actions">
              {failure.canRetry && (
                <button className="btn btn-sm" onClick={act(retry)}>
                  <RefreshCw /> {t("library.retry")}
                </button>
              )}
              {failure.reupload && (
                <button className="btn btn-sm" onClick={act(() => navigate("/new"))}>
                  <Upload /> {t("library.reupload")}
                </button>
              )}
              <button className="btn btn-sm btn-ghost btn-danger" onClick={act(remove)}>
                <Trash2 /> {t("common.delete")}
              </button>
            </div>
          </div>
        ) : (
          preview
        )}
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
          <div className="eyebrow library-count">{query ? t("library.searchResults", { q: query, n: total }) : total === 1 ? t("library.countOne") : t("library.count", { n: total })}</div>
          <h1>{t("library.title")}</h1>
        </div>
        <div className="library-tools">
          <label className="search-field library-search">
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
          <div className="library-empty-actions">
            <Link to="/new" className="btn btn-primary btn-lg">
              <Upload /> {t("nav.addUpload")}
            </Link>
            <Link to="/new?mode=record" className="btn btn-lg">
              <Mic /> {t("nav.addRecord")}
            </Link>
          </div>
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
                <Row key={m.id} m={m} query={query} />
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
