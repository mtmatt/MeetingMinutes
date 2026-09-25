import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
  seek: (t: number, autoplay?: boolean) => void;
  toggle: () => void;
  skip: (delta: number) => void;
  setRate: (r: number) => void;
  register: (el: HTMLMediaElement | null) => void;
  /** Subscribe to high-frequency time updates (animation frames while playing). */
  subscribe: (fn: (t: number) => void) => () => void;
  getTime: () => number;
}

const PlayerContext = createContext<PlayerValue | null>(null);

export function PlayerProvider({ children, fallbackDuration }: { children: ReactNode; fallbackDuration: number }) {
  const elRef = useRef<HTMLMediaElement | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(fallbackDuration);
  const [playing, setPlaying] = useState(false);
  const [rate, setRateState] = useState(1);
  const listeners = useRef(new Set<(t: number) => void>());
  const pendingSeek = useRef<{ t: number; play: boolean } | null>(null);
  const lastState = useRef({ t: 0, playing: false, rate: 1 });

  const emit = useCallback((t: number) => {
    for (const l of listeners.current) l(t);
  }, []);

  // Coarse React state at ~4 Hz; fine-grained updates go to subscribers via rAF.
  useEffect(() => {
    let raf = 0;
    let lastCoarse = 0;
    const loop = (now: number) => {
      const el = elRef.current;
      if (el && !el.paused) {
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
  }, [emit]);

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
      el.addEventListener("timeupdate", sync);
      el.addEventListener("seeked", sync);
      el.addEventListener("play", () => setPlaying(true));
      el.addEventListener("pause", () => setPlaying(false));
      el.addEventListener("ended", () => setPlaying(false));
      el.addEventListener("ratechange", () => setRateState(el.playbackRate));
      el.addEventListener("loadedmetadata", () => {
        if (Number.isFinite(el.duration) && el.duration > 0) setDuration(el.duration);
        const p = pendingSeek.current;
        if (p) {
          el.currentTime = p.t;
          if (p.play) void el.play().catch(() => undefined);
          pendingSeek.current = null;
        }
      });
      // Carry position and state across a switch between audio and video.
      el.playbackRate = lastState.current.rate;
      if (prev) pendingSeek.current = { t: lastState.current.t, play: lastState.current.playing };
    },
    [emit],
  );

  const seek = useCallback(
    (t: number, autoplay = false) => {
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
        if (autoplay) void el.play().catch(() => undefined);
      } else {
        pendingSeek.current = { t: clamped, play: autoplay };
      }
    },
    [emit],
  );

  const toggle = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  }, []);

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
    () => ({ time, duration, playing, rate, seek, toggle, skip, setRate, register, subscribe, getTime }),
    [time, duration, playing, rate, seek, toggle, skip, setRate, register, subscribe, getTime],
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
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName))) return;
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
