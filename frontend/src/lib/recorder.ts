/**
 * In-browser meeting recorder.
 *
 * "meeting" mode records an online meeting running in another browser tab
 * (Google Meet, Teams, Zoom web, ...): the tab's audio carries everyone else,
 * but a meeting tab never plays your own voice back, so the microphone is
 * captured too and both are mixed into one track with Web Audio.
 * "mic" mode records only the microphone (an in-room meeting).
 *
 * Only audio is recorded. Chrome requires a video track for tab sharing; it is
 * requested at 1 fps and never recorded or stored.
 *
 * Either source can drop out mid-recording (sharing stopped, headset
 * unplugged). The mix keeps running, so the recording continues with whatever
 * is still connected, and a source can be reconnected into the same recording.
 */
import { appendChunk, saveMeta, type RecordingMeta } from "./recordingStore";

export type RecordSource = "mic" | "meeting";
export type SourceKind = "meeting" | "mic";
export type SourceStatus = "live" | "muted" | "ended";

export interface SourceState {
  status: SourceStatus;
  /** Device name for microphones; empty when the browser does not expose one. */
  label: string;
}

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

async function captureTab(): Promise<MediaStream> {
  let tab: MediaStream;
  try {
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
    throw new RecorderError("no-tab-audio", "The shared surface has no audio.");
  }
  return tab;
}

async function captureMic(deviceId?: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        // Cancels the meeting audio coming back out of the speakers into the mic.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (e) {
    const name = (e as DOMException)?.name;
    throw new RecorderError(name === "NotFoundError" || name === "OverconstrainedError" ? "mic-missing" : "mic-denied", String(e));
  }
}

export interface RecorderCallbacks {
  /** A chunk was durably written; `meta.durationMs` is the recorded time now safe on disk. */
  onSaved?: (meta: RecordingMeta) => void;
  /** Writing to browser storage failed (quota, private mode...). Recording continues in memory. */
  onSaveError?: (error: unknown) => void;
  onSourceChange?: (kind: SourceKind, state: SourceState) => void;
}

interface Input {
  stream: MediaStream;
  gain: GainNode;
  analyser: AnalyserNode;
}

export class MeetingRecorder {
  meta!: RecordingMeta;
  source!: RecordSource;
  private ctx!: AudioContext;
  private dest!: MediaStreamAudioDestinationNode;
  private recorder!: MediaRecorder;
  private inputs: Partial<Record<SourceKind, Input>> = {};
  private buf = new Float32Array(1024);
  private segmentStart = 0;
  private accumulated = 0;
  private saving: Promise<void> = Promise.resolve();
  private stopped: Promise<void> | null = null;
  /** Every chunk also stays in memory, so stopping never depends on browser storage. */
  private chunks: Blob[] = [];
  private cb: RecorderCallbacks = {};

  static async start(opts: { source: RecordSource; micDeviceId?: string } & RecorderCallbacks): Promise<MeetingRecorder> {
    const r = new MeetingRecorder();
    await r.init(opts);
    return r;
  }

  private async init(opts: { source: RecordSource; micDeviceId?: string } & RecorderCallbacks) {
    const support = recorderSupport();
    if (!support.secure) throw new RecorderError("insecure", "Recording needs HTTPS.");
    if (!support.mic) throw new RecorderError("unsupported", "This browser cannot record audio.");
    if (opts.source === "meeting" && !support.meeting) throw new RecorderError("unsupported", "This browser cannot capture tab audio.");
    this.cb = opts;
    this.source = opts.source;

    const tab = opts.source === "meeting" ? await captureTab() : null;
    let mic: MediaStream;
    try {
      mic = await captureMic(opts.micDeviceId);
    } catch (e) {
      tab?.getTracks().forEach((t) => t.stop());
      throw e;
    }

    this.ctx = new AudioContext();
    this.dest = this.ctx.createMediaStreamDestination();
    // A silent constant source keeps the mix producing audio even if every input drops out.
    const keepAlive = this.ctx.createConstantSource();
    keepAlive.offset.value = 0;
    keepAlive.connect(this.dest);
    keepAlive.start();
    if (tab) this.attach("meeting", tab);
    this.attach("mic", mic);

    // Ask the browser not to evict our storage under pressure (best effort).
    void navigator.storage?.persist?.().catch(() => false);

    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(this.dest.stream, { mimeType: mimeType || undefined, audioBitsPerSecond: 64_000 });
    this.meta = {
      id: crypto.randomUUID(),
      startedAt: Date.now(),
      mimeType: this.recorder.mimeType || mimeType || "audio/webm",
      source: opts.source,
      bytes: 0,
      durationMs: 0,
      finished: false,
    };
    await saveMeta(this.meta).catch((e) => this.cb.onSaveError?.(e));
    this.recorder.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      this.chunks.push(e.data);
      this.meta = { ...this.meta, bytes: this.meta.bytes + e.data.size, durationMs: this.elapsedMs() };
      const meta = this.meta;
      // Serialise writes so chunks stay in order; a failed write is reported but
      // does not break the chain for later chunks.
      this.saving = this.saving
        .then(() => appendChunk(meta, e.data))
        .then(
          () => this.cb.onSaved?.(meta),
          (err) => this.cb.onSaveError?.(err),
        );
    };
    this.recorder.start(5000);
    this.segmentStart = performance.now();
  }

  /** Route a stream into the mix and watch it for dropouts. */
  private attach(kind: SourceKind, stream: MediaStream) {
    const old = this.inputs[kind];
    if (old) {
      old.gain.disconnect();
      old.stream.getTracks().forEach((t) => t.stop());
    }
    const audio = new MediaStream(stream.getAudioTracks());
    const src = this.ctx.createMediaStreamSource(audio);
    const gain = this.ctx.createGain();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(gain);
    gain.connect(this.dest);
    src.connect(analyser);
    this.inputs[kind] = { stream, gain, analyser };

    const track = stream.getAudioTracks()[0]!;
    const label = kind === "mic" ? track.label : "";
    const report = (status: SourceStatus) => {
      if (this.inputs[kind]?.stream === stream) this.cb.onSourceChange?.(kind, { status, label });
    };
    track.addEventListener("ended", () => report("ended"));
    track.addEventListener("mute", () => report("muted"));
    track.addEventListener("unmute", () => report("live"));
    // For tab sharing, "Stop sharing" ends the video track first.
    stream.getVideoTracks()[0]?.addEventListener("ended", () => report("ended"));
    report(track.readyState === "ended" ? "ended" : track.muted ? "muted" : "live");
  }

  /** Pick a (new) meeting tab and add it to the running recording. */
  async reconnectMeeting(): Promise<void> {
    const tab = await captureTab();
    this.attach("meeting", tab);
    this.source = "meeting";
  }

  async reconnectMic(deviceId?: string): Promise<void> {
    const mic = await captureMic(deviceId);
    this.attach("mic", mic);
  }

  /** Stop listening to a source that has dropped out, and continue without it. */
  drop(kind: SourceKind) {
    const input = this.inputs[kind];
    if (!input) return;
    input.gain.disconnect();
    input.stream.getTracks().forEach((t) => t.stop());
    delete this.inputs[kind];
  }

  hasSource(kind: SourceKind): boolean {
    return !!this.inputs[kind];
  }

  elapsedMs(): number {
    const running = this.recorder?.state === "recording" ? performance.now() - this.segmentStart : 0;
    return this.accumulated + running;
  }

  get state(): RecordingState {
    return this.recorder.state;
  }

  levels(): { mic: number | null; meeting: number | null } {
    return {
      mic: this.inputs.mic ? rms(this.inputs.mic.analyser, this.buf) : null,
      meeting: this.inputs.meeting ? rms(this.inputs.meeting.analyser, this.buf) : null,
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

  /** Stop, flush the final chunk and release every device. Returns the full recording. */
  async stop(): Promise<{ meta: RecordingMeta; blob: Blob }> {
    this.stopped ??= new Promise<void>((resolve) => {
      if (this.recorder.state === "recording") this.accumulated += performance.now() - this.segmentStart;
      if (this.recorder.state === "inactive") return resolve();
      this.recorder.addEventListener("stop", () => resolve(), { once: true });
      this.recorder.stop();
    });
    await this.stopped;
    await this.saving;
    this.release();
    this.meta = { ...this.meta, durationMs: this.accumulated, finished: true };
    await saveMeta(this.meta).catch((e) => this.cb.onSaveError?.(e));
    return { meta: this.meta, blob: new Blob(this.chunks, { type: this.meta.mimeType.split(";")[0] }) };
  }

  private release() {
    for (const kind of Object.keys(this.inputs) as SourceKind[]) this.drop(kind);
    void this.ctx?.close().catch(() => undefined);
  }
}
