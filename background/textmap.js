// @ts-check

/** @typedef {import('./analysis.js').Pixels} Pixels */
/** @typedef {import('./analysis.js').Box} Box */

/**
 * @typedef {Object} TextBlock
 * @property {Box} box
 * @property {number} glyph
 * @property {boolean} dark
 * @property {boolean} vertical
 * @property {number} cells
 * @property {number} ink
 * @property {number} paper
 * @property {Mask} mask
 * @property {boolean} [colour]
 */
/** @typedef {{x0: number, y0: number, w: number, h: number, s: number, bits: Uint8Array}} Mask */
/**
 * @typedef {Object} TextChar
 * @property {Box} box
 * @property {number} size
 * @property {boolean} dark
 * @property {boolean} mark
 * @property {boolean} inBlock
 * @property {number} ink
 * @property {number} paper
 * @property {number} clear
 * @property {number} n
 * @property {Mask} mask
 * @property {TextChar} [of]
 */
/**
 * @typedef {{W: number, H: number, s: number, blocks: TextBlock[], chars: TextChar[], ms: number, partial: boolean}} TextMap
 */

const MAX_PIXELS = 1_700_000;
const REF_PAGE = 830;
/**
 * @param {number} W
 * @param {number} H
 */
const pageSize = (W, H) => Math.min(W, 0.68 * H);
const MAX_PIECES = 60_000;
const GRID = 32;
const TEXTURE_ALIKE = 10;
const MAX_CHARS = 4000;
const DELTA = 22;
const OUTLINE_STEP = 100;
const OUTLINE_REACH = 7;
const OUTLINE_CHROMA = 60;
const PAPER_CONTRAST = 70;

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

let LUM = new Uint8Array(0);
let INK_D = new Uint8Array(0);
let INK_L = new Uint8Array(0);
let INK = INK_D;
let LABEL = new Int32Array(0);
let SUM = new Uint32Array(0);
let RS = new Int32Array(0);
let RE = new Int32Array(0);
let RY = new Int32Array(0);
let RP = new Int32Array(0);
let ROW = new Int32Array(0);

/** @param {number} n @param {number} w @param {number} h */
function ensure(n, w, h) {
  if (LUM.length < n) {
    LUM = new Uint8Array(n);
    INK_D = new Uint8Array(n);
    INK_L = new Uint8Array(n);
    LABEL = new Int32Array(n);
  }
  const m = (w + 1) * (h + 1);
  if (SUM.length < m) SUM = new Uint32Array(m);
  if (ROW.length < h + 1) ROW = new Int32Array(h + 1);
}

/** @param {number} n */
function ensureRuns(n) {
  if (RS.length >= n) return;
  const grow = (/** @type {Int32Array} */ a) => { const b = new Int32Array(n); b.set(a); return b; };
  RS = grow(RS); RE = grow(RE); RY = grow(RY); RP = new Int32Array(n);
}

export function releaseScratch() {
  LUM = new Uint8Array(0);
  INK_D = new Uint8Array(0);
  INK_L = new Uint8Array(0);
  INK = INK_D;
  LABEL = new Int32Array(0);
  SUM = new Uint32Array(0);
  RS = new Int32Array(0); RE = new Int32Array(0); RY = new Int32Array(0); RP = new Int32Array(0);
  ROW = new Int32Array(0);
}

/**
 * @typedef {Object} Piece
 * @property {number} id
 * @property {number} x0
 * @property {number} y0
 * @property {number} x1
 * @property {number} y1
 * @property {number} n
 * @property {number} big
 * @property {number} sw
 * @property {number} flat
 * @property {number} lum
 * @property {number} paper
 * @property {number} cell
 * @property {boolean} huge
 */
/**
 * @typedef {Object} Cell
 * @property {number} x0
 * @property {number} y0
 * @property {number} x1
 * @property {number} y1
 * @property {number} size
 * @property {number} n
 * @property {number} lum
 * @property {number} paper
 * @property {boolean} solid
 * @property {number} sw
 * @property {number[]} pieces
 */

/**
 * @param {Pixels} px
 * @param {{deadline?: number, debug?: (stage: string, polarity: boolean, data: unknown) => void}} [opts]
 * @returns {TextMap}
 */
export function buildTextMap(px, opts = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { W, H } = px;
  const fit = pageSize(W, H) / REF_PAGE;
  const s = Math.max(1, Math.sqrt((W * H) / MAX_PIXELS), fit < 1.08 ? 1 : fit);
  const w = Math.max(1, Math.floor(W / s));
  const h = Math.max(1, Math.floor(H / s));
  const u = Math.min(1, pageSize(W, H) / s / REF_PAGE);
  const n = w * h;
  ensure(n, w, h);
  sampleLuminance(px, s, w, h);
  integrate(w, h);
  const r = clamp(Math.round(Math.min(w, h) / 36), 8, 48);
  markInk(w, h, r);
  markOutlined(px, s, w, h, Math.max(3, Math.round(OUTLINE_REACH * u)));
  /** @type {TextBlock[]} */
  const blocks = [];
  /** @type {TextChar[]} */
  const chars = [];
  deadline = opts.deadline ?? Infinity;
  cut = false;
  for (const dark of [true, false]) {
    if (late()) break;
    INK = dark ? INK_D : INK_L;
    const pieces = label(w, h);
    if (!pieces) continue;
    const r = assemble(pieces, w, h, s, u, dark, W, H, opts.debug);
    blocks.push(...r.blocks);
    chars.push(...r.chars);
  }
  dedupe(blocks);
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return { W, H, s, blocks, chars, ms, partial: cut };
}

let deadline = Infinity;
let cut = false;
function late() {
  if (cut) return true;
  if (deadline !== Infinity && now() > deadline) cut = true;
  return cut;
}

/** @template {{id: number, x0: number, y0: number, x1: number, y1: number}} T */
class Grid {
  /** @param {T[]} items @param {number} w @param {number} h @param {number} cell */
  constructor(items, w, h, cell) {
    this.cell = cell;
    this.gw = Math.ceil(w / cell);
    this.gh = Math.ceil(h / cell);
    /** @type {Map<number, T[]>} */
    this.cells = new Map();
    let top = 0;
    for (const p of items) {
      if (p.id > top) top = p.id;
      for (let cy = Math.floor(p.y0 / cell); cy <= Math.floor(p.y1 / cell); cy++) {
        for (let cx = Math.floor(p.x0 / cell); cx <= Math.floor(p.x1 / cell); cx++) {
          const k = cy * this.gw + cx;
          const list = this.cells.get(k);
          if (list) list.push(p); else this.cells.set(k, [p]);
        }
      }
    }
    this.stamp = new Uint32Array(top + 1);
    this.q = 0;
  }

  /**
   * @param {number} x0
   * @param {number} y0
   * @param {number} x1
   * @param {number} y1
   * @param {(p: T) => void} fn
   */
  near(x0, y0, x1, y1, fn) {
    const q = ++this.q;
    const cx0 = Math.max(0, Math.floor(x0 / this.cell)); const cx1 = Math.min(this.gw - 1, Math.floor(x1 / this.cell));
    const cy0 = Math.max(0, Math.floor(y0 / this.cell)); const cy1 = Math.min(this.gh - 1, Math.floor(y1 / this.cell));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const list = this.cells.get(cy * this.gw + cx);
        if (!list) continue;
        for (const p of list) {
          if (this.stamp[p.id] === q) continue;
          this.stamp[p.id] = q;
          fn(p);
        }
      }
    }
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * @param {Pixels} px
 * @param {number} s
 * @param {number} w
 * @param {number} h
 */
function sampleLuminance(px, s, w, h) {
  const { data, W, H } = px;
  /** @param {number} x @param {number} y */
  const lum = (x, y) => { const i = (y * W + x) * 4; return (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8; };
  if (s === 1) {
    for (let i = 0, k = 0; k < w * h; k++, i += 4) LUM[k] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    return;
  }
  if (s < 1) {
    for (let y = 0; y < h; y++) {
      const fy = Math.max(0, (y + 0.5) * s - 0.5);
      const y0 = Math.min(H - 1, Math.floor(fy)); const y1 = Math.min(H - 1, y0 + 1); const ay = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.max(0, (x + 0.5) * s - 0.5);
        const x0 = Math.min(W - 1, Math.floor(fx)); const x1 = Math.min(W - 1, x0 + 1); const ax = fx - x0;
        const top = lum(x0, y0) * (1 - ax) + lum(x1, y0) * ax;
        const bot = lum(x0, y1) * (1 - ax) + lum(x1, y1) * ax;
        LUM[y * w + x] = Math.round(top * (1 - ay) + bot * ay);
      }
    }
    return;
  }
  for (let y = 0; y < h; y++) {
    const fy0 = y * s; const fy1 = Math.min(H, (y + 1) * s);
    const ya = Math.floor(fy0); const yb = Math.min(H - 1, Math.ceil(fy1) - 1);
    for (let x = 0; x < w; x++) {
      const fx0 = x * s; const fx1 = Math.min(W, (x + 1) * s);
      const xa = Math.floor(fx0); const xb = Math.min(W - 1, Math.ceil(fx1) - 1);
      let sum = 0; let wsum = 0;
      for (let yy = ya; yy <= yb; yy++) {
        const wy = Math.min(yy + 1, fy1) - Math.max(yy, fy0);
        if (wy <= 0) continue;
        for (let xx = xa; xx <= xb; xx++) {
          const wx = Math.min(xx + 1, fx1) - Math.max(xx, fx0);
          if (wx <= 0) continue;
          sum += wx * wy * lum(xx, yy);
          wsum += wx * wy;
        }
      }
      LUM[y * w + x] = wsum > 0 ? Math.round(sum / wsum) : 255;
    }
  }
}

/** @param {number} w @param {number} h */
function integrate(w, h) {
  const W1 = w + 1;
  for (let x = 0; x <= w; x++) SUM[x] = 0;
  for (let y = 1; y <= h; y++) {
    let row = 0;
    SUM[y * W1] = 0;
    const src = (y - 1) * w;
    for (let x = 1; x <= w; x++) {
      row += LUM[src + x - 1];
      SUM[y * W1 + x] = SUM[(y - 1) * W1 + x] + row;
    }
  }
}

/**
 * @param {number} w
 * @param {number} h
 * @param {number} r
 */
function markInk(w, h, r) {
  const W1 = w + 1;
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - r); const yb = Math.min(h, y + r + 1);
    const top = ya * W1; const bot = yb * W1;
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - r); const xb = Math.min(w, x + r + 1);
      const sum = SUM[bot + xb] - SUM[top + xb] - SUM[bot + xa] + SUM[top + xa];
      const mean = sum / ((yb - ya) * (xb - xa));
      const k = y * w + x;
      const v = LUM[k];
      INK_D[k] = v <= mean - DELTA && v <= 175 ? 1 : 0;
      INK_L[k] = v >= mean + DELTA && v >= 80 ? 1 : 0;
    }
  }
}

/**
 * @param {Pixels} px
 * @param {number} s
 * @param {number} w
 * @param {number} h
 * @param {number} rho
 */
function markOutlined(px, s, w, h, rho) {
  const { data, W, H } = px;
  /** @param {number} x @param {number} y */
  const chroma = (x, y) => {
    const i = (Math.min(H - 1, Math.floor((y + 0.5) * s)) * W + Math.min(W - 1, Math.floor((x + 0.5) * s))) * 4;
    return Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
  };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const k = row + x;
      if (INK_D[k] || INK_L[k]) continue;
      const v = LUM[k];
      if (v <= 175) {
        const t = v + OUTLINE_STEP;
        if (((brighter(k, -1, x, rho, t) && brighter(k, 1, w - 1 - x, rho, t))
          || (brighter(k, -w, y, rho, t) && brighter(k, w, h - 1 - y, rho, t))) && chroma(x, y) >= OUTLINE_CHROMA) { INK_D[k] = 1; continue; }
      }
      if (v >= 80) {
        const t = v - OUTLINE_STEP;
        if (((darker(k, -1, x, rho, t) && darker(k, 1, w - 1 - x, rho, t))
          || (darker(k, -w, y, rho, t) && darker(k, w, h - 1 - y, rho, t))) && chroma(x, y) >= OUTLINE_CHROMA) INK_L[k] = 1;
      }
    }
  }
}

/**
 * @param {number} k
 * @param {number} d
 * @param {number} room
 * @param {number} rho
 * @param {number} t
 */
function brighter(k, d, room, rho, t) {
  for (let i = 1, q = k + d; i <= Math.min(rho, room); i++, q += d) if (LUM[q] >= t) return true;
  return false;
}

/** @param {number} k @param {number} d @param {number} room @param {number} rho @param {number} t */
function darker(k, d, room, rho, t) {
  for (let i = 1, q = k + d; i <= Math.min(rho, room); i++, q += d) if (LUM[q] <= t) return true;
  return false;
}

/**
 * @param {number} w
 * @param {number} h
 * @returns {Piece[] | null}
 */
function label(w, h) {
  let nr = 0;
  for (let y = 0; y < h; y++) {
    ROW[y] = nr;
    const row = y * w;
    let x = 0;
    while (x < w) {
      if (!INK[row + x]) { x++; continue; }
      const xs = x;
      while (x < w && INK[row + x]) x++;
      if (nr >= RS.length) ensureRuns(Math.max(1024, RS.length * 2));
      RS[nr] = xs; RE[nr] = x - 1; RY[nr] = y; nr++;
    }
  }
  ROW[h] = nr;
  if (RP.length < nr) ensureRuns(nr);
  for (let i = 0; i < nr; i++) RP[i] = i;
  /** @param {number} i */
  const find = (i) => { while (RP[i] !== i) { RP[i] = RP[RP[i]]; i = RP[i]; } return i; };
  for (let y = 1; y < h; y++) {
    let j = ROW[y - 1];
    const jEnd = ROW[y];
    for (let i = ROW[y]; i < ROW[y + 1]; i++) {
      while (j < jEnd && RE[j] < RS[i] - 1) j++;
      for (let k = j; k < jEnd && RS[k] <= RE[i] + 1; k++) {
        const a = find(i); const b = find(k);
        if (a !== b) { if (a < b) RP[b] = a; else RP[a] = b; }
      }
    }
  }
  /** @type {Map<number, number>} */
  const index = new Map();
  /** @type {number[]} */
  const st = [];
  const n = w * h;
  LABEL.fill(0, 0, n);
  for (let i = 0; i < nr; i++) {
    const root = find(i);
    let p = index.get(root);
    if (p === undefined) {
      p = st.length / 12;
      if (p >= MAX_PIECES) return null;
      index.set(root, p);
      st.push(w, h, -1, -1, 0, 0, 0, 0, 0, 0, 0, 0);
    }
    const o = p * 12;
    const y = RY[i]; const xs = RS[i]; const xe = RE[i];
    const len = xe - xs + 1;
    if (xs < st[o]) st[o] = xs;
    if (y < st[o + 1]) st[o + 1] = y;
    if (xe > st[o + 2]) st[o + 2] = xe;
    if (y > st[o + 3]) st[o + 3] = y;
    const sx = (len * (xs + xe)) / 2;
    st[o + 4] += len;
    st[o + 5] += sx;
    st[o + 6] += len * y;
    st[o + 7] += sq(xe) - sq(xs - 1);
    st[o + 8] += len * y * y;
    st[o + 9] += y * sx;
    const row = y * w;
    const id = p + 1;
    let per = 0; let lum = 0;
    for (let x = xs; x <= xe; x++) {
      const k = row + x;
      LABEL[k] = id;
      lum += LUM[k];
      if (x === xs || x === xe || y === 0 || y === h - 1 || !INK[k - w] || !INK[k + w]) per++;
    }
    st[o + 10] += per;
    st[o + 11] += lum;
  }
  /** @type {Piece[]} */
  const pieces = [];
  const maxBig = 0.45 * Math.max(w, h);
  for (let p = 0, o = 0; o < st.length; p++, o += 12) {
    const x0 = st[o]; const y0 = st[o + 1]; const x1 = st[o + 2]; const y1 = st[o + 3]; const cnt = st[o + 4];
    const big = Math.max(x1 - x0, y1 - y0) + 1;
    if (big < 3) continue;
    if (big > maxBig) {
      pieces.push({ id: p + 1, x0, y0, x1, y1, n: cnt, big, sw: 0, flat: 0, lum: 0, paper: 0, cell: -1, huge: true });
      continue;
    }
    const mx = st[o + 5] / cnt; const my = st[o + 6] / cnt;
    const vxx = st[o + 7] / cnt - mx * mx; const vyy = st[o + 8] / cnt - my * my; const vxy = st[o + 9] / cnt - mx * my;
    const tr = vxx + vyy;
    const disc = Math.sqrt(Math.max(0, ((vxx - vyy) * (vxx - vyy)) / 4 + vxy * vxy));
    const flat = tr > 0 ? Math.max(0, tr / 2 - disc) / (tr / 2 + disc) : 1;
    pieces.push({ id: p + 1, x0, y0, x1, y1, n: cnt, big, sw: (2 * cnt) / Math.max(1, st[o + 10]), flat, lum: st[o + 11] / cnt, paper: -1, cell: -1, huge: false });
  }
  return pieces;
}

/** @param {number} m */
const sq = (m) => (m < 0 ? 0 : (m * (m + 1) * (2 * m + 1)) / 6);

/** @param {Piece} p */
function glyphish(p) {
  const bw = p.x1 - p.x0 + 1;
  const bh = p.y1 - p.y0 + 1;
  const fill = p.n / (bw * bh);
  if (p.big >= 40 ? fill < 0.1 : p.big >= 12 ? fill < 0.05 : false) return false;
  if (p.big >= 24 && p.sw < 0.03 * p.big) return false;
  if (p.big >= 56 && p.sw < 0.08 * p.big) return false;
  if (p.big >= 16 && p.sw > 0.34 * p.big && fill > 0.62) return false;
  return true;
}

/** @param {Piece} p */
const hairline = (p) => p.big >= 12 && p.sw < 0.06 * p.big;

/** @param {Piece} p */
const penStroke = (p) => p.flat < 0.05 && p.sw >= 0.07 * p.big;

/**
 * @param {Piece} a
 * @param {Piece} b
 */
function parallel(a, b) {
  if (!penStroke(a) || !penStroke(b)) return false;
  const flatA = a.x1 - a.x0 >= a.y1 - a.y0;
  if (flatA !== (b.x1 - b.x0 >= b.y1 - b.y0)) return false;
  const short = Math.min(a.big, b.big);
  if (short < 0.6 * Math.max(a.big, b.big)) return false;
  const along = flatA ? -gap(a.x0, a.x1, b.x0, b.x1) - 1 : -gap(a.y0, a.y1, b.y0, b.y1) - 1;
  const apart = flatA ? gap(a.y0, a.y1, b.y0, b.y1) : gap(a.x0, a.x1, b.x0, b.x1);
  return along >= 0.6 * short && apart <= 0.45 * Math.max(a.big, b.big);
}

/** @param {{x0: number, y0: number, x1: number, y1: number, n: number, flat?: number}} c */
function compact(c) {
  const bw = c.x1 - c.x0 + 1;
  const bh = c.y1 - c.y0 + 1;
  return bw <= 3.2 * bh && bh <= 3.2 * bw && c.n >= 0.08 * bw * bh && (c.flat === undefined || c.flat >= 0.05);
}

/**
 * @param {Piece[]} pieces
 * @param {number} w
 * @param {number} h
 * @param {number} s
 * @param {number} u
 * @param {boolean} dark
 * @param {number} W
 * @param {number} H
 * @param {((stage: string, polarity: boolean, data: unknown) => void) | undefined} debug
 * @returns {{blocks: TextBlock[], chars: TextChar[]}}
 */
function assemble(pieces, w, h, s, u, dark, W, H, debug) {
  /** @type {{blocks: TextBlock[], chars: TextChar[]}} */
  const none = { blocks: [], chars: [] };
  const cand = pieces.filter((p) => !p.huge && glyphish(p));
  if (!cand.length) return none;
  /** @type {Map<number, Piece>} */
  const byId = new Map();
  for (const p of cand) byId.set(p.id, p);
  /** @type {Map<number, Piece>} */
  const every = new Map();
  for (const p of pieces) every.set(p.id, p);

  for (let i = 0; i < cand.length; i++) {
    if ((i & 1023) === 0 && late()) return none;
    cand[i].paper = paperAround(cand[i], w, h, dark, byId);
  }
  debug?.('pieces', dark, pieces);

  /** @type {Cell[]} */
  const cells = [];
  const order = cand.filter((p) => p.paper >= 0.5).sort((a, b) => a.x0 - b.x0);
  const parent = order.map((_, i) => i);
  const gx0 = order.map((p) => p.x0); const gy0 = order.map((p) => p.y0);
  const gx1 = order.map((p) => p.x1); const gy1 = order.map((p) => p.y1);
  const gbig = order.map((p) => p.big);
  /** @param {number} i */
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < order.length; i++) {
    if ((i & 1023) === 0 && late()) return none;
    const a = order[i];
    const reachA = Math.max(0.3 * Math.min(a.big, 40), penStroke(a) ? 0.45 * a.big : 0) + 1;
    for (let j = i + 1; j < order.length && order[j].x0 <= a.x1 + reachA; j++) {
      const b = order[j];
      if (Math.min(a.big, b.big) < 0.12 * Math.max(a.big, b.big)) continue;
      if (hairline(a) !== hairline(b)) continue;
      const m = Math.min(1.5 * Math.min(a.big, b.big), Math.max(a.big, b.big), 40);
      const g = 0.25 * m + 0.5;
      if ((gap(a.x0, a.x1, b.x0, b.x1) > g || gap(a.y0, a.y1, b.y0, b.y1) > g) && !parallel(a, b)) continue;
      if (Math.max(a.big, b.big) > 3.3 * Math.min(a.big, b.big) && !near(a.big < b.big ? a : b, a.big < b.big ? b : a, Math.ceil(g), w, h)) continue;
      const ra = find(i); const rb = find(j);
      if (ra === rb) continue;
      const big = Math.max(gbig[ra], gbig[rb]);
      const ux = Math.max(gx1[ra], gx1[rb]) - Math.min(gx0[ra], gx0[rb]) + 1;
      const uy = Math.max(gy1[ra], gy1[rb]) - Math.min(gy0[ra], gy0[rb]) + 1;
      const U = Math.max(ux, uy);
      const parts = a.sw >= 0.12 * a.big && b.sw >= 0.12 * b.big
        && Math.max(gap(a.x0, a.x1, b.x0, b.x1), gap(a.y0, a.y1, b.y0, b.y1)) <= Math.max(1, 0.15 * Math.min(a.big, b.big));
      if (U > 1.2 * big + 1 && !(parts && U <= 2.2 * big && U <= 1.3 * Math.min(ux, uy))) continue;
      parent[ra] = rb;
      gx0[rb] = Math.min(gx0[ra], gx0[rb]); gy0[rb] = Math.min(gy0[ra], gy0[rb]);
      gx1[rb] = Math.max(gx1[ra], gx1[rb]); gy1[rb] = Math.max(gy1[ra], gy1[rb]);
      gbig[rb] = big;
    }
  }
  /** @type {Map<number, number>} */
  const cellOf = new Map();
  order.forEach((p, i) => {
    const root = find(i);
    let ci = cellOf.get(root);
    if (ci === undefined) {
      ci = cells.length;
      cellOf.set(root, ci);
      cells.push({ x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1, size: 0, n: 0, lum: 0, paper: 0, solid: false, sw: 0, pieces: [] });
    }
    const c = cells[ci];
    c.x0 = Math.min(c.x0, p.x0); c.y0 = Math.min(c.y0, p.y0);
    c.x1 = Math.max(c.x1, p.x1); c.y1 = Math.max(c.y1, p.y1);
    c.lum += p.lum * p.n;
    c.paper += p.paper * p.n;
    c.sw += p.sw * p.n;
    c.n += p.n;
    c.pieces.push(p.id);
    p.cell = ci;
  });
  for (const c of cells) {
    c.size = Math.max(c.x1 - c.x0, c.y1 - c.y0) + 1;
    c.lum /= c.n;
    c.paper /= c.n;
    c.sw /= c.n;
    const ps = c.pieces.map((id) => /** @type {Piece} */ (byId.get(id)));
    c.solid = compact(c) && (ps.some((p) => p.flat >= 0.05 || p.big < 0.6 * c.size) || (ps.length >= 2 && ps.every(penStroke)));
  }

  debug?.('cells', dark, cells);
  const minChar = Math.max(5, 7 * u);
  const stroke = (/** @type {Cell} */ c) => {
    if (c.solid || c.pieces.length !== 1 || c.paper < 0.75) return false;
    const p = /** @type {Piece} */ (byId.get(c.pieces[0]));
    return p.flat < 0.05 && p.sw >= 0.07 * c.size;
  };
  const pieceGrid = new Grid(cand, w, h, GRID);
  /** @param {number} ci */
  const textured = (ci) => {
    const c = cells[ci];
    let top = /** @type {Piece} */ (byId.get(c.pieces[0]));
    for (const id of c.pieces) { const p = /** @type {Piece} */ (byId.get(id)); if (p.n > top.n) top = p; }
    const r = c.size;
    let alike = 0;
    pieceGrid.near(c.x0 - r, c.y0 - r, c.x1 + r, c.y1 + r, (p) => {
      if (p.cell === ci || p.x1 < c.x0 - r || p.x0 > c.x1 + r || p.y1 < c.y0 - r || p.y0 > c.y1 + r) return;
      if (p.n >= 0.6 * top.n && p.n <= 1.6 * top.n && p.big >= 0.7 * top.big && p.big <= 1.4 * top.big) alike++;
    });
    return alike >= TEXTURE_ALIKE;
  };
  const chars = cells.map((c, i) => i).filter((i) => cells[i].size >= minChar && cells[i].paper >= 0.6 && (cells[i].solid || stroke(cells[i])) && !textured(i));
  chars.sort((a, b) => cells[a].x0 - cells[b].x0);
  const up = cells.map((_, i) => i);
  /** @param {number} i */
  const top = (i) => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
  /** @param {number} a @param {number} b */
  const join = (a, b) => { const ra = top(a); const rb = top(b); if (ra !== rb) up[ra] = rb; };
  const dir = new Uint8Array(cells.length);
  /**
   * @param {Cell} a
   * @param {Cell} b
   */
  const relation = (a, b) => {
    const S = Math.max(a.size, b.size);
    const ratio = S / Math.min(a.size, b.size);
    const small = Math.min(a.size, b.size) < 0.62 * S;
    if (ratio > (small ? 3.2 : 1.7)) return { along: 0, g: Infinity };
    const gx = gap(a.x0, a.x1, b.x0, b.x1);
    const gy = gap(a.y0, a.y1, b.y0, b.y1);
    const dcx = Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2);
    const dcy = Math.abs((a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
    if (dcx <= 0.34 * S + 0.3 * dcy && gx < 0 && gy <= 0.75 * S) return { along: 1, g: gy };
    if (dcy <= 0.34 * S + 0.3 * dcx && gy < 0 && gx <= 0.75 * S) return { along: 2, g: gx };
    return { along: 0, g: Infinity };
  };
  const nearV = new Float64Array(cells.length).fill(Infinity);
  const nearH = new Float64Array(cells.length).fill(Infinity);
  /** @type {[number, number, number][]} */
  const pairs = [];
  for (let ii = 0; ii < chars.length; ii++) {
    if ((ii & 1023) === 0 && late()) return none;
    const a = cells[chars[ii]];
    for (let jj = ii + 1; jj < chars.length; jj++) {
      const b = cells[chars[jj]];
      if (b.x0 > a.x1 + 0.9 * Math.max(a.size, b.size)) break;
      const r = relation(a, b);
      if (!r.along) continue;
      const i = chars[ii]; const j = chars[jj];
      const near = r.along === 1 ? nearV : nearH;
      if (r.g < near[i] && b.size >= 0.62 * a.size && b.solid) near[i] = r.g;
      if (r.g < near[j] && a.size >= 0.62 * b.size && a.solid) near[j] = r.g;
      pairs.push([i, j, r.along]);
    }
  }
  /** @param {number} i @returns {0|1|2} */
  const prefers = (i) => (nearV[i] < nearH[i] ? 1 : nearH[i] < nearV[i] ? 2 : 0);
  /** @type {[number, number][]} */
  const joined = [];
  for (const [i, j, along] of pairs) {
    const pi = prefers(i); const pj = prefers(j);
    if ((pi && pi !== along) || (pj && pj !== along)) continue;
    if (divided(cells[i], cells[j], w, every)) continue;
    join(i, j);
    joined.push([i, j]);
    dir[i] |= along;
    dir[j] |= along;
  }

  /**
   * @typedef {Object} Run
   * @property {number} x0
   * @property {number} y0
   * @property {number} x1
   * @property {number} y1
   * @property {number} size
   * @property {number} count
   * @property {number} solid
   * @property {0|1|2} along
   * @property {number[]} cells
   * @property {boolean} [straight]
   * @property {boolean} [outlined]
   */
  debug?.('joins', dark, joined.map(([i, j]) => ({ a: cells[i], b: cells[j], x0: Math.min(cells[i].x0, cells[j].x0), y0: Math.min(cells[i].y0, cells[j].y0), x1: Math.max(cells[i].x1, cells[j].x1), y1: Math.max(cells[i].y1, cells[j].y1) })));
  /** @type {Map<number, number[]>} */
  const members = new Map();
  for (const i of chars) {
    const root = top(i);
    const m = members.get(root);
    if (m) m.push(i); else members.set(root, [i]);
  }
  /** @param {number[]} ids @returns {Run} */
  const makeRun = (ids) => {
    /** @type {Run} */
    const run = { x0: w, y0: h, x1: -1, y1: -1, size: 0, count: ids.length, solid: 0, along: 0, cells: ids };
    for (const i of ids) {
      const c = cells[i];
      run.x0 = Math.min(run.x0, c.x0); run.y0 = Math.min(run.y0, c.y0);
      run.x1 = Math.max(run.x1, c.x1); run.y1 = Math.max(run.y1, c.y1);
      if (c.solid) run.solid++;
    }
    const sizes = ids.map((i) => cells[i].size).sort((a, b) => a - b);
    run.size = sizes[sizes.length >> 1];
    let col = 0; let lin = 0;
    for (const i of ids) { if (dir[i] & 1) col++; if (dir[i] & 2) lin++; }
    run.along = run.count < 2 ? 0 : col >= lin ? 1 : 2;
    run.straight = straight(run, cells);
    run.outlined = outlined(run, w, h, dark);
    return run;
  };
  /** @type {Run[]} */
  const runList = [];
  for (const ids of members.values()) {
    const run = makeRun(ids);
    if (!run.straight && run.count >= 3) {
      const big = new Set(ids.filter((i) => cells[i].size >= 0.62 * run.size));
      if (big.size >= 2 && big.size < ids.length) {
        const up2 = new Map([...big].map((i) => [i, i]));
        /** @param {number} i @returns {number} */
        const top2 = (i) => { let r = i; while (up2.get(r) !== r) r = /** @type {number} */ (up2.get(r)); return r; };
        for (const [i, j] of joined) if (big.has(i) && big.has(j)) up2.set(top2(i), top2(j));
        /** @type {Map<number, number[]>} */
        const parts = new Map();
        for (const i of big) { const r = top2(i); const m = parts.get(r); if (m) m.push(i); else parts.set(r, [i]); }
        for (const part of parts.values()) runList.push(makeRun(part));
        for (const i of ids) if (!big.has(i)) runList.push(makeRun([i]));
        continue;
      }
    }
    runList.push(run);
  }
  const runs = runList;

  debug?.('runs', dark, runs);
  const lone = Math.max(30, 34 * u);
  const list = runs.filter((r) => (r.count >= 2 && r.straight && r.solid >= 1) || (r.solid && r.size >= lone));
  list.sort((a, b) => a.x0 - b.x0);
  const bp = list.map((_, i) => i);
  /** @param {number} i */
  const root = (i) => { while (bp[i] !== i) { bp[i] = bp[bp[i]]; i = bp[i]; } return i; };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      const S = Math.max(a.size, b.size);
      if (b.x0 > a.x1 + 1.2 * S) break;
      const small = Math.min(a.size, b.size);
      const gx = gap(a.x0, a.x1, b.x0, b.x1);
      const gy = gap(a.y0, a.y1, b.y0, b.y1);
      const ox = -gx; const oy = -gy;
      let ok = false;
      if (small >= 0.58 * S) {
        const cols = (a.along !== 2 && b.along !== 2) && gx <= 1.05 * S && gx >= -0.2 * S && oy >= 0.2 * Math.min(a.y1 - a.y0, b.y1 - b.y0);
        const lines = (a.along !== 1 && b.along !== 1) && gy <= 0.95 * S && gy >= -0.2 * S && ox >= 0.2 * Math.min(a.x1 - a.x0, b.x1 - b.x0);
        const tail = (oy > 0.5 * Math.min(a.y1 - a.y0, b.y1 - b.y0) && gx <= 0.8 * S && gx >= 0 && (a.along === 2 || b.along === 2 || a.along === 0 || b.along === 0))
          || (ox > 0.5 * Math.min(a.x1 - a.x0, b.x1 - b.x0) && gy <= 0.8 * S && gy >= 0 && (a.along === 1 || b.along === 1 || a.along === 0 || b.along === 0));
        ok = cols || lines || tail;
      } else if (small >= 0.25 * S) {
        ok = (gx <= 0.35 * S && gx >= -0.1 * S && oy > 0) || (gy <= 0.3 * S && gy >= -0.1 * S && ox > 0);
      }
      if (!ok || (!(a.outlined && b.outlined) && divided(a, b, w, every))) continue;
      const ra = root(i); const rb = root(j);
      if (ra !== rb) bp[ra] = rb;
    }
  }
  /** @type {Map<number, {runs: Run[]}>} */
  const groups = new Map();
  list.forEach((r, i) => {
    const g = root(i);
    let e = groups.get(g);
    if (!e) groups.set(g, (e = { runs: [] }));
    e.runs.push(r);
  });

  /** @type {TextBlock[]} */
  const out = [];
  /** @param {Run[]} rs */
  const mainOf = (rs) => rs.reduce((a, b) => (b.count * b.size > a.count * a.size ? b : a));
  const candGrid = pieceGrid;
  const dashGrid = new Grid(pieces.filter((p) => !p.huge && p.flat < 0.05 && p.big >= 6), w, h, GRID);
  const blockPieces = new Set();
  /**
   * @param {Run[]} rs
   * @returns {{block: TextBlock} | {why: string}}
   */
  const consider = (rs) => {
    const main = mainOf(rs);
    const memberCells = rs.flatMap((r) => r.cells);
    const count = memberCells.length;
    const solid = memberCells.filter((i) => cells[i].solid).length;
    const box = { x0: Math.min(...rs.map((r) => r.x0)), y0: Math.min(...rs.map((r) => r.y0)), x1: Math.max(...rs.map((r) => r.x1)), y1: Math.max(...rs.map((r) => r.y1)) };
    /** @param {string} why */
    const reject = (why) => { debug?.('reject', dark, { ...box, why, count, size: main.size }); return { why }; };
    if (count < 2 && main.size < lone) return reject('small mark');
    if (solid < 0.5 * count) return reject('strokes');
    if (!lettering(memberCells.map((i) => cells[i]), main.size, dark, count)) return reject('not lettering');
    if (count > 40 && main.size < 9) return reject('specks');
    const sizes = memberCells.map((i) => cells[i].size).filter((v) => v >= 0.58 * main.size);
    if (sizes.length >= 3) {
      const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
      const sd = Math.sqrt(sizes.reduce((a, b) => a + (b - mean) * (b - mean), 0) / sizes.length);
      if (sd > 0.42 * mean) return reject('uneven sizes');
    }
    const memberPieces = new Set(memberCells.flatMap((i) => cells[i].pieces));
    const reach = 0.45 * main.size;
    const col = main.along === 1 || (main.along === 0 && box.y1 - box.y0 > box.x1 - box.x0);
    const far = 1.1 * main.size;
    const rx = col ? reach : far; const ry = col ? far : reach;
    let swSum = 0; let swN = 0;
    for (const i of memberCells) { swSum += cells[i].sw * cells[i].n; swN += cells[i].n; }
    const pen = swSum / Math.max(1, swN);
    /** @type {Piece[]} */
    const marks = [];
    candGrid.near(box.x0 - rx, box.y0 - ry, box.x1 + rx, box.y1 + ry, (p) => {
      if (p.cell >= 0 && memberPieces.has(p.id)) return;
      if (p.paper < 0.5 || p.big < 0.08 * main.size) return;
      if (p.sw < 0.45 * pen && p.big > 3 * p.sw) return;
      if (p.x1 < box.x0 - rx || p.x0 > box.x1 + rx || p.y1 < box.y0 - ry || p.y0 > box.y1 + ry) return;
      const beyond = p.x1 < box.x0 - reach || p.x0 > box.x1 + reach || p.y1 < box.y0 - reach || p.y0 > box.y1 + reach;
      if (beyond && (col ? (p.x0 < box.x0 - 0.1 * main.size || p.x1 > box.x1 + 0.1 * main.size) : (p.y0 < box.y0 - 0.1 * main.size || p.y1 > box.y1 + 0.1 * main.size))) return;
      const inLine = col ? p.x0 >= box.x0 - 0.15 * main.size && p.x1 <= box.x1 + 0.15 * main.size
        : p.y0 >= box.y0 - 0.15 * main.size && p.y1 <= box.y1 + 0.15 * main.size;
      const dash = penStroke(p) && (col ? p.y1 - p.y0 > p.x1 - p.x0 : p.x1 - p.x0 > p.y1 - p.y0) && p.big <= 2.6 * main.size;
      if (p.big > 0.75 * main.size && !(inLine && (p.big <= 1.15 * main.size || dash))) return;
      marks.push(p);
    });
    const texture = marks.length > 4 + 1.5 * count;
    const members = [...memberPieces].map((id) => /** @type {Piece} */ (byId.get(id)));
    const memberGrid = new Grid(members, w, h, GRID);
    for (const p of marks) {
      if (texture && p.big < 0.2 * main.size) continue;
      const g = Math.ceil((texture ? 0.12 : 0.6) * main.size);
      let by = false;
      memberGrid.near(p.x0 - g, p.y0 - g, p.x1 + g, p.y1 + g, (m) => {
        if (!by && gap(m.x0, m.x1, p.x0, p.x1) <= g && gap(m.y0, m.y1, p.y0, p.y1) <= g && near(p, m, g, w, h)) by = true;
      });
      if (by) memberPieces.add(p.id);
      else if (!texture && (col ? p.x0 >= box.x0 && p.x1 <= box.x1 : p.y0 >= box.y0 && p.y1 <= box.y1)) memberPieces.add(p.id);
    }
    const S = main.size;
    const ahead = col ? [box.x0 - 0.1 * S, box.y1 - 0.2 * S, box.x1 + 0.1 * S, box.y1 + 0.6 * S + 1]
      : [box.x1 - 0.2 * S, box.y0 - 0.1 * S, box.x1 + 0.6 * S + 1, box.y1 + 0.1 * S];
    dashGrid.near(ahead[0], ahead[1], ahead[2], ahead[3], (p) => {
      if (memberPieces.has(p.id) || p.sw < 0.4 * pen || p.big < 0.6 * S || p.big > 2.6 * S) return;
      if (col ? p.y1 - p.y0 <= p.x1 - p.x0 : p.x1 - p.x0 <= p.y1 - p.y0) return;
      if (col ? p.x0 < box.x0 - 0.1 * S || p.x1 > box.x1 + 0.1 * S : p.y0 < box.y0 - 0.1 * S || p.y1 > box.y1 + 0.1 * S) return;
      const after = col ? p.y0 - box.y1 : p.x0 - box.x1;
      if (after < -0.2 * S || after > 0.6 * S) return;
      if (p.paper < 0) p.paper = paperAround(p, w, h, dark, byId);
      if (p.paper >= 0.6) memberPieces.add(p.id);
    });
    let x0 = w; let y0 = h; let x1 = -1; let y1 = -1; let ink = 0; let inkN = 0;
    for (const id of memberPieces) {
      const p = /** @type {Piece} */ (every.get(id));
      if (p.x0 < x0) x0 = p.x0;
      if (p.y0 < y0) y0 = p.y0;
      if (p.x1 > x1) x1 = p.x1;
      if (p.y1 > y1) y1 = p.y1;
      ink += p.lum * p.n;
      inkN += p.n;
    }
    const bm = { x0, y0, x1, y1 };
    if (!clearAround(bm, memberPieces, main.size, w, h, dark, ink / inkN)) return reject('no paper around');
    const mask = maskOf(bm, memberPieces, w, s);
    for (const id of memberPieces) blockPieces.add(id);
    return { block: {
      box: { x0: Math.floor(x0 * s), y0: Math.floor(y0 * s), x1: Math.min(W, Math.ceil((x1 + 1) * s)), y1: Math.min(H, Math.ceil((y1 + 1) * s)) },
      glyph: main.size * s,
      dark,
      vertical: main.along === 1 || (main.along === 0 && box.y1 - box.y0 > 1.3 * (box.x1 - box.x0)),
      cells: count,
      ink: ink / inkN,
      paper: paperLum(bm, w, h, dark, ink / inkN),
      mask,
    } };
  };
  for (const { runs: rs } of groups.values()) {
    if (late()) break;
    const r = consider(rs);
    if ('block' in r) { out.push(r.block); continue; }
    if (r.why !== 'uneven sizes') continue;
    const main = mainOf(rs);
    const alike = rs.filter((x) => x.size >= 0.75 * main.size && x.size <= 1.33 * main.size);
    const rest = rs.filter((x) => !alike.includes(x));
    if (!rest.length) continue;
    for (const part of [alike, rest]) {
      const q = consider(part);
      if ('block' in q) out.push(q.block);
    }
  }

  /** @type {TextChar[]} */
  const found = [];
  if (!late()) {
    const own = cells.map((_, i) => i).filter((i) => cells[i].size >= minChar && cells[i].paper >= 0.5
      && (cells[i].solid || stroke(cells[i])) && !textured(i)).slice(0, MAX_CHARS);
    const charGrid = new Grid(own.map((i) => ({ ...cells[i], id: i + 1 })), w, h, GRID);
    /** @type {number[]} */
    const marks = [];
    for (let i = 0; i < cells.length && marks.length < MAX_CHARS; i++) {
      const c = cells[i];
      if (c.size >= minChar || c.size < 3 || c.paper < 0.6) continue;
      const r = Math.max(c.size, 0.8 * minChar);
      let near = false;
      charGrid.near(c.x0 - 2 * r, c.y0 - 2 * r, c.x1 + 2 * r, c.y1 + 2 * r, (q) => {
        if (!near && gap(q.x0, q.x1, c.x0, c.x1) <= 0.8 * (q.y1 - q.y0 + q.x1 - q.x0) / 2 && gap(q.y0, q.y1, c.y0, c.y1) <= 0.8 * (q.y1 - q.y0 + q.x1 - q.x0) / 2) near = true;
      });
      if (near) marks.push(i);
    }
    const small = cells.map((_, i) => i).filter((i) => cells[i].size < minChar && cells[i].size >= 3 && cells[i].paper >= 0.6);
    const smallGrid = new Grid(small.map((i) => ({ ...cells[i], id: i + 1 })), w, h, GRID);
    const kept = new Set(marks);
    for (let k = 0; k < marks.length && marks.length < MAX_CHARS; k++) {
      const m = cells[marks[k]];
      const r = Math.max(2 * m.size, 3);
      /** @type {number[]} */
      const like = [];
      smallGrid.near(m.x0 - r, m.y0 - r, m.x1 + r, m.y1 + r, (q) => {
        const i = q.id - 1;
        if (i !== marks[k] && gap(q.x0, q.x1, m.x0, m.x1) <= r && gap(q.y0, q.y1, m.y0, m.y1) <= r
          && Math.abs(q.size - m.size) <= 0.5 * Math.max(q.size, m.size)) like.push(i);
      });
      if (like.length > 2) continue;
      for (const i of like) if (!kept.has(i)) { kept.add(i); marks.push(i); }
    }
    for (const [list, mark] of /** @type {[number[], boolean][]} */ ([[own, false], [marks, true]])) {
      for (const i of list) {
        const c = cells[i];
        found.push({
          box: { x0: Math.floor(c.x0 * s), y0: Math.floor(c.y0 * s), x1: Math.min(W, Math.ceil((c.x1 + 1) * s)), y1: Math.min(H, Math.ceil((c.y1 + 1) * s)) },
          size: c.size * s,
          dark,
          mark,
          inBlock: c.pieces.every((id) => blockPieces.has(id)),
          ink: c.lum,
          paper: paperLum(c, w, h, dark, c.lum),
          clear: c.paper,
          n: c.n,
          mask: maskOf(c, new Set(c.pieces), w, s),
        });
      }
    }
  }
  return { blocks: out, chars: found };
}

/**
 * @param {{cells: number[], along: number, size: number}} run
 * @param {Cell[]} cells
 */
function straight(run, cells) {
  if (run.cells.length < 2) return true;
  const col = run.along !== 2;
  const pts = run.cells.map((i) => {
    const c = cells[i];
    return { a: col ? (c.y0 + c.y1) / 2 : (c.x0 + c.x1) / 2, x: col ? (c.x0 + c.x1) / 2 : (c.y0 + c.y1) / 2, size: c.size };
  }).sort((p, q) => p.a - q.a);
  const full = pts.filter((p) => p.size >= 0.75 * run.size);
  const use = full.length >= 2 ? full : pts;
  const ma = use.reduce((a, p) => a + p.a, 0) / use.length;
  const mx = use.reduce((a, p) => a + p.x, 0) / use.length;
  let saa = 0; let sax = 0;
  for (const p of use) { saa += (p.a - ma) * (p.a - ma); sax += (p.a - ma) * (p.x - mx); }
  const slope = use.length >= 3 && saa > 0 ? Math.max(-0.6, Math.min(0.6, sax / saa)) : 0;
  const res = use.map((p) => p.x - mx - slope * (p.a - ma));
  const sd = Math.sqrt(res.reduce((a, r) => a + r * r, 0) / res.length);
  if (sd > 0.2 * run.size) return false;
  if (pts.length < 4) return true;
  const steps = [];
  for (let i = 1; i < pts.length; i++) steps.push(pts[i].a - pts[i - 1].a);
  const ms = steps.reduce((a, b) => a + b, 0) / steps.length;
  const ss = Math.sqrt(steps.reduce((a, b) => a + (b - ms) * (b - ms), 0) / steps.length);
  return ss <= 0.55 * Math.max(ms, 0.5 * run.size);
}

/**
 * @param {{x0: number, y0: number, x1: number, y1: number, size: number}} run
 * @param {number} w
 * @param {number} h
 * @param {boolean} dark
 */
function outlined(run, w, h, dark) {
  const far = Math.max(3, Math.round(0.45 * run.size));
  let samples = 0; let narrow = 0;
  /** @param {number} x @param {number} y @param {number} dx @param {number} dy */
  const probe = (x, y, dx, dy) => {
    let k = 1; let seenPaper = false;
    for (; k <= far; k++) {
      const qx = x + dx * k; const qy = y + dy * k;
      if (qx < 0 || qy < 0 || qx >= w || qy >= h) return;
      const v = LUM[qy * w + qx];
      const isInk = INK[qy * w + qx] !== 0;
      if (!seenPaper) { if (!isInk) seenPaper = true; continue; }
      if (dark ? v < 150 : v > 105) { samples++; narrow++; return; }
    }
    samples++;
  };
  const stepX = Math.max(1, Math.floor((run.x1 - run.x0 + 1) / 8));
  const stepY = Math.max(1, Math.floor((run.y1 - run.y0 + 1) / 8));
  for (let x = run.x0; x <= run.x1; x += stepX) { probe(x, run.y0, 0, -1); probe(x, run.y1, 0, 1); }
  for (let y = run.y0; y <= run.y1; y += stepY) { probe(run.x0, y, -1, 0); probe(run.x1, y, 1, 0); }
  return samples > 0 && narrow >= 0.6 * samples;
}

/**
 * @param {Cell[]} cs
 * @param {number} size
 * @param {boolean} dark
 * @param {number} count
 */
function lettering(cs, size, dark, count) {
  const full = cs.filter((c) => c.size >= 0.6 * size);
  if (!full.length) return false;
  if (count >= 2 && full.filter((c) => c.solid).length < 2) return false;
  if (count < 2) {
    const c = full[0];
    return dark && c.paper >= 0.85 && c.sw >= 0.1 * c.size && c.size >= 34;
  }
  if (!dark && count < 3 && size < 40) return false;
  if (!dark) {
    if (size < 16) return false;
    const med = full.map((c) => c.size).sort((a, b) => a - b)[full.length >> 1];
    const even = full.filter((c) => Math.abs(c.size - med) <= 0.25 * med).length;
    if (even < 0.65 * full.length) return false;
  }
  const thick = full.filter((c) => c.sw >= 0.085 * c.size && c.sw <= 0.34 * c.size).length;
  const most = dark ? (/** @type {Cell} */ c) => (c.size >= 30 ? 6 : c.size >= 18 ? 5 : 3) : (/** @type {Cell} */ c) => (c.size >= 30 ? 4 : 3);
  const simple = full.filter((c) => c.pieces.length <= most(c)).length;
  const inked = full.filter((c) => c.n >= 0.22 * (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1)).length;
  const need = dark ? 0.6 : 0.75;
  return thick >= need * full.length && simple >= need * full.length && inked >= need * full.length;
}

/**
 * @param {Piece} small
 * @param {Piece} big
 * @param {number} g
 * @param {number} w
 * @param {number} h
 */
function near(small, big, g, w, h) {
  const x0 = Math.max(small.x0 - g, big.x0, 0); const x1 = Math.min(small.x1 + g, big.x1, w - 1);
  const y0 = Math.max(small.y0 - g, big.y0, 0); const y1 = Math.min(small.y1 + g, big.y1, h - 1);
  for (let y = y0; y <= y1; y++) {
    const row = y * w;
    for (let x = x0; x <= x1; x++) if (LABEL[row + x] === big.id) return true;
  }
  return false;
}

function gap(/** @type {number} */ a0, /** @type {number} */ a1, /** @type {number} */ b0, /** @type {number} */ b1) {
  return Math.max(a0, b0) - Math.min(a1, b1) - 1;
}

/**
 * @param {Piece} p
 * @param {number} w
 * @param {number} h
 * @param {boolean} dark
 * @param {Map<number, Piece>} byId
 */
function paperAround(p, w, h, dark, byId) {
  const d = clamp(Math.round(0.06 * p.big), 1, 4);
  const band = dark ? 0 : 2;
  const stepX = Math.max(1, Math.floor((p.x1 - p.x0 + 1) / 10));
  const stepY = Math.max(1, Math.floor((p.y1 - p.y0 + 1) / 10));
  let total = 0; let clear = 0;
  /** @param {number} x @param {number} y */
  const isPaper = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const v = LUM[y * w + x];
    return dark ? v - p.lum >= PAPER_CONTRAST : p.lum - v >= PAPER_CONTRAST;
  };
  /** @param {number} x @param {number} y @param {number} dx @param {number} dy */
  const look = (x, y, dx, dy) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const k = y * w + x;
    const id = LABEL[k];
    if (id && INK[k]) {
      if (id === p.id) return;
      const o = byId.get(id);
      if (o && o.big >= 0.3 * p.big && o.big <= 3.5 * p.big) return;
      total++;
      return;
    }
    total++;
    if (isPaper(x, y) && (!band || isPaper(x + band * dx, y + band * dy))) clear++;
  };
  if (p.big < 24) {
    const x0 = p.x0 - d; const y0 = p.y0 - d; const x1 = p.x1 + d; const y1 = p.y1 + d;
    for (let x = x0; x <= x1; x += stepX) { look(x, y0, 0, -1); look(x, y1, 0, 1); }
    for (let y = y0 + stepY; y < y1; y += stepY) { look(x0, y, -1, 0); look(x1, y, 1, 0); }
    return total ? clear / total : 0;
  }
  const id = p.id;
  for (let y = p.y0; y <= p.y1; y += stepY) {
    const row = y * w;
    let a = p.x0; while (a <= p.x1 && LABEL[row + a] !== id) a++;
    if (a > p.x1) continue;
    let b = p.x1; while (b > a && LABEL[row + b] !== id) b--;
    look(a - d, y, -1, 0); look(b + d, y, 1, 0);
  }
  for (let x = p.x0; x <= p.x1; x += stepX) {
    let a = p.y0; while (a <= p.y1 && LABEL[a * w + x] !== id) a++;
    if (a > p.y1) continue;
    let b = p.y1; while (b > a && LABEL[b * w + x] !== id) b--;
    look(x, a - d, 0, -1); look(x, b + d, 0, 1);
  }
  return total ? clear / total : 0;
}

/**
 * @param {{x0: number, y0: number, x1: number, y1: number}} a
 * @param {{x0: number, y0: number, x1: number, y1: number}} b
 * @param {number} w
 * @param {Map<number, Piece>} every
 */
function divided(a, b, w, every) {
  const gx = gap(a.x0, a.x1, b.x0, b.x1);
  const gy = gap(a.y0, a.y1, b.y0, b.y1);
  const across = gy > 1 && gx < 0;
  if (!across && !(gx > 1 && gy < 0)) return false;
  const s0 = across ? Math.max(a.x0, b.x0) : Math.max(a.y0, b.y0);
  const s1 = across ? Math.min(a.x1, b.x1) : Math.min(a.y1, b.y1);
  const g0 = across ? Math.min(a.y1, b.y1) + 1 : Math.min(a.x1, b.x1) + 1;
  const g1 = across ? Math.max(a.y0, b.y0) - 1 : Math.max(a.x0, b.x0) - 1;
  const span = s1 - s0 + 1;
  /** @param {number} id */
  const lineLike = (id) => {
    const p = every.get(id);
    return !!p && (p.huge || (across ? p.x1 - p.x0 + 1 : p.y1 - p.y0 + 1) >= 0.6 * span);
  };
  let crossed = 0;
  for (let u = s0; u <= s1; u++) {
    for (let v = g0; v <= g1; v++) {
      const k = across ? v * w + u : u * w + v;
      if (INK[k] && LABEL[k] && lineLike(LABEL[k])) { crossed++; break; }
    }
  }
  return crossed >= 0.75 * span;
}

/**
 * @param {{x0: number, y0: number, x1: number, y1: number}} b
 * @param {Set<number>} ids
 * @param {number} size
 * @param {number} w
 * @param {number} h
 * @param {boolean} dark
 * @param {number} ink
 */
function clearAround(b, ids, size, w, h, dark, ink) {
  const r = Math.max(2, Math.round(0.12 * size));
  /** @param {number} x @param {number} y @param {number} dx @param {number} dy */
  const ray = (x, y, dx, dy) => {
    for (let k = 1; k <= r; k++) {
      const qx = x + dx * k; const qy = y + dy * k;
      if (qx < 0 || qy < 0 || qx >= w || qy >= h) return -1;
      const v = LUM[qy * w + qx];
      const paper = dark ? v - ink >= PAPER_CONTRAST : ink - v >= PAPER_CONTRAST;
      if (paper) return 1;
    }
    return 0;
  };
  const stepX = Math.max(1, Math.floor((b.x1 - b.x0 + 1) / 20));
  const stepY = Math.max(1, Math.floor((b.y1 - b.y0 + 1) / 20));
  const clear = [0, 0, 0, 0]; const seen = [0, 0, 0, 0];
  /** @param {number} side @param {number} v */
  const add = (side, v) => { if (v >= 0) { seen[side]++; clear[side] += v; } };
  /** @param {number} k */
  const mine = (k) => INK[k] !== 0 && ids.has(LABEL[k]);
  for (let x = b.x0; x <= b.x1; x += stepX) {
    let a = b.y0; while (a <= b.y1 && !mine(a * w + x)) a++;
    if (a > b.y1) continue;
    let z = b.y1; while (z > a && !mine(z * w + x)) z--;
    add(0, ray(x, a, 0, -1)); add(1, ray(x, z, 0, 1));
  }
  for (let y = b.y0; y <= b.y1; y += stepY) {
    const row = y * w;
    let a = b.x0; while (a <= b.x1 && !mine(row + a)) a++;
    if (a > b.x1) continue;
    let z = b.x1; while (z > a && !mine(row + z)) z--;
    add(2, ray(a, y, -1, 0)); add(3, ray(z, y, 1, 0));
  }
  let crowded = 0; let all = 0; let ok = 0;
  for (let i = 0; i < 4; i++) {
    if (seen[i] && clear[i] < 0.5 * seen[i]) crowded++;
    all += seen[i];
    ok += clear[i];
  }
  return all > 0 && crowded <= 1 && ok >= 0.65 * all;
}

/**
 * @param {{x0: number, y0: number, x1: number, y1: number}} b
 * @param {number} w
 * @param {number} h
 * @param {boolean} dark
 * @param {number} ink
 */
function paperLum(b, w, h, dark, ink) {
  let sum = 0; let n = 0;
  const stepX = Math.max(1, Math.floor((b.x1 - b.x0 + 1) / 24));
  const stepY = Math.max(1, Math.floor((b.y1 - b.y0 + 1) / 24));
  for (let y = b.y0; y <= b.y1; y += stepY) {
    for (let x = b.x0; x <= b.x1; x += stepX) {
      const v = LUM[y * w + x];
      if (dark ? v - ink >= PAPER_CONTRAST : ink - v >= PAPER_CONTRAST) { sum += v; n++; }
    }
  }
  void h;
  return n ? sum / n : dark ? 255 : 0;
}

/**
 * @param {{x0: number, y0: number, x1: number, y1: number}} b
 * @param {Set<number>} ids
 * @param {number} w
 * @param {number} s
 * @returns {Mask}
 */
function maskOf(b, ids, w, s) {
  const mw = b.x1 - b.x0 + 1;
  const mh = b.y1 - b.y0 + 1;
  const bits = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    const row = (b.y0 + y) * w + b.x0;
    for (let x = 0; x < mw; x++) {
      const id = LABEL[row + x];
      if (id && INK[row + x] && ids.has(id)) bits[y * mw + x] = 1;
    }
  }
  return { x0: b.x0, y0: b.y0, w: mw, h: mh, s, bits };
}

/** @param {TextBlock[]} blocks */
function dedupe(blocks) {
  const area = (/** @type {Box} */ b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i]; const b = blocks[j];
      if (!a || !b || a.dark === b.dark) continue;
      const iw = Math.min(a.box.x1, b.box.x1) - Math.max(a.box.x0, b.box.x0);
      const ih = Math.min(a.box.y1, b.box.y1) - Math.max(a.box.y0, b.box.y0);
      if (iw <= 0 || ih <= 0) continue;
      const o = (iw * ih) / Math.min(area(a.box), area(b.box));
      if (o < 0.5) continue;
      const inner = Math.abs(a.paper - b.ink) <= Math.abs(b.paper - a.ink) ? a : b;
      const outer = inner === a ? b : a;
      blocks[i] = {
        ...inner,
        box: { x0: Math.min(a.box.x0, b.box.x0), y0: Math.min(a.box.y0, b.box.y0), x1: Math.max(a.box.x1, b.box.x1), y1: Math.max(a.box.y1, b.box.y1) },
        cells: Math.max(inner.cells, outer.cells),
        mask: maskUnion(inner.mask, outer.mask),
      };
      blocks.splice(j, 1);
      j = i;
    }
  }
}

/**
 * @param {Mask} a
 * @param {Mask} b
 * @returns {Mask}
 */
function maskUnion(a, b) {
  const x0 = Math.min(a.x0, b.x0); const y0 = Math.min(a.y0, b.y0);
  const x1 = Math.max(a.x0 + a.w, b.x0 + b.w); const y1 = Math.max(a.y0 + a.h, b.y0 + b.h);
  const w = x1 - x0; const h = y1 - y0;
  const bits = new Uint8Array(w * h);
  for (const m of [a, b]) {
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) if (m.bits[y * m.w + x]) bits[(m.y0 + y - y0) * w + m.x0 + x - x0] = 1;
    }
  }
  return { x0, y0, w, h, s: a.s, bits };
}
