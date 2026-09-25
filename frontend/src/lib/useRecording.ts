import { useCallback, useEffect, useRef, useState } from "react";
import type { TKey } from "../i18n";
import { MeetingRecorder, RecorderError, extensionFor, type RecordSource, type SourceKind, type SourceState } from "./recorder";
import { deleteRecording, type RecordingMeta } from "./recordingStore";

export type RecordingPhase = "idle" | "starting" | "recording" | "paused" | "finishing";

export interface RecordedFile {
  file: File;
  recordingId: string;
  startedAt: number;
  source: RecordSource;
  durationMs: number;
}

export const RECORDER_ERRORS: Record<RecorderError["code"], TKey> = {
  insecure: "recorder.errInsecure",
  unsupported: "recorder.errUnsupported",
  "mic-denied": "recorder.errMicDenied",
  "mic-missing": "recorder.errMicMissing",
  "share-cancelled": "recorder.errShareCancelled",
  "no-tab-audio": "recorder.errNoTabAudio",
  failed: "recorder.errFailed",
};

export function fileForRecording(blob: Blob, meta: RecordingMeta): File {
  const d = new Date(meta.startedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
  return new File([blob], `recording ${stamp}.${extensionFor(meta.mimeType)}`, { type: blob.type, lastModified: meta.startedAt });
}

/**
 * Recording state shared by the recorder card and the page's bottom bar, so
 * pause / stop stay reachable wherever the page is scrolled.
 */
export function useRecording() {
  const rec = useRef<MeetingRecorder | null>(null);
  const [phase, setPhase] = useState<RecordingPhase>("idle");
  const [source, setSource] = useState<RecordSource>("meeting");
  const [elapsedMs, setElapsedMs] = useState(0);
  /** Recorded time durably written to browser storage. */
  const [savedMs, setSavedMs] = useState<number | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [sources, setSources] = useState<Partial<Record<SourceKind, SourceState>>>({});
  const [error, setError] = useState<TKey | null>(null);
  /** Error from trying to reconnect a source mid-recording. */
  const [reconnectError, setReconnectError] = useState<TKey | null>(null);

  const active = phase === "recording" || phase === "paused" || phase === "finishing" || phase === "starting";

  useEffect(() => {
    if (phase !== "recording" && phase !== "paused") return;
    const id = setInterval(() => setElapsedMs(rec.current?.elapsedMs() ?? 0), 250);
    return () => clearInterval(id);
  }, [phase]);

  // Stop capturing if the page goes away mid-recording; saved chunks remain restorable.
  useEffect(() => () => void rec.current?.stop().catch(() => undefined), []);

  const start = useCallback(async (src: RecordSource, micDeviceId?: string) => {
    setError(null);
    setReconnectError(null);
    setSaveFailed(false);
    setSavedMs(null);
    setSources({});
    setSource(src);
    setPhase("starting");
    try {
      rec.current = await MeetingRecorder.start({
        source: src,
        micDeviceId,
        onSaved: (m) => {
          setSavedMs(m.durationMs);
          setSaveFailed(false);
        },
        onSaveError: () => setSaveFailed(true),
        onSourceChange: (kind, state) => setSources((s) => ({ ...s, [kind]: state })),
      });
      setElapsedMs(0);
      setPhase("recording");
    } catch (e) {
      rec.current = null;
      setPhase("idle");
      setError(e instanceof RecorderError ? RECORDER_ERRORS[e.code] : "recorder.errFailed");
    }
  }, []);

  const pause = useCallback(() => {
    rec.current?.pause();
    setPhase("paused");
  }, []);

  const resume = useCallback(() => {
    rec.current?.resume();
    setPhase("recording");
  }, []);

  /** Stop and return the finished recording (always complete, from memory). */
  const finish = useCallback(async (): Promise<RecordedFile | null> => {
    const r = rec.current;
    if (!r) return null;
    setPhase("finishing");
    try {
      const { meta, blob } = await r.stop();
      rec.current = null;
      setPhase("idle");
      if (blob.size === 0) {
        setError("recorder.errEmpty");
        await deleteRecording(meta.id).catch(() => undefined);
        return null;
      }
      return { file: fileForRecording(blob, meta), recordingId: meta.id, startedAt: meta.startedAt, source: meta.source, durationMs: meta.durationMs };
    } catch {
      rec.current = null;
      setPhase("idle");
      setError("recorder.errFailed");
      return null;
    }
  }, []);

  const discard = useCallback(async () => {
    const r = rec.current;
    rec.current = null;
    setPhase("idle");
    if (r) {
      const { meta } = await r.stop();
      await deleteRecording(meta.id).catch(() => undefined);
    }
  }, []);

  const reconnect = useCallback(async (kind: SourceKind, micDeviceId?: string) => {
    const r = rec.current;
    if (!r) return;
    setReconnectError(null);
    try {
      if (kind === "meeting") await r.reconnectMeeting();
      else await r.reconnectMic(micDeviceId);
    } catch (e) {
      setReconnectError(e instanceof RecorderError ? RECORDER_ERRORS[e.code] : "recorder.errFailed");
    }
  }, []);

  /** Continue without a source that dropped out (e.g. only the microphone). */
  const dropSource = useCallback((kind: SourceKind) => {
    rec.current?.drop(kind);
    setSources((s) => {
      const next = { ...s };
      delete next[kind];
      return next;
    });
  }, []);

  const levels = useCallback(() => rec.current?.levels() ?? { mic: null, meeting: null }, []);

  return {
    phase,
    active,
    source,
    elapsedMs,
    savedMs,
    saveFailed,
    sources,
    error,
    reconnectError,
    setError,
    start,
    pause,
    resume,
    finish,
    discard,
    reconnect,
    dropSource,
    levels,
  };
}

export type RecordingController = ReturnType<typeof useRecording>;
