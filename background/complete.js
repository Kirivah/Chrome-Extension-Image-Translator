// @ts-check

/** @typedef {import('./analysis.js').Pixels} Pixels */
/** @typedef {import('./analysis.js').Box} Box */
/** @typedef {import('./textmap.js').TextBlock} TextBlock */

const MAX_WINDOW = 1_500_000;
const CHROMA = 60;

/**
 * @param {Pixels} px
 * @param {TextBlock[]} found
 * @param {Box[]} others
 * @returns {TextBlock | null}
 */
export function completeLettering(px, found, others = []) {
  if (!found.length) return null;
  const { data, W, H } = px;
  const glyph = median(found.map((b) => b.glyph));
  if (!(glyph >= 6)) return null;
  const box = union(found.map((b) => b.box));
  const vertical = found.some((b) => b.vertical) || box.y1 - box.y0 > 1.3 * (box.x1 - box.x0);
  const side = Math.round(0.4 * glyph);
  const breadth = vertical ? box.x1 - box.x0 + 2 * side : box.y1 - box.y0 + 2 * side;
  const ext = Math.max(Math.round(2.5 * glyph), Math.floor((MAX_WINDOW / Math.max(1, breadth) - (vertical ? box.y1 - box.y0 : box.x1 - box.x0)) / 2));
  const wx0 = Math.max(0, Math.floor(box.x0 - (vertical ? side : ext)));
  const wy0 = Math.max(0, Math.floor(box.y0 - (vertical ? ext : side)));
  const wx1 = Math.min(W, Math.ceil(box.x1 + (vertical ? side : ext)));
  const wy1 = Math.min(H, Math.ceil(box.y1 + (vertical ? ext : side)));
  const w = wx1 - wx0; const h = wy1 - wy0;
  if (w <= 2 || h <= 2 || w * h > MAX_WINDOW) return null;
  const n = w * h;

  const seed = new Uint8Array(n);
  for (const b of found) {
    const m = b.mask;
    for (let my = 0; my < m.h; my++) {
      for (let mx = 0; mx < m.w; mx++) {
        if (!m.bits[my * m.w + mx]) continue;
        const X0 = Math.floor((m.x0 + mx) * m.s); const Y0 = Math.floor((m.y0 + my) * m.s);
        for (let Y = Math.max(wy0, Y0); Y < Math.min(wy1, Math.ceil((m.y0 + my + 1) * m.s)); Y++) {
          for (let X = Math.max(wx0, X0); X < Math.min(wx1, Math.ceil((m.x0 + mx + 1) * m.s)); X++) seed[(Y - wy0) * w + X - wx0] = 1;
        }
      }
    }
  }
  const lum = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0, i = ((wy0 + y) * W + wx0) * 4; x < w; x++, i += 4) lum[y * w + x] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  const inkLum = found.reduce((a, b) => a + b.ink * Math.max(1, b.cells), 0) / found.reduce((a, b) => a + Math.max(1, b.cells), 0);
  /** @type {number[][]} */
  const ch = [[], [], []];
  for (let k = 0; k < n; k++) {
    if (!seed[k] || Math.abs(lum[k] - inkLum) > 30) continue;
    const x = k % w; const i = ((wy0 + (k - x) / w) * W + wx0 + x) * 4;
    for (let c = 0; c < 3; c++) ch[c].push(data[i + c]);
  }
  if (ch[0].length < 30) return null;
  const ink = ch.map(median);
  const spread = Math.max(...ch.map((v, c) => median(v.map((q) => Math.abs(q - ink[c])))));
  const tol = Math.max(28, Math.min(60, 3 * spread + 16));
  const chromatic = Math.max(...ink) - Math.min(...ink) >= CHROMA;
  /** @param {number} k */
  const inky = (k) => {
    const x = k % w; const i = ((wy0 + (k - x) / w) * W + wx0 + x) * 4;
    return Math.abs(data[i] - ink[0]) <= tol && Math.abs(data[i + 1] - ink[1]) <= tol && Math.abs(data[i + 2] - ink[2]) <= tol;
  };
  const near = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (seed[k] && inky(k)) near[k] = 1;
  const inner = near.slice();
  grow(inner, w, h, 2);
  const ring = near.slice();
  grow(ring, w, h, Math.max(4, Math.round(0.12 * glyph)));
  /** @type {number[]} */
  const tones = [];
  for (let k = 0; k < n; k++) if (ring[k] && !inner[k]) tones.push(lum[k]);
  const tone = tones.length ? median(tones) : 0;
  const tSpread = tones.length ? median(tones.map((v) => Math.abs(v - tone))) : 255;
  const outlined = tones.length >= 30 && Math.abs(tone - inkLum) >= 80 && tSpread <= 14;
  if (!chromatic) return null;
  const oTol = Math.max(24, 3 * tSpread + 12);

  /** @param {number} k */
  const acrossOf = (k) => (vertical ? k % w : Math.floor(k / w));
  /** @param {number} k */
  const alongOf = (k) => (vertical ? Math.floor(k / w) : k % w);
  const span = vertical ? w : h;
  const profile = new Uint32Array(span);
  for (let k = 0; k < n; k++) if (near[k]) profile[acrossOf(k)]++;
  /** @type {{a0: number, a1: number, lo: number, hi: number}[]} */
  const cols = [];
  const gapMin = Math.max(2, Math.round(0.25 * glyph));
  let start = -1; let last = -1;
  for (let a = 0; a <= span; a++) {
    const on = a < span && profile[a] > 0;
    if (on) { if (start < 0) start = a; last = a; } else if (start >= 0 && a - last > gapMin) { cols.push({ a0: start, a1: last, lo: Infinity, hi: -Infinity }); start = -1; }
  }
  if (start >= 0) cols.push({ a0: start, a1: last, lo: Infinity, hi: -Infinity });
  for (const c of cols) if (c.a1 - c.a0 > 1.8 * glyph) { const mid = peak(profile, c.a0, c.a1, glyph); c.a0 = Math.max(c.a0, Math.round(mid - 0.6 * glyph)); c.a1 = Math.min(c.a1, Math.round(mid + 0.6 * glyph)); }
  for (let k = 0; k < n; k++) {
    if (!near[k]) continue;
    const a = acrossOf(k); const t = alongOf(k);
    for (const c of cols) if (a >= c.a0 && a <= c.a1) { if (t < c.lo) c.lo = t; if (t > c.hi) c.hi = t; }
  }
  const live = cols.filter((c) => c.hi >= c.lo);
  if (!live.length) return null;
  const size = Math.max(glyph, median(live.map((c) => c.a1 - c.a0 + 1)));

  const banned = new Uint8Array(n);
  for (const o of others) {
    for (let Y = Math.max(wy0, Math.floor(o.y0)); Y < Math.min(wy1, Math.ceil(o.y1)); Y++) {
      for (let X = Math.max(wx0, Math.floor(o.x0)); X < Math.min(wx1, Math.ceil(o.x1)); X++) banned[(Y - wy0) * w + X - wx0] = 1;
    }
  }
  const label = new Int32Array(n).fill(-1);
  /** @type {{x0: number, y0: number, x1: number, y1: number, n: number, ring: number, toned: number, seeded: number, pix: number[]}[]} */
  const pieces = [];
  const stack = new Int32Array(n);
  for (let k0 = 0; k0 < n; k0++) {
    if (label[k0] >= 0 || banned[k0] || !inky(k0)) continue;
    const id = pieces.length;
    const p = { x0: w, y0: h, x1: -1, y1: -1, n: 0, ring: 0, toned: 0, seeded: 0, pix: /** @type {number[]} */ ([]) };
    let top = 0;
    stack[top++] = k0; label[k0] = id;
    while (top) {
      const k = stack[--top];
      const x = k % w; const y = (k - x) / w;
      p.pix.push(k); p.n++;
      if (seed[k]) p.seeded++;
      if (x < p.x0) p.x0 = x;
      if (x > p.x1) p.x1 = x;
      if (y < p.y0) p.y0 = y;
      if (y > p.y1) p.y1 = y;
      if (p.n > 4 * glyph * glyph) break;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (label[q] >= 0 || banned[q] || !inky(q)) continue;
          label[q] = id;
          stack[top++] = q;
        }
      }
    }
    pieces.push(p);
  }
  if (outlined) {
    for (let pi = 0; pi < pieces.length; pi++) {
      const p = pieces[pi];
      if (p.n > 4 * glyph * glyph) continue;
      const step = Math.max(1, Math.floor(p.pix.length / 400));
      for (let j = 0; j < p.pix.length; j += step) {
        const k = p.pix[j];
        const x = k % w; const y = (k - x) / w;
        for (const [dx, dy] of DIRS) {
          let q = -1;
          for (let r = 1; r <= 4; r++) {
            const xx = x + dx * r; const yy = y + dy * r;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) break;
            const t = yy * w + xx;
            if (label[t] === pi) break;
            if (r >= 3) { q = t; break; }
          }
          if (q < 0) continue;
          p.ring++;
          if (Math.abs(lum[q] - tone) <= oTol || label[q] >= 0) p.toned++;
        }
      }
    }
  }

  const out = new Uint8Array(n);
  let added = 0;
  const reachGap = Math.round(1.1 * size);
  const big = 1.7 * size;
  /** @param {typeof pieces[number]} p */
  const fits = (p) => {
    if (p.n > 4 * size * size || p.x1 - p.x0 + 1 > big || p.y1 - p.y0 + 1 > big) return false;
    if (outlined && (p.ring < 8 || p.toned < (chromatic ? 0.55 : 0.75) * p.ring)) return false;
    return true;
  };
  for (const c of live) {
    let lo = c.lo; let hi = c.hi;
    const inCol = (/** @type {typeof pieces[number]} */ p) => {
      const a0 = vertical ? p.x0 : p.y0; const a1 = vertical ? p.x1 : p.y1;
      const mid = (a0 + a1) / 2;
      return mid >= c.a0 - 0.3 * size && mid <= c.a1 + 0.3 * size;
    };
    const cand = pieces.filter((p) => inCol(p) && fits(p));
    const taken = new Set();
    for (let more = true; more;) {
      more = false;
      for (const p of cand) {
        if (taken.has(p)) continue;
        const t0 = vertical ? p.y0 : p.x0; const t1 = vertical ? p.y1 : p.x1;
        if (t1 < lo - reachGap || t0 > hi + reachGap) continue;
        taken.add(p);
        if (t0 < lo) { lo = t0; more = true; }
        if (t1 > hi) { hi = t1; more = true; }
      }
    }
    for (const p of taken) {
      for (const k of p.pix) out[k] = 1;
      if (p.seeded < 0.5 * p.n) added++;
    }
  }
  if (!added) return null;
  for (let k = 0; k < n; k++) if (near[k]) out[k] = 1;
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let k = 0; k < n; k++) {
    if (!out[k]) continue;
    const x = k % w; const y = (k - x) / w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const mw = x1 - x0 + 1; const mh = y1 - y0 + 1;
  const bits = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) bits[y * mw + x] = out[(y0 + y) * w + x0 + x];
  return {
    box: { x0: wx0 + x0, y0: wy0 + y0, x1: wx0 + x1 + 1, y1: wy0 + y1 + 1 },
    glyph: size,
    dark: found[0].dark,
    vertical,
    cells: found.reduce((a, b) => a + b.cells, 0) + added,
    ink: inkLum,
    paper: found.reduce((a, b) => a + b.paper, 0) / found.length,
    mask: { x0: wx0 + x0, y0: wy0 + y0, w: mw, h: mh, s: 1, bits },
  };
}

const DIRS = /** @type {const} */ ([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]);

/** @param {number[]} v */
function median(v) {
  const s = v.slice().sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
}

/** @param {Box[]} boxes @returns {Box} */
function union(boxes) {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

/**
 * @param {Uint32Array} profile
 * @param {number} a0
 * @param {number} a1
 * @param {number} glyph
 */
function peak(profile, a0, a1, glyph) {
  const r = Math.max(1, Math.round(0.5 * glyph));
  let best = a0; let most = -1;
  for (let a = a0; a <= a1; a++) {
    let s = 0;
    for (let b = Math.max(a0, a - r); b <= Math.min(a1, a + r); b++) s += profile[b];
    if (s > most) { most = s; best = a; }
  }
  return best;
}

/**
 * @param {Uint8Array} m
 * @param {number} w
 * @param {number} h
 * @param {number} r
 */
function grow(m, w, h, r) {
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let cnt = 0;
    for (let x = -r; x < w; x++) {
      if (x + r < w && m[y * w + x + r]) cnt++;
      if (x - r - 1 >= 0 && m[y * w + x - r - 1]) cnt--;
      if (x >= 0 && cnt > 0) tmp[y * w + x] = 1;
    }
  }
  for (let x = 0; x < w; x++) {
    let cnt = 0;
    for (let y = -r; y < h; y++) {
      if (y + r < h && tmp[(y + r) * w + x]) cnt++;
      if (y - r - 1 >= 0 && tmp[(y - r - 1) * w + x]) cnt--;
      if (y >= 0) m[y * w + x] = cnt > 0 ? 1 : 0;
    }
  }
}
