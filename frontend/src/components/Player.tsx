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

/**
 * Waveform with speaker lanes. The top band draws the audio envelope (played
 * part in ink, the rest faint); beneath it, one thin lane per speaker shows
 * when each person talks. Click or drag anywhere to seek.
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

  const speakerIndex = useMemo(() => new Map(meeting.speakers.map((s, i) => [s.key, i])), [meeting.speakers]);
  const lanes = Math.max(1, meeting.speakers.length);
  // Changes whenever the transcript or speaker list is replaced (e.g. after an edit).
  const layoutVersion = useMemo(() => Math.random().toString(36), [meeting.segments, meeting.speakers]);

  // Static layers (envelope heights and speaker lanes) are cached per size and data;
  // each animation frame only recolours bars and moves the playhead.
  const cache = useRef<{ key: string; bars: Float32Array; lanes: HTMLCanvasElement | null; waveH: number } | null>(null);

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
      const ink = cssVar(canvas, "--ink");
      const faint = cssVar(canvas, "--rule-strong");
      const accent = cssVar(canvas, "--accent");

      const laneH = 4;
      const laneGap = 3;
      const hasLanes = meeting.speakers.length > 0;
      const lanesH = hasLanes ? lanes * laneH + (lanes - 1) * laneGap + 8 : 0;
      const waveH = h - lanesH;
      const step = 3;
      const bar = 2;

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
          bars[i] = Math.max(1.5, v * (waveH - 6));
        }
        let lanesCanvas: HTMLCanvasElement | null = null;
        if (hasLanes) {
          lanesCanvas = document.createElement("canvas");
          lanesCanvas.width = Math.round(w * dpr);
          lanesCanvas.height = Math.round(lanesH * dpr);
          const lc = lanesCanvas.getContext("2d")!;
          lc.setTransform(dpr, 0, 0, dpr, 0, 0);
          const top = 8;
          lc.globalAlpha = 0.35;
          lc.fillStyle = faint;
          for (let i = 0; i < lanes; i++) lc.fillRect(0, top + i * (laneH + laneGap), w, laneH);
          lc.globalAlpha = 1;
          const colors = meeting.speakers.map((s) => cssVar(canvas, `--spk-${s.color % 10}`));
          for (const seg of meeting.segments) {
            if (!seg.speaker) continue;
            const idx = speakerIndex.get(seg.speaker);
            if (idx === undefined) continue;
            lc.fillStyle = colors[idx]!;
            const x0 = (seg.start / total) * w;
            const x1 = Math.max(x0 + 1.5, (seg.end / total) * w);
            lc.fillRect(x0, top + idx * (laneH + laneGap), x1 - x0, laneH);
          }
        }
        cache.current = { key, bars, lanes: lanesCanvas, waveH };
      }

      const { bars, lanes: lanesCanvas } = cache.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const mid = waveH / 2;
      const playedX = (t / total) * w;
      ctx.fillStyle = ink;
      let i = 0;
      for (; i < bars.length && i * step + bar <= playedX; i++) ctx.fillRect(i * step, mid - bars[i]! / 2, bar, bars[i]!);
      ctx.fillStyle = faint;
      for (; i < bars.length; i++) ctx.fillRect(i * step, mid - bars[i]! / 2, bar, bars[i]!);
      if (lanesCanvas) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(lanesCanvas, 0, Math.round(waveH * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      ctx.fillStyle = accent;
      ctx.fillRect(Math.round(playedX) - 1, 0, 2, h);
    },
    [peaks, total, meeting.segments, meeting.speakers, speakerIndex, lanes, layoutVersion],
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
    const seg = meeting.segments.find((s) => s.start <= hover.t && s.end >= hover.t);
    return seg?.speaker ? meeting.speakers.find((s) => s.key === seg.speaker) ?? null : null;
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
          <button className="icon-btn" onClick={() => skip(-15)} aria-label={t("meeting.back15")} title={t("meeting.back15")}>
            <RotateCcw />
          </button>
          <button className="player-play" onClick={toggle} aria-label={t("meeting.playPause")} title={`${t("meeting.playPause")} (Space)`}>
            {playing ? <Pause /> : <Play />}
          </button>
          <button className="icon-btn" onClick={() => skip(15)} aria-label={t("meeting.fwd15")} title={t("meeting.fwd15")}>
            <RotateCw />
          </button>
        </div>
        <div className="player-time mono">
          <span className="now">{clock(time, total >= 3600)}</span>
          <span className="sep">/</span>
          <span>{clock(total, total >= 3600)}</span>
        </div>
        <Waveform meeting={meeting} />
        <Menu
          up
          trigger={({ toggle: open }) => (
            <button className="player-rate mono" onClick={open} aria-label={t("meeting.speed")} title={t("meeting.speed")}>
              {rate}×
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
