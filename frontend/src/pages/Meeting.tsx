import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Download,
  FileAudio,
  FileVideo,
  FileX2,
  Languages,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  Users,
  Undo2,
  Video,
  Wand2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ApiError, api, mediaUrl } from "../api/client";
import type { MeetingDetail } from "../api/types";
import { Menu } from "../components/Menu";
import { useConfirm } from "../components/Modal";
import { PlayerBar } from "../components/Player";
import { MeetingStatus } from "../components/Status";
import { DiarizationNotice, ResplitDialog, RetranscribeDialog } from "../components/Diarization";
import { SummaryExportItems, SummaryPanel, useSummaryInfo, useSummarySelection } from "../components/SummaryPanel";
import { useToast } from "../components/Toast";
import { Transcript } from "../components/Transcript";
import { useI18n, type TKey } from "../i18n";
import { PAGE_DATA_FRESH_MS } from "../lib/prefetch";
import { bytes, dateLong, dateTime, duration, monthDay } from "../lib/format";
import { setPageContext } from "../lib/pageContext";
import { PlayerProvider, usePlayer, usePlayerShortcuts } from "../lib/player";
import { useAuth } from "../lib/auth";
import { apiErrorMessage, describeFailure } from "../lib/errors";

const PIPELINE: { key: string; label: TKey; stages: string[] }[] = [
  { key: "queued", label: "status.queued", stages: ["queued", "starting", "retrying"] },
  // Loading the models, and on a machine elsewhere also receiving the recording; named by what it is doing.
  { key: "prepare", label: "stage.prepare", stages: ["loading", "downloading"] },
  { key: "decode", label: "stage.decoding", stages: ["decoding", "preparing"] },
  { key: "speakers", label: "stage.diarizing", stages: ["diarizing"] },
  { key: "transcribe", label: "stage.transcribing", stages: ["transcribing", "finalizing", "uploading"] },
];

/** What the current stage is doing, where a number alone would not say (it can sit at 0% for minutes). */
const STAGE_HINT: Record<string, TKey> = {
  loading: "meeting.hintLoading",
  downloading: "meeting.hintDownloading",
  uploading: "meeting.hintUploading",
};
/** Stages whose length cannot be told in advance: the bar moves without a figure. */
const UNMEASURED = new Set(["starting", "loading"]);

function Pipeline({ meeting, onRetry }: { meeting: MeetingDetail; onRetry: () => void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const current = meeting.status === "queued" ? "queued" : meeting.stage ?? "starting";
  const activeIdx = PIPELINE.findIndex((p) => p.stages.includes(current));
  const pct = Math.round(meeting.progress * 100);
  const hint = STAGE_HINT[current];
  const unmeasured = meeting.status === "queued" || (UNMEASURED.has(current) && pct === 0);

  if (meeting.status === "failed") {
    const failure = describeFailure(meeting.error);
    return (
      <div className="processing failed">
        <div className="failure-head">
          <span className="failure-icon">
            <AlertTriangle />
          </span>
          <div>
            <h2>{t("meeting.failedTitle")}</h2>
            <p>{t(failure.key)}</p>
            <p className="muted">{t(`${failure.key}Next` as TKey)}</p>
          </div>
        </div>
        <div className="failure-actions">
          {failure.canRetry && (
            <button className="btn btn-ink" onClick={onRetry}>
              <RefreshCw /> {t("library.retry")}
            </button>
          )}
          {failure.reupload && (
            <button className="btn" onClick={() => navigate("/new")}>
              <Upload /> {t("library.reupload")}
            </button>
          )}
          {failure.key === "failure.credits" && (
            <button className="btn" onClick={() => navigate("/billing")}>
              {t("upload.buyMinutes")}
            </button>
          )}
        </div>
        {meeting.error && (
          <details className="tech-details">
            <summary>{t("meeting.technicalDetails")}</summary>
            <pre className="mono">{meeting.error}</pre>
          </details>
        )}
      </div>
    );
  }
  if (meeting.status === "uploading") {
    return (
      <div className="processing">
        <div className="callout warn">
          <AlertTriangle />
          <div>{t("meeting.uploadingBody")}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="processing">
      <div className="processing-head">
        <div>
          <div className="smallcaps">{t("meeting.processingTitle")}</div>
          {meeting.status === "queued" ? (
            <div className="processing-pct processing-wait">{t("status.queued")}</div>
          ) : (
            <div className="processing-pct">
              <span className="mono">{pct}</span>
              <span className="pct">%</span>
            </div>
          )}
        </div>
        <div className="processing-note">
          {hint && <p className="processing-hint">{t(hint)}</p>}
          <p className="muted">{meeting.status === "queued" ? t("meeting.queuedBody") : t("meeting.processingBody")}</p>
        </div>
      </div>
      <ol className="pipeline">
        {PIPELINE.map((p, i) => {
          const state = i < activeIdx ? "done" : i === activeIdx ? "active" : "todo";
          return (
            <li key={p.key} className={`pipeline-step ${state}`}>
              <span className="pipeline-mark">{state === "done" ? <Check /> : <span className="mono">{i + 1}</span>}</span>
              <span className="pipeline-label">{state === "active" && p.key === "prepare" ? t(`stage.${current}` as TKey) : t(p.label)}</span>
            </li>
          );
        })}
      </ol>
      <div className={`progress ${unmeasured ? "indeterminate" : ""}`} style={{ height: 6 }}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function EditableTitle({ meeting }: { meeting: MeetingDetail }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(meeting.title);
  useEffect(() => setValue(meeting.title), [meeting.title]);
  const save = async () => {
    setEditing(false);
    const v = value.trim();
    if (!v || v === meeting.title) return setValue(meeting.title);
    try {
      await api.updateMeeting(meeting.id, { title: v });
      await qc.invalidateQueries({ queryKey: ["meeting", meeting.id] });
      await qc.invalidateQueries({ queryKey: ["meetings"] });
    } catch (e) {
      toast.error(e);
    }
  };
  if (editing) {
    return (
      <input
        className="title-input"
        value={value}
        autoFocus
        maxLength={200}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setValue(meeting.title);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <h1 className="meeting-title" onClick={() => setEditing(true)} title={t("meeting.titleRenameHint")}>
      {meeting.title}
      {/* Inline after the last word, so it reads as part of the title wherever it wraps. */}
      <button type="button" className="title-edit" aria-label={t("meeting.renameTitle")}>
        <Pencil aria-hidden="true" />
      </button>
    </h1>
  );
}

function VideoPane() {
  const { register } = usePlayer();
  const { id = "" } = useParams();
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    register(ref.current);
  }, [register]);
  return (
    <div className="video-pane">
      <video ref={ref} src={mediaUrl.original(id)} preload="metadata" playsInline />
    </div>
  );
}

function MeetingBody({ meeting }: { meeting: MeetingDetail }) {
  const { t, tMaybe, locale } = useI18n();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const qc = useQueryClient();
  const [videoMode, setVideoMode] = useState(false);
  const [tab, setTab] = useState<"transcript" | "summary">("transcript");
  const [resplit, setResplit] = useState(false);
  const summarySelection = useSummarySelection(meeting.summaries);
  const summaryInfo = useSummaryInfo(meeting);
  const exportable = summarySelection.current?.status === "done" ? summarySelection.current : null;
  usePlayerShortcuts();

  // Deep link from a search result: /m/:id?t=seconds
  const [params] = useSearchParams();
  const { seek } = usePlayer();
  useEffect(() => {
    const t0 = Number(params.get("t"));
    if (Number.isFinite(t0) && t0 > 0) seek(t0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ready = meeting.status === "ready";
  // The recording was deleted after its retention period: the transcript and summaries stay.
  const mediaGone = meeting.media.deletedAt != null;
  const when = meeting.occurredAt ?? meeting.createdAt;
  const headRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = headRef.current;
    if (!el) return;
    const ctx = {
      title: meeting.title,
      subtitle: monthDay(when, locale),
      onClick: () => window.scrollTo({ top: 0, behavior: "smooth" }),
    };
    const io = new IntersectionObserver(([entry]) => setPageContext(entry && !entry.isIntersecting ? ctx : null), {
      rootMargin: "-64px 0px 0px 0px",
    });
    io.observe(el);
    return () => {
      io.disconnect();
      setPageContext(null);
    };
  }, [meeting.title, when, locale]);
  const lang = meeting.language
    ?.split(",")
    .map((l) => tMaybe(`lang.${l}`) ?? l)
    .join(" + ");

  // Transcribing again: a dialog with the option to correct the new transcript with AI.
  const [retranscribing, setRetranscribing] = useState(false);
  const retranscribe = async () => setRetranscribing(true);

  // AI correction of the transcript (a hosted model, from the meeting's topic).
  const { refine: refineInfo } = useAuth();
  const refinement = meeting.refinement ?? null;
  const refining = refinement?.status === "queued" || refinement?.status === "running";
  const corrected = meeting.segments.filter((s) => s.original != null).length;
  const startRefine = async () => {
    if (!(await confirm({ title: t("refine.confirmTitle"), body: t("refine.confirmBody", { vendor: refineInfo?.vendor ?? "", host: refineInfo?.host ?? "" }), confirmLabel: t("refine.confirm") })))
      return;
    try {
      qc.setQueryData(["meeting", meeting.id], await api.refineMeeting(meeting.id));
    } catch (e) {
      toast.error(e);
    }
  };
  const undoRefine = async () => {
    if (!(await confirm({ title: t("refine.undoTitle"), body: t("refine.undoBody", { n: corrected }), confirmLabel: t("refine.undo") }))) return;
    try {
      const r = await api.undoRefineMeeting(meeting.id);
      qc.setQueryData(["meeting", meeting.id], { meeting: r.meeting });
      toast.show(t("refine.undone", { n: r.restored }));
    } catch (e) {
      toast.error(e);
    }
  };

  const remove = async () => {
    if (!(await confirm({ title: t("meeting.deleteTitle"), body: t("meeting.deleteBody"), confirmLabel: t("common.delete"), danger: true }))) return;
    try {
      await api.deleteMeeting(meeting.id);
      qc.removeQueries({ queryKey: ["meeting", meeting.id] });
      await qc.invalidateQueries({ queryKey: ["meetings"] });
      toast.show(t("meeting.deleted"));
      navigate("/", { replace: true });
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className={`meeting ${ready && !mediaGone ? "has-player" : ""}`}>
      <header className="meeting-head" ref={headRef}>
        <Link to="/" className="back-link">
          <ArrowLeft /> {t("meeting.backToLibrary")}
        </Link>
        <div className="meeting-head-row">
          <div className="meeting-head-main">
            <EditableTitle meeting={meeting} />
            <div className="meeting-meta">
              <span>{dateTime(when, locale)}</span>
              {meeting.durationSec != null && <span>{duration(meeting.durationSec, locale)}</span>}
              {meeting.speakers.length > 0 && (
                <span>
                  <Users /> {meeting.speakers.length === 1 ? t("library.speakerOne") : t("library.speakers", { n: meeting.speakers.length })}
                </span>
              )}
              {lang && (
                <span>
                  <Languages /> {lang}
                </span>
              )}
              {mediaGone ? (
                <span className="faint" title={meeting.media.name}>
                  <FileX2 /> {t("retention.metaDeleted")}
                </span>
              ) : (
                <span className="faint" title={meeting.media.name}>
                  {meeting.media.hasVideo ? <FileVideo /> : <FileAudio />} {bytes(meeting.media.size)}
                  {meeting.media.deletesAt != null && <> · {t("retention.metaKeptUntil", { date: monthDay(meeting.media.deletesAt, locale) })}</>}
                </span>
              )}
              <MeetingStatus m={meeting} />
            </div>
          </div>
          <div className="meeting-actions">
            {ready && !mediaGone && meeting.media.hasVideo && (
              <button className="btn btn-sm" aria-pressed={videoMode} onClick={() => setVideoMode((v) => !v)}>
                <Video /> {t("meeting.showVideo")}
              </button>
            )}
            {ready && (
              <Menu
                trigger={({ toggle }) => (
                  <button className="btn btn-sm" onClick={toggle}>
                    <Download /> {t("meeting.export")}
                  </button>
                )}
              >
                {(close) => (
                  <>
                    {exportable && (
                      <>
                        <div className="menu-label smallcaps">
                          {meeting.summaries.length > 1
                            ? `${t("meeting.exportSummary")} · ${t("summary.version", { n: summaryInfo.versionOf(exportable) })}`
                            : t("meeting.exportSummary")}
                        </div>
                        <SummaryExportItems
                          onExport={(withTranscript) => {
                            summaryInfo.exportMarkdown(exportable, withTranscript);
                            close();
                          }}
                          onGoogleDoc={(withTranscript) => {
                            summaryInfo.exportGoogleDoc(exportable, withTranscript);
                            close();
                          }}
                          onPdf={() => {
                            close();
                            summaryInfo.exportPdf(exportable);
                          }}
                        />
                        <div className="menu-sep" />
                      </>
                    )}
                    <div className="menu-label smallcaps">{t("meeting.exportTranscript")}</div>
                    {[
                      ["txt", "Plain text", ".txt"],
                      ["md", "Markdown", ".md"],
                      ["srt", "Subtitles", ".srt"],
                      ["vtt", "WebVTT", ".vtt"],
                      ["json", "JSON", ".json"],
                    ].map(([f, label, ext]) => (
                      <a key={f} className="menu-item" href={mediaUrl.export(meeting.id, f!)} download>
                        {label}
                        <span className="end mono">{ext}</span>
                      </a>
                    ))}
                    {!mediaGone && (
                      <>
                        <div className="menu-sep" />
                        <a className="menu-item" href={mediaUrl.original(meeting.id, true)} download>
                          {meeting.media.hasVideo ? <FileVideo /> : <FileAudio />} {meeting.media.compacted ? t("meeting.exportMediaCompact") : t("meeting.exportMedia")}
                          <span className="end mono">{bytes(meeting.media.size)}</span>
                        </a>
                      </>
                    )}
                  </>
                )}
              </Menu>
            )}
            <Menu
              trigger={({ toggle }) => (
                <button className="icon-btn" onClick={toggle} aria-label={t("common.more")}>
                  <MoreHorizontal />
                </button>
              )}
            >
              {(close) => (
                <>
                  {meeting.status !== "uploading" && !mediaGone && (
                    <button
                      className="menu-item"
                      onClick={() => {
                        close();
                        void retranscribe();
                      }}
                    >
                      <RefreshCw /> {t("meeting.retranscribe")}
                    </button>
                  )}
                  {ready && refineInfo?.available && (
                    <button
                      className="menu-item"
                      disabled={refining}
                      onClick={() => {
                        close();
                        void startRefine();
                      }}
                    >
                      <Wand2 /> {refining ? t("refine.running") : t("refine.menu")}
                    </button>
                  )}
                  {ready && corrected > 0 && !refining && (
                    <button
                      className="menu-item"
                      onClick={() => {
                        close();
                        void undoRefine();
                      }}
                    >
                      <Undo2 /> {t("refine.undoMenu")}
                    </button>
                  )}
                  {ready && !mediaGone && (
                    <button
                      className="menu-item"
                      onClick={() => {
                        close();
                        setResplit(true);
                      }}
                    >
                      <Users /> {t("diarize.resplit")}
                    </button>
                  )}
                  <button
                    className="menu-item danger"
                    onClick={() => {
                      close();
                      void remove();
                    }}
                  >
                    <Trash2 /> {t("meeting.delete")}
                  </button>
                </>
              )}
            </Menu>
          </div>
        </div>
      </header>

      {!ready && (
        <Pipeline
          meeting={meeting}
          onRetry={() =>
            void api
              .retranscribe(meeting.id)
              .then(() => qc.invalidateQueries({ queryKey: ["meeting", meeting.id] }))
              .catch((e) => toast.error(apiErrorMessage(e, t)))
          }
        />
      )}

      {ready && (
        <>
          {mediaGone && (
            <div className="callout retention-note" role="note">
              <FileX2 />
              <div>
                <strong>{t("retention.deletedTitle", { date: dateLong(meeting.media.deletedAt!, locale) })}</strong>
                <p>{t("retention.deletedBody")}</p>
              </div>
            </div>
          )}
          {!mediaGone && <DiarizationNotice meeting={meeting} />}
          {refining && (
            <div className="callout refine-note" role="status">
              <span className="spinner" />
              <div>{t("refine.runningNote")}</div>
            </div>
          )}
          {!refining && refinement?.status === "failed" && (
            <div className="callout warn refine-note" role="note">
              <Wand2 />
              <div>{t("refine.failedNote", { error: refinement.error ?? "" })}</div>
            </div>
          )}
          {!refining && refinement?.status === "done" && corrected > 0 && (
            <div className="callout refine-note" role="note">
              <Wand2 />
              <div>
                {t("refine.doneNote", { n: corrected })}{" "}
                <button type="button" className="link-btn" onClick={() => void undoRefine()}>
                  {t("refine.undo")}
                </button>
              </div>
            </div>
          )}
          <div className="meeting-tabs tabs" role="tablist">
            <button role="tab" aria-selected={tab === "transcript"} onClick={() => setTab("transcript")}>
              {t("meeting.transcript")}
            </button>
            <button role="tab" aria-selected={tab === "summary"} onClick={() => setTab("summary")}>
              {t("meeting.summary")}
              {meeting.summaries.length > 0 && <span className="count">{meeting.summaries.length}</span>}
            </button>
          </div>
          <div className="meeting-grid" data-tab={tab}>
            <section className="meeting-col transcript-col">
              {videoMode && <VideoPane />}
              <Transcript meeting={meeting} />
            </section>
            <aside className="meeting-col summary-col">
              <SummaryPanel meeting={meeting} selection={summarySelection} />
            </aside>
          </div>
          {!mediaGone && <PlayerBar meeting={meeting} videoMode={videoMode} />}
        </>
      )}
      {resplit && <ResplitDialog meeting={meeting} onClose={() => setResplit(false)} />}
      {retranscribing && <RetranscribeDialog meeting={meeting} onClose={() => setRetranscribing(false)} />}
      {!ready && meeting.summaries.length > 0 && <SummaryPanel meeting={meeting} selection={summarySelection} />}
    </div>
  );
}

export function MeetingPage() {
  const { id = "" } = useParams();
  const { t } = useI18n();
  const q = useQuery({ queryKey: ["meeting", id], queryFn: () => api.meeting(id), staleTime: PAGE_DATA_FRESH_MS });

  if (q.isLoading) {
    return (
      <div className="meeting">
        <div className="skeleton" style={{ width: 90, height: 16, marginBottom: 20 }} />
        <div className="skeleton" style={{ width: "55%", height: 48, marginBottom: 14 }} />
        <div className="skeleton" style={{ width: "40%", height: 18 }} />
      </div>
    );
  }
  if (q.isError || !q.data) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="empty">
        <h3>{notFound ? t("meeting.notFound") : t("common.error")}</h3>
        <Link to="/" className="btn">
          <ArrowLeft /> {t("meeting.backToLibrary")}
        </Link>
      </div>
    );
  }
  const meeting = q.data.meeting;
  return (
    <PlayerProvider key={meeting.id} fallbackDuration={meeting.durationSec ?? 0}>
      <MeetingBody meeting={meeting} />
    </PlayerProvider>
  );
}
