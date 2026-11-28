/**
 * Picking slides out of a video, in the browser.
 *
 * Each sampled frame is shrunk on the GPU (WebGL) to a small grey picture, a
 * "signature", and compared with the last picture kept. When enough of the
 * screen changes and the new picture holds still (a slide change, a new
 * window shared), the full frame is kept as a JPEG. Only these pictures are
 * uploaded; the video itself never needs to leave the computer for this.
 *
 * Things that are not slide changes are left out:
 * - parts of the screen that keep moving (a speaker's camera, a playing clip)
 *   are learned and ignored, so they neither hide a change nor count as one;
 * - a transition (fade, wipe) is waited out: a picture is kept once it holds still;
 * - small changes on the same slide (a bullet point appearing) replace the
 *   picture kept for it, so the slide is kept as it finally looked;
 * - going back to a slide shown before keeps no second copy;
 * - black or blank frames are passed over.
 */

/** Signature size: small enough to compare in microseconds, big enough to see a line of text change. */
const SIG_W = 160;
const SIG_H = 90;
const SIG_N = SIG_W * SIG_H;

/** A grey level difference (0–255) that counts as a changed point, above compression noise. */
const PIXEL_DELTA = 26;
/** Less of the screen than this changing is noise (a cursor, compression). */
const NOTHING = 0.002;
/**
 * A slide's content ("ink": whatever is not its background). When more of the
 * old ink than this changed, it is another slide; less, and only things were
 * added (a bullet appearing): the same slide, which is then kept as it looks now.
 */
const NEW_SLIDE_LOST_INK = 0.25;
/** A new slide also changes at least this much of the screen. */
const NEW_SLIDE_MIN = 0.008;
/** Coming back to a picture kept before: at most this share of the two pictures' ink differs. */
const DUPLICATE_INK = 0.08;
/** Recent sample pairs remembered to tell parts that keep moving. */
const MOTION_WINDOW = 8;
/** A point that changed in at least this many of them is treated as moving and ignored... */
const MOTION_COUNT = 2;
/** ...with the points this close to it (a moving thing's edges change in a different place each time). */
const MOTION_SPREAD = 2;
/** A change of more of the screen than this between two samples is a new picture, not motion. */
const SCENE_CHANGE = 0.25;
/** With less of the screen than this still, nothing can be told (a full-screen video). */
const MIN_STILL = 0.2;
/** Pictures kept at most (the server takes 300). */
export const MAX_SLIDES = 200;
/** Longest side of a kept picture. */
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
// of the frame (about 8×8 source pixels for 1280×720), so shrinking does not
// alias: a thin line of text still moves the average.
const FRAGMENT = `
precision mediump float;
uniform sampler2D tex;
uniform vec2 cell;
varying vec2 uv;
void main() {
  float sum = 0.0;
  for (int i = 0; i < 4; i++) {
    for (int j = 0; j < 4; j++) {
      vec2 o = (vec2(float(i), float(j)) - 1.5) * 0.25 * cell;
      vec3 c = texture2D(tex, uv + o).rgb;
      sum += dot(c, vec3(0.299, 0.587, 0.114));
    }
  }
  gl_FragColor = vec4(vec3(sum / 16.0), 1.0);
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
  sign(src: Source): Uint8Array {
    const out = new Uint8Array(SIG_N);
    const gl = this.gl;
    if (gl) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.readPixels(0, 0, SIG_W, SIG_H, gl.RGBA, gl.UNSIGNED_BYTE, this.rgba);
      // readPixels starts at the bottom row.
      for (let y = 0; y < SIG_H; y++) {
        const from = (SIG_H - 1 - y) * SIG_W * 4;
        for (let x = 0; x < SIG_W; x++) out[y * SIG_W + x] = this.rgba[from + x * 4]!;
      }
      return out;
    }
    const ctx = this.ctx2d!;
    ctx.drawImage(src as CanvasImageSource, 0, 0, SIG_W, SIG_H);
    const data = ctx.getImageData(0, 0, SIG_W, SIG_H).data;
    for (let i = 0; i < SIG_N; i++) out[i] = Math.round(data[i * 4]! * 0.299 + data[i * 4 + 1]! * 0.587 + data[i * 4 + 2]! * 0.114);
    return out;
  }

  dispose() {
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
    this.gl = null;
  }
}

/** Standard deviation of the grey levels: near zero for a black or blank frame. */
function spread(sig: Uint8Array): number {
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < SIG_N; i++) {
    sum += sig[i]!;
    sq += sig[i]! * sig[i]!;
  }
  const mean = sum / SIG_N;
  return Math.sqrt(Math.max(0, sq / SIG_N - mean * mean));
}

// ------------------------------------------------------------- decisions

/** "new": a new slide, first seen at `at` (before it held still); "update": the slide at `index` changed a little. */
export type Decision = { kind: "new"; at: number } | { kind: "update"; index: number } | null;

/**
 * Decides, frame by frame, when a new slide is on screen. Kept apart from the
 * GPU work so it can be reasoned about (and tested) with plain arrays.
 */
export class ChangeDetector {
  /** Signatures of the pictures kept, in order, with their ink. */
  private kept: { sig: Uint8Array; ink: Uint8Array }[] = [];
  /** Which kept picture is on screen now (after going back to an earlier slide, not the last). */
  private current = -1;
  private prev: Uint8Array | null = null;
  /** Points that changed between recent samples, for telling the parts that keep moving. */
  private motion: Uint8Array[] = [];
  private moving = new Uint8Array(SIG_N);
  /** When the picture last moved: a slide that then holds still has been on screen since. */
  private movedAt: number | null = null;

  private isMoving(i: number) {
    return this.moving[i] === 1;
  }

  /** Share of the still points that differ; NaN when too little of the screen is still. */
  private changed(a: Uint8Array, b: Uint8Array): number {
    let changed = 0;
    let still = 0;
    for (let i = 0; i < SIG_N; i++) {
      if (this.isMoving(i)) continue;
      still++;
      if (Math.abs(a[i]! - b[i]!) > PIXEL_DELTA) changed++;
    }
    return still < SIG_N * MIN_STILL ? Number.NaN : changed / still;
  }

  /** How two pictures differ, measured on their content rather than the whole screen. */
  private compare(a: { sig: Uint8Array; ink: Uint8Array }, b: { sig: Uint8Array; ink: Uint8Array }) {
    let changed = 0;
    let still = 0;
    let inkA = 0;
    let lostA = 0;
    let union = 0;
    let unionChanged = 0;
    for (let i = 0; i < SIG_N; i++) {
      if (this.isMoving(i)) continue;
      still++;
      const diff = Math.abs(a.sig[i]! - b.sig[i]!) > PIXEL_DELTA;
      if (diff) changed++;
      if (a.ink[i]) {
        inkA++;
        if (diff) lostA++;
      }
      if (a.ink[i] || b.ink[i]) {
        union++;
        if (diff) unionChanged++;
      }
    }
    if (still < SIG_N * MIN_STILL) return null;
    return {
      /** Share of the screen that changed. */
      changed: changed / still,
      /** Share of a's content that is gone or different in b. */
      lost: inkA ? lostA / inkA : changed > 0 ? 1 : 0,
      /** Share of either picture's content that differs. */
      differ: union ? unionChanged / union : 0,
    };
  }

  private learnMotion(sig: Uint8Array) {
    if (!this.prev) return;
    const changed = new Uint8Array(SIG_N);
    let n = 0;
    for (let i = 0; i < SIG_N; i++) {
      if (Math.abs(sig[i]! - this.prev[i]!) > PIXEL_DELTA) {
        changed[i] = 1;
        n++;
      }
    }
    // A slide change touches most of the screen once: that is not something that keeps moving.
    if (n > SIG_N * SCENE_CHANGE) return;
    this.motion.push(changed);
    if (this.motion.length > MOTION_WINDOW) this.motion.shift();
    const count = new Uint8Array(SIG_N);
    for (const m of this.motion) for (let i = 0; i < SIG_N; i++) count[i]! += m[i]!;
    // Moving points, spread to their neighbours (rows, then columns).
    const rows = new Uint8Array(SIG_N);
    for (let y = 0; y < SIG_H; y++) {
      for (let x = 0; x < SIG_W; x++) {
        if (count[y * SIG_W + x]! < MOTION_COUNT) continue;
        for (let dx = -MOTION_SPREAD; dx <= MOTION_SPREAD; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < SIG_W) rows[y * SIG_W + xx] = 1;
        }
      }
    }
    this.moving.fill(0);
    for (let y = 0; y < SIG_H; y++) {
      for (let x = 0; x < SIG_W; x++) {
        if (!rows[y * SIG_W + x]) continue;
        for (let dy = -MOTION_SPREAD; dy <= MOTION_SPREAD; dy++) {
          const yy = y + dy;
          if (yy >= 0 && yy < SIG_H) this.moving[yy * SIG_W + x] = 1;
        }
      }
    }
  }

  /** Look at the next sampled frame, shown at `at` seconds. */
  feed(sig: Uint8Array, at: number): Decision {
    // How much changed since the last sample, before this sample is learned as motion.
    const sincePrev = this.prev ? this.changed(sig, this.prev) : 0;
    this.learnMotion(sig);
    this.prev = sig;
    if (spread(sig) < 4) return null;
    // A transition is still running: wait until the picture holds still.
    // (Anything moving on purpose was learned above and does not count.)
    const settled = !(sincePrev > NOTHING * 2);
    if (!settled) this.movedAt = at;
    const pic = { sig, ink: inkOf(sig) };

    if (this.current < 0) {
      if (!settled) return null;
      this.kept.push(pic);
      this.current = 0;
      return { kind: "new", at: this.take(at) };
    }
    const c = this.compare(this.kept[this.current]!, pic);
    if (!c || c.changed < NOTHING) return null;
    const isNew = c.lost >= NEW_SLIDE_LOST_INK && c.changed >= NEW_SLIDE_MIN;
    if (isNew) {
      if (!settled) return null;
      // Back to a slide kept before: follow it, keep nothing new.
      for (let i = 0; i < this.kept.length; i++) {
        if (i === this.current) continue;
        const back = this.compare(this.kept[i]!, pic);
        if (back && back.differ <= DUPLICATE_INK) {
          this.current = i;
          return null;
        }
      }
      const first = this.take(at);
      if (this.kept.length >= MAX_SLIDES) return null;
      this.kept.push(pic);
      this.current = this.kept.length - 1;
      return { kind: "new", at: first };
    }
    if (!settled) return null;
    // The same slide with things added: keep how it looks now instead.
    this.movedAt = null;
    this.kept[this.current] = pic;
    return { kind: "update", index: this.current };
  }

  /** When the slide now holding still appeared: the last time the picture moved, else now. */
  private take(now: number): number {
    const at = this.movedAt ?? now;
    this.movedAt = null;
    return at;
  }
}

/** The background is the most common grey level; ink is everything clearly different from it. */
function inkOf(sig: Uint8Array): Uint8Array {
  const hist = new Uint32Array(32);
  for (let i = 0; i < SIG_N; i++) hist[sig[i]! >> 3]!++;
  let mode = 0;
  for (let b = 1; b < 32; b++) if (hist[b]! > hist[mode]!) mode = b;
  // The background's level: the mean of the most common bucket and its neighbours.
  let sum = 0;
  let n = 0;
  for (let i = 0; i < SIG_N; i++) {
    const b = sig[i]! >> 3;
    if (Math.abs(b - mode) <= 1) {
      sum += sig[i]!;
      n++;
    }
  }
  const bg = n ? sum / n : 0;
  const ink = new Uint8Array(SIG_N);
  for (let i = 0; i < SIG_N; i++) ink[i] = Math.abs(sig[i]! - bg) > PIXEL_DELTA ? 1 : 0;
  return ink;
}

// ---------------------------------------------------------------- capture

let keySeq = 0;
function newKey(): string {
  keySeq++;
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `s${Date.now().toString(36)}${rand[0]!.toString(36)}${rand[1]!.toString(36)}${keySeq}`;
}

/** The frame as a JPEG, at most MAX_EDGE pixels on its longest side. */
async function encode(src: Source): Promise<{ blob: Blob; width: number; height: number }> {
  const { w, h } = sourceSize(src);
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const width = Math.max(1, Math.round(w * scale));
  const height = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src as CanvasImageSource, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  if (!blob) throw new Error("The browser could not encode the picture.");
  return { blob, width, height };
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

  /** Look at a frame shown at `at` seconds; keeps a picture of it when it is a new slide. */
  async frame(src: Source, at: number): Promise<CapturedSlide | null> {
    const { w, h } = sourceSize(src);
    if (!w || !h) return null;
    const decision = this.detector.feed(this.signer.sign(src), at);
    if (!decision) return null;
    const pic = await encode(src);
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
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const step = sampleInterval(duration);
    // A frame at 0 can be black before the first picture: start just after.
    for (let t = Math.min(0.5, duration / 2); t < duration; t += step) {
      if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");
      video.currentTime = t;
      await waitFor(video, "seeked", opts.signal);
      await collector.frame(video, video.currentTime);
      opts.onProgress({ done: Math.min(1, t / duration), slides: collector.slides() });
    }
    opts.onProgress({ done: 1, slides: collector.slides() });
    return collector.slides();
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
 * newest one is kept, and looked at once a second whether or not another came
 * (a slide that holds still is how a new one is confirmed). Frames are read
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
    this.stopClock = backgroundClock(1000, () => void this.tick());
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
