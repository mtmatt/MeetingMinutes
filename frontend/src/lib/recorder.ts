/**
 * In-browser meeting recorder.
 *
 * "meeting" mode records an online meeting running in another browser tab
 * (Google Meet, Teams, Zoom web, ...): the tab's audio carries everyone else,
 * but a meeting tab never plays your own voice back, so the microphone is
 * captured too and both are mixed into one track with Web Audio.
 * "mic" mode records only the microphone (an in-room meeting).
 */
import { appendChunk, saveMeta, type RecordingMeta } from "./recordingStore";

export type RecordSource = "mic" | "meeting";

export class RecorderError extends Error {
  constructor(
    readonly code: "insecure" | "unsupported" | "mic-denied" | "mic-missing" | "share-cancelled" | "no-tab-audio" | "failed",
    message: string,
  ) {
    super(message);
  }
}

export interface RecorderSupport {
  secure: boolean;
  mic: boolean;
  /** Tab audio capture: Chromium-based desktop browsers only. */
  meeting: boolean;
}

export function recorderSupport(): RecorderSupport {
  const secure = window.isSecureContext;
  const md = navigator.mediaDevices;
  const hasRecorder = typeof window.MediaRecorder !== "undefined";
  const mic = secure && !!md?.getUserMedia && hasRecorder;
  const ua = navigator.userAgent;
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[]; mobile?: boolean } }).userAgentData;
  // Tab audio capture is implemented by Chromium (Chrome, Edge, Brave, Arc...).
  const uaChromium = /Chrome\/|Chromium\/|Edg\//.test(ua) && !/Firefox\//.test(ua);
  const chromium = brands?.brands ? brands.brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand)) : uaChromium;
  const mobile = brands?.mobile ?? /Android|iPhone|iPad/.test(ua);
  const meeting = mic && !!md?.getDisplayMedia && chromium && !mobile && !/Firefox\//.test(ua);
  return { secure, mic, meeting };
}

function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? "";
}

export function extensionFor(mimeType: string): string {
  if (mimeType.startsWith("audio/mp4")) return "m4a";
  if (mimeType.startsWith("audio/ogg")) return "ogg";
  return "weba";
}

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput" && d.deviceId !== "communications");
}

function rms(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
  // Map RMS to a 0..1 meter with a rough dB curve (-60 dB .. 0 dB).
  const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9);
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

export interface StartOptions {
  source: RecordSource;
  micDeviceId?: string;
  onChunkSaved?: (meta: RecordingMeta) => void;
  /** The shared tab stopped (user clicked "Stop sharing" or closed the tab). */
  onSourceEnded?: () => void;
}

export class MeetingRecorder {
  meta!: RecordingMeta;
  private ctx!: AudioContext;
  private recorder!: MediaRecorder;
  private streams: MediaStream[] = [];
  private micAnalyser: AnalyserNode | null = null;
  private tabAnalyser: AnalyserNode | null = null;
  private buf = new Float32Array(1024);
  private segmentStart = 0;
  private accumulated = 0;
  private saving: Promise<void> = Promise.resolve();
  private stopped: Promise<void> | null = null;

  static async start(opts: StartOptions): Promise<MeetingRecorder> {
    const r = new MeetingRecorder();
    await r.init(opts);
    return r;
  }

  private async init(opts: StartOptions) {
    const support = recorderSupport();
    if (!support.secure) throw new RecorderError("insecure", "Recording needs HTTPS.");
    if (!support.mic) throw new RecorderError("unsupported", "This browser cannot record audio.");

    let tab: MediaStream | null = null;
    if (opts.source === "meeting") {
      if (!support.meeting) throw new RecorderError("unsupported", "This browser cannot capture tab audio.");
      try {
        // Chrome requires video for display capture; a 1 fps thumbnail-sized track is ignored.
        tab = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: "browser", frameRate: 1, width: 320 },
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false } as MediaTrackConstraints,
          preferCurrentTab: false,
          selfBrowserSurface: "exclude",
          surfaceSwitching: "include",
          systemAudio: "include",
          monitorTypeSurfaces: "exclude",
        } as DisplayMediaStreamOptions);
      } catch (e) {
        throw new RecorderError("share-cancelled", String(e));
      }
      if (tab.getAudioTracks().length === 0) {
        tab.getTracks().forEach((t) => t.stop());
        throw new RecorderError("no-tab-audio", "The shared tab has no audio.");
      }
      this.streams.push(tab);
    }

    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: opts.micDeviceId ? { exact: opts.micDeviceId } : undefined,
          // Cancels the meeting audio coming back out of the speakers into the mic.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      const name = (e as DOMException)?.name;
      throw new RecorderError(name === "NotFoundError" ? "mic-missing" : "mic-denied", String(e));
    }
    this.streams.push(mic);

    this.ctx = new AudioContext();
    const dest = this.ctx.createMediaStreamDestination();
    const connect = (stream: MediaStream, gain: number) => {
      const src = this.ctx.createMediaStreamSource(stream);
      const g = this.ctx.createGain();
      g.gain.value = gain;
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(g);
      g.connect(dest);
      src.connect(analyser);
      return analyser;
    };
    this.micAnalyser = connect(mic, 1);
    if (tab) {
      this.tabAnalyser = connect(new MediaStream(tab.getAudioTracks()), 1);
      const ended = () => opts.onSourceEnded?.();
      tab.getAudioTracks()[0]!.addEventListener("ended", ended);
      tab.getVideoTracks()[0]?.addEventListener("ended", ended);
    }

    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(dest.stream, { mimeType: mimeType || undefined, audioBitsPerSecond: 64_000 });
    this.meta = {
      id: crypto.randomUUID(),
      startedAt: Date.now(),
      mimeType: this.recorder.mimeType || mimeType || "audio/webm",
      source: opts.source,
      bytes: 0,
      durationMs: 0,
      finished: false,
    };
    await saveMeta(this.meta);
    this.recorder.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      this.meta = { ...this.meta, bytes: this.meta.bytes + e.data.size, durationMs: this.elapsedMs() };
      const meta = this.meta;
      // Serialise writes so chunks stay in order.
      this.saving = this.saving.then(() => appendChunk(meta, e.data)).then(() => opts.onChunkSaved?.(meta));
    };
    this.recorder.start(5000);
    this.segmentStart = performance.now();
  }

  elapsedMs(): number {
    const running = this.recorder?.state === "recording" ? performance.now() - this.segmentStart : 0;
    return this.accumulated + running;
  }

  get state(): RecordingState {
    return this.recorder.state;
  }

  levels(): { mic: number; meeting: number | null } {
    return {
      mic: this.micAnalyser ? rms(this.micAnalyser, this.buf) : 0,
      meeting: this.tabAnalyser ? rms(this.tabAnalyser, this.buf) : null,
    };
  }

  pause() {
    if (this.recorder.state !== "recording") return;
    this.accumulated += performance.now() - this.segmentStart;
    this.recorder.pause();
  }

  resume() {
    if (this.recorder.state !== "paused") return;
    this.segmentStart = performance.now();
    this.recorder.resume();
  }

  /** Stop, flush the final chunk to storage and release every device. */
  stop(): Promise<RecordingMeta> {
    this.stopped ??= new Promise<void>((resolve) => {
      if (this.recorder.state === "recording") this.accumulated += performance.now() - this.segmentStart;
      if (this.recorder.state === "inactive") return resolve();
      this.recorder.addEventListener("stop", () => resolve(), { once: true });
      this.recorder.stop();
    });
    return this.stopped.then(async () => {
      await this.saving;
      this.release();
      this.meta = { ...this.meta, durationMs: this.accumulated, finished: true };
      await saveMeta(this.meta);
      return this.meta;
    });
  }

  private release() {
    this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    this.streams = [];
    void this.ctx?.close().catch(() => undefined);
  }
}
