import { describe, expect, test } from "bun:test";
import { ChangeDetector, SIG_H, SIG_N, SIG_W, type Decision, type Region } from "./slideDetector";

/**
 * Frames like a shared Google Meet tab, drawn at signature size: the
 * meeting's dark background, someone's camera, a clock, and the slide either
 * alone (presenting) or inside the Google Slides editor (toolbar, thumbnails,
 * notes). Text is drawn as rows of short strokes, which is what text looks
 * like at this size.
 */

type Img = Uint8Array;

let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function fill(img: Img, x: number, y: number, w: number, h: number, v: number) {
  for (let yy = Math.max(0, y); yy < Math.min(SIG_H, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(SIG_W, x + w); xx++) img[yy * SIG_W + xx] = v;
}

/** A line of text: words of the given lengths (in letters), letters two points wide with a gap. */
function text(img: Img, x: number, y: number, words: number[], v: number, size = 2) {
  let cx = x;
  for (const len of words) {
    for (let i = 0; i < len; i++) {
      fill(img, cx, y, size, size + 1, v);
      cx += size + 1;
    }
    cx += size + 2;
  }
}

interface SlideSpec {
  title: number[];
  lines: number[][];
  /** Slide background (default: dark blue, like the screenshot). */
  bg?: number;
}

interface FrameSpec {
  slide: SlideSpec;
  /** The slide inside the Google Slides editor (else presenting: the slide alone). */
  editor?: boolean;
  /** Which thumbnail is highlighted in the editor. */
  thumb?: number;
  /** Time, for the camera and the clock; no camera when absent. */
  cam?: number;
  clock?: number;
  /** A playing video inside the slide (changes every frame). */
  video?: number;
  /** Mouse pointer position. */
  pointer?: [number, number];
}

/** Where the slide is drawn, in each layout. */
export const SLIDE_EDITOR = { x: 70, y: 40, w: 180, h: 102 };
export const SLIDE_PRESENT = { x: 30, y: 14, w: 230, h: 130 };

function slideInto(img: Img, s: SlideSpec, box: { x: number; y: number; w: number; h: number }) {
  const bg = s.bg ?? 40;
  const ink = bg > 128 ? 20 : 235;
  fill(img, box.x, box.y, box.w, box.h, bg);
  const scale = box.w >= 200 ? 3 : 2;
  text(img, box.x + 8, box.y + 8, s.title, ink, scale + 1);
  s.lines.forEach((words, i) => text(img, box.x + 12, box.y + 26 + i * (scale * 4 + 2), words, ink, scale));
}

/** How blue each point is: the slide is navy, the meeting and the editor grey. */
function chromaOf(f: FrameSpec): Img {
  const c = new Uint8Array(SIG_N).fill(128);
  const box = f.editor ? SLIDE_EDITOR : SLIDE_PRESENT;
  if ((f.slide.bg ?? 40) < 128) fill(c, box.x, box.y, box.w, box.h, 190);
  return c;
}

function frame(f: FrameSpec): Img {
  const img = new Uint8Array(SIG_N).fill(22);
  if (f.editor) {
    // The editor: a white page with a toolbar, a column of thumbnails, the slide, notes below.
    fill(img, 6, 14, 262, 160, 246);
    text(img, 10, 17, [6, 4, 4, 6, 5, 6, 5, 4], 60, 1);
    text(img, 10, 23, [5, 3, 3, 8, 6, 6, 8], 90, 1);
    for (let k = 0; k < 6; k++) {
      const ty = 34 + k * 22;
      fill(img, 12, ty, 40, 20, k === f.thumb ? 120 : 200);
      fill(img, 14, ty + 2, 36, 16, 40);
      text(img, 16, ty + 4, [4, 3, 5], 200, 1);
    }
    slideInto(img, f.slide, SLIDE_EDITOR);
    text(img, 72, 156, [5, 2, 3, 7, 5], 110, 1);
  } else {
    slideInto(img, f.slide, SLIDE_PRESENT);
  }
  if (f.video != null) {
    const box = f.editor ? SLIDE_EDITOR : SLIDE_PRESENT;
    for (let y = box.y + box.h - 40; y < box.y + box.h - 6; y++) for (let x = box.x + box.w - 70; x < box.x + box.w - 6; x++) img[y * SIG_W + x] = (x * 7 + y * 13 + f.video * 40) % 255;
  }
  if (f.cam != null) {
    // Someone's camera: a moving face over a moving background.
    fill(img, 272, 120, 44, 50, 70);
    const cx = 290 + Math.round(5 * Math.sin(f.cam * 1.7));
    const cy = 140 + Math.round(3 * Math.cos(f.cam * 2.3));
    fill(img, cx, cy, 12, 14, 180);
    for (let y = 120; y < 170; y += 2) img[y * SIG_W + 272 + Math.floor(rand() * 44)] = 150;
  }
  if (f.clock != null) text(img, 6, 4, [1, 1 + (f.clock % 3), 2], 230, 1);
  if (f.pointer) fill(img, f.pointer[0], f.pointer[1], 2, 3, 255);
  // Compression noise.
  for (let i = 0; i < SIG_N; i++) img[i] = Math.max(0, Math.min(255, img[i]! + Math.round((rand() - 0.5) * 8)));
  return img;
}

/** Ten different slides of one template: a title and bullets of different words. */
const SLIDES: SlideSpec[] = Array.from({ length: 10 }, (_, k) => ({
  title: [3 + (k % 4), 4 + ((k * 3) % 5), 5 + (k % 3)],
  lines: Array.from({ length: 3 + (k % 3) }, (_, j) => [2 + ((k + j) % 5), 4 + ((k * j) % 6), 3 + ((j * 7 + k) % 5), 5]),
}));

interface Step {
  /** Seconds this lasts (one sample a second). */
  secs: number;
  f: (t: number) => FrameSpec;
}

function run(steps: Step[]) {
  const d = new ChangeDetector();
  const out: { at: number; d: NonNullable<Decision> }[] = [];
  let t = 0;
  for (const s of steps) {
    for (let i = 0; i < s.secs; i++, t++) {
      const spec = s.f(t);
      const r = d.feed(frame(spec), t, chromaOf(spec));
      if (r) out.push({ at: t, d: r });
    }
  }
  const news = out.filter((o) => o.d.kind === "new").map((o) => (o.d as { at: number }).at);
  const updates = out.filter((o) => o.d.kind === "update").length;
  return { news, updates, region: d.contentRegion() };
}

const iou = (a: Region, b: Region) => {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  const area = (r: Region) => (r.x1 - r.x0) * (r.y1 - r.y0);
  return inter / (area(a) + area(b) - inter);
};
const boxRegion = (b: { x: number; y: number; w: number; h: number }): Region => ({ x0: b.x / SIG_W, y0: b.y / SIG_H, x1: (b.x + b.w) / SIG_W, y1: (b.y + b.h) / SIG_H });

describe("slide changes in a Google Meet tab", () => {
  test("the Slides editor shared in Meet, with a camera: one picture per slide, at the right time", () => {
    seed = 1;
    const steps: Step[] = SLIDES.slice(0, 6).map((s, k) => ({ secs: 8, f: (t) => ({ slide: s, editor: true, thumb: k, cam: t, clock: Math.floor(t / 60) }) }));
    const r = run(steps);
    expect(r.news.length).toBe(6);
    // Each within two seconds of the change (0, 8, 16, ...).
    r.news.forEach((at, k) => expect(Math.abs(at - k * 8)).toBeLessThanOrEqual(2));
  });

  test("presenting (the slide alone), no camera, frames identical between changes", () => {
    seed = 2;
    const r = run(SLIDES.slice(0, 5).map((s) => ({ secs: 6, f: () => ({ slide: s }) })));
    expect(r.news.length).toBe(5);
  });

  test("a bullet appearing keeps the same slide (updated), not a new one", () => {
    seed = 3;
    const base = SLIDES[1]!;
    const r = run([
      { secs: 6, f: (t) => ({ slide: SLIDES[0]!, editor: true, thumb: 0, cam: t }) },
      { secs: 5, f: (t) => ({ slide: { ...base, lines: base.lines.slice(0, 1) }, editor: true, thumb: 1, cam: t }) },
      { secs: 5, f: (t) => ({ slide: { ...base, lines: base.lines.slice(0, 2) }, editor: true, thumb: 1, cam: t }) },
      { secs: 5, f: (t) => ({ slide: base, editor: true, thumb: 1, cam: t }) },
      { secs: 6, f: (t) => ({ slide: SLIDES[2]!, editor: true, thumb: 2, cam: t }) },
    ]);
    expect(r.news.length).toBe(3);
    expect(r.updates).toBeGreaterThanOrEqual(2);
  });

  test("going back to a slide shown before keeps no second copy", () => {
    seed = 4;
    const r = run([0, 1, 2, 0, 3].map((k) => ({ secs: 6, f: (t) => ({ slide: SLIDES[k]!, editor: true, thumb: k, cam: t }) })));
    expect(r.news.length).toBe(4);
  });

  test("a short slide after a busy one is still a new slide", () => {
    seed = 5;
    const thanks: SlideSpec = { title: [6], lines: [] };
    const r = run([
      { secs: 6, f: (t) => ({ slide: SLIDES[4]!, editor: true, thumb: 4, cam: t }) },
      { secs: 6, f: (t) => ({ slide: thanks, editor: true, thumb: 5, cam: t }) },
    ]);
    expect(r.news.length).toBe(2);
  });

  test("a slide of another colour is a new slide", () => {
    seed = 6;
    const r = run([
      { secs: 6, f: () => ({ slide: SLIDES[0]! }) },
      { secs: 6, f: () => ({ slide: { ...SLIDES[0]!, bg: 245 } }) },
    ]);
    expect(r.news.length).toBe(2);
  });

  test("a fade between slides is waited out", () => {
    seed = 7;
    const d = new ChangeDetector();
    const a = frame({ slide: SLIDES[0]! });
    const b = frame({ slide: SLIDES[1]! });
    const mid = a.map((v, i) => Math.round((v + b[i]!) / 2));
    const kinds = [a, a, a, mid, b, b, b, b].map((f, t) => d.feed(f, t)?.kind ?? null);
    expect(kinds.filter((k) => k === "new").length).toBe(2);
    // The fade itself is never kept.
    expect(kinds[3]).toBeNull();
  });

  test("a clock ticking, a pointer moving and a camera do not count as slides", () => {
    seed = 8;
    const r = run([{ secs: 40, f: (t) => ({ slide: SLIDES[0]!, editor: true, thumb: 0, cam: t, clock: t, pointer: [100 + ((t * 13) % 120), 60 + ((t * 7) % 60)] as [number, number] }) }]);
    expect(r.news.length).toBe(1);
  });

  test("a video playing inside a slide keeps at most one extra picture", () => {
    seed = 9;
    const r = run([
      { secs: 6, f: () => ({ slide: SLIDES[0]! }) },
      { secs: 20, f: (t) => ({ slide: SLIDES[1]!, video: t }) },
      { secs: 6, f: () => ({ slide: SLIDES[2]! }) },
    ]);
    expect(r.news.length).toBeGreaterThanOrEqual(3);
    expect(r.news.length).toBeLessThanOrEqual(4);
  });

  test("black frames (a screen share starting) are skipped", () => {
    seed = 10;
    const d = new ChangeDetector();
    expect(d.feed(new Uint8Array(SIG_N), 0)).toBeNull();
    expect(d.feed(new Uint8Array(SIG_N), 1)).toBeNull();
    // The first slide is kept once it has held still for two samples, dated from when it appeared.
    expect(d.feed(frame({ slide: SLIDES[0]! }), 2)).toBeNull();
    expect(d.feed(frame({ slide: SLIDES[0]! }), 3)).toBeNull();
    expect(d.feed(frame({ slide: SLIDES[0]! }), 4)).toEqual({ kind: "new", at: 2 });
  });

  test("where the slide is: found from where it changed, in the editor and presenting", () => {
    seed = 11;
    const inEditor = run(SLIDES.slice(0, 6).map((s, k) => ({ secs: 6, f: (t) => ({ slide: s, editor: true, thumb: k, cam: t }) }))).region;
    expect(inEditor).not.toBeNull();
    expect(iou(inEditor!, boxRegion(SLIDE_EDITOR))).toBeGreaterThan(0.75);
    const presenting = run(SLIDES.slice(0, 6).map((s) => ({ secs: 6, f: () => ({ slide: s }) }))).region;
    // A navy slide on the meeting's near-black: found by its colour.
    expect(presenting).not.toBeNull();
    expect(iou(presenting!, boxRegion(SLIDE_PRESENT))).toBeGreaterThan(0.75);
  });

  test("no slide changes yet: no area to cut to", () => {
    seed = 12;
    expect(run([{ secs: 10, f: (t) => ({ slide: SLIDES[0]!, editor: true, thumb: 0, cam: t }) }]).region).toBeNull();
  });
});

describe("cutting to the slide", () => {
  test("without colour, a navy slide on the near-black meeting has no clear border: no cut", () => {
    seed = 13;
    const d = new ChangeDetector();
    let t = 0;
    for (const s of SLIDES.slice(0, 5)) for (let i = 0; i < 6; i++, t++) d.feed(frame({ slide: s }), t);
    expect(d.contentRegion()).toBeNull();
  });
});
