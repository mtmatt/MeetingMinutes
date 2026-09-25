import { AlertTriangle, Headphones, Mic, MonitorSpeaker, Pause, Play, RotateCcw, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n, type TKey } from "../i18n";
import { clock, dateTime } from "../lib/format";
import { MeetingRecorder, RecorderError, extensionFor, listMicrophones, recorderSupport, type RecordSource } from "../lib/recorder";
import { deleteRecording, listRecordings, loadRecording, type RecordingMeta } from "../lib/recordingStore";
import { useConfirm } from "./Modal";

export interface RecordedFile {
  file: File;
  recordingId: string;
  startedAt: number;
  source: RecordSource;
}

function fileFor(blob: Blob, meta: RecordingMeta): File {
  const d = new Date(meta.startedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
  return new File([blob], `recording ${stamp}.${extensionFor(meta.mimeType)}`, { type: blob.type, lastModified: meta.startedAt });
}

const ERROR_KEYS: Record<RecorderError["code"], TKey> = {
  insecure: "recorder.errInsecure",
  unsupported: "recorder.errUnsupported",
  "mic-denied": "recorder.errMicDenied",
  "mic-missing": "recorder.errMicMissing",
  "share-cancelled": "recorder.errShareCancelled",
  "no-tab-audio": "recorder.errNoTabAudio",
  failed: "recorder.errFailed",
};

/** Live input level, drawn without re-rendering React on every frame. */
function Meter({ label, icon, read, silentHint }: { label: string; icon: React.ReactNode; read: () => number | null; silentHint?: string }) {
  const fillRef = useRef<HTMLSpanElement>(null);
  const [silentFor, setSilentFor] = useState(0);
  // The parent re-renders every 250 ms (clock); keep the animation loop and its
  // silence counter alive across renders by reading through a ref.
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    let raf = 0;
    let smoothed = 0;
    let lastLoud = performance.now();
    let lastReport = 0;
    const tick = (now: number) => {
      const v = readRef.current() ?? 0;
      // Peak hold with a slow fall, so bursty input reads as a steady level.
      smoothed = Math.max(v, smoothed * 0.965);
      if (fillRef.current) fillRef.current.style.transform = `scaleX(${smoothed})`;
      if (v > 0.25) lastLoud = now;
      if (now - lastReport > 1000) {
        lastReport = now;
        setSilentFor(Math.floor((now - lastLoud) / 1000));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="meter" data-silent={silentFor >= 20 ? "true" : undefined}>
      <span className="meter-label">
        {icon}
        {label}
      </span>
      <span className="meter-track">
        <span className="meter-fill" ref={fillRef} />
      </span>
      {silentHint && silentFor >= 20 && <span className="meter-hint">{silentHint}</span>}
    </div>
  );
}

export function Recorder({ onRecorded, onBusyChange }: { onRecorded: (r: RecordedFile) => void; onBusyChange: (busy: boolean) => void }) {
  const { t, locale } = useI18n();
  const confirm = useConfirm();
  const support = useRef(recorderSupport()).current;
  const [source, setSource] = useState<RecordSource>(support.meeting ? "meeting" : "mic");
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState<string>("");
  const [phase, setPhase] = useState<"setup" | "starting" | "recording" | "paused" | "finishing">("setup");
  const [error, setError] = useState<TKey | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [saved, setSaved] = useState<RecordingMeta | null>(null);
  const [sourceEnded, setSourceEnded] = useState(false);
  const [pending, setPending] = useState<RecordingMeta[]>([]);
  const rec = useRef<MeetingRecorder | null>(null);

  const refreshMics = useCallback(async () => {
    const list = await listMicrophones().catch(() => []);
    setMics(list);
  }, []);

  useEffect(() => {
    void refreshMics();
    void listRecordings()
      .then(setPending)
      .catch(() => setPending([]));
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshMics);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshMics);
  }, [refreshMics]);

  useEffect(() => {
    onBusyChange(phase !== "setup");
  }, [phase, onBusyChange]);
  // Handing a finished recording to the parent unmounts this component before
  // the effect above can report "not busy" again, so clear it explicitly.
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  // Stop capturing if the component goes away mid-recording (chunks are already saved).
  useEffect(() => () => void rec.current?.stop().catch(() => undefined), []);

  useEffect(() => {
    if (phase !== "recording" && phase !== "paused") return;
    const id = setInterval(() => setElapsed(rec.current?.elapsedMs() ?? 0), 250);
    return () => clearInterval(id);
  }, [phase]);

  const start = async () => {
    setError(null);
    setSourceEnded(false);
    setPhase("starting");
    try {
      rec.current = await MeetingRecorder.start({
        source,
        micDeviceId: micId || undefined,
        onChunkSaved: (m) => setSaved(m),
        onSourceEnded: () => setSourceEnded(true),
      });
      setElapsed(0);
      setPhase("recording");
      void refreshMics(); // labels become available after permission is granted
    } catch (e) {
      rec.current = null;
      setPhase("setup");
      setError(e instanceof RecorderError ? ERROR_KEYS[e.code] : "recorder.errFailed");
    }
  };

  const finish = async () => {
    const r = rec.current;
    if (!r) return;
    setPhase("finishing");
    const meta = await r.stop();
    rec.current = null;
    const blob = await loadRecording(meta.id);
    setPhase("setup");
    onBusyChange(false);
    if (!blob) {
      setError("recorder.errFailed");
      return;
    }
    onRecorded({ file: fileFor(blob, meta), recordingId: meta.id, startedAt: meta.startedAt, source: meta.source });
  };

  // When the shared meeting tab stops, finish automatically; everything so far is kept.
  useEffect(() => {
    if (sourceEnded && (phase === "recording" || phase === "paused")) void finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceEnded]);

  const discard = async () => {
    if (!(await confirm({ title: t("recorder.discardTitle"), body: t("recorder.discardBody"), confirmLabel: t("recorder.discard"), danger: true }))) return;
    const r = rec.current;
    rec.current = null;
    setPhase("setup");
    if (r) {
      const meta = await r.stop();
      await deleteRecording(meta.id);
    }
  };

  const restore = async (m: RecordingMeta) => {
    const blob = await loadRecording(m.id);
    if (!blob) {
      await deleteRecording(m.id);
      setPending((p) => p.filter((x) => x.id !== m.id));
      return;
    }
    onRecorded({ file: fileFor(blob, m), recordingId: m.id, startedAt: m.startedAt, source: m.source });
  };

  const dropPending = async (m: RecordingMeta) => {
    if (!(await confirm({ title: t("recorder.discardTitle"), body: t("recorder.discardBody"), confirmLabel: t("recorder.discard"), danger: true }))) return;
    await deleteRecording(m.id);
    setPending((p) => p.filter((x) => x.id !== m.id));
  };

  if (phase === "recording" || phase === "paused" || phase === "finishing") {
    const paused = phase === "paused";
    return (
      <div className="recorder live" aria-live="polite">
        <div className="recorder-top">
          <span className={`rec-status ${paused ? "paused" : ""}`}>
            <span className="rec-dot" />
            {phase === "finishing" ? t("recorder.finishing") : paused ? t("recorder.paused") : t("recorder.recording")}
          </span>
          <span className="rec-source">{source === "meeting" ? t("recorder.sourceMeeting") : t("recorder.sourceMic")}</span>
        </div>
        <div className="rec-clock">{clock(elapsed / 1000, true)}</div>
        <div className="meters">
          {source === "meeting" && (
            <Meter
              label={t("recorder.meterMeeting")}
              icon={<MonitorSpeaker />}
              read={() => rec.current?.levels().meeting ?? 0}
              silentHint={paused ? undefined : t("recorder.meetingSilent")}
            />
          )}
          <Meter label={t("recorder.meterMic")} icon={<Mic />} read={() => rec.current?.levels().mic ?? 0} />
        </div>
        <p className="rec-saved">
          {saved ? t("recorder.savedLocally", { t: clock(saved.durationMs / 1000) }) : t("recorder.savingLocally")}
        </p>
        <div className="rec-actions">
          <button type="button" className="btn btn-ghost btn-danger" onClick={discard} disabled={phase === "finishing"}>
            <Trash2 /> {t("recorder.discard")}
          </button>
          <span style={{ flex: 1 }} />
          {paused ? (
            <button type="button" className="btn" onClick={() => (rec.current?.resume(), setPhase("recording"))}>
              <Play /> {t("recorder.resume")}
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => (rec.current?.pause(), setPhase("paused"))} disabled={phase === "finishing"}>
              <Pause /> {t("recorder.pause")}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={finish} disabled={phase === "finishing"}>
            {phase === "finishing" ? <span className="spinner" /> : <Square />} {t("recorder.stop")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="recorder">
      {pending.length > 0 && (
        <div className="rec-recover">
          <RotateCcw />
          <div className="rec-recover-main">
            <strong>{t("recorder.recoverTitle")}</strong>
            {pending.map((m) => (
              <div key={m.id} className="rec-recover-item">
                <span>
                  {t("recorder.recoverItem", { when: dateTime(m.startedAt, locale), length: clock(m.durationMs / 1000) })}
                  {!m.finished && <span className="faint"> · {t("recorder.interrupted")}</span>}
                </span>
                <span className="rec-recover-actions">
                  <button type="button" className="btn btn-sm btn-ink" onClick={() => restore(m)}>
                    {t("recorder.useRecording")}
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => dropPending(m)}>
                    {t("recorder.discard")}
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!support.secure ? (
        <div className="callout warn">
          <AlertTriangle />
          <div>{t("recorder.errInsecure")}</div>
        </div>
      ) : (
        <>
          <div className="source-grid" role="radiogroup" aria-label={t("recorder.sourceLabel")}>
            <button
              type="button"
              role="radio"
              aria-checked={source === "meeting"}
              className="source-option"
              disabled={!support.meeting}
              onClick={() => setSource("meeting")}
            >
              <MonitorSpeaker />
              <span className="source-option-name">{t("recorder.sourceMeeting")}</span>
              <span className="source-option-desc">{support.meeting ? t("recorder.sourceMeetingDesc") : t("recorder.meetingUnsupported")}</span>
            </button>
            <button type="button" role="radio" aria-checked={source === "mic"} className="source-option" onClick={() => setSource("mic")}>
              <Mic />
              <span className="source-option-name">{t("recorder.sourceMic")}</span>
              <span className="source-option-desc">{t("recorder.sourceMicDesc")}</span>
            </button>
          </div>

          {source === "meeting" && (
            <ol className="rec-steps">
              <li>{t("recorder.step1")}</li>
              <li>{t("recorder.step2")}</li>
              <li>
                <Headphones /> {t("recorder.step3")}
              </li>
            </ol>
          )}

          <div className="field">
            <label htmlFor="mic">{t("recorder.micLabel")}</label>
            <select id="mic" className="select rec-mic" value={micId} onChange={(e) => setMicId(e.target.value)}>
              <option value="">{t("recorder.micDefault")}</option>
              {mics
                .filter((m) => m.deviceId && m.deviceId !== "default")
                .map((m, i) => (
                  <option key={m.deviceId} value={m.deviceId}>
                    {m.label || t("recorder.micN", { n: i + 1 })}
                  </option>
                ))}
            </select>
          </div>

          {error && (
            <div className="callout danger" role="alert">
              <AlertTriangle />
              <div>{t(error)}</div>
            </div>
          )}

          <div className="rec-start">
            <button type="button" className="btn btn-primary btn-lg" onClick={start} disabled={phase === "starting"}>
              {phase === "starting" ? <span className="spinner" /> : <span className="rec-dot static" />}
              {source === "meeting" ? t("recorder.startMeeting") : t("recorder.startMic")}
            </button>
            <p className="faint">{t("recorder.consent")}</p>
          </div>
        </>
      )}
    </div>
  );
}
