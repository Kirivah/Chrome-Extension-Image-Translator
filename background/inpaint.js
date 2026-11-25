// @ts-check

import { patchFill } from './patchfill.js';

/** @typedef {import('./analysis.js').Pixels} Pixels */
/** @typedef {import('./analysis.js').Box} Box */
/** @typedef {import('./textmap.js').TextBlock} TextBlock */

export const MAX_ERASE_PIXELS = 600_000;
const PATCH_BUDGET_MS = 1500;

/**
 * @typedef {Object} Erased
 * @property {Box} box
 * @property {Uint8ClampedArray} rgba
 * @property {number} covered
 * @property {[number, number, number]} ink
 * @property {[number, number, number] | null} outline
 */

/**
 * @param {Pixels} px
 * @param {TextBlock[]} blocks
 * @param {Box[]} [avoid]
 * @param {(stage: string, data: unknown) => void} [debug]
 * @param {boolean} [plain]
 * @param {number} [margin]
 * @param {boolean} [colour]
 * @returns {Erased | null}
 */
export function eraseLettering(px, blocks, avoid = [], debug, plain = false, margin = 0, colour = false) {
  const { W, H } = px;
  const u = Math.max(1, blocks[0].mask.s);
  /** @param {number} d @returns {number} */
  const sc = (d) => Math.max(1, Math.round(d * u));
  const glyph = Math.max(...blocks.map((b) => b.glyph));
  const reach = Math.max(2, Math.min(sc(16), Math.round(0.34 * glyph)));
  const ctx = reach + sc(3) + margin;
  const bx0 = Math.max(0, Math.min(...blocks.map((b) => b.box.x0)) - ctx);
  const by0 = Math.max(0, Math.min(...blocks.map((b) => b.box.y0)) - ctx);
  const bx1 = Math.min(W, Math.max(...blocks.map((b) => b.box.x1)) + ctx);
  const by1 = Math.min(H, Math.max(...blocks.map((b) => b.box.y1)) + ctx);
  const w = bx1 - bx0;
  const h = by1 - by0;
  if (w <= 0 || h <= 0 || w * h > MAX_ERASE_PIXELS * Math.min(2, u * u)) return null;

  const lum = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let i = ((by0 + y) * W + bx0) * 4;
    for (let x = 0; x < w; x++, i += 4) lum[y * w + x] = (px.data[i] * 77 + px.data[i + 1] * 150 + px.data[i + 2] * 29) >> 8;
  }
  const mask = new Uint8Array(w * h);
  for (const b of blocks) {
    const m = b.mask;
    const y0 = Math.max(0, Math.ceil(m.y0 * m.s) - by0); const y1 = Math.min(h, Math.ceil((m.y0 + m.h) * m.s) - by0);
    const x0 = Math.max(0, Math.ceil(m.x0 * m.s) - bx0); const x1 = Math.min(w, Math.ceil((m.x0 + m.w) * m.s) - bx0);
    for (let y = y0; y < y1; y++) {
      const my = Math.floor((by0 + y) / m.s) - m.y0;
      if (my < 0 || my >= m.h) continue;
      const row = my * m.w;
      for (let x = x0; x < x1; x++) {
        const mx = Math.floor((bx0 + x) / m.s) - m.x0;
        if (mx >= 0 && mx < m.w && m.bits[row + mx]) mask[y * w + x] = 1;
      }
    }
  }
  fillHoles(mask, w, h, Math.round(glyph * glyph));
  const dark = blocks[0].dark;
  const paper = blocks.reduce((a, b) => a + b.paper, 0) / blocks.length;
  const ink = blocks.reduce((a, b) => a + b.ink, 0) / blocks.length;
  const mid = (ink + paper) / 2;
  let ir = 0; let ig = 0; let ib = 0; let nInk = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (mask[k] !== 1 || (dark ? lum[k] >= mid : lum[k] <= mid)) continue;
      const i = ((by0 + y) * W + bx0 + x) * 4;
      ir += px.data[i]; ig += px.data[i + 1]; ib += px.data[i + 2]; nInk++;
    }
  }
  /** @type {[number, number, number]} */
  const inkRgb = nInk ? [ir / nInk, ig / nInk, ib / nInk] : (dark ? [17, 17, 17] : [255, 255, 255]);
  dilate(mask, w, h, Math.max(1, Math.ceil(blocks[0].mask.s)), 1);
  const ring = ringAround(mask, w, h, sc(2));
  const tones = ring.map((k) => lum[k]).sort((a, b) => a - b);
  const tone = tones.length ? tones[tones.length >> 1] : paper;
  const spread = tones.length ? median(tones.map((v) => Math.abs(v - tone))) : 255;
  const banded = tones.length >= 8 && Math.abs(tone - ink) >= 60 && spread <= Math.max(6, 0.12 * Math.abs(tone - ink));
  const tol = Math.max(16, 3 * spread + 8);
  /** @param {number} k */
  const outlineTone = (k) => Math.abs(lum[k] - tone) <= tol;
  if (banded) {
    const lo = Math.min(ink, tone) + 8; const hi = Math.max(ink, tone) - tol;
    for (let step = 0; step < sc(2); step++) {
      /** @type {number[]} */
      const add = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const k = y * w + x;
          if (mask[k] || lum[k] < lo || lum[k] > hi) continue;
          if (mask[k - 1] === 1 || mask[k + 1] === 1 || mask[k - w] === 1 || mask[k + w] === 1) add.push(k);
        }
      }
      if (!add.length) break;
      for (const k of add) mask[k] = 1;
    }
  }
  /** @param {number} q */
  const solidBand = (q) => {
    if (!outlineTone(q)) return false;
    for (const d of [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1]) if (!mask[q + d] && !outlineTone(q + d)) return false;
    return true;
  };
  const { width: band, open } = banded ? outlineWidth(mask, w, h, outlineTone, reach, u) : { width: 0, open: 1 };
  debug?.('outline', { tone, spread, banded, band, open, reach });
  /** @type {number[]} */
  let frontier = [];
  const from = banded ? new Int32Array(w * h) : null;
  if (from) for (let k = 0; k < w * h; k++) if (mask[k] === 1) { frontier.push(k); from[k] = k; }
  const band2 = band * band;
  while (from && frontier.length) {
    /** @type {number[]} */
    const next = [];
    for (const k of frontier) {
      const x = k % w;
      const y = (k - x) / w;
      const f = from[k];
      const fx = f % w; const fy = (f - fx) / w;
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx; const ny = y + dy;
        if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue;
        if ((nx - fx) * (nx - fx) + (ny - fy) * (ny - fy) > band2) continue;
        const q = ny * w + nx;
        if (mask[q] || !solidBand(q)) continue;
        mask[q] = 2;
        from[q] = f;
        next.push(q);
      }
    }
    frontier = next;
  }
  if (banded && open < 0.3) {
    for (let step = 0; step < sc(3); step++) {
      /** @type {number[]} */
      const add = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const k = y * w + x;
          if (mask[k] || !outlineTone(k)) continue;
          if (mask[k - 1] === 2 || mask[k + 1] === 2 || mask[k - w] === 2 || mask[k + w] === 2) add.push(k);
        }
      }
      if (!add.length) break;
      for (const k of add) mask[k] = 2;
    }
  }
  if (banded) {
    const level = dark ? tone - 60 : tone + 60;
    /** @param {number} k */
    const art = (k) => (dark ? lum[k] < level : lum[k] > level);
    const glow = glowWidth(mask, w, h, art, reach, sc(2));
    debug?.('glow', { glow, band });
    if (glow > band + sc(2)) growFrom(mask, w, h, glow, (q) => !art(q));
  }
  let or = 0; let og = 0; let ob = 0; let nOutline = 0; let nGlyph = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = mask[y * w + x];
      if (v === 1) nGlyph++;
      if (v !== 2) continue;
      const i = ((by0 + y) * W + bx0 + x) * 4;
      or += px.data[i]; og += px.data[i + 1]; ob += px.data[i + 2]; nOutline++;
    }
  }
  /** @type {[number, number, number] | null} */
  const outlineRgb = nOutline >= 0.35 * nGlyph ? [or / nOutline, og / nOutline, ob / nOutline] : null;
  dilate(mask, w, h, banded ? sc(2) : sc(1), 2);
  const glyphs = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) if (mask[k] === 1) glyphs[k] = 1;
  dilate(glyphs, w, h, sc(1), 1);
  const near = paperNear(lum, glyphs, w, h, sc(2), Math.round(0.3 * glyph) + sc(2), banded ? open : 0, glyph);
  const edged = banded && open < 0.3;
  const onPaper = !!near && near.plain && Math.abs(near.tone - ink) >= 60 && !edged;
  debug?.('paper', near && { ...near, onPaper });
  if (near && onPaper) {
    const cut = smallMarks(lum, mask, w, h, near, Math.round(0.8 * glyph), 0.6 * glyph, blocks.some((b) => b.vertical));
    if (cut && !margin) {
      const wider = eraseLettering(px, blocks, avoid, debug, plain, Math.max(sc(4), Math.round(0.4 * glyph)), colour);
      if (wider) return wider;
    }
    const other = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) if (!mask[k] && Math.abs(lum[k] - near.tone) > STRONG) other[k] = 1;
    dilate(other, w, h, sc(1) + 1, 1);
    growFrom(mask, w, h, Math.max(sc(2), Math.min(sc(5), Math.round(0.35 * glyph))) + sc(1), (q) => !other[q]);
  }
  let covered = 0;
  for (let k = 0; k < w * h; k++) if (mask[k]) covered++;
  debug?.('mask', { mask, w, h, x0: bx0, y0: by0 });

  const across = colour && !onPaper;
  let rgb = near && onPaper ? paperFill(px, mask, bx0, by0, w, h, lum, near, sc(2) + 1)
    : across ? crossFill(px, mask, bx0, by0, w, h, fill(px, mask, bx0, by0, w, h, minorInk(lum, mask, w, h, sc(3))))
      : fill(px, mask, bx0, by0, w, h, minorInk(lum, mask, w, h, sc(3)));
  if (!plain && across) {
    const t0 = performance.now();
    rgb = patchFill(px, mask, bx0, by0, w, h, rgb, avoid, reach + sc(4), Math.max(sc(32), Math.min(sc(160), Math.round(2.5 * glyph))), t0 + PATCH_BUDGET_MS, debug);
    debug?.('patch', { ms: performance.now() - t0 });
  }
  if (!plain && !onPaper && !across) heal(px, mask, fill(px, mask, bx0, by0, w, h), rgb, bx0, by0, w, h, avoid, blocks.map((b) => b.box), u, glyph, debug);

  const edge = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) if (mask[k]) edge[k] = 255;
  softEdge(edge, w, h);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let k = 0; k < w * h; k++) {
    if (!edge[k]) continue;
    if (mask[k]) {
      rgba[k * 4] = rgb[k * 3];
      rgba[k * 4 + 1] = rgb[k * 3 + 1];
      rgba[k * 4 + 2] = rgb[k * 3 + 2];
    } else {
      const x = k % w;
      const i = ((by0 + (k - x) / w) * W + bx0 + x) * 4;
      rgba[k * 4] = px.data[i]; rgba[k * 4 + 1] = px.data[i + 1]; rgba[k * 4 + 2] = px.data[i + 2];
    }
    rgba[k * 4 + 3] = edge[k];
  }
  return { box: { x0: bx0, y0: by0, x1: bx1, y1: by1 }, rgba, covered, ink: inkRgb, outline: outlineRgb };
}

const NEIGHBOURS = /** @type {const} */ ([[1, 0], [-1, 0], [0, 1], [0, -1]]);

const STRONG = 70;
const FLAT = 28;

/**
 * @param {Uint8Array} lum
 * @param {Uint8Array} mask
 * @param {number} w
 * @param {number} h
 * @param {number} r
 * @param {number} zone
 * @param {number} rays
 * @param {number} glyph
 * @returns {{plain: boolean, tone: number, tol: number, flat: number, share: number, around: number, beyond: number, near: number, open: number, specks: number, area: number} | null}
 */
function paperNear(lum, mask, w, h, r, zone, rays, glyph) {
  const ring = ringAround(mask, w, h, r);
  if (ring.length < 12) return null;
  const n = w * h;
  /** @type {number[]} */
  const flat = [];
  for (const k of ring) {
    const x = k % w;
    let lo = 255; let hi = 0;
    for (let dy = -w; dy <= w; dy += w) {
      for (let dx = -1; dx <= 1; dx++) {
        const q = k + dy + dx;
        if (q < 0 || q >= n || (dx < 0 && x === 0) || (dx > 0 && x === w - 1) || mask[q]) continue;
        if (lum[q] < lo) lo = lum[q];
        if (lum[q] > hi) hi = lum[q];
      }
    }
    if (hi - lo <= FLAT) flat.push(lum[k]);
  }
  const flatShare = flat.length / ring.length;
  if (flat.length < 12) return { plain: false, tone: 0, tol: 0, flat: flatShare, share: 0, around: 0, beyond: 0, near: 0, open: 0, specks: 0, area: 0 };
  const tone = median(flat);
  const spread = median(flat.map((x) => Math.abs(x - tone)));
  const tol = Math.max(12, 3 * spread + 8);
  let close = 0;
  for (const k of ring) if (Math.abs(lum[k] - tone) <= tol) close++;
  const share = close / ring.length;
  const zoned = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (mask[k] === 1) zoned[k] = 1;
  const inner = zoned.slice();
  dilate(inner, w, h, Math.round(zone / 2), 1);
  dilate(zoned, w, h, zone, 1);
  let outer = 0; let outerPaper = 0;
  for (let k = 0; k < n; k++) {
    if (!zoned[k] || inner[k]) continue;
    outer++;
    if (Math.abs(lum[k] - tone) <= tol) outerPaper++;
  }
  const around = outer ? outerPaper / outer : 0;
  const off = Math.max(tol, 40);
  /** @param {number} q */
  const paperish = (q) => { const d = Math.abs(lum[q] - tone); return d <= off || (zoned[q] === 1 && d <= STRONG); };
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  for (const k of ring) if (!seen[k] && paperish(k)) { seen[k] = 1; stack[top++] = k; }
  let area = 0; let beyond = 0; let past = 0; let near = 0; let open = 0;
  /** @type {number[]} */
  const edge = [];
  /** @param {number} q */
  const reach = (q) => {
    if (seen[q] || mask[q]) return;
    if (paperish(q)) { seen[q] = 1; stack[top++] = q; } else edge.push(q);
  };
  while (top) {
    const k = stack[--top];
    area++;
    const x = k % w;
    if (zoned[k]) near++;
    else {
      past++;
      if (Math.abs(lum[k] - tone) <= tol) {
        beyond++;
        if (x === 0 || x === w - 1 || k < w || k >= n - w) open++;
      }
    }
    if (x > 0) reach(k - 1);
    if (x < w - 1) reach(k + 1);
    if (k >= w) reach(k - w);
    if (k < n - w) reach(k + w);
  }
  const dot = Math.max(2, Math.round(0.2 * glyph));
  let specks = 0;
  /** @param {number} q */
  const join = (q) => { if (!seen[q] && !mask[q] && !paperish(q)) { seen[q] = 2; stack[top++] = q; } };
  for (const k0 of edge) {
    if (seen[k0]) continue;
    seen[k0] = 2;
    top = 0;
    stack[top++] = k0;
    let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
    while (top) {
      const k = stack[--top];
      const x = k % w; const y = (k - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0) join(k - 1);
      if (x < w - 1) join(k + 1);
      if (k >= w) join(k - w);
      if (k < n - w) join(k + w);
    }
    if (x1 - x0 < dot && y1 - y0 < dot && !zoned[((y0 + y1) >> 1) * w + ((x0 + x1) >> 1)]) specks++;
  }
  const plain = flatShare >= 0.45 && share >= 0.55
    && (around >= 0.4 || beyond >= 0.25 * near || open >= Math.max(8, 0.05 * (w + h)) || rays >= 0.4)
    && !(specks >= 8 && specks >= past / 200);
  return { plain, tone, tol, flat: flatShare, share, around, beyond, near, open, specks, area };
}

/**
 * @param {Uint8Array} lum
 * @param {Uint8Array} mask
 * @param {number} w
 * @param {number} h
 * @param {{tone: number, tol: number}} paper
 * @param {number} reach
 * @param {number} most
 * @param {boolean} vertical
 * @returns {boolean}
 */
function smallMarks(lum, mask, w, h, paper, reach, most, vertical) {
  let cut = false;
  const n = w * h;
  const by = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (mask[k] === 1) by[k] = 1;
  dilate(by, w, h, reach, 1);
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  /** @type {number[]} */
  const piece = [];
  const thin = 0.75 * most; const long = 5.5 * most;
  const cap = Math.ceil(Math.max(most * most, thin * long));
  const off = Math.max(paper.tol, 40);
  for (let k0 = 0; k0 < n; k0++) {
    if (seen[k0] || mask[k0] || !by[k0] || Math.abs(lum[k0] - paper.tone) <= off) continue;
    let top = 0; let x0 = w; let y0 = h; let x1 = -1; let y1 = -1; let big = false;
    piece.length = 0;
    seen[k0] = 1; stack[top++] = k0;
    while (top) {
      const k = stack[--top];
      const x = k % w; const y = (k - x) / w;
      if (piece.length <= cap) piece.push(k); else big = true;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (seen[q] || mask[q] || Math.abs(lum[q] - paper.tone) <= off) continue;
          seen[q] = 1; stack[top++] = q;
        }
      }
    }
    const across = vertical ? x1 - x0 + 1 : y1 - y0 + 1; const along = vertical ? y1 - y0 + 1 : x1 - x0 + 1;
    const mark = across <= most && along <= most;
    const dash = across <= thin && along <= long && piece.length <= thin * along;
    if (big || !(mark || dash)) continue;
    for (const k of piece) mask[k] = 1;
    if (x0 === 0 || y0 === 0 || x1 === w - 1 || y1 === h - 1) cut = true;
  }
  return cut;
}

/**
 * @param {Pixels} px
 * @param {Uint8Array} mask
 * @param {number} bx0
 * @param {number} by0
 * @param {number} w
 * @param {number} h
 * @param {Uint8Array} lum
 * @param {{tone: number, tol: number}} paper
 * @param {number} reach
 * @returns {Float32Array}
 */
function paperFill(px, mask, bx0, by0, w, h, lum, paper, reach) {
  const n = w * h;
  const side = new Uint8Array(n);
  const depth = new Uint16Array(n);
  const from = new Int32Array(n);
  const queue = new Int32Array(n);
  let head = 0; let tail = 0;
  let shapes = 0;
  for (const s of [2, 1]) {
    for (let k = 0; k < n; k++) {
      if (mask[k]) continue;
      side[k] = Math.abs(lum[k] - paper.tone) > STRONG ? 2 : 1;
      from[k] = k;
      const x = k % w;
      if (side[k] === s && ((x > 0 && mask[k - 1]) || (x < w - 1 && mask[k + 1]) || (k >= w && mask[k - w]) || (k < n - w && mask[k + w]))) queue[tail++] = k;
    }
  }
  while (head < tail) {
    const k = queue[head++];
    if (side[k] === 2 && depth[k] >= reach) continue;
    const x = k % w; const y = (k - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const q = yy * w + xx;
        if (!mask[q] || side[q]) continue;
        if (side[k] === 2 && Math.abs(lum[q] - paper.tone) <= STRONG / 2) continue;
        side[q] = side[k];
        depth[q] = depth[k] + 1;
        from[q] = from[k];
        if (side[q] === 2) shapes++;
        queue[tail++] = q;
      }
    }
  }
  const wp = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const d = Math.abs(lum[k] - paper.tone);
    wp[k] = d <= paper.tol ? 1 : d <= STRONG ? 0.01 : 1e-4;
  }
  const rgb = fill(px, mask, bx0, by0, w, h, wp);
  if (!shapes) return rgb;
  /** @param {number} k @param {number} c */
  const shapeAt = (k, c) => { const f = from[k]; const x = f % w; return px.data[((by0 + (f - x) / w) * px.W + bx0 + x) * 4 + c]; };
  for (let k = 0; k < n; k++) {
    if (!mask[k]) continue;
    if (side[k] === 2) { for (let c = 0; c < 3; c++) rgb[k * 3 + c] = shapeAt(k, c); continue; }
    let a = 0; let m = 0; let q2 = -1;
    const x = k % w;
    for (let dy = -w; dy <= w; dy += w) {
      for (let dx = -1; dx <= 1; dx++) {
        const q = k + dy + dx;
        if (q < 0 || q >= n || (dx < 0 && x === 0) || (dx > 0 && x === w - 1)) continue;
        m++;
        if (side[q] === 2) { a++; q2 = q; }
      }
    }
    if (!a) continue;
    const t = 0.5 * a / m;
    for (let c = 0; c < 3; c++) rgb[k * 3 + c] = (1 - t) * rgb[k * 3 + c] + t * shapeAt(q2, c);
  }
  return rgb;
}

/**
 * @param {Uint8Array} mask
 * @param {number} w
 * @param {number} h
 * @param {number} most
 */
function fillHoles(mask, w, h, most) {
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  /** @param {number} k */
  const push = (k) => { if (!mask[k] && !seen[k]) { seen[k] = 1; stack[top++] = k; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (top) {
    const k = stack[--top];
    const x = k % w;
    if (x > 0) push(k - 1);
    if (x < w - 1) push(k + 1);
    if (k >= w) push(k - w);
    if (k < n - w) push(k + w);
  }
  for (let k0 = 0; k0 < n; k0++) {
    if (mask[k0] || seen[k0]) continue;
    let len = 0;
    seen[k0] = 1;
    stack[len++] = k0;
    for (let i = 0; i < len; i++) {
      const k = stack[i];
      const x = k % w;
      if (x > 0 && !mask[k - 1] && !seen[k - 1]) { seen[k - 1] = 1; stack[len++] = k - 1; }
      if (x < w - 1 && !mask[k + 1] && !seen[k + 1]) { seen[k + 1] = 1; stack[len++] = k + 1; }
      if (k >= w && !mask[k - w] && !seen[k - w]) { seen[k - w] = 1; stack[len++] = k - w; }
      if (k < n - w && !mask[k + w] && !seen[k + w]) { seen[k + w] = 1; stack[len++] = k + w; }
    }
    if (len <= most) for (let i = 0; i < len; i++) mask[stack[i]] = 1;
  }
}

/**
 * @param {Uint8Array} mask
 * @param {number} w
 * @param {number} h
 * @param {(k: number) => boolean} isTone
 * @param {number} reach
 * @param {number} u
 * @returns {{width: number, open: number}}
 */
function outlineWidth(mask, w, h, isTone, reach, u) {
  /** @type {number[]} */
  const edge = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      if (mask[k] === 1 && (mask[k - 1] !== 1 || mask[k + 1] !== 1 || mask[k - w] !== 1 || mask[k + w] !== 1)) edge.push(k);
    }
  }
  const stride = Math.max(1, Math.floor(edge.length / 600));
  /** @type {number[]} */
  const ended = [];
  let open = 0;
  for (let e = 0; e < edge.length; e += stride) {
    const k0 = edge[e];
    const x0 = k0 % w; const y0 = (k0 - x0) / w;
    for (const [dx, dy] of DIRS8) {
      if (mask[(y0 + dy) * w + x0 + dx] === 1) continue;
      const len = dx && dy ? Math.SQRT2 : 1;
      let entered = false;
      for (let k = 1; ; k++) {
        const x = x0 + k * dx; const y = y0 + k * dy;
        if (x < 0 || y < 0 || x >= w || y >= h) break;
        const q = y * w + x;
        if (mask[q] === 1) break;
        if (!isTone(q)) {
          if (entered) ended.push((k - 1) * len);
          else if (k <= Math.max(2, Math.round(u))) continue;
          break;
        }
        entered = true;
        if ((k - 1) * len > reach) { open++; break; }
      }
    }
  }
  const share = open / Math.max(1, open + ended.length);
  if (ended.length < 12) return { width: open > ended.length ? Math.round(2 * u) : reach, open: share };
  ended.sort((a, b) => a - b);
  return { width: Math.max(1, Math.min(reach, ended[Math.floor(0.25 * ended.length)] + Math.round(2 * u))), open: share };
}

const DIRS8 = /** @type {const} */ ([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]);

/**
 * @param {Uint8Array} mask
 * @param {number} w
 * @param {number} h
 * @param {(k: number) => boolean} art
 * @param {number} reach
 * @param {number} soft
 */
function glowWidth(mask, w, h, art, reach, soft) {
  const near = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) if (mask[k] === 1) near[k] = 1;
  dilate(near, w, h, soft, 1);
  /** @type {number[]} */
  const edge = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      if (mask[k] === 1 && (mask[k - 1] !== 1 || mask[k + 1] !== 1 || mask[k - w] !== 1 || mask[k + w] !== 1)) edge.push(k);
    }
  }
  const stride = Math.max(1, Math.floor(edge.length / 600));
  /** @type {number[]} */
  const met = [];
  let rays = 0;
  for (let e = 0; e < edge.length; e += stride) {
    const x0 = edge[e] % w; const y0 = (edge[e] - x0) / w;
    for (const [dx, dy] of DIRS8) {
      if (mask[(y0 + dy) * w + x0 + dx] === 1) continue;
      const len = dx && dy ? Math.SQRT2 : 1;
      for (let k = 1; ; k++) {
        const x = x0 + dx * k; const y = y0 + dy * k;
        if (x < 0 || y < 0 || x >= w || y >= h) break;
        if ((k - 1) * len > reach) { rays++; break; }
        const q = y * w + x;
        if (mask[q] === 1) break;
        if (art(q)) { if (!near[q]) { rays++; met.push((k - 1) * len); } break; }
      }
    }
  }
  if (met.length < 0.4 * rays || met.length < 12) return 0;
  met.sort((a, b) => a - b);
  return met[Math.floor(0.25 * met.length)];
}

/**
 * @param {Uint8Array} mask
 * @param {number} w
 * @param {number} h
 * @param {number} r
 * @param {(k: number) => boolean} ok
 */
function growFrom(mask, w, h, r, ok) {
  const from = new Int32Array(w * h).fill(-1);
  /** @type {number[]} */
  let frontier = [];
  for (let k = 0; k < w * h; k++) if (mask[k] === 1) { frontier.push(k); from[k] = k; }
  const r2 = r * r;
  while (frontier.length) {
    /** @type {number[]} */
    const next = [];
    for (const k of frontier) {
      const x = k % w; const y = (k - x) / w;
      const f = from[k]; const fx = f % w; const fy = (f - fx) / w;
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx; const ny = y + dy;
        if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue;
        const q = ny * w + nx;
        if (from[q] >= 0 || mask[q] === 1) continue;
        if ((nx - fx) * (nx - fx) + (ny - fy) * (ny - fy) > r2) continue;
        if (!mask[q] && !ok(q)) continue;
        from[q] = f;
        if (!mask[q]) mask[q] = 2;
        next.push(q);
      }
    }
    frontier = next;
  }
}

/** @param {number[]} v */
function median(v) {
  const s = v.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * @param {Uint8Array} mask
 * @param {number} w
 * @param {number} h
 * @param {number} r
 * @returns {number[]}
 */
function ringAround(mask, w, h, r) {
  const grown = mask.slice();
  dilate(grown, w, h, r, 1);
  /** @type {number[]} */
  const out = [];
  let n = 0;
  for (let k = 0; k < w * h; k++) if (grown[k] && !mask[k]) n++;
  const step = Math.max(1, Math.floor(n / 4000));
  let i = 0;
  for (let k = 0; k < w * h; k++) if (grown[k] && !mask[k] && i++ % step === 0) out.push(k);
  return out;
}

/**
 * @param {Uint8Array} mask
 * @param {number} w
 * @param {number} h
 * @param {number} r
 * @param {number} v
 */
function dilate(mask, w, h, r, v) {
  if (r <= 0 || !w || !h) return;
  const rows = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let n = 0;
    for (let x = 0; x < Math.min(r, w); x++) if (mask[o + x]) n++;
    for (let x = 0; x < w; x++) {
      if (x + r < w && mask[o + x + r]) n++;
      if (n) rows[o + x] = 1;
      if (x - r >= 0 && mask[o + x - r]) n--;
    }
  }
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y < Math.min(r, h); y++) if (rows[y * w + x]) n++;
    for (let y = 0; y < h; y++) {
      const k = y * w + x;
      if (y + r < h && rows[k + r * w]) n++;
      if (n && !mask[k]) mask[k] = v;
      if (y - r >= 0 && rows[k - r * w]) n--;
    }
  }
}

/**
 * @param {Uint8Array} a
 * @param {number} w
 * @param {number} h
 */
function softEdge(a, w, h) {
  for (const level of [140, 55]) {
    const was = a.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        if (was[k]) continue;
        if ((x > 0 && was[k - 1] > level) || (x < w - 1 && was[k + 1] > level) || (y > 0 && was[k - w] > level) || (y < h - 1 && was[k + w] > level)) a[k] = level;
      }
    }
  }
}

const MIN_PIECE = 16;
const RING_SAMPLES = 240;
const MATCHED = 0.6;
const GRAIN = 0.6;
const COLOUR_SHIFT = 14;
const HEAL_BUDGET_MS = 150;

/**
 * @param {Pixels} px
 * @param {Uint8Array} mask
 * @param {Float32Array} plain
 * @param {Float32Array} rgb
 * @param {number} bx0
 * @param {number} by0
 * @param {number} w
 * @param {number} h
 * @param {Box[]} avoid
 * @param {Box[]} own
 * @param {number} u
 * @param {number} glyph
 * @param {(stage: string, data: unknown) => void} [debug]
 */
function heal(px, mask, plain, rgb, bx0, by0, w, h, avoid, own, u, glyph, debug) {
  const { data, W, H } = px;
  const n = w * h;
  /** @param {number} d @returns {number} */
  const sc = (d) => Math.max(1, Math.round(d * u));
  /** @param {number} X @param {number} Y */
  const lumAt = (X, Y) => { const i = (Y * W + X) * 4; return (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8; };
  /** @param {number} X @param {number} Y */
  const masked = (X, Y) => { const x = X - bx0; const y = Y - by0; return x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] !== 0; };
  const done = new Uint8Array(n);
  /** @param {number} X @param {number} Y */
  const known = (X, Y) => { const x = X - bx0; const y = Y - by0; if (x < 0 || y < 0 || x >= w || y >= h) return true; const k = y * w + x; return !mask[k] || done[k] === 1; };
  /** @param {number} X @param {number} Y @param {number} c */
  const rgbNow = (X, Y, c) => {
    const x = X - bx0; const y = Y - by0;
    if (x >= 0 && y >= 0 && x < w && y < h) { const k = y * w + x; if (done[k]) return rgb[k * 3 + c]; }
    return data[(Y * W + X) * 4 + c];
  };
  /** @param {number} X @param {number} Y */
  const lumNow = (X, Y) => {
    const x = X - bx0; const y = Y - by0;
    if (x >= 0 && y >= 0 && x < w && y < h) { const k = y * w + x; if (done[k]) return (77 * rgb[k * 3] + 150 * rgb[k * 3 + 1] + 29 * rgb[k * 3 + 2]) / 256; }
    return lumAt(X, Y);
  };
  const seen = new Uint8Array(n);
  const until = performance.now() + HEAL_BUDGET_MS;
  const side = new Uint8Array(n);
  /** @type {number[]} */
  const stack = [];
  /** @type {{comp: number[], cx0: number, cy0: number, cx1: number, cy1: number}[]} */
  const pieces = [];
  for (let k0 = 0; k0 < n; k0++) {
    if (!mask[k0] || seen[k0]) continue;
    /** @type {number[]} */
    const comp = [];
    let cx0 = w; let cy0 = h; let cx1 = -1; let cy1 = -1;
    stack.push(k0); seen[k0] = 1;
    while (stack.length) {
      const k = /** @type {number} */ (stack.pop());
      comp.push(k);
      const x = k % w; const y = (k - x) / w;
      if (x < cx0) cx0 = x;
      if (x > cx1) cx1 = x;
      if (y < cy0) cy0 = y;
      if (y > cy1) cy1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (mask[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
        }
      }
    }
    if (comp.length >= MIN_PIECE * u * u) pieces.push({ comp, cx0, cy0, cx1, cy1 });
  }
  pieces.sort((a, b) => b.comp.length - a.comp.length);
  const T = Math.max(sc(12), Math.round(0.75 * glyph));
  for (const p of pieces) {
    if (Math.max(p.cx1 - p.cx0, p.cy1 - p.cy0) + 1 <= 2 * T) {
      healPiece(p.comp, p.cx0, p.cy0, p.cx1, p.cy1, performance.now() > until, false);
      continue;
    }
    sides(p.comp);
    const dir = grain(p);
    debug?.('grain', { box: [bx0 + p.cx0, by0 + p.cy0, bx0 + p.cx1, by0 + p.cy1], ...dir });
    if (dir.c >= GRAIN) { streak(p.comp, dir.dx, dir.dy, Math.max(p.cx1 - p.cx0, p.cy1 - p.cy0) + sc(24)); continue; }
    for (const t of tilesOf(p.comp, T)) healPiece(t.comp, t.cx0, t.cy0, t.cx1, t.cy1, performance.now() > until, p);
  }

  /**
   * @param {{cx0: number, cy0: number, cx1: number, cy1: number}} p
   * @returns {{dx: number, dy: number, c: number}}
   */
  function grain(p) {
    const m = sc(10);
    let xx = 0; let yy = 0; let xy = 0; let n = 0; let edges = 0;
    const x0 = Math.max(1, bx0 + p.cx0 - m); const x1 = Math.min(W - 2, bx0 + p.cx1 + m);
    const y0 = Math.max(1, by0 + p.cy0 - m); const y1 = Math.min(H - 2, by0 + p.cy1 + m);
    for (let Y = y0; Y <= y1; Y++) {
      for (let X = x0; X <= x1; X++) {
        if (masked(X, Y) || masked(X - 1, Y) || masked(X + 1, Y) || masked(X, Y - 1) || masked(X, Y + 1)) continue;
        const gx = lumAt(X + 1, Y) - lumAt(X - 1, Y); const gy = lumAt(X, Y + 1) - lumAt(X, Y - 1);
        xx += gx * gx; yy += gy * gy; xy += gx * gy;
        n++;
        if (gx * gx + gy * gy > 400) edges++;
      }
    }
    const tr = xx + yy;
    if (tr <= 0 || edges < 0.2 * n) return { dx: 0, dy: 1, c: 0 };
    const c = Math.sqrt((xx - yy) * (xx - yy) + 4 * xy * xy) / tr;
    const theta = 0.5 * Math.atan2(2 * xy, xx - yy);
    return { dx: -Math.sin(theta), dy: Math.cos(theta), c };
  }

  /**
   * @param {number[]} comp
   * @param {number} dx
   * @param {number} dy
   * @param {number} L
   */
  function streak(comp, dx, dy, L) {
    const run = sc(10);
    const vl = new Float32Array(run); const vr = new Float32Array(run); const vg = new Float32Array(run); const vb = new Float32Array(run);
    /**
     * @param {number} X
     * @param {number} Y
     */
    const where = (X, Y) => {
      if (X < 0 || Y < 0 || X >= W || Y >= H) return -2;
      const x = X - bx0; const y = Y - by0;
      if (x >= 0 && y >= 0 && x < w && y < h) {
        const k = y * w + x;
        if (mask[k]) return done[k] ? -3 - k : -1;
      }
      return (Y * W + X) * 4;
    };
    /** @param {number} s @param {number} j */
    const put = (s, j) => {
      let r; let g; let b;
      if (s >= 0) { r = data[s]; g = data[s + 1]; b = data[s + 2]; } else { const k = -3 - s; r = rgb[k * 3]; g = rgb[k * 3 + 1]; b = rgb[k * 3 + 2]; }
      const l = 77 * r + 150 * g + 29 * b;
      let p = j;
      for (; p > 0 && vl[p - 1] > l; p--) { vl[p] = vl[p - 1]; vr[p] = vr[p - 1]; vg[p] = vg[p - 1]; vb[p] = vb[p - 1]; }
      vl[p] = l; vr[p] = r; vg[p] = g; vb[p] = b;
    };
    const got = new Float32Array(6);
    const dist = [0, 0];
    const out = new Float32Array(comp.length * 3);
    const has = new Uint8Array(comp.length);
    for (let c = 0; c < comp.length; c++) {
      const k = comp[c];
      const x = k % w; const y = (k - x) / w;
      const X = bx0 + x; const Y = by0 + y;
      dist[0] = 0; dist[1] = 0;
      for (let side2 = 0; side2 < 2; side2++) {
        const sgn = side2 ? -1 : 1;
        for (let t = 1; t <= L; t++) {
          const s0 = where(Math.round(X + sgn * t * dx), Math.round(Y + sgn * t * dy));
          if (s0 === -2) break;
          if (s0 === -1) continue;
          let m = 0;
          put(s0, m++);
          for (let t2 = t + 1; t2 < t + run; t2++) {
            const s2 = where(Math.round(X + sgn * t2 * dx), Math.round(Y + sgn * t2 * dy));
            if (s2 === -1 || s2 === -2) break;
            put(s2, m++);
          }
          const mid = m >> 1;
          got[side2 * 3] = vr[mid]; got[side2 * 3 + 1] = vg[mid]; got[side2 * 3 + 2] = vb[mid];
          dist[side2] = t;
          break;
        }
      }
      const [d0, d1] = dist;
      if (!d0 && !d1) continue;
      has[c] = 1;
      for (let ch = 0; ch < 3; ch++) {
        out[c * 3 + ch] = d0 && d1 ? (got[ch] * d1 + got[3 + ch] * d0) / (d0 + d1) : d0 ? got[ch] : got[3 + ch];
      }
    }
    for (let c = 0; c < comp.length; c++) {
      if (!has[c]) continue;
      const k = comp[c];
      rgb[k * 3] = out[c * 3]; rgb[k * 3 + 1] = out[c * 3 + 1]; rgb[k * 3 + 2] = out[c * 3 + 2];
      done[k] = 1;
    }
  }

  /**
   * @param {number[]} comp
   * @param {number} T
   * @returns {{comp: number[], cx0: number, cy0: number, cx1: number, cy1: number}[]}
   */
  function tilesOf(comp, T) {
    const depth = new Int32Array(n).fill(-1);
    /** @type {number[]} */
    let front = [];
    for (const k of comp) {
      const x = k % w; const y = (k - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[k - 1] || !mask[k + 1] || !mask[k - w] || !mask[k + w]) { depth[k] = 0; front.push(k); }
    }
    for (let d = 1; front.length; d++) {
      /** @type {number[]} */
      const next = [];
      for (const k of front) {
        for (const q of [k - 1, k + 1, k - w, k + w]) {
          if (q < 0 || q >= n || !mask[q] || depth[q] >= 0) continue;
          depth[q] = d;
          next.push(q);
        }
      }
      front = next;
    }
    let ox = w; let oy = h;
    for (const k of comp) { const x = k % w; const y = (k - x) / w; if (x < ox) ox = x; if (y < oy) oy = y; }
    /** @type {Map<number, {comp: number[], cx0: number, cy0: number, cx1: number, cy1: number, d: number}>} */
    const tiles = new Map();
    for (const k of comp) {
      const x = k % w; const y = (k - x) / w;
      const key = Math.floor((y - oy) / T) * 4096 + Math.floor((x - ox) / T);
      let t = tiles.get(key);
      if (!t) tiles.set(key, (t = { comp: [], cx0: x, cy0: y, cx1: x, cy1: y, d: Infinity }));
      t.comp.push(k);
      if (x < t.cx0) t.cx0 = x;
      if (x > t.cx1) t.cx1 = x;
      if (y < t.cy0) t.cy0 = y;
      if (y > t.cy1) t.cy1 = y;
      t.d = Math.min(t.d, Math.max(0, depth[k]));
    }
    const all = [...tiles.entries()];
    for (const [key, t] of all) {
      if (t.comp.length >= (T * T) / 6) continue;
      const nb = [key - 1, key + 1, key - 4096, key + 4096].map((q) => tiles.get(q)).filter((q) => q && q !== t && q.comp.length >= (T * T) / 6);
      const into = nb.sort((a, b) => (b?.comp.length ?? 0) - (a?.comp.length ?? 0))[0];
      if (!into) continue;
      into.comp.push(...t.comp);
      into.cx0 = Math.min(into.cx0, t.cx0); into.cy0 = Math.min(into.cy0, t.cy0);
      into.cx1 = Math.max(into.cx1, t.cx1); into.cy1 = Math.max(into.cy1, t.cy1);
      into.d = Math.min(into.d, t.d);
      tiles.delete(key);
    }
    return [...tiles.values()].sort((a, b) => a.d - b.d);
  }

  /**
   * @param {number[]} comp
   * @param {number} cx0
   * @param {number} cy0
   * @param {number} cx1
   * @param {number} cy1
   * @param {boolean} quick
   * @param {{cx0: number, cy0: number, cx1: number, cy1: number} | false} tile
   */
  function healPiece(comp, cx0, cy0, cx1, cy1, quick, tile) {
    const cw = cx1 - cx0 + 1; const ch = cy1 - cy0 + 1;
    const M = sc(6); const R0 = sc(2); const R1 = sc(4); const T0 = sc(3); const t = sc(1);
    const ww = cw + 2 * M; const wh = ch + 2 * M;
    const dist = new Uint8Array(ww * wh).fill(255);
    /** @type {number[]} */
    let front = [];
    for (const k of comp) {
      const x = k % w; const y = (k - x) / w;
      const q = (y - cy0 + M) * ww + (x - cx0 + M);
      dist[q] = 0;
      front.push(q);
    }
    for (let d = 1; d <= M && front.length; d++) {
      /** @type {number[]} */
      const next = [];
      for (const q of front) {
        const x = q % ww; const y = (q - x) / ww;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= wh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= ww || dist[yy * ww + xx] !== 255) continue;
            dist[yy * ww + xx] = d;
            next.push(yy * ww + xx);
          }
        }
      }
      front = next;
    }
    /** @type {number[]} */
    const ring = [];
    let flat = 0; let far = 0;
    for (let y = 0; y < wh; y++) {
      for (let x = 0; x < ww; x++) {
        const d = dist[y * ww + x];
        if (d < R0 || d > M) continue;
        const X = bx0 + cx0 - M + x; const Y = by0 + cy0 - M + y;
        if (X < t || Y < t || X >= W - t || Y >= H - t || !known(X, Y)) continue;
        if (d <= R1) ring.push(X, Y);
        if (d >= T0) {
          let lo = 255; let hi = 0;
          for (let dy = -t; dy <= t; dy++) for (let dx = -t; dx <= t; dx++) { const v = lumNow(X + dx, Y + dy); if (v < lo) lo = v; if (v > hi) hi = v; }
          far++;
          if (hi - lo <= 8) flat++;
        }
      }
    }
    const nr = ring.length / 2;
    if (nr < 12) return;
    let sum = 0; let sq = 0;
    for (let i = 0; i < nr; i++) { const v = lumNow(ring[2 * i], ring[2 * i + 1]); sum += v; sq += v * v; }
    let varT = sq / nr - (sum / nr) * (sum / nr);
    const amid = !!tile && comp.filter((k) => side[k] === 1).length > 0.5 * comp.length;
    if (varT < 36 && !amid) { if (tile) for (const k of comp) done[k] = 1; return; }
    varT = Math.max(36, varT);
    const textured = (far > 0 && flat <= 0.67 * far) || amid;
    const rs = Math.max(1, Math.floor(nr / RING_SAMPLES));
    /** @type {number[]} */
    const rX = [];
    /** @type {number[]} */
    const rY = [];
    /** @type {number[]} */
    const rL = [];
    for (let i = 0; i < nr; i += rs) { rX.push(ring[2 * i]); rY.push(ring[2 * i + 1]); rL.push(lumNow(ring[2 * i], ring[2 * i + 1])); }
    const ps = Math.max(1, Math.floor(comp.length / 160));
    /** @type {number[]} */
    const pX = [];
    /** @type {number[]} */
    const pY = [];
    for (let i = 0; i < comp.length; i += ps) { const k = comp[i]; const x = k % w; pX.push(bx0 + x); pY.push(by0 + (k - x) / w); }
    const X0 = bx0 + cx0 - M; const Y0 = by0 + cy0 - M; const X1 = bx0 + cx1 + M; const Y1 = by0 + cy1 + M;
    const keepOff = tile ? avoid : [...avoid, ...own];
    /** @param {number} vx @param {number} vy */
    const clear = (vx, vy) => {
      if (X0 + vx < 0 || Y0 + vy < 0 || X1 + vx >= W || Y1 + vy >= H) return false;
      for (const b of keepOff) if (X0 + vx < b.x1 && X1 + vx >= b.x0 && Y0 + vy < b.y1 && Y1 + vy >= b.y0) return false;
      for (let i = 0; i < pX.length; i++) if (masked(pX[i] + vx, pY[i] + vy)) return false;
      return true;
    };
    const foreign = Math.max(24, 0.6 * Math.sqrt(varT));
    /**
     * @param {number} vx
     * @param {number} vy
     */
    const inside = (vx, vy) => {
      let d2 = 0; let odd = 0;
      const b = sc(2);
      for (let i = 0; i < pX.length; i++) {
        const X = pX[i] + vx; const Y = pY[i] + vy;
        let sum = 0; let cnt = 0;
        for (let yy = Math.max(0, Y - b); yy <= Math.min(H - 1, Y + b); yy++) {
          for (let xx = Math.max(0, X - b); xx <= Math.min(W - 1, X + b); xx++) { sum += lumAt(xx, yy); cnt++; }
        }
        const k = (pY[i] - by0) * w + (pX[i] - bx0);
        const want = (77 * plain[k * 3] + 150 * plain[k * 3 + 1] + 29 * plain[k * 3 + 2]) / 256;
        const d = sum / cnt - want;
        d2 += d * d;
        if (Math.abs(d) > foreign) odd++;
      }
      return (0.5 * d2) / pX.length / varT + (2.5 * odd) / pX.length;
    };
    /** @param {number} vx @param {number} vy */
    const score = (vx, vy) => {
      let s1 = 0; let s2 = 0; let m = 0;
      for (let i = 0; i < rX.length; i++) {
        const X = rX[i] + vx; const Y = rY[i] + vy;
        if (masked(X, Y)) continue;
        const d = rL[i] - lumAt(X, Y);
        s1 += d; s2 += d * d; m++;
      }
      if (m < 0.7 * rX.length) return Infinity;
      return (s2 / m - (s1 / m) * (s1 / m)) / varT;
    };
    const size = Math.max(cw, ch);
    const r = quick ? 0 : Math.max(sc(3), Math.min(sc(6), Math.round(size / 12)));
    const st = Math.max(1, Math.round(u));
    /** @param {number} vx @param {number} vy */
    const rate = (vx, vy) => (clear(vx, vy) ? score(vx, vy) + 0.04 * Math.hypot(vx, vy) / size : Infinity);
    /** @type {{vx: number, vy: number, q: number}[]} */
    const cands = [];
    /** @type {[number, number][]} */
    const bases = [];
    for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      for (const f of [0.5, 1, 1.5]) bases.push([Math.round(ux * f * (cw + 2 * M)), Math.round(uy * f * (ch + 2 * M))]);
    }
    if (tile) {
      bases.push([0, tile.cy0 - cy1 - M - 1], [0, tile.cy1 - cy0 + M + 1], [tile.cx0 - cx1 - M - 1, 0], [tile.cx1 - cx0 + M + 1, 0]);
    }
    for (const [bvx, bvy] of bases) {
      {
        let best = { vx: 0, vy: 0, q: Infinity };
        for (let dy = -r; dy <= r; dy += st) {
          for (let dx = -r; dx <= r; dx += st) {
            const q = rate(bvx + dx, bvy + dy);
            if (q < best.q) best = { vx: bvx + dx, vy: bvy + dy, q };
          }
        }
        if (st > 1 && best.q < Infinity) {
          const { vx: cx, vy: cy } = best;
          for (let dy = 1 - st; dy < st; dy++) {
            for (let dx = 1 - st; dx < st; dx++) {
              if (!dx && !dy) continue;
              const q = rate(cx + dx, cy + dy);
              if (q < best.q) best = { vx: cx + dx, vy: cy + dy, q };
            }
          }
        }
        if (best.q < Infinity) cands.push(best);
      }
    }
    cands.sort((a, b) => a.q - b.q);
    const top = cands.slice(0, 8);
    for (const c of top) c.q += inside(c.vx, c.vy);
    top.sort((a, b) => a.q - b.q);
    debug?.('piece', { box: [bx0 + cx0, by0 + cy0, bx0 + cx1, by0 + cy1], n: comp.length, varT: Math.round(varT), flat: +(flat / Math.max(1, far)).toFixed(2), cands: top.slice(0, 5).map((c) => [c.vx, c.vy, +c.q.toFixed(3)]) });
    if (!top.length || !(textured || top[0].q <= MATCHED)) return;
    let v = null;
    for (const c of top) {
      let ok = true;
      for (const k of comp) {
        const x = k % w;
        if (masked(bx0 + x + c.vx, by0 + (k - x) / w + c.vy)) { ok = false; break; }
      }
      if (ok) { v = c; break; }
    }
    if (!v) return;
    const shift = [0, 0, 0];
    {
      /** @type {number[][]} */
      const diffs = [[], [], []];
      for (let i = 0; i < rX.length; i++) {
        const X = rX[i] + v.vx; const Y = rY[i] + v.vy;
        if (masked(X, Y)) continue;
        const j = (Y * W + X) * 4;
        for (let c = 0; c < 3; c++) diffs[c].push(rgbNow(rX[i], rY[i], c) - data[j + c]);
      }
      if (diffs[0].length) for (let c = 0; c < 3; c++) shift[c] = median(diffs[c]);
      const l = (77 * shift[0] + 150 * shift[1] + 29 * shift[2]) / 256;
      if (Math.max(...shift.map((s) => Math.abs(s - l))) > COLOUR_SHIFT) return;
    }
    if (tile) {
      for (const k of comp) {
        done[k] = 1;
        if (side[k] === 2) continue;
        const x = k % w; const y = (k - x) / w;
        const i = ((by0 + y + v.vy) * W + bx0 + x + v.vx) * 4;
        for (let c = 0; c < 3; c++) rgb[k * 3 + c] = Math.min(255, Math.max(0, data[i + c] + shift[c]));
      }
      return;
    }
    const wx0 = Math.max(0, X0); const wy0 = Math.max(0, Y0);
    const wx1 = Math.min(W - 1, X1); const wy1 = Math.min(H - 1, Y1);
    const fw = wx1 - wx0 + 1; const fh = wy1 - wy0 + 1;
    const holes = new Uint8Array(fw * fh);
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) if (masked(wx0 + x, wy0 + y)) holes[y * fw + x] = 1;
    const bt = fill(px, holes, wx0, wy0, fw, fh);
    const bs = fill(px, holes, wx0 + v.vx, wy0 + v.vy, fw, fh);
    sides(comp);
    for (const k of comp) {
      if (side[k] === 2) continue;
      const x = k % w; const y = (k - x) / w;
      const X = bx0 + x; const Y = by0 + y;
      const f3 = ((Y - wy0) * fw + (X - wx0)) * 3;
      const i = ((Y + v.vy) * W + X + v.vx) * 4;
      for (let c = 0; c < 3; c++) rgb[k * 3 + c] = Math.min(255, Math.max(0, data[i + c] + bt[f3 + c] - bs[f3 + c]));
    }
  }

  /** @param {number[]} comp */
  function sides(comp) {
    /** @type {number[]} */
    let front = [];
    for (const k of comp) {
      const x = k % w; const y = (k - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (mask[q] || side[q]) continue;
          side[q] = flatAt(bx0 + xx, by0 + yy) ? 2 : 1;
          front.push(q);
        }
      }
    }
    const outside = front.slice();
    while (front.length) {
      /** @type {number[]} */
      const next = [];
      for (const q of front) {
        const x = q % w; const y = (q - x) / w;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const r = yy * w + xx;
            if (!mask[r] || side[r]) continue;
            side[r] = side[q];
            next.push(r);
          }
        }
      }
      front = next;
    }
    for (const q of outside) side[q] = 0;
  }

  /** @param {number} X @param {number} Y */
  function flatAt(X, Y) {
    let lo = 255; let hi = 0;
    const b = sc(2);
    for (let yy = Math.max(0, Y - b); yy <= Math.min(H - 1, Y + b); yy++) {
      for (let xx = Math.max(0, X - b); xx <= Math.min(W - 1, X + b); xx++) {
        const v = lumAt(xx, yy);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    return hi - lo <= 12;
  }
}

/**
 * @param {Uint8Array} lum
 * @param {Uint8Array} mask
 * @param {number} w
 * @param {number} h
 * @param {number} D
 * @returns {Float32Array}
 */
function minorInk(lum, mask, w, h, D) {
  const out = new Float32Array(w * h).fill(1);
  const steps = DIRS4.map(([dx, dy]) => D * (dy * w + dx));
  const [s0, s1, s2, s3] = steps;
  /** @param {number} v @param {number} a @param {number} b */
  const off = (v, a, b) => (a < b ? v < a - 30 || v > b + 30 : v < b - 30 || v > a + 30);
  for (let y = D; y < h - D; y++) {
    for (let x = D; x < w - D; x++) {
      const k = y * w + x;
      if (mask[k]) continue;
      const v = lum[k];
      if (off(v, lum[k + s0], lum[k - s0]) || off(v, lum[k + s1], lum[k - s1])
        || off(v, lum[k + s2], lum[k - s2]) || off(v, lum[k + s3], lum[k - s3])) out[k] = 0.04;
    }
  }
  return out;
}

const DIRS4 = /** @type {const} */ ([[1, 0], [0, 1], [1, 1], [1, -1]]);

/**
 * @param {Pixels} px
 * @param {Uint8Array} mask
 * @param {number} bx0
 * @param {number} by0
 * @param {number} w
 * @param {number} h
 * @param {Float32Array} smooth
 * @returns {Float32Array}
 */
function crossFill(px, mask, bx0, by0, w, h, smooth) {
  const { data, W } = px;
  const n = w * h;
  const out = new Float32Array(smooth);
  const acc = new Float32Array(n * 3);
  const wsum = new Float32Array(n);
  /** @param {number} x @param {number} y @param {number} dx @param {number} dy @param {number} c */
  const side = (x, y, dx, dy, c) => {
    const i = ((by0 + y) * W + bx0 + x) * 4 + c;
    const x2 = x + dx; const y2 = y + dy;
    if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h || mask[y2 * w + x2]) return data[i];
    return 0.65 * data[i] + 0.35 * data[((by0 + y2) * W + bx0 + x2) * 4 + c];
  };
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!mask[y * w + x]) { x++; continue; }
      const a = x - 1;
      while (x < w && mask[y * w + x]) x++;
      const b = x;
      if (a < 0 || b >= w) continue;
      const len = b - a;
      const wt = 1 / (len * len);
      for (let k = a + 1; k < b; k++) {
        const t = (k - a) / len;
        const q = y * w + k;
        for (let c = 0; c < 3; c++) acc[q * 3 + c] += wt * ((1 - t) * side(a, y, -1, 0, c) + t * side(b, y, 1, 0, c));
        wsum[q] += wt;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!mask[y * w + x]) { y++; continue; }
      const a = y - 1;
      while (y < h && mask[y * w + x]) y++;
      const b = y;
      if (a < 0 || b >= h) continue;
      const len = b - a;
      const wt = 1 / (len * len);
      for (let k = a + 1; k < b; k++) {
        const t = (k - a) / len;
        const q = k * w + x;
        for (let c = 0; c < 3; c++) acc[q * 3 + c] += wt * ((1 - t) * side(x, a, 0, -1, c) + t * side(x, b, 0, 1, c));
        wsum[q] += wt;
      }
    }
  }
  for (let q = 0; q < n; q++) {
    if (!mask[q] || !wsum[q]) continue;
    for (let c = 0; c < 3; c++) out[q * 3 + c] = acc[q * 3 + c] / wsum[q];
  }
  return out;
}

/**
 * @param {Pixels} px
 * @param {Uint8Array} mask
 * @param {number} bx0
 * @param {number} by0
 * @param {number} w
 * @param {number} h
 * @param {Float32Array} [weight]
 * @returns {Float32Array}
 */
function fill(px, mask, bx0, by0, w, h, weight) {
  const { data, W } = px;
  /** @type {{w: number, h: number, c: Float32Array, a: Float32Array}[]} */
  const levels = [];
  let c = new Float32Array(w * h * 3);
  let a = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (mask[k]) continue;
      const i = ((by0 + y) * W + bx0 + x) * 4;
      c[k * 3] = data[i]; c[k * 3 + 1] = data[i + 1]; c[k * 3 + 2] = data[i + 2];
      a[k] = weight ? weight[k] : 1;
    }
  }
  levels.push({ w, h, c, a });
  let lw = w; let lh = h;
  while (lw > 1 || lh > 1) {
    const nw = Math.ceil(lw / 2); const nh = Math.ceil(lh / 2);
    const nc = new Float32Array(nw * nh * 3);
    const na = new Float32Array(nw * nh);
    let holes = 0;
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let sa = 0; let sr = 0; let sg = 0; let sb = 0;
        for (let dy = 0; dy < 2; dy++) {
          const yy = 2 * y + dy;
          if (yy >= lh) continue;
          for (let dx = 0; dx < 2; dx++) {
            const xx = 2 * x + dx;
            if (xx >= lw) continue;
            const k = yy * lw + xx;
            const wt = a[k];
            sa += wt; sr += wt * c[k * 3]; sg += wt * c[k * 3 + 1]; sb += wt * c[k * 3 + 2];
          }
        }
        const k = y * nw + x;
        if (sa > 0) { nc[k * 3] = sr / sa; nc[k * 3 + 1] = sg / sa; nc[k * 3 + 2] = sb / sa; }
        else holes++;
        na[k] = Math.min(1, sa);
      }
    }
    levels.push({ w: nw, h: nh, c: nc, a: na });
    c = nc; a = na; lw = nw; lh = nh;
    if (!holes) break;
  }
  for (let li = levels.length - 2; li >= 0; li--) {
    const L = levels[li];
    const U = levels[li + 1];
    for (let y = 0; y < L.h; y++) {
      for (let x = 0; x < L.w; x++) {
        const k = y * L.w + x;
        const wt = L.a[k];
        if (wt >= 1) continue;
        const ux = Math.min(U.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
        const uy = Math.min(U.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
        const x0 = Math.floor(ux); const y0 = Math.floor(uy);
        const x1 = Math.min(U.w - 1, x0 + 1); const y1 = Math.min(U.h - 1, y0 + 1);
        const fx = ux - x0; const fy = uy - y0;
        for (let ch = 0; ch < 3; ch++) {
          const v = (1 - fy) * ((1 - fx) * U.c[(y0 * U.w + x0) * 3 + ch] + fx * U.c[(y0 * U.w + x1) * 3 + ch])
            + fy * ((1 - fx) * U.c[(y1 * U.w + x0) * 3 + ch] + fx * U.c[(y1 * U.w + x1) * 3 + ch]);
          L.c[k * 3 + ch] = wt * L.c[k * 3 + ch] + (1 - wt) * v;
        }
        L.a[k] = 1;
      }
    }
  }
  return levels[0].c;
}
