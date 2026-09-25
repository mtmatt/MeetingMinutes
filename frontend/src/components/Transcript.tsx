import { useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Search, UserPlus, Users, X } from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { MeetingDetail, Segment, Speaker } from "../api/types";
import { useI18n } from "../i18n";
import { clock, speakerVar, wordCount } from "../lib/format";
import { usePlayer } from "../lib/player";
import { Menu } from "./Menu";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

interface Block {
  speaker: string | null;
  start: number;
  segments: Segment[];
}

function toBlocks(segments: Segment[]): Block[] {
  const blocks: Block[] = [];
  for (const s of segments) {
    const last = blocks[blocks.length - 1];
    // Start a new paragraph on speaker change or after a long pause.
    if (last && last.speaker === s.speaker && s.start - last.segments[last.segments.length - 1]!.end < 8) {
      last.segments.push(s);
    } else {
      blocks.push({ speaker: s.speaker, start: s.start, segments: [s] });
    }
  }
  return blocks;
}

function findActive(segments: Segment[], t: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid]!.start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (ans >= 0 && t > segments[ans]!.end + 1.5) return -1;
  return ans;
}

function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (true) {
    const j = lower.indexOf(needle, i);
    if (j < 0) break;
    parts.push(text.slice(i, j), <mark key={k++}>{text.slice(j, j + q.length)}</mark>);
    i = j + q.length;
  }
  parts.push(text.slice(i));
  return parts;
}

function SpeakerLegend({ meeting }: { meeting: MeetingDetail }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const talk = useMemo(() => {
    const totals = new Map<string, number>();
    let sum = 0;
    for (const s of meeting.segments) {
      if (!s.speaker) continue;
      const d = Math.max(0, s.end - s.start);
      totals.set(s.speaker, (totals.get(s.speaker) ?? 0) + d);
      sum += d;
    }
    return { totals, sum };
  }, [meeting.segments]);

  const sorted = [...meeting.speakers].sort((a, b) => (talk.totals.get(b.key) ?? 0) - (talk.totals.get(a.key) ?? 0));

  const save = async (sp: Speaker) => {
    const name = draft.trim();
    setEditing(null);
    if (!name || name === sp.name) return;
    try {
      await api.renameSpeaker(meeting.id, sp.key, name);
      await qc.invalidateQueries({ queryKey: ["meeting", meeting.id] });
    } catch (e) {
      toast.error(e);
    }
  };

  if (!meeting.speakers.length) return null;
  return (
    <div className="legend">
      <div className="legend-head">
        <span className="smallcaps">
          <Users style={{ width: 12, height: 12, display: "inline", verticalAlign: "-1px" }} /> {t("meeting.speakingTime")}
        </span>
      </div>
      <div className="legend-bar" aria-hidden="true">
        {sorted.map((sp) => (
          <span key={sp.key} style={{ flexGrow: talk.totals.get(sp.key) ?? 0, background: speakerVar(sp.color) }} />
        ))}
      </div>
      <ul className="legend-list">
        {sorted.map((sp) => {
          const share = talk.sum ? (talk.totals.get(sp.key) ?? 0) / talk.sum : 0;
          return (
            <li key={sp.key} style={{ ["--spk" as string]: speakerVar(sp.color) }}>
              <span className="speaker-dot" />
              {editing === sp.key ? (
                <input
                  className="legend-input"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => save(sp)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setEditing(null);
                  }}
                  maxLength={80}
                />
              ) : (
                <button
                  className="legend-name"
                  title={t("meeting.renameHint")}
                  onClick={() => {
                    setDraft(sp.name);
                    setEditing(sp.key);
                  }}
                >
                  {sp.name}
                  <Pencil />
                </button>
              )}
              <span className="legend-share mono">{Math.round(share * 100)}%</span>
              <span className="legend-time mono faint">{clock(talk.totals.get(sp.key) ?? 0)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const SegmentText = memo(function SegmentText({
  seg,
  active,
  query,
  onSeek,
  onEdit,
}: {
  seg: Segment;
  active: boolean;
  query: string;
  onSeek: (s: Segment) => void;
  onEdit: (s: Segment) => void;
}) {
  return (
    <span
      className={`seg ${active ? "active" : ""} ${seg.edited ? "edited" : ""}`}
      data-seg={seg.id}
      onClick={() => onSeek(seg)}
      onDoubleClick={() => onEdit(seg)}
    >
      {highlight(seg.text, query)}{" "}
    </span>
  );
});

function SegmentEditor({ seg, onDone }: { seg: Segment; onDone: (text: string | null) => void }) {
  const [text, setText] = useState(seg.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, []);
  return (
    <span className="seg-editor">
      <textarea
        ref={ref}
        className="textarea"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = e.target.scrollHeight + "px";
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onDone(text);
          }
          if (e.key === "Escape") onDone(null);
        }}
        rows={1}
      />
      <span className="seg-editor-actions">
        <button className="icon-btn sm" onClick={() => onDone(null)} aria-label="Cancel">
          <X />
        </button>
        <button className="icon-btn sm" aria-pressed="true" onClick={() => onDone(text)} aria-label="Save">
          <Check />
        </button>
      </span>
    </span>
  );
}

export function Transcript({ meeting }: { meeting: MeetingDetail }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const { time, seek } = usePlayer();
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const [editing, setEditing] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const speakers = useMemo(() => new Map(meeting.speakers.map((s) => [s.key, s])), [meeting.speakers]);
  const blocks = useMemo(() => toBlocks(meeting.segments), [meeting.segments]);
  const activeIdx = findActive(meeting.segments, time);
  const activeId = activeIdx >= 0 ? meeting.segments[activeIdx]!.id : null;
  const q = query.trim();
  const matchCount = useMemo(() => {
    if (!q) return 0;
    const needle = q.toLowerCase();
    let n = 0;
    for (const s of meeting.segments) {
      const hay = s.text.toLowerCase();
      let i = hay.indexOf(needle);
      while (i >= 0) {
        n++;
        i = hay.indexOf(needle, i + needle.length);
      }
    }
    return n;
  }, [q, meeting.segments]);

  const totalWords = useMemo(() => meeting.segments.reduce((n, s) => n + wordCount(s.text), 0), [meeting.segments]);

  // Keep the active line in view while following playback.
  useEffect(() => {
    if (!follow || activeId == null || editing != null) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-seg="${activeId}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 180;
    if (r.top < margin || r.bottom > window.innerHeight - margin - 120) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [activeId, follow, editing]);

  const onSeek = useCallback((s: Segment) => seek(s.start, true), [seek]);
  const onEdit = useCallback((s: Segment) => setEditing(s.id), []);

  const saveText = async (seg: Segment, text: string | null) => {
    setEditing(null);
    if (text == null || text.trim() === seg.text) return;
    try {
      await api.updateSegment(meeting.id, seg.id, { text: text.trim() });
      await qc.invalidateQueries({ queryKey: ["meeting", meeting.id] });
    } catch (e) {
      toast.error(e);
    }
  };

  const reassign = async (block: Block, speaker: string | null) => {
    try {
      for (const s of block.segments) await api.updateSegment(meeting.id, s.id, { speaker });
      await qc.invalidateQueries({ queryKey: ["meeting", meeting.id] });
    } catch (e) {
      toast.error(e);
    }
  };

  const [newSpeakerFor, setNewSpeakerFor] = useState<Block | null>(null);
  const [newSpeakerName, setNewSpeakerName] = useState("");
  const addSpeakerAndAssign = async () => {
    const block = newSpeakerFor;
    const name = newSpeakerName.trim();
    setNewSpeakerFor(null);
    setNewSpeakerName("");
    if (!block || !name) return;
    try {
      const { speaker } = await api.addSpeaker(meeting.id, name);
      await reassign(block, speaker.key);
    } catch (e) {
      toast.error(e);
    }
  };

  if (!meeting.segments.length) {
    return (
      <div className="empty">
        <p>{t("meeting.emptyTranscript")}</p>
      </div>
    );
  }

  return (
    <div className="transcript">
      <SpeakerLegend meeting={meeting} />
      <div className="transcript-tools">
        <label className="input-line transcript-search">
          <Search />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("meeting.searchTranscript")} />
          {q && <span className="faint mono" style={{ fontSize: "var(--step--2)" }}>{t("meeting.matches", { n: matchCount })}</span>}
        </label>
        <label className="switch switch-sm" title={t("meeting.followHint")}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          <span className="switch-track" />
          <span className="switch-label">
            {t("meeting.follow")}
            <span className={`switch-state ${follow ? "on" : ""}`}>{follow ? t("common.on") : t("common.off")}</span>
          </span>
        </label>
        <span className="faint mono transcript-count">
          {locale === "zh-TW" ? t("meeting.chars", { n: totalWords.toLocaleString() }) : t("meeting.words", { n: totalWords.toLocaleString() })}
        </span>
      </div>

      <div className="transcript-body" ref={listRef}>
        {blocks.map((b, bi) => {
          const sp = b.speaker ? speakers.get(b.speaker) : undefined;
          const hasActive = activeId != null && b.segments.some((s) => s.id === activeId);
          return (
            <section key={`${bi}-${b.segments[0]!.id}`} className={`block ${hasActive ? "is-active" : ""}`} style={{ ["--spk" as string]: speakerVar(sp?.color) }}>
              <header className="block-head">
                <button className="block-time mono" onClick={() => seek(b.start, true)}>
                  {clock(b.start, (meeting.durationSec ?? 0) >= 3600)}
                </button>
                {meeting.speakers.length > 0 && (
                  <Menu
                    align="left"
                    trigger={({ toggle }) => (
                      <button className="block-speaker" onClick={toggle} title={t("meeting.assignSpeaker")}>
                        <span className="speaker-dot" />
                        {sp?.name ?? t("meeting.speaker")}
                      </button>
                    )}
                  >
                    {(close) => (
                      <>
                        <div className="menu-label smallcaps">{t("meeting.assignSpeaker")}</div>
                        {meeting.speakers.map((s) => (
                          <button
                            key={s.key}
                            className="menu-item"
                            onClick={() => {
                              close();
                              void reassign(b, s.key);
                            }}
                          >
                            <span className="speaker-dot" style={{ ["--spk" as string]: speakerVar(s.color) }} />
                            {s.name}
                            {s.key === b.speaker && <Check className="end" />}
                          </button>
                        ))}
                        <div className="menu-sep" />
                        <button
                          className="menu-item"
                          onClick={() => {
                            close();
                            setNewSpeakerFor(b);
                          }}
                        >
                          <UserPlus /> {t("meeting.newSpeaker")}
                        </button>
                      </>
                    )}
                  </Menu>
                )}
              </header>
              <p className="block-text">
                {b.segments.map((s) => (
                  <Fragment key={s.id}>
                    {editing === s.id ? (
                      <SegmentEditor seg={s} onDone={(text) => saveText(s, text)} />
                    ) : (
                      <SegmentText seg={s} active={s.id === activeId} query={q} onSeek={onSeek} onEdit={onEdit} />
                    )}
                  </Fragment>
                ))}
              </p>
              <button
                className="icon-btn sm block-edit"
                title={t("meeting.editSegment")}
                aria-label={t("meeting.editSegment")}
                onClick={() => setEditing((activeId != null && b.segments.find((s) => s.id === activeId)?.id) || b.segments[0]!.id)}
              >
                <Pencil />
              </button>
            </section>
          );
        })}
      </div>

      {newSpeakerFor && (
        <Modal
          title={t("meeting.newSpeaker").replace("…", "")}
          onClose={() => setNewSpeakerFor(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setNewSpeakerFor(null)}>
                {t("common.cancel")}
              </button>
              <button className="btn btn-ink" onClick={addSpeakerAndAssign} disabled={!newSpeakerName.trim()}>
                {t("common.save")}
              </button>
            </>
          }
        >
          <div className="field">
            <label htmlFor="new-speaker">{t("meeting.newSpeakerPrompt")}</label>
            <input
              id="new-speaker"
              className="input"
              value={newSpeakerName}
              maxLength={80}
              onChange={(e) => setNewSpeakerName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addSpeakerAndAssign()}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}
