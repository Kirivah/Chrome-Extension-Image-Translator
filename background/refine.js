// @ts-check

/** @typedef {import('./analysis.js').Pixels} Pixels */
/** @typedef {import('./analysis.js').Box} Box */

/** @typedef {{box: Box, model: Box}} Claim */

/**
 * @typedef {Object} Refined
 * @property {Box} box
 * @property {number} glyph
 */

const MAX_SAMPLES = 800_000;
const MAX_PIECES = 4000;
const MAX_WORK = 2_000_000;
let work = 0;
const BUSY = Symbol('busy');
/** @param {number} n */
function spend(n) {
  work += n;
  if (work > MAX_WORK) throw BUSY;
}

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

let LUM = new Uint8Array(0);
let LABEL = new Int32Array(0);
let STACK = new Int32Array(0);
const HIST = new Uint32Array(256);

/** @param {number} n */
function ensure(n) {
  if (LUM.length >= n) return;
  LUM = new Uint8Array(n);
  LABEL = new Int32Array(n);
  STACK = new Int32Array(n);
}

/**
 * @typedef {{x0: number, y0: number, x1: number, y1: number, n: number, big: number, flat: number}} Piece
 */
/** @typedef {{x0: number, y0: number, x1: number, y1: number, anchors: number, size: number}} Block */
/**
 * @typedef {Object} Found
 * @property {Piece[]} glyphs
 * @property {Piece[]} edges
 * @property {(v: number) => boolean} isInk
 * @property {(v: number) => boolean} isPaper
 */
/** @param {Piece} c */
const fill = (c) => c.n / ((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1));

/** @param {Box} a @param {Box} b */
function overlapRatio(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  const m = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
  return m > 0 ? (w * h) / m : 0;
}

const gapX = (/** @type {Piece|Block} */ a, /** @type {Piece|Block} */ b) => Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1) - 1;
const gapY = (/** @type {Piece|Block} */ a, /** @type {Piece|Block} */ b) => Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1) - 1;

/**
 * @param {Uint32Array} hist
 * @param {number} total
 */
function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0; let wB = 0; let best = -1; let t = 127; let mLo = 0; let mHi = 255;
  for (let i = 0; i < 255; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; t = i; mLo = mB; mHi = mF; }
  }
  return { t, mLo, mHi };
}

/**
 * @param {Pixels} px
 * @param {Box} box
 * @param {Claim[]} [taken]
 * @returns {Refined | 'duplicate' | null}
 */
export function refineBox(px, box, taken = []) {
  const { W, H } = px;
  const x0 = clamp(Math.floor(box.x0), 0, W - 1);
  const y0 = clamp(Math.floor(box.y0), 0, H - 1);
  const x1 = clamp(Math.ceil(box.x1), x0 + 1, W);
  const y1 = clamp(Math.ceil(box.y1), y0 + 1, H);
  const model = { x0, y0, x1, y1 };
  let around = model;
  let reach = clamp(0.75 * Math.max(x1 - x0, y1 - y0), 16, 0.25 * Math.max(W, H));
  work = 0;
  try {
    for (let pass = 0; ; pass++) {
      const r = search(px, model, around, reach, taken, pass === 2);
      if (!r) return null;
      if (r.kind === 'duplicate') return 'duplicate';
      if (r.kind === 'ok') return r.refined;
      const b = r.refined.box;
      around = { x0: Math.min(model.x0, b.x0), y0: Math.min(model.y0, b.y0), x1: Math.max(model.x1, b.x1), y1: Math.max(model.y1, b.y1) };
      reach = clamp(2.5 * r.refined.glyph, 16, 0.25 * Math.max(W, H));
    }
  } catch (e) {
    if (e === BUSY) return null;
    throw e;
  }
}

/**
 * @typedef {Object} Window
 * @property {number} wx0
 * @property {number} wy0
 * @property {number} ww
 * @property {number} wh
 * @property {number} s
 * @property {number} W
 * @property {number} H
 */

/**
 * @param {Pixels} px
 * @param {Box} model
 * @param {Box} around
 * @param {number} reach
 * @param {Claim[]} taken
 * @param {boolean} final
 * @returns {{kind: 'ok'|'grow'|'duplicate', refined: Refined} | null}
 */
function search(px, model, around, reach, taken, final) {
  const { data, W, H } = px;
  const wx0 = Math.max(0, Math.floor(around.x0 - reach));
  const wy0 = Math.max(0, Math.floor(around.y0 - reach));
  const wx1 = Math.min(W, Math.ceil(around.x1 + reach));
  const wy1 = Math.min(H, Math.ceil(around.y1 + reach));
  const s = Math.max(1, Math.ceil(Math.sqrt(((wx1 - wx0) * (wy1 - wy0)) / MAX_SAMPLES)));
  const ww = Math.ceil((wx1 - wx0) / s);
  const wh = Math.ceil((wy1 - wy0) / s);
  const n = ww * wh;
  ensure(n);
  /** @type {Window} */
  const win = { wx0, wy0, ww, wh, s, W, H };

  HIST.fill(0);
  for (let y = 0; y < wh; y++) {
    const py = Math.min(H - 1, wy0 + y * s);
    let i = (py * W + wx0) * 4;
    let k = y * ww;
    for (let x = 0; x < ww; x++, k++, i += 4 * s) {
      const v = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
      LUM[k] = v;
      HIST[v]++;
    }
  }
  const { t, mLo, mHi } = otsu(HIST, n);
  if (mHi - mLo < 50) return null;

  const mb = { x0: (model.x0 - wx0) / s, y0: (model.y0 - wy0) / s, x1: (model.x1 - wx0) / s, y1: (model.y1 - wy0) / s };
  const ex = 0.5 * (mb.x1 - mb.x0); const ey = 0.5 * (mb.y1 - mb.y0);
  let bright = 0; let seen = 0;
  for (let y = Math.max(0, Math.floor(mb.y0 - ey)); y < Math.min(wh, Math.ceil(mb.y1 + ey)); y += 2) {
    for (let x = Math.max(0, Math.floor(mb.x0 - ex)); x < Math.min(ww, Math.ceil(mb.x1 + ex)); x += 2) {
      seen++;
      if (LUM[y * ww + x] > t) bright++;
    }
  }
  const darkFirst = bright >= 0.35 * seen;
  const first = piecesFor(darkFirst, t, mLo, mHi, win, model);
  const second = piecesFor(!darkFirst, t, mLo, mHi, win, model);
  const p1 = papers(first.glyphs, second.glyphs, s);
  const p2 = papers(second.glyphs, first.glyphs, s);
  if (p1.size) first.glyphs = first.glyphs.filter((c) => !p1.has(c));
  if (p2.size) second.glyphs = second.glyphs.filter((c) => !p2.has(c));
  const a = pick(blocksFrom(first, win, model), mb, win, taken, model);
  const b = pick(blocksFrom(second, win, model), mb, win, taken, model);
  const best = !b || (a && a.score + 0.3 >= b.score) ? a : b;
  if (!best) return null;
  return best.kind === 'grow' && final ? { kind: 'ok', refined: best.refined } : best;
}

/**
 * @param {boolean} dark
 * @param {number} t
 * @param {number} mLo
 * @param {number} mHi
 * @param {Window} win
 * @param {Box} model
 * @returns {Found}
 */
function piecesFor(dark, t, mLo, mHi, win, model) {
  const { ww, wh, s } = win;
  const n = ww * wh;
  const isInk = dark ? (/** @type {number} */ v) => v <= t : (/** @type {number} */ v) => v > t;
  const paperT = dark ? t + 0.35 * (mHi - t) : t - 0.35 * (t - mLo);
  const isPaper = dark ? (/** @type {number} */ v) => v >= paperT : (/** @type {number} */ v) => v <= paperT;

  LABEL.fill(0, 0, n);
  /** @type {Piece[]} */
  const pieces = [];
  /** @type {Piece[]} */
  const edges = [];
  const side = Math.max(model.x1 - model.x0, model.y1 - model.y0);
  const maxBig = Math.min(1.6 * side, 0.3 * Math.max(win.W, win.H)) / s;
  const minBig = Math.max(2, 3 / s);
  let label = 0;
  for (let k = 0; k < n; k++) {
    if (LABEL[k] || !isInk(LUM[k])) continue;
    label++;
    let sp = 0;
    STACK[sp++] = k;
    LABEL[k] = label;
    let cx0 = ww; let cy0 = wh; let cx1 = -1; let cy1 = -1; let cnt = 0; let edge = false;
    let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0;
    while (sp) {
      const q = STACK[--sp];
      const qx = q % ww;
      const qy = (q - qx) / ww;
      cnt++;
      sx += qx; sy += qy; sxx += qx * qx; syy += qy * qy; sxy += qx * qy;
      if (qx < cx0) cx0 = qx;
      if (qx > cx1) cx1 = qx;
      if (qy < cy0) cy0 = qy;
      if (qy > cy1) cy1 = qy;
      if (qx === 0 || qy === 0 || qx === ww - 1 || qy === wh - 1) edge = true;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = qy + dy;
        if (ny < 0 || ny >= wh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = qx + dx;
          if (nx < 0 || nx >= ww) continue;
          const nq = ny * ww + nx;
          if (!LABEL[nq] && isInk(LUM[nq])) { LABEL[nq] = label; STACK[sp++] = nq; }
        }
      }
    }
    const big = Math.max(cx1 - cx0, cy1 - cy0) + 1;
    if (big < minBig || big > maxBig) continue;
    const mx = sx / cnt; const my = sy / cnt;
    const vxx = sxx / cnt - mx * mx; const vyy = syy / cnt - my * my; const vxy = sxy / cnt - mx * my;
    const tr = vxx + vyy; const disc = Math.sqrt(Math.max(0, (vxx - vyy) * (vxx - vyy) / 4 + vxy * vxy));
    const flat = tr > 0 ? (tr / 2 - disc) / (tr / 2 + disc) : 1;
    const piece = { x0: cx0, y0: cy0, x1: cx1, y1: cy1, n: cnt, big, flat };
    if (edge) { edges.push(piece); continue; }
    pieces.push(piece);
    if (pieces.length > MAX_PIECES) return { glyphs: [], edges: [], isInk, isPaper };
  }

  /** @param {Piece} c */
  const paperAround = (c) => {
    const d = Math.max(1, Math.round(0.15 * c.big));
    const ax0 = Math.max(0, c.x0 - d); const ay0 = Math.max(0, c.y0 - d);
    const ax1 = Math.min(ww - 1, c.x1 + d); const ay1 = Math.min(wh - 1, c.y1 + d);
    const stepX = Math.max(1, Math.floor((ax1 - ax0) / 16));
    const stepY = Math.max(1, Math.floor((ay1 - ay0) / 16));
    let total = 0; let paper = 0;
    for (let x = ax0; x <= ax1; x += stepX) {
      total += 2;
      if (isPaper(LUM[ay0 * ww + x])) paper++;
      if (isPaper(LUM[ay1 * ww + x])) paper++;
    }
    for (let y = ay0 + stepY; y < ay1; y += stepY) {
      total += 2;
      if (isPaper(LUM[y * ww + ax0])) paper++;
      if (isPaper(LUM[y * ww + ax1])) paper++;
    }
    return total ? paper / total : 0;
  };
  let glyphs = pieces.filter((c) => {
    if (fill(c) < (c.big * s >= 40 ? 0.15 : c.big * s >= 12 ? 0.06 : 0)) return false;
    return paperAround(c) >= 0.6;
  });
  const byX = [...glyphs].sort((p, q) => p.x0 - q.x0);
  glyphs = glyphs.filter((c) => {
    if (c.big < 2 * minBig) return true;
    let inside = 0;
    const from = firstFrom(byX, c.x0);
    let i = from;
    for (; i < byX.length && byX[i].x0 <= c.x1; i++) {
      const o = byX[i];
      if (o !== c && o.big <= 0.5 * c.big && o.x1 <= c.x1 && o.y0 >= c.y0 && o.y1 <= c.y1 && ++inside >= 3) break;
    }
    spend(i - from + 1);
    return inside < 3;
  });
  return { glyphs, edges, isInk, isPaper };
}

/**
 * @param {{x0: number}[]} sorted
 * @param {number} x
 */
function firstFrom(sorted, x) {
  let lo = 0; let hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid].x0 >= x) hi = mid; else lo = mid + 1; }
  return lo;
}

/**
 * @param {Piece[]} a
 * @param {Piece[]} b
 * @param {number} s
 * @returns {Set<Piece>}
 */
function papers(a, b, s) {
  const out = /** @type {Set<Piece>} */ (new Set());
  const min = 6 / s;
  const strokes = b.filter((q) => q.big >= min && fill(q) < 0.5).sort((p, q) => p.x0 - q.x0);
  if (strokes.length < 2) return out;
  for (const p of a) {
    if (p.big < 3 * min || fill(p) < 0.55) continue;
    const from = firstFrom(strokes, p.x0 + 1);
    let k = 0; let i = from;
    for (; i < strokes.length && strokes[i].x0 < p.x1; i++) {
      const q = strokes[i];
      if (q.x1 < p.x1 && q.y0 > p.y0 && q.y1 < p.y1 && ++k >= 2) { out.add(p); break; }
    }
    spend(i - from + 1);
  }
  return out;
}

/**
 * @typedef {{blocks: Block[], edges: Piece[], scale: number, clear: (b: Block) => boolean, apart: (a: Block, b: Block) => boolean}} Blocks
 */

/**
 * @param {Found} found
 * @param {Window} win
 * @param {Box} model
 * @returns {Blocks}
 */
function blocksFrom(found, win, model) {
  const { ww, wh, s } = win;
  const { glyphs, edges, isInk, isPaper } = found;
  const none = { blocks: [], edges: [], scale: 0, clear: () => false, apart: () => true };
  if (!glyphs.length) return none;

  const minAnchor = 6 / s;
  const mx = 0.25 * (model.x1 - model.x0) / s; const my = 0.25 * (model.y1 - model.y0) / s;
  const near = { x0: (model.x0 - win.wx0) / s - mx, y0: (model.y0 - win.wy0) / s - my, x1: (model.x1 - win.wx0) / s + mx, y1: (model.y1 - win.wy0) / s + my };
  const sized = glyphs.filter((c) => c.big >= minAnchor);
  if (!sized.length) return none;
  const local = sized.filter((c) => c.x1 >= near.x0 && c.x0 <= near.x1 && c.y1 >= near.y0 && c.y0 <= near.y1);
  const bySize = (local.length >= 3 ? local : sized).sort((p, q) => p.big - q.big);
  const half = bySize.reduce((a, c) => a + c.n, 0) / 2;
  let acc = 0;
  let scale = bySize[bySize.length - 1].big;
  for (const c of bySize) { acc += c.n; if (acc >= half) { scale = c.big; break; } }

  const compact = (/** @type {Piece} */ c) => {
    const w = c.x1 - c.x0 + 1;
    const h = c.y1 - c.y0 + 1;
    return w <= 4 * h && h <= 4 * w && c.n >= 0.08 * w * h && c.flat >= 0.04;
  };
  const isAnchor = (/** @type {Piece} */ c) => c.big >= Math.max(minAnchor, 0.33 * scale) && compact(c);
  const anchors = glyphs.filter(isAnchor).sort((p, q) => p.x0 - q.x0);
  const specks = glyphs.filter((c) => !isAnchor(c));
  const gap = Math.max(1, 0.85 * scale);
  const parent = anchors.map((_, i) => i);
  /** @param {number} i @returns {number} */
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  /**
   * @param {Piece | Block} a
   * @param {Piece | Block} b
   */
  const divided = (a, b) => {
    const dx = gapX(a, b);
    const dy = gapY(a, b);
    if (dy > 1 && dx < 0) {
      const x0 = Math.max(a.x0, b.x0); const x1 = Math.min(a.x1, b.x1);
      const y0 = Math.min(a.y1, b.y1) + 1; const y1 = Math.max(a.y0, b.y0) - 1;
      spend((x1 - x0 + 1) * (y1 - y0 + 1));
      let crossed = 0;
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) if (isInk(LUM[y * ww + x])) { crossed++; break; }
      }
      return crossed >= 0.7 * (x1 - x0 + 1);
    }
    if (dx > 1 && dy < 0) {
      const y0 = Math.max(a.y0, b.y0); const y1 = Math.min(a.y1, b.y1);
      const x0 = Math.min(a.x1, b.x1) + 1; const x1 = Math.max(a.x0, b.x0) - 1;
      spend((x1 - x0 + 1) * (y1 - y0 + 1));
      let crossed = 0;
      for (let y = y0; y <= y1; y++) {
        const row = y * ww;
        for (let x = x0; x <= x1; x++) if (isInk(LUM[row + x])) { crossed++; break; }
      }
      return crossed >= 0.7 * (y1 - y0 + 1);
    }
    return false;
  };

  const reachX = 1.2 * scale + 1;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    let j = i + 1;
    for (; j < anchors.length && anchors[j].x0 <= a.x1 + reachX; j++) {
      const b = anchors[j];
      const size = Math.min(scale, Math.max(Math.min(a.big, b.big), 0.5 * Math.max(a.big, b.big)));
      const near = 0.85 * size;
      const along = 1.2 * size;
      const dx = gapX(a, b);
      const dy = gapY(a, b);
      if (dx > along || dy > along) continue;
      const sameLine = -dy >= 0.5 * Math.min(a.y1 - a.y0, b.y1 - b.y0);
      const sameColumn = -dx >= 0.5 * Math.min(a.x1 - a.x0, b.x1 - b.x0);
      const joined = sameLine ? dx <= along && dy <= near
        : sameColumn ? dy <= along && dx <= near
          : dx <= near && dy <= near;
      if (joined && !divided(a, b)) {
        const ra = find(i); const rb = find(j);
        if (ra !== rb) parent[ra] = rb;
      }
    }
    spend(j - i);
  }
  /** @type {Map<number, Block & {small: number}>} */
  const blocks = new Map();
  anchors.forEach((c, i) => {
    const r = find(i);
    const b = blocks.get(r);
    if (!b) blocks.set(r, { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, anchors: 1, small: c.big < 0.5 * scale ? 1 : 0, size: c.big });
    else {
      b.x0 = Math.min(b.x0, c.x0); b.y0 = Math.min(b.y0, c.y0);
      b.x1 = Math.max(b.x1, c.x1); b.y1 = Math.max(b.y1, c.y1);
      b.anchors++;
      b.size = Math.max(b.size, c.big);
      if (c.big < 0.5 * scale) b.small++;
    }
  });
  /** @param {Block} b @param {Piece | Block} c */
  const absorb = (b, c) => {
    b.x0 = Math.min(b.x0, c.x0); b.y0 = Math.min(b.y0, c.y0);
    b.x1 = Math.max(b.x1, c.x1); b.y1 = Math.max(b.y1, c.y1);
  };
  let list = [...blocks.values()];
  let rest = specks;
  for (let round = 0; round < 4 && rest.length; round++) {
    const left = [];
    for (const c of rest) {
      spend(list.length);
      const b = list.find((x) => gapX(c, x) <= 0.5 * gap && gapY(c, x) <= 0.5 * gap);
      if (b) absorb(b, c); else left.push(c);
    }
    if (left.length === rest.length) break;
    rest = left;
  }
  const inLine = (/** @type {Block} */ a, /** @type {Block} */ b) => {
    if (Math.max(a.size, b.size) > 2.2 * Math.min(a.size, b.size)) return false;
    const reach = 1.5 * Math.max(a.size, b.size);
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1;
    const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1;
    const sameColumn = ox >= 0.5 * Math.min(a.x1 - a.x0 + 1, b.x1 - b.x0 + 1) && gapY(a, b) <= reach;
    const sameLine = oy >= 0.5 * Math.min(a.y1 - a.y0 + 1, b.y1 - b.y0 + 1) && gapX(a, b) <= reach;
    return (sameColumn || sameLine) && !divided(a, b);
  };
  const gone = new Set();
  for (let sweep = 0; sweep < 3; sweep++) {
    list.sort((p, q) => q.anchors - p.anchors);
    let merged = false;
    for (const tail of list) {
      if (tail.anchors > 3 || gone.has(tail)) continue;
      spend(list.length);
      const head = list.find((b) => b !== tail && !gone.has(b) && b.anchors >= tail.anchors && inLine(b, tail));
      if (!head) continue;
      absorb(head, tail);
      head.anchors += tail.anchors;
      head.small += tail.small;
      head.size = Math.max(head.size, tail.size);
      gone.add(tail);
      merged = true;
    }
    if (!merged) break;
    list = list.filter((b) => !gone.has(b));
  }
  const margin = Math.max(2, Math.round(clamp(0.2 * scale * s, 4, 10) / s));
  /** @param {Block} b */
  const inClearMargin = (b) => {
    const r = margin;
    spend(anchors.length + 4 * 25 * r);
    const others = anchors.filter((c) => (c.x1 < b.x0 || c.x0 > b.x1 || c.y1 < b.y0 || c.y0 > b.y1)
      && c.x1 >= b.x0 - r && c.x0 <= b.x1 + r && c.y1 >= b.y0 - r && c.y0 <= b.y1 + r);
    /** @param {number} x @param {number} y @param {number} dx @param {number} dy */
    const ray = (x, y, dx, dy) => {
      for (let k = 1; k <= r; k++) {
        const qx = x + dx * k; const qy = y + dy * k;
        if (qx < 0 || qy < 0 || qx >= ww || qy >= wh) return -1;
        if (others.some((c) => qx >= c.x0 && qx <= c.x1 && qy >= c.y0 && qy <= c.y1)) return -1;
        if (!isPaper(LUM[qy * ww + qx])) return 0;
      }
      return 1;
    };
    const stepX = Math.max(1, Math.floor((b.x1 - b.x0 + 1) / 24));
    const stepY = Math.max(1, Math.floor((b.y1 - b.y0 + 1) / 24));
    const clear = [0, 0, 0, 0];
    const seen = [0, 0, 0, 0];
    /** @param {number} side @param {number} v */
    const add = (side, v) => { if (v >= 0) { seen[side]++; clear[side] += v; } };
    for (let x = b.x0; x <= b.x1; x += stepX) { add(0, ray(x, b.y0, 0, -1)); add(1, ray(x, b.y1, 0, 1)); }
    for (let y = b.y0; y <= b.y1; y += stepY) { add(2, ray(b.x0, y, -1, 0)); add(3, ray(b.x1, y, 1, 0)); }
    let crowded = 0; let all = 0; let ok = 0;
    for (let i = 0; i < 4; i++) {
      if (seen[i] && clear[i] < 0.5 * seen[i]) crowded++;
      all += seen[i];
      ok += clear[i];
    }
    return all > 0 && crowded <= 1 && ok >= 0.7 * all;
  };
  return { blocks: list.filter((b) => !(b.anchors > 30 && b.small > 0.8 * b.anchors)), edges, scale, clear: inClearMargin, apart: divided };
}

/**
 * @param {Blocks} found
 * @param {Box} mb
 * @param {Window} win
 * @param {Claim[]} taken
 * @param {Box} model
 * @returns {{kind: 'ok'|'grow'|'duplicate', refined: Refined, score: number} | null}
 */
function pick(found, mb, win, taken, model) {
  const { blocks, edges, scale, clear, apart } = found;
  if (!blocks.length) return null;
  const { wx0, wy0, ww, wh, s, W, H } = win;
  const mbw = mb.x1 - mb.x0;
  const mbh = mb.y1 - mb.y0;
  const mbArea = Math.max(1, mbw * mbh);
  const mside = Math.max(mbw, mbh);
  /** @param {Block} b */
  const toPx = (b) => ({
    x0: wx0 + b.x0 * s, y0: wy0 + b.y0 * s,
    x1: Math.min(W, wx0 + (b.x1 + 1) * s), y1: Math.min(H, wy0 + (b.y1 + 1) * s),
  });
  const scored = [];
  for (const b of blocks) {
    const bw = b.x1 - b.x0 + 1;
    const bh = b.y1 - b.y0 + 1;
    const iw = Math.min(b.x1 + 1, mb.x1) - Math.max(b.x0, mb.x0);
    const ih = Math.min(b.y1 + 1, mb.y1) - Math.max(b.y0, mb.y0);
    const inter = iw > 0 && ih > 0 ? iw * ih : 0;
    const covB = inter / mbArea;
    const covC = inter / (bw * bh);
    let score;
    if (inter > 0) score = 1 + covB + covC;
    else {
      const d = Math.hypot((b.x0 + b.x1 + 1) / 2 - (mb.x0 + mb.x1) / 2, (b.y0 + b.y1 + 1) / 2 - (mb.y0 + mb.y1) / 2) / Math.max(1, mside);
      const aspect = Math.abs(Math.log((bw / bh) / Math.max(1e-3, mbw / Math.max(1e-3, mbh))));
      const size = Math.abs(Math.log((bw * bh) / mbArea));
      score = d < 1.2 && aspect < Math.log(2.5) && size < Math.log(4) ? 1 - d / 1.2 : 0;
    }
    if (score <= 0 || !clear(b)) continue;
    const box = toPx(b);
    const claim = taken.find((c) => overlapRatio(c.box, box) > 0.5);
    scored.push({ b, box, covB, covC, score, claim });
  }
  if (!scored.length) return null;
  scored.sort((p, q) => q.score - p.score);

  const best = scored[0];
  const glyph = scale * s;
  if (best.claim && (best.covB >= 0.3 || best.covC >= 0.6) && overlapRatio(best.claim.model, model) >= 0.3) {
    return { kind: 'duplicate', refined: { box: best.box, glyph }, score: best.score };
  }
  const chosen = scored.find((c) => !c.claim);
  if (best.claim && best.covB >= 0.5 && !(chosen && chosen.covB > 0)) {
    return { kind: 'duplicate', refined: { box: best.box, glyph }, score: best.score };
  }
  if (!chosen) return null;
  const parts = [chosen, ...scored.filter((c) => c !== chosen && !c.claim && c.covC >= 0.5
    && c.b.size >= 0.5 * chosen.b.size && c.b.size <= 2 * chosen.b.size && !apart(chosen.b, c.b))];
  const u = {
    x0: Math.min(...parts.map((c) => c.b.x0)), y0: Math.min(...parts.map((c) => c.b.y0)),
    x1: Math.max(...parts.map((c) => c.b.x1)), y1: Math.max(...parts.map((c) => c.b.y1)), anchors: 0, size: chosen.b.size,
  };
  const out = toPx(u);
  const outArea = (out.x1 - out.x0) * (out.y1 - out.y0);
  const modelArea = (model.x1 - model.x0) * (model.y1 - model.y0);
  if (outArea < 0.12 * modelArea && chosen.covB < 0.12) return null;
  const g = 0.85 * scale;
  const cut = edges.some((e) => gapX(e, u) <= g && gapY(e, u) <= g);
  const atWindowEdge = (u.x0 <= g && wx0 > 0) || (u.y0 <= g && wy0 > 0)
    || (u.x1 >= ww - 1 - g && wx0 + ww * s < W) || (u.y1 >= wh - 1 - g && wy0 + wh * s < H);
  return { kind: cut || atWindowEdge ? 'grow' : 'ok', refined: { box: out, glyph }, score: chosen.score };
}
