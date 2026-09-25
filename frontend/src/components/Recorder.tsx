import { AlertTriangle, Headphones, Mic, MonitorSpeaker, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n, type TKey } from "../i18n";
import { clock, dateTime } from "../lib/format";
import { listMicrophones, recorderSupport, type RecordSource, type SourceKind, type SourceState } from "../lib/recorder";
import { deleteRecording, listRecordings, loadRecording, type RecordingMeta } from "../lib/recordingStore";
import { fileForRecording, type RecordedFile, type RecordingController } from "../lib/useRecording";
import { useConfirm } from "./Modal";

/** Live input level, drawn without re-rendering React on every frame. */
function Meter({ read, silentHint }: { read: () => number | null; silentHint?: string }) {
  const fillRef = useRef<HTMLSpanElement>(null);
  const [silentFor, setSilentFor] = useState(0);
  // The page re-renders every 250 ms (clock); keep the animation loop and its
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
    <>
      <span className="meter-track">
        <span className="meter-fill" ref={fillRef} />
      </span>
      {silentHint && silentFor >= 20 && <span className="meter-hint">{silentHint}</span>}
    </>
  );
}

const STATUS_KEY: Record<SourceState["status"], TKey> = {
  live: "recorder.connected",
  muted: "recorder.muted",
  ended: "recorder.disconnected",
};

/** One input: name, connection state, level, and what to do if it dropped out. */
function SourceRow({
  kind,
  state,
  rec,
  canDrop,
  paused,
}: {
  kind: SourceKind;
  state: SourceState | undefined;
  rec: RecordingController;
  canDrop: boolean;
  paused: boolean;
}) {
  const { t } = useI18n();
  const status = state?.status ?? "live";
  const icon = kind === "meeting" ? <MonitorSpeaker /> : <Mic />;
  const name = kind === "meeting" ? t("recorder.meterMeeting") : t("recorder.meterMic");
  const detail = kind === "meeting" ? t("recorder.meetingSourceLabel") : state?.label || t("recorder.micDefault");
  const read = kind === "meeting" ? () => rec.levels().meeting : () => rec.levels().mic;
  return (
    <div className={`source-row ${status}`}>
      <span className="source-row-name">
        {icon}
        {name}
      </span>
      <span className="source-row-status">
        <span className={`pill ${status === "live" ? "ok" : status === "muted" ? "warn" : "danger"}`}>
          <span className="dot" />
          {t(STATUS_KEY[status])}
        </span>
        <span className="source-row-detail">{detail}</span>
      </span>
      {status !== "ended" ? (
        <Meter read={read} silentHint={kind === "meeting" && !paused ? t("recorder.meetingSilent") : undefined} />
      ) : (
        <div className="source-row-ended">
          <p>{kind === "meeting" ? t("recorder.meetingEnded") : t("recorder.micEnded")}</p>
          <div className="source-row-actions">
            <button type="button" className="btn btn-sm btn-ink" onClick={() => void rec.reconnect(kind)}>
              {kind === "meeting" ? t("recorder.reselectTab") : t("recorder.reconnectMic")}
            </button>
            {canDrop && (
              <button type="button" className="btn btn-sm" onClick={() => rec.dropSource(kind)}>
                {kind === "meeting" ? t("recorder.continueMicOnly") : t("recorder.continueWithoutMic")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function Recorder({ rec, onRecorded }: { rec: RecordingController; onRecorded: (r: RecordedFile) => void }) {
  const { t, locale } = useI18n();
  const confirm = useConfirm();
  const support = useRef(recorderSupport()).current;
  const [source, setSource] = useState<RecordSource>(support.meeting ? "meeting" : "mic");
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState<string>("");
  const [pending, setPending] = useState<RecordingMeta[]>([]);

  const refreshMics = useCallback(async () => {
    setMics(await listMicrophones().catch(() => []));
  }, []);

  useEffect(() => {
    void refreshMics();
    void listRecordings()
      .then(setPending)
      .catch(() => setPending([]));
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshMics);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshMics);
  }, [refreshMics]);

  // Device names become available once microphone permission is granted.
  useEffect(() => {
    if (rec.phase === "recording") void refreshMics();
  }, [rec.phase, refreshMics]);

  const restore = async (m: RecordingMeta) => {
    const blob = await loadRecording(m.id);
    if (!blob) {
      await deleteRecording(m.id);
      setPending((p) => p.filter((x) => x.id !== m.id));
      return;
    }
    onRecorded({ file: fileForRecording(blob, m), recordingId: m.id, startedAt: m.startedAt, source: m.source, durationMs: m.durationMs });
  };

  const dropPending = async (m: RecordingMeta) => {
    if (!(await confirm({ title: t("recorder.discardTitle"), body: t("recorder.discardBody"), confirmLabel: t("recorder.discard"), danger: true }))) return;
    await deleteRecording(m.id);
    setPending((p) => p.filter((x) => x.id !== m.id));
  };

  const discard = async () => {
    if (!(await confirm({ title: t("recorder.discardTitle"), body: t("recorder.discardBody"), confirmLabel: t("recorder.discard"), danger: true }))) return;
    await rec.discard();
  };

  if (rec.phase === "recording" || rec.phase === "paused" || rec.phase === "finishing") {
    const paused = rec.phase === "paused";
    const kinds: SourceKind[] = rec.source === "meeting" || rec.sources.meeting ? ["meeting", "mic"] : ["mic"];
    const shown = kinds.filter((k) => rec.sources[k]);
    const allEnded = shown.length > 0 && shown.every((k) => rec.sources[k]?.status === "ended");
    let saveLine: ReactNode;
    if (rec.saveFailed) {
      saveLine = (
        <div className="callout warn" role="alert">
          <AlertTriangle />
          <div>{t("recorder.saveFailed")}</div>
        </div>
      );
    } else {
      saveLine = (
        <p className="rec-saved">
          {rec.savedMs != null ? t("recorder.savedUpTo", { t: clock(rec.savedMs / 1000, true) }) : t("recorder.savingLocally")}
        </p>
      );
    }
    return (
      <div className="recorder live" aria-live="polite">
        <div className="recorder-top">
          <span className={`rec-status ${paused ? "paused" : ""}`}>
            <span className="rec-dot" />
            {rec.phase === "finishing" ? t("recorder.finishing") : paused ? t("recorder.paused") : t("recorder.recording")}
          </span>
        </div>
        <div className="rec-clock">{clock(rec.elapsedMs / 1000, true)}</div>
        <div className="source-rows">
          {shown.map((k) => (
            <SourceRow key={k} kind={k} state={rec.sources[k]} rec={rec} paused={paused} canDrop={shown.length > 1} />
          ))}
        </div>
        {rec.reconnectError && (
          <div className="callout danger" role="alert">
            <AlertTriangle />
            <div>{t(rec.reconnectError)}</div>
          </div>
        )}
        {allEnded && (
          <div className="callout warn" role="alert">
            <AlertTriangle />
            <div>{t("recorder.allEnded")}</div>
          </div>
        )}
        {saveLine}
        <div className="rec-card-foot">
          <button type="button" className="btn btn-sm btn-ghost btn-danger" onClick={discard} disabled={rec.phase === "finishing"}>
            <Trash2 /> {t("recorder.discard")}
          </button>
          <span className="faint">{t("recorder.controlsBelow")}</span>
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
            <span className="faint">{t("recorder.recoverScope")}</span>
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
            <div className="rec-howto">
              <p className="rec-audio-only">{t("recorder.audioOnly")}</p>
              <ol className="rec-steps">
                <li>{t("recorder.step1")}</li>
                <li>{t("recorder.step2")}</li>
                <li>
                  <Headphones /> {t("recorder.step3")}
                </li>
              </ol>
            </div>
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

          {rec.error && (
            <div className="callout danger" role="alert">
              <AlertTriangle />
              <div>{t(rec.error)}</div>
            </div>
          )}

          <div className="rec-start">
            <button type="button" className="btn btn-primary btn-lg" onClick={() => void rec.start(source, micId || undefined)} disabled={rec.phase === "starting"}>
              {rec.phase === "starting" ? <span className="spinner" /> : <span className="rec-dot static" />}
              {rec.error ? t("recorder.tryAgain") : source === "meeting" ? t("recorder.startMeeting") : t("recorder.startMic")}
            </button>
            <p className="faint">{t("recorder.consent")}</p>
          </div>
        </>
      )}
    </div>
  );
}
