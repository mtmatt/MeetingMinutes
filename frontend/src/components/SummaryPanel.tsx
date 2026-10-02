import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronDown, Copy, Download, FileText, MoreHorizontal, Pencil, RefreshCw, ScrollText, Sparkles, Square, Trash2, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api/client";
import type { MeetingDetail, Summary, SummaryRequest } from "../api/types";
import { useI18n } from "../i18n";
import { clock, relative } from "../lib/format";
import { usePlayer } from "../lib/player";
import { downloadText, safeFileName, summaryMarkdown } from "../lib/summaryExport";
import { segmentAt } from "./Player";
import { Menu } from "./Menu";
import { Modal, useConfirm } from "./Modal";
import { DataFlowNote, SummaryComposer, defaultOutputLanguage, normalizeRequest, templateName, useTemplates } from "./SummaryComposer";
import { useToast } from "./Toast";

const TIMESTAMP = /\[?\b(\d{1,2}):(\d{2}):(\d{2})\b\]?/g;

/** Turn [hh:mm:ss] mentions into links the renderer maps to seek buttons. */
function linkTimestamps(md: string, duration: number): string {
  // Leave fenced code blocks untouched.
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(TIMESTAMP, (m, h, mi, s, offset, whole) => {
            // Skip timestamps that are already link text: [..](..)
            if (whole[offset + m.length] === "(") return m;
            const sec = Number(h) * 3600 + Number(mi) * 60 + Number(s);
            // A time of day ("10:30:00") beyond the recording is left as text.
            if (duration > 0 && sec > duration + 5) return m;
            return `[${h.padStart(2, "0")}:${mi}:${s}](#t=${sec})`;
          }),
    )
    .join("");
}

/**
 * A clickable [hh:mm:ss]. Hovering or focusing it shows who spoke at that
 * moment and what they said, so a summary claim can be checked in place.
 */
function TsLink({ sec, meeting, children }: { sec: number; meeting: MeetingDetail; children: ReactNode }) {
  const { t } = useI18n();
  const { seek } = usePlayer();
  const segs = meeting.segments;
  let idx = segmentAt(segs, sec);
  if (idx < 0) idx = segs.findIndex((s) => s.start >= sec - 1);
  const quote = idx >= 0 ? segs.slice(idx, idx + 2) : [];
  const speaker = (key: string | null) => (key ? meeting.speakers.find((s) => s.key === key) : undefined);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [place, setPlace] = useState<{ above: boolean; dx: number }>({ above: false, dx: 0 });
  // Open the quote where it fits inside what is actually visible: the summary
  // column scrolls (and clips), and the player bar covers the bottom.
  const measure = () => {
    const wrap = wrapRef.current;
    const pop = wrap?.querySelector<HTMLElement>(".ts-quote");
    if (!wrap || !pop) return;
    const link = wrap.getBoundingClientRect();
    let top = 0;
    let bottom = window.innerHeight;
    let left = 0;
    let right = window.innerWidth;
    for (let el = wrap.parentElement; el && el !== document.body; el = el.parentElement) {
      const o = getComputedStyle(el);
      if (/(auto|scroll|hidden)/.test(o.overflowY + o.overflowX)) {
        const r = el.getBoundingClientRect();
        top = Math.max(top, r.top);
        bottom = Math.min(bottom, r.bottom);
        left = Math.max(left, r.left);
        right = Math.min(right, r.right);
        break;
      }
    }
    const player = document.querySelector<HTMLElement>(".player");
    if (player) bottom = Math.min(bottom, player.getBoundingClientRect().top);
    const header = document.querySelector<HTMLElement>(".masthead");
    if (header) top = Math.max(top, header.getBoundingClientRect().bottom);
    // Hidden until hover, so fall back to typical sizes on the first measure.
    const h = pop.offsetHeight || 200;
    const w = pop.offsetWidth || Math.min(380, window.innerWidth * 0.8);
    const above = bottom - link.bottom < h + 12 && link.top - top > bottom - link.bottom;
    const dx = Math.min(0, right - 8 - (link.left + w)) + Math.max(0, left + 8 - link.left);
    setPlace({ above, dx: Math.round(dx) });
    // Measured before the popover was laid out: measure again with its real size.
    if (!pop.offsetHeight) requestAnimationFrame(measure);
  };
  return (
    <span className="ts-wrap" ref={wrapRef} onMouseEnter={measure} onFocus={measure}>
      <button className="ts-link mono" onClick={() => seek(sec, true)} aria-describedby={quote.length ? `ts-${sec}` : undefined}>
        {children}
      </button>
      {quote.length > 0 && (
        <span
          className={`ts-quote ${place.above ? "above" : ""}`}
          role="tooltip"
          id={`ts-${sec}`}
          style={{ "--dx": `${place.dx}px` } as CSSProperties}
        >
          <span className="ts-quote-head">{t("summary.quoteHead", { t: clock(sec, true) })}</span>
          {quote.map((q) => {
            const sp = speaker(q.speaker);
            return (
              <span key={q.id} className="ts-quote-line">
                <span className="ts-quote-who" style={{ color: `var(--spk-${(sp?.color ?? 8) % 10})` }}>
                  {sp?.name ?? t("meeting.speaker")} <span className="mono faint">{clock(q.start)}</span>
                </span>
                <span className="ts-quote-text">{q.text}</span>
              </span>
            );
          })}
        </span>
      )}
    </span>
  );
}

function Markdown({ content, meeting }: { content: string; meeting: MeetingDetail }) {
  const { duration } = usePlayer();
  // The player context changes several times a second during playback. Build
  // the tree only when the text changes, so timestamp links are not remounted
  // on every tick (which would drop keyboard focus and an open quote preview).
  return useMemo(
    () => (
      <div className="prose">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a({ href, children }) {
              if (href?.startsWith("#t=")) {
                return (
                  <TsLink sec={Number(href.slice(3))} meeting={meeting}>
                    {children}
                  </TsLink>
                );
              }
              return (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            },
            table({ children }) {
              return (
                <div className="prose-table">
                  <table>{children}</table>
                </div>
              );
            },
          }}
        >
          {linkTimestamps(content, duration)}
        </ReactMarkdown>
      </div>
    ),
    [content, duration, meeting],
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="mono">{clock((now - since) / 1000)}</span>;
}

/**
 * Speakers renamed after this summary was written whose names it could not
 * update by itself: a one-character name (replacing it could change unrelated
 * text) or a name another speaker also has (replacing would merge two people).
 * The person decides: replace anyway, where that is possible, or keep the text.
 */
function StaleNames({ summary, meeting }: { summary: Summary; meeting: MeetingDetail }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const stale = meeting.speakers.flatMap((sp) => {
    const written = summary.speakerNames?.[sp.key];
    if (written === undefined || written === sp.name) return [];
    const shared = meeting.speakers.some((o) => o.key !== sp.key && o.name === sp.name);
    return [{ key: sp.key, from: written, to: sp.name, shared }];
  });
  if (!stale.length) return null;

  const resolve = async (action: "replace" | "keep", keys: string[]) => {
    setBusy(true);
    try {
      await api.resolveSummaryNames(meeting.id, summary.id, action, keys);
      await qc.invalidateQueries({ queryKey: ["meeting", meeting.id] });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="callout warn stale-names" role="status">
      <Users />
      <div className="stale-names-main">
        <strong>{t("summary.staleNamesTitle")}</strong>
        <ul>
          {stale.map((n) => (
            <li key={n.key}>
              <span className="stale-names-pair">{t("summary.staleNamesPair", { from: n.from, to: n.to })}</span>
              <span className="stale-names-why">{n.shared ? t("summary.staleNamesShared", { to: n.to }) : t("summary.staleNamesShort", { from: n.from })}</span>
              <span className="stale-names-actions">
                {!n.shared && (
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => resolve("replace", [n.key])}>
                    {t("summary.staleNamesReplace")}
                  </button>
                )}
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => resolve("keep", [n.key])}>
                  {t("summary.staleNamesKeep")}
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Writing({ summary, onCancel }: { summary: Summary; onCancel: () => void }) {
  const { t } = useI18n();
  const running = summary.status === "running";
  return (
    <div className="writing">
      <div className="writing-head">
        <span className="writing-pen">
          <Sparkles />
        </span>
        <div>
          <div className="writing-title">{running ? t("summary.running") : t("summary.queued")}</div>
          {running && summary.startedAt && (
            <div className="faint" style={{ fontSize: "var(--step--1)" }}>
              <Elapsed since={summary.startedAt} />
            </div>
          )}
        </div>
        <button className="btn btn-sm btn-ghost" onClick={onCancel} style={{ marginLeft: "auto" }}>
          <Square /> {t("summary.cancel")}
        </button>
      </div>
      <div className="writing-lines" aria-hidden="true">
        {[92, 78, 85, 40, 88, 70, 60].map((w, i) => (
          <div key={i} className="skeleton" style={{ width: `${w}%`, animationDelay: `${i * 120}ms` }} />
        ))}
      </div>
    </div>
  );
}


export function Composer({ meeting, onClose, initial }: { meeting: MeetingDetail; onClose: () => void; initial?: SummaryRequest }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [value, setValue] = useState<SummaryRequest>(
    initial ??
      (meeting.autoSummary
        ? { ...meeting.autoSummary, prompt: meeting.autoSummary.templateId ? "" : meeting.autoSummary.prompt }
        : { templateId: "builtin-minutes", prompt: "", outputLanguage: defaultOutputLanguage(locale) }),
  );
  const [busy, setBusy] = useState(false);
  const { data: templates } = useTemplates();
  const submit = async () => {
    setBusy(true);
    try {
      await api.createSummary(meeting.id, normalizeRequest(value, templates?.templates ?? []));
      await qc.invalidateQueries({ queryKey: ["meeting", meeting.id] });
      onClose();
    } catch (e) {
      toast.error(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      wide
      title={meeting.summaries.length ? t("summary.regenerate") : t("summary.generate")}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !value.prompt.trim()}>
            {busy ? <span className="spinner" /> : <Sparkles />} {t("summary.generate")}
          </button>
        </>
      }
    >
      <p className="composer-note">{meeting.summaries.length ? t("summary.regenerateNote") : t("summary.firstNote")}</p>
      <SummaryComposer value={value} onChange={setValue} />
      <DataFlowNote />
    </Modal>
  );
}

/**
 * Which summary version is on screen. Owned by the meeting page so its Export
 * menu and the summary panel always act on the same version.
 */
export function useSummarySelection(summaries: Summary[]) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Follow the newest version when one is added.
  const newestId = summaries[0]?.id ?? null;
  useEffect(() => {
    setSelectedId(newestId);
  }, [newestId]);
  const current = summaries.find((s) => s.id === selectedId) ?? summaries[0] ?? null;
  return { current, select: setSelectedId };
}
export type SummarySelection = ReturnType<typeof useSummarySelection>;

/** Version numbers, display names and Markdown export for a meeting's summaries. */
export function useSummaryInfo(meeting: MeetingDetail) {
  const { t, tMaybe, locale } = useI18n();
  const { data: tpl } = useTemplates();
  const summaries = meeting.summaries;
  const versionOf = (s: Summary) => summaries.length - summaries.indexOf(s);
  const labelOf = (s: Summary) => {
    const known = s.templateId ? tpl?.templates.find((x) => x.id === s.templateId) : undefined;
    if (known) return templateName(known, tMaybe);
    if (s.templateId?.startsWith("builtin-")) return tMaybe(`builtin.${s.templateId}.name`) ?? s.templateName ?? t("summary.custom");
    return s.templateName ?? t("summary.custom");
  };
  const exportMarkdown = (s: Summary, withTranscript: boolean) => {
    const text = summaryMarkdown({
      meeting,
      summary: s,
      version: versionOf(s),
      templateLabel: labelOf(s),
      withTranscript,
      locale,
      transcriptHeading: t("meeting.transcript"),
    });
    const kind = withTranscript ? t("summary.fileWithTranscript") : t("summary.fileSummary");
    const version = summaries.length > 1 ? ` v${versionOf(s)}` : "";
    downloadText(`${safeFileName(`${meeting.title} ${kind}${version}`)}.md`, text);
  };
  return { versionOf, labelOf, exportMarkdown };
}

/** Export choices for one summary version, used by the summary header and the page's Export menu. */
export function SummaryExportItems({ onExport }: { onExport: (withTranscript: boolean) => void }) {
  const { t } = useI18n();
  return (
    <>
      <button className="menu-item menu-item-rich" onClick={() => onExport(false)}>
        <FileText />
        <span>
          <span className="menu-item-title">{t("summary.exportSummaryOnly")}</span>
          <span className="menu-item-desc">{t("summary.exportSummaryOnlyDesc")}</span>
        </span>
        <span className="end mono">.md</span>
      </button>
      <button className="menu-item menu-item-rich" onClick={() => onExport(true)}>
        <ScrollText />
        <span>
          <span className="menu-item-title">{t("summary.exportWithTranscript")}</span>
          <span className="menu-item-desc">{t("summary.exportWithTranscriptDesc")}</span>
        </span>
        <span className="end mono">.md</span>
      </button>
    </>
  );
}

export function SummaryPanel({ meeting, selection }: { meeting: MeetingDetail; selection: SummarySelection }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const summaries = meeting.summaries;
  const [composer, setComposer] = useState<SummaryRequest | null | false>(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [copied, setCopied] = useState(false);

  const { current, select: setSelectedId } = selection;
  const { versionOf, labelOf, exportMarkdown } = useSummaryInfo(meeting);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["meeting", meeting.id] });

  const cancel = async (s: Summary) => {
    await api.cancelSummary(meeting.id, s.id).catch(toast.error);
    await invalidate();
  };

  const remove = async (s: Summary) => {
    if (!(await confirm({ title: t("summary.deleteTitle"), confirmLabel: t("common.delete"), danger: true }))) return;
    await api.deleteSummary(meeting.id, s.id).catch(toast.error);
    await invalidate();
  };

  const copy = async (s: Summary) => {
    await navigator.clipboard.writeText(s.content ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  let body: ReactNode;
  if (meeting.status !== "ready") {
    body = (
      <div className="summary-empty">
        <FileText />
        <p>{t("summary.waitTranscript")}</p>
      </div>
    );
  } else if (!current) {
    body = (
      <div className="summary-empty">
        <span className="summary-empty-mark">
          <Sparkles />
        </span>
        <h3>{t("summary.none")}</h3>
        <p>{t("summary.noneBody")}</p>
        <button className="btn btn-primary" onClick={() => setComposer(null)}>
          <Sparkles /> {t("summary.generate")}
        </button>
      </div>
    );
  } else if (current.status === "queued" || current.status === "running") {
    body = <Writing summary={current} onCancel={() => cancel(current)} />;
  } else if (current.status === "failed" || current.status === "canceled") {
    body = (
      <div className="summary-failed">
        <div className={`callout ${current.status === "failed" ? "danger" : ""}`}>
          <AlertTriangle />
          <div>
            <strong>{current.status === "failed" ? t("summary.failed") : t("summary.canceled")}</strong>
            {current.error && <pre className="summary-error mono">{current.error}</pre>}
          </div>
        </div>
        <button
          className="btn btn-ink"
          onClick={() => setComposer({ templateId: current.templateId, prompt: current.prompt, outputLanguage: current.outputLanguage })}
        >
          {t("common.retry")}
        </button>
      </div>
    );
  } else if (editing === current.id) {
    body = <SummaryEditor summary={current} onDone={() => setEditing(null)} meetingId={meeting.id} />;
  } else {
    body = (
      <>
        <StaleNames summary={current} meeting={meeting} />
        <Markdown content={current.content ?? ""} meeting={meeting} />
        <div className="summary-foot">
          <button className="summary-prompt-toggle" onClick={() => setShowPrompt((v) => !v)} aria-expanded={showPrompt}>
            <ChevronDown style={{ transform: showPrompt ? "rotate(180deg)" : undefined }} /> {t("summary.promptUsed")}
          </button>
          <span className="faint mono">
            {current.model && <>{current.model} · </>}
            {current.usage?.input_tokens != null &&
              t("summary.tokens", {
                input: current.usage.input_tokens.toLocaleString(),
                output: (current.usage.output_tokens ?? 0).toLocaleString(),
              })}
          </span>
        </div>
        {showPrompt && <pre className="summary-prompt mono">{current.prompt}</pre>}
      </>
    );
  }

  return (
    <div className="summary-panel">
      <header className="summary-head">
        <div className="summary-head-left">
          <h2>{t("meeting.summary")}</h2>
          {current && summaries.length > 1 && (
            <Menu
              align="left"
              trigger={({ toggle }) => (
                <button className="version-chip" onClick={toggle} title={t("summary.versions")}>
                  {t("summary.versionOf", { n: versionOf(current), total: summaries.length })}
                  <ChevronDown />
                </button>
              )}
            >
              {(close) =>
                summaries.map((s) => (
                  <button
                    key={s.id}
                    className="menu-item"
                    onClick={() => {
                      setSelectedId(s.id);
                      close();
                    }}
                  >
                    <span className="faint">{t("summary.version", { n: versionOf(s) })}</span>
                    <span>{labelOf(s)}</span>
                    <span className="end" style={{ fontSize: "var(--step--2)" }}>
                      {s.status === "done" ? relative(s.createdAt, t, locale) : t(`status.${s.status === "failed" ? "summaryFailed" : s.status === "running" ? "summarizing" : s.status === "queued" ? "summaryQueued" : "failed"}`)}
                    </span>
                  </button>
                ))
              }
            </Menu>
          )}
        </div>
        {meeting.status === "ready" && (
          <div className="summary-actions">
            {current?.status === "done" && editing !== current.id && (
              <>
                <button className="icon-btn" onClick={() => copy(current)} title={t("summary.copyMarkdown")} aria-label={t("summary.copyMarkdown")}>
                  {copied ? <Check /> : <Copy />}
                </button>
                <Menu
                  trigger={({ toggle, open }) => (
                    <button className="btn btn-sm" onClick={toggle} aria-expanded={open} aria-haspopup="menu">
                      <Download /> {t("summary.exportMd")}
                    </button>
                  )}
                >
                  {(close) => (
                    <SummaryExportItems
                      onExport={(withTranscript) => {
                        exportMarkdown(current, withTranscript);
                        close();
                      }}
                    />
                  )}
                </Menu>
              </>
            )}
            {current && (
              <Menu
                trigger={({ toggle }) => (
                  <button className="icon-btn" onClick={toggle} aria-label="More">
                    <MoreHorizontal />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    {current.status === "done" && (
                      <button
                        className="menu-item"
                        onClick={() => {
                          setEditing(current.id);
                          close();
                        }}
                      >
                        <Pencil /> {t("summary.editMarkdown")}
                      </button>
                    )}
                    <button
                      className="menu-item danger"
                      onClick={() => {
                        close();
                        void remove(current);
                      }}
                    >
                      <Trash2 /> {t("summary.deleteVersion")}
                    </button>
                  </>
                )}
              </Menu>
            )}
            {current && (
              <button
                className="btn btn-sm"
                onClick={() =>
                  // Template-based summaries start from the template's current text;
                  // only a fully custom prompt is carried over verbatim.
                  setComposer({
                    templateId: current.templateId,
                    prompt: current.templateId ? "" : current.prompt,
                    outputLanguage: current.outputLanguage,
                  })
                }
                title={t("summary.regenerateHint")}
              >
                <RefreshCw /> {t("summary.regenerate")}
              </button>
            )}
          </div>
        )}
      </header>
      {current && meeting.status === "ready" && (
        <div className="summary-context">
          <span>
            {t("summary.templateLabel")}：{labelOf(current)}
          </span>
          <span>{relative(current.createdAt, t, locale)}</span>
          {summaries.length === 1 && <span>{t("summary.version", { n: 1 })}</span>}
        </div>
      )}
      <div className="summary-body">{body}</div>
      {composer !== false && <Composer meeting={meeting} onClose={() => setComposer(false)} initial={composer ?? undefined} />}
    </div>
  );
}

function SummaryEditor({ summary, meetingId, onDone }: { summary: Summary; meetingId: string; onDone: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState(summary.content ?? "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.updateSummary(meetingId, summary.id, text);
      await qc.invalidateQueries({ queryKey: ["meeting", meetingId] });
      onDone();
    } catch (e) {
      toast.error(e);
      setBusy(false);
    }
  };
  return (
    <div className="summary-editor">
      <textarea className="textarea code" value={text} onChange={(e) => setText(e.target.value)} rows={24} autoFocus />
      <div className="summary-editor-actions">
        <button className="btn btn-ghost" onClick={onDone}>
          {t("common.cancel")}
        </button>
        <button className="btn btn-ink" onClick={save} disabled={busy}>
          {busy && <span className="spinner" />} {t("common.save")}
        </button>
      </div>
    </div>
  );
}
