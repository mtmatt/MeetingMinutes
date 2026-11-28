/**
 * Picking slides out of a video or a shared tab, in the browser.
 *
 * Each sampled frame is shrunk on the GPU (WebGL) to a small grey picture and
 * a colour channel; slideDetector.ts decides from those when a new slide is on
 * screen, and where on screen the slide is. A kept frame is held at a high
 * resolution until the end, then cut to the slide (when its border was found)
 * and saved as a compact JPEG. Only these pictures are uploaded; the video
 * itself never needs to leave the computer for this.
 */
import { ChangeDetector, SIG_H, SIG_N, SIG_W, type Region } from "./slideDetector";

export type { Region } from "./slideDetector";
export { MAX_SLIDES } from "./slideDetector";

/** Kept frames are held at this size until they are cut to the slide... */
const HOLD_EDGE = 1920;
const HOLD_QUALITY = 0.85;
/** ...and uploaded at most this size: slide text stays sharp, files stay small. */
const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.72;

export interface CapturedSlide {
  /** Unique id: an upload sent twice is stored once. */
  key: string;
  /** Which slide it is: stays the same when the slide's picture is updated (a new key, the same slot). */
  slot: string;
  /** Recording time it appeared at, in seconds. */
  at: number;
  blob: Blob;
  width: number;
  height: number;
}

type Source = HTMLVideoElement | VideoFrame | HTMLCanvasElement | ImageBitmap;

function sourceSize(src: Source): { w: number; h: number } {
  if (typeof VideoFrame !== "undefined" && src instanceof VideoFrame) return { w: src.displayWidth, h: src.displayHeight };
  if (src instanceof HTMLVideoElement) return { w: src.videoWidth, h: src.videoHeight };
  const c = src as HTMLCanvasElement | ImageBitmap;
  return { w: c.width, h: c.height };
}

// ------------------------------------------------------------ signatures

const VERTEX = `
attribute vec2 p;
varying vec2 uv;
void main() {
  uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// Each output point averages a 4×4 grid of bilinear samples across its share
// of the frame (about 4×4 source pixels for 1280×720), so shrinking does not
// alias: a thin line of text still moves the average.
const FRAGMENT = `
precision mediump float;
uniform sampler2D tex;
uniform vec2 cell;
varying vec2 uv;
void main() {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    for (int j = 0; j < 4; j++) {
      vec2 o = (vec2(float(i), float(j)) - 1.5) * 0.25 * cell;
      sum += texture2D(tex, uv + o).rgb;
    }
  }
  vec3 c = sum / 16.0;
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  // Brightness, and how blue (against yellow) it is: a navy slide on a black meeting differs there.
  gl_FragColor = vec4(y, clamp(0.5 + (c.b - y) * 0.564, 0.0, 1.0), 0.0, 1.0);
}`;

/** Shrinks frames to signatures with WebGL, or with a 2D canvas where WebGL is not available. */
class Signer {
  private canvas = document.createElement("canvas");
  private gl: WebGLRenderingContext | null = null;
  private tex: WebGLTexture | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private rgba = new Uint8Array(SIG_N * 4);
  readonly webgl: boolean;

  constructor() {
    this.canvas.width = SIG_W;
    this.canvas.height = SIG_H;
    this.webgl = this.initGl();
    if (!this.webgl) {
      this.ctx2d = this.canvas.getContext("2d", { willReadFrequently: true });
      if (this.ctx2d) this.ctx2d.imageSmoothingQuality = "high";
    }
  }

  private initGl(): boolean {
    const gl = this.canvas.getContext("webgl", { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: "low-power" });
    if (!gl) return false;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = shader(gl.VERTEX_SHADER, VERTEX);
    const fs = shader(gl.FRAGMENT_SHADER, FRAGMENT);
    if (!vs || !fs) return false;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    // Frames are rarely a power of two in size: WebGL 1 then needs clamping and no mipmaps.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(gl.getUniformLocation(prog, "tex"), 0);
    gl.uniform2f(gl.getUniformLocation(prog, "cell"), 1 / SIG_W, 1 / SIG_H);
    gl.viewport(0, 0, SIG_W, SIG_H);
    this.gl = gl;
    return true;
  }

  /** The frame as SIG_W × SIG_H grey levels, top row first. */
  /** The frame as SIG_W × SIG_H grey levels and blueness, top row first. */
  sign(src: Source): { grey: Uint8Array; chroma: Uint8Array } {
    const grey = new Uint8Array(SIG_N);
    const chroma = new Uint8Array(SIG_N);
    const gl = this.gl;
    if (gl) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.readPixels(0, 0, SIG_W, SIG_H, gl.RGBA, gl.UNSIGNED_BYTE, this.rgba);
      // readPixels starts at the bottom row.
      for (let y = 0; y < SIG_H; y++) {
        const from = (SIG_H - 1 - y) * SIG_W * 4;
        for (let x = 0; x < SIG_W; x++) {
          grey[y * SIG_W + x] = this.rgba[from + x * 4]!;
          chroma[y * SIG_W + x] = this.rgba[from + x * 4 + 1]!;
        }
      }
      return { grey, chroma };
    }
    const ctx = this.ctx2d!;
    ctx.drawImage(src as CanvasImageSource, 0, 0, SIG_W, SIG_H);
    const data = ctx.getImageData(0, 0, SIG_W, SIG_H).data;
    for (let i = 0; i < SIG_N; i++) {
      const y = data[i * 4]! * 0.299 + data[i * 4 + 1]! * 0.587 + data[i * 4 + 2]! * 0.114;
      grey[i] = Math.round(y);
      chroma[i] = Math.max(0, Math.min(255, Math.round(128 + (data[i * 4 + 2]! - y) * 0.564)));
    }
    return { grey, chroma };
  }

  dispose() {
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
    this.gl = null;
  }
}

// ---------------------------------------------------------------- capture

let keySeq = 0;
function newKey(): string {
  keySeq++;
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `s${Date.now().toString(36)}${rand[0]!.toString(36)}${rand[1]!.toString(36)}${keySeq}`;
}

/** `region` of a picture (all of it when null) as a JPEG, at most `edge` pixels on its longest side. */
async function encode(
  src: CanvasImageSource,
  w: number,
  h: number,
  region: Region | null,
  edge: number,
  quality: number,
): Promise<{ blob: Blob; width: number; height: number }> {
  const r = region ?? { x0: 0, y0: 0, x1: 1, y1: 1 };
  const sx = Math.round(r.x0 * w);
  const sy = Math.round(r.y0 * h);
  const sw = Math.max(1, Math.round((r.x1 - r.x0) * w));
  const sh = Math.max(1, Math.round((r.y1 - r.y0) * h));
  const scale = Math.min(1, edge / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error("The browser could not encode the picture.");
  return { blob, width, height };
}

/**
 * The pictures as they are uploaded: cut to the slide (`region`, when its
 * border was found) and made compact. A picture that cannot be read is kept
 * as it was.
 */
export async function finishSlides(slides: CapturedSlide[], region: Region | null): Promise<CapturedSlide[]> {
  const out: CapturedSlide[] = [];
  for (const s of slides) {
    try {
      const bitmap = await createImageBitmap(s.blob);
      const pic = await encode(bitmap, bitmap.width, bitmap.height, region, MAX_EDGE, JPEG_QUALITY);
      bitmap.close();
      // A new key: the held picture and the finished one are different files.
      out.push({ ...s, ...pic, key: newKey() });
    } catch {
      out.push(s);
    }
  }
  return out;
}

/**
 * Signatures plus decisions plus the kept pictures. `onChange` is told every
 * time the list changes (a new slide, or a slide's picture updated).
 */
export class SlideCollector {
  private signer = new Signer();
  private detector = new ChangeDetector();
  /** Kept pictures, by the detector's index. */
  private byIndex: CapturedSlide[] = [];
  /** Slides the person removed: an update of one does not bring it back. */
  private removed = new Set<string>();

  constructor(private onChange: (slides: CapturedSlide[]) => void = () => {}) {}

  get webgl() {
    return this.signer.webgl;
  }

  slides(): CapturedSlide[] {
    return this.byIndex.filter((s) => !this.removed.has(s.slot));
  }

  /** Leave out a slide (by its slot), now and when it is updated later. */
  remove(slot: string) {
    this.removed.add(slot);
    this.onChange(this.slides());
  }

  /** Where the slide is on screen, as far as can be told yet (null: not cut). */
  region(): Region | null {
    return this.detector.contentRegion();
  }

  /** The slides as they are uploaded: cut to the slide and made compact. */
  finish(): Promise<CapturedSlide[]> {
    return finishSlides(this.slides(), this.region());
  }

  /** Look at a frame shown at `at` seconds; keeps a picture of it when it is a new slide. */
  async frame(src: Source, at: number): Promise<CapturedSlide | null> {
    const { w, h } = sourceSize(src);
    if (!w || !h) return null;
    const { grey, chroma } = this.signer.sign(src);
    const decision = this.detector.feed(grey, at, chroma);
    if (!decision) return null;
    const pic = await encode(src as CanvasImageSource, w, h, null, HOLD_EDGE, HOLD_QUALITY);
    if (decision.kind === "new") {
      const key = newKey();
      const slide: CapturedSlide = { key, slot: key, at: decision.at, ...pic };
      this.byIndex.push(slide);
      this.onChange(this.slides());
      return slide;
    }
    const old = this.byIndex[decision.index];
    if (!old || this.removed.has(old.slot)) return null;
    // Same slide, same time; a new key, so a version already uploaded is not mistaken for this one.
    const slide: CapturedSlide = { ...old, ...pic, key: newKey() };
    this.byIndex[decision.index] = slide;
    this.onChange(this.slides());
    return slide;
  }

  dispose() {
    this.signer.dispose();
  }
}

// ----------------------------------------------------------- video files

export interface ScanProgress {
  /** 0..1 of the video looked at. */
  done: number;
  slides: CapturedSlide[];
}

/** Seconds between samples: every second for an hour, then less often for longer videos. */
export function sampleInterval(durationSec: number): number {
  if (durationSec <= 3600) return 1;
  if (durationSec <= 3 * 3600) return 2;
  return 3;
}

function waitFor(el: HTMLMediaElement, event: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(el.error ?? new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      el.removeEventListener(event, done);
      el.removeEventListener("error", fail);
      signal.removeEventListener("abort", fail);
    };
    el.addEventListener(event, done, { once: true });
    el.addEventListener("error", fail, { once: true });
    signal.addEventListener("abort", fail, { once: true });
  });
}

/**
 * Go through a video file and keep its slides. The video is stepped through
 * by seeking (works in a background tab too, and never plays sound); it never
 * leaves the computer. Throws when the browser cannot decode the video.
 */
export async function scanVideo(
  file: File,
  opts: { signal: AbortSignal; onProgress: (p: ScanProgress) => void },
): Promise<CapturedSlide[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  const collector = new SlideCollector();
  try {
    video.src = url;
    await waitFor(video, "loadeddata", opts.signal);
    if (!video.videoWidth) throw new Error("This file has no picture.");
    let duration = video.duration;
    // Recordings made in a browser (WebM) often carry no length: seeking far past the end makes the
    // browser work it out.
    if (!Number.isFinite(duration)) {
      video.currentTime = 1e9;
      await waitFor(video, "seeked", opts.signal);
      duration = Number.isFinite(video.duration) ? video.duration : video.currentTime;
      video.currentTime = 0;
      await waitFor(video, "seeked", opts.signal);
    }
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("The length of this video cannot be read.");
    const step = sampleInterval(duration);
    // A frame at 0 can be black before the first picture: start just after.
    for (let t = Math.min(0.5, duration / 2); t < duration; t += step) {
      if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");
      video.currentTime = t;
      await waitFor(video, "seeked", opts.signal);
      await collector.frame(video, video.currentTime);
      opts.onProgress({ done: Math.min(1, t / duration), slides: collector.slides() });
    }
    // Cut to the slide and made compact, now that where it is on screen is known.
    const finished = await collector.finish();
    opts.onProgress({ done: 1, slides: finished });
    return finished;
  } finally {
    collector.dispose();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

// ------------------------------------------------------- shared screens

/** Calls `fn` every `ms` milliseconds, from a worker where possible (not slowed down in a background tab). */
function backgroundClock(ms: number, fn: () => void): () => void {
  try {
    const worker = new Worker(new URL("./tick.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = fn;
    worker.postMessage({ start: ms });
    return () => worker.terminate();
  } catch {
    const id = window.setInterval(fn, ms);
    return () => clearInterval(id);
  }
}

/**
 * Watch a shared tab's video track during a recording. A shared tab sends a
 * frame only when its picture changes, so frames cannot be the clock: the
 * newest one is kept, and looked at twice a second whether or not another came
 * (a slide that holds still is how a new one is confirmed) . Frames are read
 * with MediaStreamTrackProcessor where the browser has it, else from a muted
 * video element showing the track. `timeAt` gives the recording time, or null
 * while paused.
 */
export class ScreenWatcher {
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private latest: VideoFrame | null = null;
  private video: HTMLVideoElement | null = null;
  private stopClock: (() => void) | null = null;
  private busy = false;
  private generation = 0;

  constructor(
    private collector: SlideCollector,
    private timeAt: () => number | null,
    private onSlide: (s: CapturedSlide) => void,
  ) {}

  watch(track: MediaStreamTrack) {
    this.release();
    const gen = ++this.generation;
    const Processor = (window as unknown as { MediaStreamTrackProcessor?: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } })
      .MediaStreamTrackProcessor;
    if (Processor) {
      const reader = new Processor({ track }).readable.getReader();
      this.reader = reader;
      void this.pump(reader, gen);
    } else {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = new MediaStream([track]);
      void video.play().catch(() => undefined);
      this.video = video;
    }
    this.stopClock = backgroundClock(500, () => void this.tick());
  }

  /** Keep only the newest frame. */
  private async pump(reader: ReadableStreamDefaultReader<VideoFrame>, gen: number) {
    while (gen === this.generation) {
      let r: ReadableStreamReadResult<VideoFrame>;
      try {
        r = await reader.read();
      } catch {
        return;
      }
      if (r.done) return;
      if (gen !== this.generation) {
        r.value.close();
        return;
      }
      this.latest?.close();
      this.latest = r.value;
    }
  }

  private async tick() {
    if (this.busy) return;
    const at = this.timeAt();
    if (at == null) return;
    // A copy: a newer frame may replace (and close) the newest one while this one is read.
    let copy: VideoFrame | null = null;
    try {
      copy = this.latest?.clone() ?? null;
    } catch {
      copy = null;
    }
    const src: Source | null = copy ?? (this.video && this.video.readyState >= 2 ? this.video : null);
    if (!src) return;
    this.busy = true;
    try {
      const slide = await this.collector.frame(src, at);
      if (slide) this.onSlide(slide);
    } catch {
      // One unreadable frame is not worth stopping for.
    } finally {
      copy?.close();
      this.busy = false;
    }
  }

  private release() {
    this.generation++;
    this.stopClock?.();
    this.stopClock = null;
    void this.reader?.cancel().catch(() => undefined);
    this.reader = null;
    this.latest?.close();
    this.latest = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
  }

  stop() {
    this.release();
  }
}

/** Whether this browser can pick slides at all (it needs a canvas that can encode JPEG). */
export function slidesSupported(): boolean {
  return typeof document !== "undefined" && typeof HTMLCanvasElement !== "undefined" && "toBlob" in HTMLCanvasElement.prototype;
}
