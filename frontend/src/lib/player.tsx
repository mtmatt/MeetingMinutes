import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** A stretch played on its own, such as one turn of a speaker: playback pauses at its end. */
export interface Clip {
  start: number;
  end: number;
  /** Who started it, so only they stop it. */
  tag: string;
}

/**
 * One media clock for the meeting page. Either the <audio> element in the
 * docked player or the optional <video> element registers itself here; all
 * UI (waveform, transcript highlighting, summary timestamps) reads from it.
 */
interface PlayerValue {
  time: number;
  duration: number;
  playing: boolean;
  rate: number;
  /** Increments on every explicit seek (transcript, summary timestamp, waveform, skip). */
  seekCount: number;
  /** The clip being played, until it reaches its end or another seek. */
  clip: Clip | null;
  seek: (t: number, autoplay?: boolean) => void;
  /** Play just this stretch. Not an explicit seek: the transcript does not jump to it. */
  playClip: (clip: Clip) => void;
  /** Stop the clip, if it is still the one `tag` started. */
  stopClip: (tag: string) => void;
  toggle: () => void;
  skip: (delta: number) => void;
  setRate: (r: number) => void;
  register: (el: HTMLMediaElement | null) => void;
  /** Subscribe to high-frequency time updates (animation frames while playing). */
  subscribe: (fn: (t: number) => void) => () => void;
  getTime: () => number;
  /** Why playback failed, until it works again. */
  error: PlayError | null;
}

/**
 * Why the recording does not play, when it does not: shown in the player
 * instead of a play button that silently does nothing.
 */
export type PlayError = "deleted" | "missing" | "signedOut" | "format" | "blocked" | "network" | "stalled";

/** How long a press of play may go without sound before the player looks into why. */
const STALL_MS = 8000;

/** Asks the server about the file once the browser gave up on it: its answer says why. */
async function diagnose(el: HTMLMediaElement, stalled = false): Promise<PlayError> {
  const decode = el.error?.code === MediaError.MEDIA_ERR_DECODE || el.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;
  // A request that never gets an answer (no free connection to the site, a server that
  // does not reply) must not leave this waiting too.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), STALL_MS);
  try {
    const res = await fetch(el.currentSrc || el.src, { headers: { Range: "bytes=0-0" }, credentials: "same-origin", signal: timeout.signal });
    if (res.status === 410) return "deleted";
    if (res.status === 404) return "missing";
    if (res.status === 401 || res.status === 403) return "signedOut";
    if (!res.ok) return "network";
  } catch {
    return stalled ? "stalled" : "network";
  } finally {
    clearTimeout(timer);
  }
  // The server sends the file: the browser could not use it, or is still waiting for it.
  return decode ? "format" : stalled ? "stalled" : "network";
}

const PlayerContext = createContext<PlayerValue | null>(null);

export function PlayerProvider({ children, fallbackDuration }: { children: ReactNode; fallbackDuration: number }) {
  const elRef = useRef<HTMLMediaElement | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(fallbackDuration);
  const [playing, setPlaying] = useState(false);
  const [rate, setRateState] = useState(1);
  const [seekCount, setSeekCount] = useState(0);
  const [clip, setClipState] = useState<Clip | null>(null);
  const clipRef = useRef<Clip | null>(null);
  const listeners = useRef(new Set<(t: number) => void>());
  const pendingSeek = useRef<{ t: number; play: boolean } | null>(null);
  const lastState = useRef({ t: 0, playing: false, rate: 1 });
  const [error, setError] = useState<PlayError | null>(null);
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Start playing; a refusal is reported, not swallowed, and so is a wait that never ends. */
  const start = useCallback((el: HTMLMediaElement) => {
    if (stallTimer.current) clearTimeout(stallTimer.current);
    stallTimer.current = setTimeout(() => {
      stallTimer.current = null;
      // Still no sound, and nothing said why: ask the server, with a time limit.
      if (el.paused === false && el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
      if (el.error) return;
      void diagnose(el, true).then(setError);
    }, STALL_MS);
    el.play().then(
      () => setError(null),
      (e: unknown) => {
        const name = (e as { name?: string })?.name;
        // Interrupted by a pause or a new source: not a failure.
        if (name === "AbortError") return;
        if (name === "NotAllowedError") setError("blocked");
        else void diagnose(el).then(setError);
      },
    );
  }, []);

  const emit = useCallback((t: number) => {
    for (const l of listeners.current) l(t);
  }, []);

  const setClip = useCallback((c: Clip | null) => {
    clipRef.current = c;
    setClipState(c);
  }, []);

  /** Pause at the end of the clip being played. */
  const endClip = useCallback(
    (el: HTMLMediaElement) => {
      const c = clipRef.current;
      if (!c || el.currentTime < c.end) return;
      el.pause();
      setClip(null);
    },
    [setClip],
  );

  // Coarse React state at ~4 Hz; fine-grained updates go to subscribers via rAF.
  useEffect(() => {
    let raf = 0;
    let lastCoarse = 0;
    const loop = (now: number) => {
      const el = elRef.current;
      if (el && !el.paused) {
        endClip(el);
        emit(el.currentTime);
        if (now - lastCoarse > 250) {
          lastCoarse = now;
          setTime(el.currentTime);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [emit, endClip]);

  const register = useCallback(
    (el: HTMLMediaElement | null) => {
      const prev = elRef.current;
      if (prev === el) return;
      if (prev) {
        lastState.current = { t: prev.currentTime, playing: !prev.paused, rate: prev.playbackRate };
        prev.pause();
      }
      elRef.current = el;
      if (!el) return;
      const sync = () => {
        setTime(el.currentTime);
        emit(el.currentTime);
      };
      el.addEventListener("timeupdate", () => {
        // Animation frames stop in a background tab; the clip still ends on time.
        endClip(el);
        sync();
      });
      el.addEventListener("seeked", sync);
      el.addEventListener("error", () => void diagnose(el).then(setError));
      el.addEventListener("canplay", () => setError(null));
      el.addEventListener("pause", () => {
        if (stallTimer.current) clearTimeout(stallTimer.current);
        stallTimer.current = null;
      });
      el.addEventListener("playing", () => {
        if (stallTimer.current) clearTimeout(stallTimer.current);
        stallTimer.current = null;
        setError(null);
      });
      el.addEventListener("play", () => setPlaying(true));
      el.addEventListener("pause", () => setPlaying(false));
      el.addEventListener("ended", () => {
        setPlaying(false);
        setClip(null);
      });
      el.addEventListener("ratechange", () => setRateState(el.playbackRate));
      el.addEventListener("loadedmetadata", () => {
        if (Number.isFinite(el.duration) && el.duration > 0) setDuration(el.duration);
        const p = pendingSeek.current;
        if (p) {
          el.currentTime = p.t;
          if (p.play) start(el);
          pendingSeek.current = null;
        }
      });
      // Carry position and state across a switch between audio and video.
      el.playbackRate = lastState.current.rate;
      if (prev) pendingSeek.current = { t: lastState.current.t, play: lastState.current.playing };
    },
    [emit, endClip, setClip, start],
  );

  /** Move the playhead, without counting as an explicit seek. */
  const jump = useCallback(
    (t: number, autoplay: boolean) => {
      const el = elRef.current;
      const clamped = Math.max(0, t);
      setTime(clamped);
      emit(clamped);
      if (!el) {
        // No media element yet (e.g. a deep link on first render): apply once it loads.
        pendingSeek.current = { t: clamped, play: autoplay };
        return;
      }
      if (el.readyState >= 1) {
        el.currentTime = clamped;
        if (autoplay) start(el);
      } else {
        pendingSeek.current = { t: clamped, play: autoplay };
      }
    },
    [emit, start],
  );

  const seek = useCallback(
    (t: number, autoplay = false) => {
      setClip(null);
      setSeekCount((c) => c + 1);
      jump(t, autoplay);
    },
    [jump, setClip],
  );

  const playClip = useCallback(
    (c: Clip) => {
      setClip(c);
      jump(c.start, true);
    },
    [jump, setClip],
  );

  const stopClip = useCallback(
    (tag: string) => {
      if (clipRef.current?.tag !== tag) return;
      elRef.current?.pause();
      setClip(null);
    },
    [setClip],
  );

  const toggle = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    if (el.paused) start(el);
    else el.pause();
  }, [start]);

  const skip = useCallback((d: number) => {
    const el = elRef.current;
    if (el) seek(el.currentTime + d);
  }, [seek]);

  const setRate = useCallback((r: number) => {
    const el = elRef.current;
    if (el) el.playbackRate = r;
    setRateState(r);
  }, []);

  const subscribe = useCallback((fn: (t: number) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const getTime = useCallback(() => elRef.current?.currentTime ?? 0, []);

  const value = useMemo(
    () => ({ time, duration, playing, rate, seekCount, clip, seek, playClip, stopClip, toggle, skip, setRate, register, subscribe, getTime, error }),
    [time, duration, playing, rate, seekCount, clip, seek, playClip, stopClip, toggle, skip, setRate, register, subscribe, getTime, error],
  );
  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer(): PlayerValue {
  const v = useContext(PlayerContext);
  if (!v) throw new Error("usePlayer outside PlayerProvider");
  return v;
}

/** Keyboard shortcuts: space toggles, arrows skip 5 s (ignored while typing). */
export function usePlayerShortcuts() {
  const { toggle, skip } = usePlayer();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // A timestamp just clicked keeps the focus: Space then pauses, as everywhere else on
      // the page, instead of pressing that timestamp again (which only jumps back to it).
      if (target?.closest(".block-time, .ts-link") && (e.key === " " || e.key === "k") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        toggle();
        return;
      }
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName) || target.closest('[role="menu"]'))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === " " || e.key === "k") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowLeft" || e.key === "j") {
        e.preventDefault();
        skip(-5);
      } else if (e.key === "ArrowRight" || e.key === "l") {
        e.preventDefault();
        skip(5);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, skip]);
}
