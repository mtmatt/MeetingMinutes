import { useQueryClient } from "@tanstack/react-query";
import { AudioLines, Check, ChevronLeft, ChevronRight, Headphones, LocateFixed, Pause, Pencil, Play, Search, Settings2, UserPlus, Users, X } from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import type { MeetingDetail, Segment, Speaker, VoiceOutcome } from "../api/types";
import { useI18n } from "../i18n";
import { clock, duration, speakerVar, wordCount } from "../lib/format";
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

/** A turn this long is enough to recognise a voice; shorter ones ("Yes.") are passed over at first. */
const REFERENCE_MIN_SEC = 3;
/** Long enough to recognise a voice, short enough to try several turns in a row. */
const CLIP_MAX_SEC = 15;
/** Timestamps tend to clip the first syllable. */
const CLIP_PREROLL_SEC = 0.25;

/** One of a speaker's turns, as a transcript paragraph, and the clip of it that is played. */
interface Turn {
  start: number;
  clip: { start: number; end: number };
  /** What is said within the clip. */
  text: string;
}

function turnsBySpeaker(blocks: Block[]): Map<string, Turn[]> {
  const turns = new Map<string, Turn[]>();
  for (const b of blocks) {
    if (!b.speaker) continue;
    const end = Math.min(b.segments[b.segments.length - 1]!.end, b.start + CLIP_MAX_SEC);
    const text = b.segments
      .filter((s) => s.start < end)
      .map((s) => s.text)
      .join(" ");
    const list = turns.get(b.speaker) ?? [];
    list.push({ start: b.start, clip: { start: Math.max(0, b.start - CLIP_PREROLL_SEC), end }, text });
    turns.set(b.speaker, list);
  }
  return turns;
}

/** The turn to listen to first: the first one long enough to tell the voice, else the longest. */
function referenceTurn(turns: Turn[]): number {
  const first = turns.findIndex((t) => t.clip.end - t.start >= REFERENCE_MIN_SEC);
  if (first >= 0) return first;
  let best = 0;
  turns.forEach((t, i) => {
    if (t.clip.end - t.start > turns[best]!.clip.end - turns[best]!.start) best = i;
  });
  return best;
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

const percent = (score: number | null | undefined) => `${Math.round(Math.max(0, score ?? 0) * 100)}%`;

/** Run a voice action on a speaker, refresh, and say what happened. */
function useSpeakerVoice(meeting: MeetingDetail) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: ["meeting", meeting.id] }), qc.invalidateQueries({ queryKey: ["voices"] })]);
  const run = async (sp: Speaker, action: VoiceAction) => {
    try {
      const { voice } = await api.speakerVoice(meeting.id, sp.key, action);
      await refresh();
      if (action === "confirm") toast.show(t("meeting.voiceToastConfirmed", { name: voice.profile?.name ?? sp.name }));
      else if (action === "reject") toast.show(t("meeting.voiceToastRejected"));
      else if (action === "forget") toast.show(t("meeting.voiceToastForgotten"));
      else announce(sp, voice);
    } catch (e) {
      toast.error(e);
    }
  };
  /** After naming a speaker: whether the voice was remembered, with a way to take it back. */
  const announce = (sp: Speaker, voice: VoiceOutcome | null) => {
    if (!voice?.profile) return;
    const name = voice.profile.name;
    const undo = { label: t("meeting.voiceUndo"), onClick: () => void run(sp, "forget") };
    if (voice.remembered === "remembered") toast.show(t("meeting.voiceToastRemembered", { name }), undo);
    else if (voice.remembered === "pending") toast.show(t("meeting.voiceToastPending", { name }), undo);
    else if (voice.remembered === "short") toast.show(t("meeting.voiceToastShort", { name }));
  };
  return { run, announce, refresh };
}

/**
 * What voice recognition knows about a speaker, beside their name: a chip to
 * confirm or correct a recognised or suggested name, or a quiet mark for a
 * remembered (or deliberately forgotten) voice. Each opens a short menu.
 */
type VoiceAction = "confirm" | "reject" | "forget" | "remember";

function VoiceBadge({
  meeting,
  sp,
  run,
  onListen,
}: {
  meeting: MeetingDetail;
  sp: Speaker;
  run: (sp: Speaker, action: VoiceAction) => void;
  /** Play the speaker's turns, to check the guess by ear; absent when they have none. */
  onListen?: () => void;
}) {
  const { t } = useI18n();
  const voice = sp.voice;
  if (!meeting.voiceRecognition || !voice?.status) return null;
  const profileName = voice.profile?.name ?? sp.name;

  if ((voice.status === "auto" || voice.status === "suggested") && voice.profile) {
    const auto = voice.status === "auto";
    const label = t(auto ? "meeting.voiceAutoLabel" : "meeting.voiceSuggestLabel", { name: profileName, score: percent(voice.score) });
    return (
      <Menu
        align="left"
        trigger={({ toggle, open }) => (
          <button
            className={`voice-chip ${auto ? "is-auto" : "is-suggested"}`}
            onClick={toggle}
            aria-expanded={open}
            aria-haspopup="menu"
            title={label}
          >
            <AudioLines />
            <span>{auto ? t("meeting.voiceByVoice") : `${profileName}?`}</span>
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="menu-label voice-menu-label">{label}</div>
            <button
              className="menu-item"
              onClick={() => {
                close();
                run(sp, "confirm");
              }}
            >
              <Check /> {t("meeting.voiceConfirm", { name: profileName })}
            </button>
            <button
              className="menu-item"
              onClick={() => {
                close();
                run(sp, "reject");
              }}
            >
              <X /> {t("meeting.voiceReject", { name: profileName })}
            </button>
            {onListen && (
              <>
                <div className="menu-sep" />
                <button
                  className="menu-item"
                  onClick={() => {
                    close();
                    onListen();
                  }}
                >
                  <Headphones /> {t("meeting.clipListenItem")}
                </button>
              </>
            )}
          </>
        )}
      </Menu>
    );
  }

  if (voice.status === "confirmed" || (voice.status === "ignored" && !voice.defaultName)) {
    const confirmed = voice.status === "confirmed";
    const pending = confirmed && !voice.fingerprint && voice.speechSec == null;
    const label = !confirmed
      ? t("meeting.voiceIgnoredLabel")
      : voice.fingerprint
        ? t("meeting.voiceRememberedLabel", { name: profileName })
        : pending
          ? t("meeting.voicePendingLabel", { name: profileName })
          : t("meeting.voiceShortLabel", { name: profileName });
    const state = !confirmed ? "is-off" : voice.fingerprint ? "is-on" : "is-pending";
    return (
      <Menu
        align="left"
        trigger={({ toggle, open }) => (
          <button className={`voice-mark ${state}`} onClick={toggle} aria-expanded={open} aria-haspopup="menu" title={label} aria-label={label}>
            <AudioLines />
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="menu-label voice-menu-label">{label}</div>
            {confirmed ? (
              <button
                className="menu-item"
                onClick={() => {
                  close();
                  run(sp, "forget");
                }}
              >
                <X /> {t("meeting.voiceForget")}
              </button>
            ) : (
              <button
                className="menu-item"
                onClick={() => {
                  close();
                  run(sp, "remember");
                }}
              >
                <AudioLines /> {t("meeting.voiceRememberAs", { name: sp.name })}
              </button>
            )}
            <div className="menu-sep" />
            <Link className="menu-item" to="/voices" onClick={close}>
              <Settings2 /> {t("meeting.voiceManage")}
            </Link>
          </>
        )}
      </Menu>
    );
  }
  return null;
}

/** Keeps focus where it is (the name being typed) when a control is clicked. */
const keepFocus = (e: ReactMouseEvent) => e.preventDefault();

/**
 * A speaker's turns, one clip at a time, to tell by ear who it is: it opens on
 * the first turn long enough to recognise the voice, and steps through the
 * others in order. Shown while the speaker is being named, or on request.
 */
function SpeakerClips({
  sp,
  turns,
  playSignal,
  onPlay,
  onClose,
  onScroll,
}: {
  sp: Speaker;
  turns: Turn[];
  /** Play the clip shown whenever this changes (0: wait to be asked). */
  playSignal: number;
  /** A clip was started from here. */
  onPlay: () => void;
  /** Absent while the speaker is being named: finishing the name closes it, unless a clip was played. */
  onClose?: () => void;
  /** Called before the panel scrolls itself into view, which is not the reader scrolling away. */
  onScroll: () => void;
}) {
  const { t, locale } = useI18n();
  const { clip, playing, playClip, stopClip, toggle, seek, subscribe, getTime } = usePlayer();
  const [index, setIndex] = useState(() => referenceTurn(turns));
  const barRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const tag = `speaker:${sp.key}`;
  const i = Math.min(index, turns.length - 1);
  const turn = turns[i]!;
  const current = clip?.tag === tag && clip.start === turn.clip.start;

  const play = (n: number) => {
    const next = turns[n];
    if (!next) return;
    setIndex(n);
    playClip({ ...next.clip, tag });
    onPlay();
  };

  useEffect(() => {
    if (playSignal > 0) play(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playSignal]);

  // Opened low on a short screen, it would be under the player bar.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    // "nearest" would ignore the scroll margin that keeps it clear of the player.
    const covered = el.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(el).scrollMarginBottom) || 0) > window.innerHeight;
    if (!covered) return;
    onScroll();
    el.scrollIntoView({ block: "end", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Closing the panel stops what it was playing.
  useEffect(() => () => stopClip(tag), [stopClip, tag]);

  // How far into the clip playback is, drawn every frame without re-rendering.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const { start, end } = turn.clip;
    const draw = (now: number) => {
      const p = current ? Math.min(1, Math.max(0, (now - start) / Math.max(0.1, end - start))) : 0;
      bar.style.transform = `scaleX(${p})`;
    };
    draw(getTime());
    return subscribe(draw);
  }, [current, turn, subscribe, getTime]);

  const name = sp.name;
  return (
    <div
      ref={panelRef}
      className="speaker-clips"
      role="group"
      aria-label={t("meeting.clipGroup", { name })}
      onKeyDown={(e) => {
        if (e.key === "Escape" && onClose) {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="speaker-clips-bar">
        <button
          type="button"
          className="speaker-clips-play"
          onMouseDown={keepFocus}
          onClick={() => (current ? toggle() : play(i))}
          title={current && playing ? t("meeting.clipPause") : t("meeting.clipPlay")}
          aria-label={current && playing ? t("meeting.clipPause") : t("meeting.clipPlay")}
        >
          {current && playing ? <Pause /> : <Play />}
        </button>
        <span className="speaker-clips-step">
          <button
            type="button"
            className="icon-btn sm"
            onMouseDown={keepFocus}
            onClick={() => play(i - 1)}
            disabled={i === 0}
            title={t("meeting.clipPrev")}
            aria-label={t("meeting.clipPrev")}
          >
            <ChevronLeft />
          </button>
          <span className="mono speaker-clips-count" title={t("meeting.clipCount", { i: i + 1, n: turns.length })}>
            {i + 1} / {turns.length}
          </span>
          <button
            type="button"
            className="icon-btn sm"
            onMouseDown={keepFocus}
            onClick={() => play(i + 1)}
            disabled={i === turns.length - 1}
            title={t("meeting.clipNext")}
            aria-label={t("meeting.clipNext")}
          >
            <ChevronRight />
          </button>
        </span>
        <span className="speaker-clips-where">
          <button
            type="button"
            className="speaker-clips-time mono"
            onMouseDown={keepFocus}
            onClick={() => seek(turn.start)}
            title={t("meeting.clipShow")}
          >
            {clock(turn.start)}
          </button>
          <span className="speaker-clips-length">{duration(turn.clip.end - turn.start, locale)}</span>
        </span>
        {onClose && (
          <button type="button" className="icon-btn sm speaker-clips-close" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
            <X />
          </button>
        )}
      </div>
      <span className="speaker-clips-progress" aria-hidden="true">
        <span ref={barRef} />
      </span>
      <p className="speaker-clips-text">
        {i === 0 && <span className="speaker-clips-first">{t("meeting.clipFirst")}</span>}
        {t("meeting.clipQuote", { text: turn.text })}
      </p>
    </div>
  );
}

function SpeakerLegend({ meeting, turns, onScroll }: { meeting: MeetingDetail; turns: Map<string, Turn[]>; onScroll: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const voice = useSpeakerVoice(meeting);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Whose turns are open to listen to, and a count that asks to play one.
  const [listening, setListening] = useState<{ key: string; play: number } | null>(null);
  const plays = useRef(0);

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
  const byVoice = meeting.voiceRecognition ? meeting.speakers.filter((s) => s.voice?.status === "auto").length : 0;
  // One panel at a time: the speaker being named, else the one listened to.
  const panelFor = editing ?? listening?.key ?? null;

  const startEditing = (sp: Speaker) => {
    setDraft(sp.name);
    setEditing(sp.key);
    setListening((l) => (l?.key === sp.key ? l : null));
  };
  const listen = (key: string) => setListening({ key, play: ++plays.current });
  // Once a clip is played the panel stays open, also after naming is done.
  const keepListening = (key: string) => setListening((l) => (l?.key === key ? l : { key, play: 0 }));

  const save = async (sp: Speaker) => {
    const name = draft.trim();
    setEditing(null);
    if (!name || name === sp.name) return;
    try {
      const { summaries, voice: outcome } = await api.renameSpeaker(meeting.id, sp.key, name);
      await Promise.all([qc.invalidateQueries({ queryKey: ["meeting", meeting.id] }), qc.invalidateQueries({ queryKey: ["voices"] })]);
      if (summaries.skipped > 0) toast.show(t("meeting.namesNotReplaced", { n: summaries.skipped }));
      voice.announce(sp, outcome);
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
        {byVoice > 0 && (
          <span className="pill accent legend-voice-count">
            <AudioLines /> {t("meeting.voiceRecognisedCount", { n: byVoice })}
          </span>
        )}
      </div>
      <div className="legend-bar" aria-hidden="true">
        {sorted.map((sp) => (
          <span key={sp.key} style={{ flexGrow: talk.totals.get(sp.key) ?? 0, background: speakerVar(sp.color) }} />
        ))}
      </div>
      <ul className="legend-list">
        {sorted.map((sp) => {
          const share = talk.sum ? (talk.totals.get(sp.key) ?? 0) / talk.sum : 0;
          const spTurns = turns.get(sp.key) ?? [];
          const open = panelFor === sp.key && spTurns.length > 0;
          return (
            <li
              key={sp.key}
              className={open ? "has-clips" : ""}
              style={{ ["--spk" as string]: speakerVar(sp.color) }}
              // Naming ends when focus leaves the row, not when it moves to the clip controls.
              onBlur={(e) => {
                if (editing === sp.key && !e.currentTarget.contains(e.relatedTarget as Node | null)) void save(sp);
              }}
            >
              <span className="speaker-dot" />
              {editing === sp.key ? (
                <input
                  className="legend-input"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setEditing(null);
                  }}
                  maxLength={80}
                />
              ) : (
                <button className="legend-name" title={t("meeting.renameHint")} onClick={() => startEditing(sp)}>
                  {sp.name}
                  <Pencil />
                </button>
              )}
              {editing !== sp.key && (
                <VoiceBadge
                  meeting={meeting}
                  sp={sp}
                  run={(s, a) => void voice.run(s, a)}
                  onListen={spTurns.length ? () => listen(sp.key) : undefined}
                />
              )}
              {editing !== sp.key && spTurns.length > 0 && (
                <button
                  type="button"
                  className="legend-listen"
                  aria-pressed={open}
                  onClick={() => (open ? setListening(null) : listen(sp.key))}
                  title={t("meeting.clipListen", { name: sp.name })}
                  aria-label={t("meeting.clipListen", { name: sp.name })}
                >
                  <Headphones />
                </button>
              )}
              <span className="legend-share mono">{Math.round(share * 100)}%</span>
              <span className="legend-time mono faint">{clock(talk.totals.get(sp.key) ?? 0)}</span>
              {open && (
                <SpeakerClips
                  sp={sp}
                  turns={spTurns}
                  playSignal={listening?.key === sp.key ? listening.play : 0}
                  onPlay={() => keepListening(sp.key)}
                  onClose={editing === sp.key ? undefined : () => setListening(null)}
                  onScroll={onScroll}
                />
              )}
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
  const { time, seek, clip, playing } = usePlayer();
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const [editing, setEditing] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const speakers = useMemo(() => new Map(meeting.speakers.map((s) => [s.key, s])), [meeting.speakers]);
  const blocks = useMemo(() => toBlocks(meeting.segments), [meeting.segments]);
  const turns = useMemo(() => turnsBySpeaker(blocks), [blocks]);
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

  /*
   * Follow rules
   * - While following, the playing line is kept in view as playback advances.
   * - Scrolling away by hand detaches: auto-scroll pauses and "Back to playback"
   *   appears. Scrolling back to the playing line re-attaches.
   * - Any explicit seek (transcript line, summary timestamp, waveform, skip)
   *   re-attaches and brings that moment into view, even while paused.
   */
  const [detached, setDetached] = useState(false);
  const programmatic = useRef(0);
  const activeEl = useCallback(
    () => (activeId == null ? null : listRef.current?.querySelector<HTMLElement>(`[data-seg="${activeId}"]`) ?? null),
    [activeId],
  );
  const inView = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 120 && r.top < window.innerHeight - 140;
  };
  const scrollToActive = useCallback(
    (force: boolean) => {
      const el = activeEl();
      if (!el) return;
      const r = el.getBoundingClientRect();
      const margin = 180;
      if (force || r.top < margin || r.bottom > window.innerHeight - margin - 120) {
        programmatic.current = performance.now();
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    },
    [activeEl],
  );

  // A speaker's clips are listened to in the speaker list, so the page holds
  // still while one plays and after it ends, until playback is started some
  // other way or a seek moves it.
  const held = useRef(false);
  const wasPlaying = useRef(false);
  useEffect(() => {
    if (clip) held.current = true;
    else if (playing && !wasPlaying.current) held.current = false;
    wasPlaying.current = playing;
    if (!follow || detached || editing != null || held.current) return;
    scrollToActive(false);
  }, [activeId, follow, detached, editing, clip, playing, scrollToActive]);

  // Explicit seeks re-attach and bring the target into view.
  const { seekCount } = usePlayer();
  const firstSeek = useRef(true);
  useEffect(() => {
    if (firstSeek.current) {
      firstSeek.current = false;
      return;
    }
    setDetached(false);
    held.current = false;
    // Wait a frame so the active line reflects the new time.
    requestAnimationFrame(() => scrollToActive(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekCount]);

  // Manual scrolling (wheel, touch, keys, scrollbar) detaches; our own smooth scrolls do not.
  useEffect(() => {
    if (!follow) return;
    const onScroll = () => {
      if (performance.now() - programmatic.current < 900) return;
      const el = activeEl();
      // Hidden transcript (e.g. the Summary tab on phones) cannot be "scrolled away from".
      if (!el || el.offsetParent === null) return;
      setDetached(!inView(el));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [follow, activeEl]);

  const markScroll = useCallback(() => {
    programmatic.current = performance.now();
  }, []);

  const backToPlayback = () => {
    setDetached(false);
    scrollToActive(true);
  };

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
      await qc.invalidateQueries({ queryKey: ["voices"] });
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
      <SpeakerLegend meeting={meeting} turns={turns} onScroll={markScroll} />
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
        {follow && detached && activeId != null ? (
          // In the sticky toolbar rather than floating, so it never covers transcript text.
          <button type="button" className="btn btn-sm btn-ink back-to-playback" onClick={backToPlayback}>
            <LocateFixed /> {t("meeting.backToPlayback")}
          </button>
        ) : (
          <span className="faint mono transcript-count">
            {locale === "zh-TW" ? t("meeting.chars", { n: totalWords.toLocaleString() }) : t("meeting.words", { n: totalWords.toLocaleString() })}
          </span>
        )}
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
