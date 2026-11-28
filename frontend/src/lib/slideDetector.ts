/**
 * When a new slide is on screen: the decisions behind slide capture, on small
 * grey pictures ("signatures") of the frames. No browser APIs here, so this is
 * tested on its own (slideDetector.test.ts); slides.ts makes the signatures
 * (WebGL) and the pictures.
 *
 * A slide is rarely the whole picture. In a Google Meet tab it sits among the
 * meeting's tiles, often inside the Google Slides editor with its toolbar,
 * thumbnails and notes. So nothing here measures "how much of the screen
 * changed". The picture is cut into blocks, and only the blocks that changed
 * are looked at:
 * - in those blocks, did the text and lines that were there disappear
 *   (another slide), or were things only added (a bullet appearing: the same
 *   slide, kept as it now looks)?
 * - text and lines are found as edges, so the background's colour, the
 *   slide's or the meeting's, does not matter;
 * - parts that keep moving (cameras, a speaking indicator, a blinking cursor)
 *   are learned and left out;
 * - a picture is kept once it holds still (transitions are waited out);
 * - going back to a slide kept before keeps no second copy.
 * Where the changes happen also tells where the slide is: contentRegion()
 * gives that area, so pictures can be cut down to the slide.
 */

export const SIG_W = 320;
export const SIG_H = 180;
export const SIG_N = SIG_W * SIG_H;

/** Block size, in signature points: a 32 × 18 grid. */
const BLOCK = 10;
const BW = SIG_W / BLOCK;
const BH = SIG_H / BLOCK;
const BLOCKS = BW * BH;

/** A grey level difference (0–255) that counts as a changed point, above compression noise. */
const PIXEL_DELTA = 26;
/** Brightness step across a point that makes it an edge (text, lines). */
const EDGE_STEP = 48;
/** Between two samples, more of the still screen than this changing means it has not settled yet. */
const SETTLED = 0.003;

/** A block changed: this share of its points changed brightness... */
const BLOCK_GREY = 0.12;
/** ...or this share of its edges appeared or disappeared (and at least BLOCK_EDGES of them). */
const BLOCK_EDGE_SHARE = 0.15;
const BLOCK_EDGES = 4;
/** A block whose brightness mostly changed had its background replaced: all it held counts as gone. */
const BLOCK_REPLACED = 0.6;

/** Fewer changed blocks than this is noise (a cursor, a clock). */
const MIN_BLOCKS = 2;
/** A new slide changes at least this many blocks... */
const NEW_MIN_BLOCKS = 4;
/** ...and, in them, this share of what was there is gone. Less: things were only added. */
const NEW_LOST = 0.2;
/** Coming back to a slide kept before: at most this many blocks differ. */
const SAME_MAX_BLOCKS = 2;

/**
 * Recent sample pairs remembered to tell parts that keep moving: a block that
 * changed in at least MOTION_COUNT of the last MOTION_WINDOW, and in one of
 * the last two, is moving (a camera changes every second; a slide changing,
 * a bullet appearing or a fade changes a block once or twice and then holds
 * still, and is looked at again once it has)...
 */
const MOTION_WINDOW = 3;
const MOTION_COUNT = 2;
/** ...and so are the blocks this close to it. */
const MOTION_SPREAD = 1;
/** A block with this many changed points changed (between two samples). */
const MOTION_POINTS = 3;
/** A change of more of the screen than this between two samples is a new picture, not motion. */
const SCENE_CHANGE = 0.25;
/** A block with less still than this is left out (mostly moving). */
const BLOCK_MIN_STILL = 0.3;

/** Pictures kept at most (the server takes 300). */
export const MAX_SLIDES = 200;

/** An area of the picture, as shares of its width and height (0..1). */
export interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** "new": a new slide, first seen at `at`; "update": the slide at `index` gained something. */
export type Decision = { kind: "new"; at: number } | { kind: "update"; index: number } | null;

interface Pic {
  grey: Uint8Array;
  edge: Uint8Array;
  /** Edges spread by one point: an edge that moved by a point (scaling, compression) is the same edge. */
  near: Uint8Array;
}

export interface Comparison {
  /** Blocks that changed. */
  blocks: number;
  /** In them, the share of the first picture's content that is gone. */
  lost: number;
  /** In them, edges the second picture has that the first did not. */
  gained: number;
  /** Which blocks changed (BW × BH). */
  marked: Uint8Array;
}

export function edgesOf(grey: Uint8Array): { edge: Uint8Array; near: Uint8Array } {
  const edge = new Uint8Array(SIG_N);
  for (let y = 1; y < SIG_H - 1; y++) {
    for (let x = 1; x < SIG_W - 1; x++) {
      const i = y * SIG_W + x;
      const g = Math.abs(grey[i + 1]! - grey[i - 1]!) + Math.abs(grey[i + SIG_W]! - grey[i - SIG_W]!);
      if (g > EDGE_STEP) edge[i] = 1;
    }
  }
  const near = new Uint8Array(SIG_N);
  for (let y = 0; y < SIG_H; y++) {
    for (let x = 0; x < SIG_W; x++) {
      if (!edge[y * SIG_W + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= SIG_H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < SIG_W) near[yy * SIG_W + xx] = 1;
        }
      }
    }
  }
  return { edge, near };
}

/** Standard deviation of the grey levels: near zero for a black or blank frame. */
function spread(grey: Uint8Array): number {
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < SIG_N; i++) {
    sum += grey[i]!;
    sq += grey[i]! * grey[i]!;
  }
  const mean = sum / SIG_N;
  return Math.sqrt(Math.max(0, sq / SIG_N - mean * mean));
}

/** The bounding box of the heaviest group of neighbouring blocks with a weight. */
function heaviestGroup(weight: Uint16Array): Region | null {
  const marked = weight;
  const seen = new Uint8Array(BLOCKS);
  let best: { n: number; bx0: number; by0: number; bx1: number; by1: number } | null = null;
  for (let start = 0; start < BLOCKS; start++) {
    if (!marked[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let n = 0;
    let bx0 = BW;
    let by0 = BH;
    let bx1 = -1;
    let by1 = -1;
    while (stack.length) {
      const b = stack.pop()!;
      n += weight[b]!;
      const bx = b % BW;
      const by = (b / BW) | 0;
      bx0 = Math.min(bx0, bx);
      by0 = Math.min(by0, by);
      bx1 = Math.max(bx1, bx);
      by1 = Math.max(by1, by);
      // Neighbours one block apart, diagonals included: a slide's text has gaps between lines.
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = bx + dx;
          const ny = by + dy;
          if (nx < 0 || ny < 0 || nx >= BW || ny >= BH) continue;
          const nb = ny * BW + nx;
          if (marked[nb] && !seen[nb]) {
            seen[nb] = 1;
            stack.push(nb);
          }
        }
      }
    }
    if (!best || n > best.n) best = { n, bx0, by0, bx1, by1 };
  }
  if (!best) return null;
  return { x0: best.bx0 / BW, y0: best.by0 / BH, x1: (best.bx1 + 1) / BW, y1: (best.by1 + 1) / BH };
}

const areaOf = (r: Region) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);

export class ChangeDetector {
  private kept: Pic[] = [];
  /** Which kept picture is on screen now (after going back to an earlier slide, not the last). */
  private current = -1;
  private prev: Uint8Array | null = null;
  private motion: Uint8Array[] = [];
  private moving = new Uint8Array(SIG_N);
  /** When the picture last moved: a slide that then holds still has been on screen since. */
  private movedAt: number | null = null;
  /** When something other than a black screen was first shown. */
  private shownAt: number | null = null;
  /** Samples in a row the picture has held still. */
  private stillFor = 0;
  /** How many changes between slides each block took part in. */
  private heat = new Uint16Array(BLOCKS);
  private changes = 0;
  /** The newest picture and its colour, for finding the slide's border. */
  private last: Pic | null = null;
  private lastChroma: Uint8Array | null = null;

  get count() {
    return this.kept.length;
  }

  /**
   * Learn which blocks keep moving. Motion is told by block, not by point: a
   * camera's changes move around within its tile from one second to the
   * next, so no single point changes every time, but its blocks do.
   */
  private learnMotion(grey: Uint8Array) {
    if (!this.prev) return;
    const perBlock = new Uint16Array(BLOCKS);
    let n = 0;
    for (let y = 0; y < SIG_H; y++) {
      for (let x = 0; x < SIG_W; x++) {
        const i = y * SIG_W + x;
        if (Math.abs(grey[i]! - this.prev[i]!) > PIXEL_DELTA) {
          perBlock[((y / BLOCK) | 0) * BW + ((x / BLOCK) | 0)]!++;
          n++;
        }
      }
    }
    // A slide change touches much of the screen once: that is not something that keeps moving.
    if (n > SIG_N * SCENE_CHANGE) return;
    const active = new Uint8Array(BLOCKS);
    for (let b = 0; b < BLOCKS; b++) active[b] = perBlock[b]! >= MOTION_POINTS ? 1 : 0;
    this.motion.push(active);
    if (this.motion.length > MOTION_WINDOW) this.motion.shift();
    const last = this.motion[this.motion.length - 1]!;
    const before = this.motion[this.motion.length - 2];
    const movingBlock = new Uint8Array(BLOCKS);
    for (let b = 0; b < BLOCKS; b++) {
      let count = 0;
      for (const m of this.motion) count += m[b]!;
      // Still moving: changed in one of the last two samples too (a fade changes twice, then holds still).
      if (count >= MOTION_COUNT && (last[b] || before?.[b])) movingBlock[b] = 1;
    }
    // With the blocks around them: a moving thing's edge reaches into its neighbours.
    this.moving.fill(0);
    for (let by = 0; by < BH; by++) {
      for (let bx = 0; bx < BW; bx++) {
        let m = 0;
        for (let dy = -MOTION_SPREAD; dy <= MOTION_SPREAD && !m; dy++) {
          for (let dx = -MOTION_SPREAD; dx <= MOTION_SPREAD && !m; dx++) {
            const nx = bx + dx;
            const ny = by + dy;
            if (nx >= 0 && ny >= 0 && nx < BW && ny < BH && movingBlock[ny * BW + nx]) m = 1;
          }
        }
        if (!m) continue;
        for (let y = by * BLOCK; y < (by + 1) * BLOCK; y++) this.moving.fill(1, y * SIG_W + bx * BLOCK, y * SIG_W + (bx + 1) * BLOCK);
      }
    }
  }

  /** Share of the still points that changed between two samples. */
  private stillChange(a: Uint8Array, b: Uint8Array): number {
    let changed = 0;
    let still = 0;
    for (let i = 0; i < SIG_N; i++) {
      if (this.moving[i]) continue;
      still++;
      if (Math.abs(a[i]! - b[i]!) > PIXEL_DELTA) changed++;
    }
    return still ? changed / still : 0;
  }

  /** How `b` differs from `a`, block by block, leaving out what keeps moving. */
  compare(a: Pic, b: Pic): Comparison {
    const marked = new Uint8Array(BLOCKS);
    let blocks = 0;
    let lost = 0;
    let had = 0;
    let gained = 0;
    for (let by = 0; by < BH; by++) {
      for (let bx = 0; bx < BW; bx++) {
        let still = 0;
        let grey = 0;
        let oldE = 0;
        let newE = 0;
        let gone = 0;
        let added = 0;
        for (let y = by * BLOCK; y < (by + 1) * BLOCK; y++) {
          for (let x = bx * BLOCK; x < (bx + 1) * BLOCK; x++) {
            const i = y * SIG_W + x;
            if (this.moving[i]) continue;
            still++;
            const diff = Math.abs(a.grey[i]! - b.grey[i]!) > PIXEL_DELTA;
            if (diff) grey++;
            // A point of text or line that no longer looks the same is gone (another slide's text on
            // the same line still differs letter by letter); one that appeared was added.
            if (a.edge[i]) {
              oldE++;
              if (diff) gone++;
            }
            if (b.edge[i]) {
              newE++;
              if (diff) added++;
            }
          }
        }
        if (still < BLOCK * BLOCK * BLOCK_MIN_STILL) continue;
        const edgeChange = gone + added;
        const changed = grey >= still * BLOCK_GREY || (edgeChange >= BLOCK_EDGES && edgeChange >= (oldE + newE) * BLOCK_EDGE_SHARE);
        if (!changed) continue;
        marked[by * BW + bx] = 1;
        blocks++;
        gained += added;
        if (grey >= still * BLOCK_REPLACED) {
          // The background changed under it (another slide's colour): what it held is gone.
          const weight = Math.max(oldE, still * 0.1);
          lost += weight;
          had += weight;
        } else {
          lost += gone;
          had += oldE;
        }
      }
    }
    return { blocks, lost: had ? lost / had : 0, gained, marked };
  }

  /**
   * Look at the next sampled frame (a SIG_W × SIG_H grey picture), shown at
   * `at` seconds. `chroma` (optional, same size): how blue or yellow each
   * point is, which tells a navy slide from a black meeting background that
   * are about as bright.
   */
  feed(grey: Uint8Array, at: number, chroma?: Uint8Array): Decision {
    this.lastChroma = chroma ?? null;
    // What keeps moving is learned first, so a camera's latest movement does not count as a change.
    const prev = this.prev;
    this.learnMotion(grey);
    const sincePrev = prev ? this.stillChange(grey, prev) : 0;
    this.prev = grey;
    if (spread(grey) < 4) return null;
    this.shownAt ??= at;
    // Held still for two samples in a row: one still sample can be chance (a camera that happened not
    // to move much before its tile was learned as moving).
    this.stillFor = sincePrev <= SETTLED ? this.stillFor + 1 : 0;
    const settled = this.stillFor >= 2;
    if (this.stillFor === 0) this.movedAt = at;
    const pic: Pic = { grey, ...edgesOf(grey) };
    this.last = pic;

    if (this.current < 0) {
      if (!settled) return null;
      this.kept.push(pic);
      this.current = 0;
      // The first slide has been on screen since the share began (the first seconds may go to telling
      // a moving camera apart).
      this.movedAt = null;
      return { kind: "new", at: this.shownAt };
    }
    const c = this.compare(this.kept[this.current]!, pic);
    if (c.blocks < MIN_BLOCKS) return null;
    if (!settled) return null;
    if (c.blocks >= NEW_MIN_BLOCKS && c.lost >= NEW_LOST) {
      this.changes++;
      for (let b = 0; b < BLOCKS; b++) this.heat[b]! += c.marked[b]!;
      // Back to a slide kept before: follow it, keep nothing new.
      for (let i = 0; i < this.kept.length; i++) {
        if (i === this.current) continue;
        if (this.compare(this.kept[i]!, pic).blocks <= SAME_MAX_BLOCKS) {
          this.current = i;
          this.movedAt = null;
          return null;
        }
      }
      const first = this.take(at);
      if (this.kept.length >= MAX_SLIDES) return null;
      this.kept.push(pic);
      this.current = this.kept.length - 1;
      return { kind: "new", at: first };
    }
    if (c.gained === 0) return null;
    // The same slide with things added: keep how it looks now instead.
    this.movedAt = null;
    this.kept[this.current] = pic;
    return { kind: "update", index: this.current };
  }

  private take(now: number): number {
    const at = this.movedAt ?? now;
    this.movedAt = null;
    return at;
  }

  /**
   * Where the slide is, from where it changed: the blocks that changed in a
   * good share of the slide changes (the slide changes every time; a
   * thumbnail's highlight or a layout change only now and then), their
   * heaviest group, widened to the slide's own border where one is found.
   * Null when that is not clear (no changes yet, or the slide fills most of
   * the picture anyway).
   */
  contentRegion(): Region | null {
    if (this.changes === 0) return null;
    const min = Math.max(1, Math.ceil(this.changes * 0.25));
    const weight = new Uint16Array(BLOCKS);
    for (let b = 0; b < BLOCKS; b++) if (this.heat[b]! >= min) weight[b] = this.heat[b]!;
    let r = heaviestGroup(weight);
    if (!r) return null;
    if (!this.last) return null;
    const snapped = snapToBorder(r, this.last.grey, this.lastChroma);
    // Cut only to a slide whose border was found all round: cutting part of a slide off is worse than
    // keeping some of the meeting around it.
    if (!snapped) return null;
    r = snapped;
    // A little room around it.
    const mx = 0.01;
    const my = 0.015;
    r = { x0: Math.max(0, r.x0 - mx), y0: Math.max(0, r.y0 - my), x1: Math.min(1, r.x1 + mx), y1: Math.min(1, r.y1 + my) };
    const a = areaOf(r);
    if (a > 0.85 || a < 0.04) return null;
    return r;
  }
}

/** Difference across a border: brightness, or colour when it is known. */
function across(grey: Uint8Array, chroma: Uint8Array | null, i: number, j: number): number {
  const g = Math.abs(grey[i]! - grey[j]!);
  return chroma ? Math.max(g, Math.abs(chroma[i]! - chroma[j]!)) : g;
}

/** Points two apart on either side of a border differ by at least this. */
const BORDER_STEP = 20;
/** Along this share of the border's length. */
const BORDER_ALONG = 0.85;

/**
 * Widen an area to the slide's border: a line along which the two sides
 * differ (the slide against the meeting or the editor, by brightness or by
 * colour), all along it, unlike a line of text, which has the same background
 * on both sides. Looked for up to 35% of the picture beyond the area (the text
 * may fill only part of the slide); the picture's own edge counts as a border.
 * Null when a side has none.
 */
export function snapToBorder(r: Region, grey: Uint8Array, chroma: Uint8Array | null = null): Region | null {
  const x0 = Math.floor(r.x0 * SIG_W);
  const x1 = Math.min(SIG_W - 1, Math.ceil(r.x1 * SIG_W) - 1);
  const y0 = Math.floor(r.y0 * SIG_H);
  const y1 = Math.min(SIG_H - 1, Math.ceil(r.y1 * SIG_H) - 1);
  const rowBorder = (y: number, left: number, right: number) => {
    if (y < 2 || y > SIG_H - 3) return false;
    let n = 0;
    for (let x = left; x <= right; x++) if (across(grey, chroma, (y - 2) * SIG_W + x, (y + 2) * SIG_W + x) >= BORDER_STEP) n++;
    return n >= (right - left + 1) * BORDER_ALONG;
  };
  const colBorder = (x: number, top: number, bottom: number) => {
    if (x < 2 || x > SIG_W - 3) return false;
    let n = 0;
    for (let y = top; y <= bottom; y++) if (across(grey, chroma, y * SIG_W + x - 2, y * SIG_W + x + 2) >= BORDER_STEP) n++;
    return n >= (bottom - top + 1) * BORDER_ALONG;
  };
  const reachY = Math.round(SIG_H * 0.35);
  const reachX = Math.round(SIG_W * 0.35);
  /** The first border from `from` outward, or the picture's edge if the search reaches it. */
  const find = (from: number, step: 1 | -1, reach: number, max: number, line: (v: number) => boolean): number | null => {
    for (let k = 0; k <= reach; k++) {
      const v = from + step * k;
      if (v < 0 || v > max) return step < 0 ? 0 : max;
      if (line(v)) return v;
    }
    return null;
  };
  const top = find(y0, -1, reachY, SIG_H - 1, (y) => rowBorder(y, x0, x1));
  const bottom = find(y1, 1, reachY, SIG_H - 1, (y) => rowBorder(y, x0, x1));
  if (top == null || bottom == null) return null;
  const left = find(x0, -1, reachX, SIG_W - 1, (x) => colBorder(x, top + 2, bottom - 2));
  const right = find(x1, 1, reachX, SIG_W - 1, (x) => colBorder(x, top + 2, bottom - 2));
  if (left == null || right == null) return null;
  return { x0: left / SIG_W, y0: top / SIG_H, x1: (right + 1) / SIG_W, y1: (bottom + 1) / SIG_H };
}
