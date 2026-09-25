import { useQuery } from "@tanstack/react-query";
import { Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api, mediaUrl } from "../api/client";
import type { MeetingDetail } from "../api/types";
import { useI18n } from "../i18n";
import { clock } from "../lib/format";
import { usePlayer } from "../lib/player";
import { Menu } from "./Menu";

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

function cssVar(el: Element, name: string) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

/** Index of the segment playing at time t, or -1 (segments are sorted by start). */
export function segmentAt(segments: MeetingDetail["segments"], t: number): number {
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
  return ans >= 0 && t <= segments[ans]!.end + 0.5 ? ans : -1;
}

export interface SpeakerRun {
  start: number;
  end: number;
  speaker: string;
}

/**
 * Collapse segments into continuous speaker runs: consecutive segments of the
 * same speaker join across pauses shorter than `joinGap` seconds, and runs
 * narrower than `minWidth` seconds are absorbed by their predecessor so the
 * band shows who holds the floor rather than every interjection.
 */
export function speakerRuns(segments: MeetingDetail["segments"], joinGap: number, minWidth: number): SpeakerRun[] {
  const runs: SpeakerRun[] = [];
  for (const s of segments) {
    if (!s.speaker) continue;
    const last = runs[runs.length - 1];
    if (last && last.speaker === s.speaker && s.start - last.end <= joinGap) {
      last.end = Math.max(last.end, s.end);
    } else if (last && s.end - s.start < minWidth && s.start - last.end <= joinGap) {
      last.end = Math.max(last.end, s.end);
    } else {
      runs.push({ start: s.start, end: s.end, speaker: s.speaker });
    }
  }
  // A short run between two runs of the same speaker disappears; re-join those.
  const merged: SpeakerRun[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === r.speaker && r.start - last.end <= joinGap) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

const BAND_H = 8;
const BAND_GAP = 6;

/**
 * A quiet, single-colour volume waveform with a speaker band beneath it.
 * The band shows continuous runs of who is talking; the red playhead crosses
 * both. Click or drag anywhere to seek.
 */
function Waveform({ meeting }: { meeting: MeetingDetail }) {
  const { seek, subscribe, getTime, duration } = usePlayer();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const peaksQ = useQuery({
    queryKey: ["peaks", meeting.id, meeting.transcribedAt],
    queryFn: () => api.peaks(meeting.id),
    enabled: meeting.media.hasPeaks,
    staleTime: Infinity,
  });
  const peaks = peaksQ.data;
  const total = duration || meeting.durationSec || peaks?.duration || 1;
  const speakerColor = useMemo(() => new Map(meeting.speakers.map((s) => [s.key, s.color % 10])), [meeting.speakers]);
  const hasBand = meeting.speakers.length > 0;
  // Changes whenever the transcript or speaker list is replaced (e.g. after an edit).
  const layoutVersion = useMemo(() => Math.random().toString(36), [meeting.segments, meeting.speakers]);

  // Bar heights and the speaker band are cached per size and data; each
  // animation frame only recolours played bars and moves the playhead.
  const cache = useRef<{ key: string; bars: Float32Array; band: HTMLCanvasElement | null } | null>(null);

  const draw = useCallback(
    (t: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const step = 3;
      const bar = 2;
      const waveH = hasBand ? h - BAND_H - BAND_GAP : h;

      const faint = cssVar(canvas, "--rule-strong");
      const key = `${w}x${h}@${dpr}:${faint}:${peaks?.peaks.length ?? 0}:${total}:${layoutVersion}`;
      if (!cache.current || cache.current.key !== key) {
        const n = Math.floor(w / step);
        const bars = new Float32Array(n);
        const data = peaks?.peaks;
        for (let i = 0; i < n; i++) {
          let v = 0.06;
          if (data && data.length) {
            const a = Math.floor((i / n) * data.length);
            const b = Math.max(a + 1, Math.floor(((i + 1) / n) * data.length));
            // Average rather than max: at meeting length each bar spans seconds of
            // audio, and the max would pin almost every bar to full height.
            let sum = 0;
            let cnt = 0;
            for (let j = a; j < b && j < data.length; j++) {
              sum += data[j]!;
              cnt++;
            }
            v = Math.max(0.04, Math.min(1, Math.pow(sum / Math.max(1, cnt) / 255, 1.15) * 1.35));
          }
          bars[i] = Math.max(1.5, v * (waveH - 2));
        }

        let band: HTMLCanvasElement | null = null;
        if (hasBand) {
          band = document.createElement("canvas");
          band.width = Math.round(w * dpr);
          band.height = Math.round(BAND_H * dpr);
          const bc = band.getContext("2d")!;
          bc.setTransform(dpr, 0, 0, dpr, 0, 0);
          bc.fillStyle = faint;
          bc.globalAlpha = 0.45;
          bc.fillRect(0, 0, w, BAND_H);
          bc.globalAlpha = 1;
          const secPerPx = total / w;
          const runs = speakerRuns(meeting.segments, Math.max(2, secPerPx * 3), secPerPx * 4);
          const palette = Array.from({ length: 10 }, (_, i) => cssVar(canvas, `--spk-${i}`));
          for (const r of runs) {
            const c = speakerColor.get(r.speaker);
            if (c === undefined) continue;
            const x0 = Math.round((r.start / total) * w);
            const x1 = Math.round((r.end / total) * w);
            bc.fillStyle = palette[c]!;
            // 1px seam between runs keeps speaker changes visible.
            bc.fillRect(x0, 0, Math.max(1, x1 - x0 - 1), BAND_H);
          }
        }
        cache.current = { key, bars, band };
      }

      const { bars, band } = cache.current;
      const ink = cssVar(canvas, "--ink-2");
      const accent = cssVar(canvas, "--accent");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const mid = waveH / 2;
      const playedX = (t / total) * w;
      ctx.fillStyle = ink;
      let i = 0;
      for (; i < bars.length && i * step + bar <= playedX; i++) ctx.fillRect(i * step, mid - bars[i]! / 2, bar, bars[i]!);
      ctx.fillStyle = faint;
      for (; i < bars.length; i++) ctx.fillRect(i * step, mid - bars[i]! / 2, bar, bars[i]!);
      if (band) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(band, 0, Math.round((waveH + BAND_GAP) * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      ctx.fillStyle = accent;
      ctx.fillRect(Math.round(playedX) - 1, 0, 2, h);
    },
    [peaks, total, meeting.segments, speakerColor, layoutVersion, hasBand],
  );

  useEffect(() => {
    draw(getTime());
    const unsub = subscribe(draw);
    const ro = new ResizeObserver(() => draw(getTime()));
    if (wrapRef.current) ro.observe(wrapRef.current);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const redraw = () => {
      cache.current = null;
      draw(getTime());
    };
    mq.addEventListener("change", redraw);
    const mo = new MutationObserver(redraw);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      unsub();
      ro.disconnect();
      mq.removeEventListener("change", redraw);
      mo.disconnect();
    };
  }, [draw, subscribe, getTime]);

  const timeAt = (e: ReactPointerEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const x = Math.min(Math.max(0, e.clientX - rect.left), rect.width);
    return { x, t: (x / rect.width) * total };
  };

  const hoverSpeaker = useMemo(() => {
    if (!hover) return null;
    const idx = segmentAt(meeting.segments, hover.t);
    const key = idx >= 0 ? meeting.segments[idx]!.speaker : null;
    return key ? meeting.speakers.find((s) => s.key === key) ?? null : null;
  }, [hover, meeting.segments, meeting.speakers]);

  return (
    <div
      ref={wrapRef}
      className="waveform"
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture?.(e.pointerId);
        seek(timeAt(e).t);
      }}
      onPointerMove={(e) => {
        const p = timeAt(e);
        setHover(p);
        if (e.buttons === 1) seek(p.t);
      }}
      onPointerLeave={() => setHover(null)}
      role="slider"
      aria-valuemin={0}
      aria-valuemax={Math.round(total)}
      aria-valuenow={Math.round(getTime())}
      tabIndex={-1}
    >
      <canvas ref={canvasRef} />
      {hover && (
        <div className="waveform-hover" style={{ left: hover.x }}>
          <span className="mono">{clock(hover.t)}</span>
          {hoverSpeaker && (
            <span className="waveform-hover-spk" style={{ color: `var(--spk-${hoverSpeaker.color % 10})` }}>
              {hoverSpeaker.name}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Names for the waveform colours, with the current speaker marked. */
function SpeakerKey({ meeting }: { meeting: MeetingDetail }) {
  const { t } = useI18n();
  const { time, playing } = usePlayer();
  const idx = segmentAt(meeting.segments, time);
  const current = idx >= 0 ? meeting.segments[idx]!.speaker : null;
  if (!meeting.speakers.length) return null;
  return (
    <ul className="speaker-key" aria-label={t("meeting.speakers")}>
      {meeting.speakers.map((s) => (
        <li key={s.key} className={s.key === current ? "speaking" : ""} style={{ ["--spk" as string]: `var(--spk-${s.color % 10})` }}>
          <span className="speaker-dot" />
          {s.name}
          {s.key === current && (
            <span className={`speaker-key-now ${playing ? "" : "paused"}`}>{playing ? t("meeting.speakingNow") : t("meeting.atPlayhead")}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function PlayerBar({ meeting, videoMode }: { meeting: MeetingDetail; videoMode: boolean }) {
  const { t } = useI18n();
  const { time, duration, playing, rate, toggle, skip, setRate, register } = usePlayer();
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (!videoMode) register(audioRef.current);
  }, [videoMode, register]);

  const total = duration || meeting.durationSec || 0;
  return (
    <div className="player">
      {!videoMode && <audio ref={audioRef} src={mediaUrl.audio(meeting.id)} preload="metadata" />}
      <div className="player-inner">
        <div className="player-controls">
          <button className="skip-btn" onClick={() => skip(-15)} aria-label={t("meeting.back15")} title={t("meeting.back15")}>
            <RotateCcw />
            <span>{t("meeting.back15Short")}</span>
          </button>
          <button className="player-play" onClick={toggle} aria-label={t("meeting.playPause")} title={`${t("meeting.playPause")} (Space)`}>
            {playing ? <Pause /> : <Play />}
          </button>
          <button className="skip-btn" onClick={() => skip(15)} aria-label={t("meeting.fwd15")} title={t("meeting.fwd15")}>
            <span>{t("meeting.fwd15Short")}</span>
            <RotateCw />
          </button>
        </div>
        <div className="player-time mono">
          <span className="now">{clock(time, total >= 3600)}</span>
          <span className="sep">/</span>
          <span>{clock(total, total >= 3600)}</span>
        </div>
        <div className="player-track">
          <Waveform meeting={meeting} />
          <SpeakerKey meeting={meeting} />
        </div>
        <Menu
          up
          trigger={({ toggle: open }) => (
            <button className="player-rate" onClick={open} aria-label={t("meeting.speed")} title={t("meeting.speed")}>
              <span className="player-rate-label">{t("meeting.speedShort")}</span>
              <span className="mono">{rate}×</span>
            </button>
          )}
        >
          {(close) =>
            RATES.map((r) => (
              <button
                key={r}
                className="menu-item mono"
                onClick={() => {
                  setRate(r);
                  close();
                }}
              >
                {r}× {r === rate && <span className="end">●</span>}
              </button>
            ))
          }
        </Menu>
      </div>
    </div>
  );
}
