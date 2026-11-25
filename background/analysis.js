// @ts-check

/** @typedef {{data: Uint8ClampedArray, W: number, H: number}} Pixels */
/** @typedef {{x0: number, y0: number, x1: number, y1: number}} Box */
/** @typedef {[number, number, number]} RGB */
/** @typedef {{chars: number, word: number, cap: number}} TextNeed */
/**
 * @typedef {Object} Style
 * @property {0|1} m
 * @property {RGB} bg
 * @property {RGB} fg
 * @property {RGB} ol
 * @property {Box} patch
 * @property {Box} area
 * @property {Box} core
 * @property {Box} [text]
 */

const HIST = new Uint32Array(4096);
const SUMS = new Float64Array(4096 * 3);
const DIST = new Uint32Array(64);
/** @type {Uint8Array} */ let MASK = new Uint8Array(0);
/** @type {Int32Array} */ let STACK = new Int32Array(0);

const WHITE = /** @type {RGB} */ ([255, 255, 255]);
const INK = /** @type {RGB} */ ([17, 17, 17]);

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** @param {number} sens */
export function thresholds(sens) {
  const s = clamp(sens, 0, 1);
  return {
    T: 28 + 20 * s,
    A: 0.62 - 0.24 * s,
    B: 0.88 - 0.26 * s,
  };
}

/** @param {RGB} c */
export function luminance(c) {
  const f = (/** @type {number} */ v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

/** @param {RGB} a @param {RGB} b */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** @param {number} n */
function ensureScratch(n) {
  if (MASK.length < n) {
    MASK = new Uint8Array(n);
    STACK = new Int32Array(n);
  }
}

/**
 * @param {Pixels} px
 * @param {Box} box
 * @param {number} sens
 * @param {number} [glyph]
 * @param {TextNeed | null} [need]
 * @param {boolean} [inBubble]
 * @param {{ink: number, paper: number} | null} [tone]
 * @returns {Style}
 */
export function analyzeBox(px, box, sens, glyph = 0, need = null, inBubble = false, tone = null) {
  const { data, W, H } = px;
  const x0 = clamp(Math.floor(box.x0), 0, W - 1);
  const y0 = clamp(Math.floor(box.y0), 0, H - 1);
  const x1 = clamp(Math.ceil(box.x1), x0 + 1, W);
  const y1 = clamp(Math.ceil(box.y1), y0 + 1, H);
  const bw = x1 - x0;
  const bh = y1 - y0;
  const { T, A, B } = thresholds(sens);
  const T2 = T * T;

  HIST.fill(0);
  SUMS.fill(0);
  const step = Math.max(1, Math.floor(Math.sqrt((bw * bh) / 20000)));
  let n = 0;
  let mr = 0;
  let mg = 0;
  let mb = 0;
  for (let y = y0; y < y1; y += step) {
    let i = (y * W + x0) * 4;
    for (let x = x0; x < x1; x += step, i += 4 * step) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      HIST[k]++;
      SUMS[k * 3] += r;
      SUMS[k * 3 + 1] += g;
      SUMS[k * 3 + 2] += b;
      mr += r; mg += g; mb += b;
      n++;
    }
  }
  let best = 0;
  for (let k = 1; k < 4096; k++) if (HIST[k] > HIST[best]) best = k;
  if (tone) {
    let top = -1;
    for (let k = 0; k < 4096; k++) {
      if (!HIST[k]) continue;
      const l = (SUMS[k * 3] * 77 + SUMS[k * 3 + 1] * 150 + SUMS[k * 3 + 2] * 29) / 256 / HIST[k];
      if (Math.abs(l - tone.paper) < Math.abs(l - tone.ink) && (top < 0 || HIST[k] > HIST[top])) top = k;
    }
    if (top >= 0) best = top;
  }
  const seed = /** @type {RGB} */ ([SUMS[best * 3] / HIST[best], SUMS[best * 3 + 1] / HIST[best], SUMS[best * 3 + 2] / HIST[best]]);
  const mean = /** @type {RGB} */ ([mr / n, mg / n, mb / n]);

  let bc = 0; let br = 0; let bgc = 0; let bb = 0;
  const inkD2 = (2.2 * T) ** 2;
  DIST.fill(0);
  let cand = 0;
  for (let y = y0; y < y1; y += step) {
    let i = (y * W + x0) * 4;
    for (let x = x0; x < x1; x += step, i += 4 * step) {
      const dr = data[i] - seed[0];
      const dg = data[i + 1] - seed[1];
      const db = data[i + 2] - seed[2];
      const d2 = dr * dr + dg * dg + db * db;
      if (d2 <= T2) { bc++; br += data[i]; bgc += data[i + 1]; bb += data[i + 2]; }
      else if (d2 > inkD2) { cand++; DIST[Math.min(63, (Math.sqrt(d2) / 7) | 0)]++; }
    }
  }
  let cut = inkD2;
  for (let k = 63, acc = 0; k >= 0 && cand; k--) {
    acc += DIST[k];
    if (acc >= 0.1 * cand) { cut = Math.max(inkD2, (0.85 * 7 * k) ** 2); break; }
  }
  let ic = 0; let ir = 0; let ig = 0; let ib = 0;
  if (cand) {
    for (let y = y0; y < y1; y += step) {
      let i = (y * W + x0) * 4;
      for (let x = x0; x < x1; x += step, i += 4 * step) {
        const dr = data[i] - seed[0];
        const dg = data[i + 1] - seed[1];
        const db = data[i + 2] - seed[2];
        if (dr * dr + dg * dg + db * db >= cut) { ic++; ir += data[i]; ig += data[i + 1]; ib += data[i + 2]; }
      }
    }
  }
  const bg = /** @type {RGB} */ (bc ? [br / bc, bgc / bc, bb / bc] : seed);
  const bgFrac = bc / n;

  const t = Math.max(2, Math.round(Math.min(bw, bh) * 0.08));
  const rx0 = x0 - t - 1; const ry0 = y0 - t - 1; const rx1 = x1 + t + 1; const ry1 = y1 + t + 1;
  const rstep = Math.max(1, Math.floor(Math.sqrt(((rx1 - rx0) * (ry1 - ry0) - bw * bh) / 6000)));
  let rn = 0; let rm = 0;
  for (let y = ry0; y < ry1; y += rstep) {
    if (y < 0 || y >= H) continue;
    const inBand = y < y0 - 1 || y >= y1 + 1;
    for (let x = rx0; x < rx1; x += rstep) {
      if (x < 0 || x >= W) continue;
      if (!inBand && x >= x0 - 1 && x < x1 + 1) continue;
      const i = (y * W + x) * 4;
      const dr = data[i] - bg[0]; const dg = data[i + 1] - bg[1]; const db = data[i + 2] - bg[2];
      rn++;
      if (dr * dr + dg * dg + db * db <= T2) rm++;
    }
  }
  const ringFrac = rn >= 8 ? rm / rn : bgFrac;
  const plain = (inBubble && bgFrac >= 0.5 * A) || (bgFrac >= A && ringFrac >= B);

  const pad = Math.max(2, Math.round(Math.min(bw, bh) * 0.06));
  /** @type {Box} */
  const padded = {
    x0: Math.max(0, x0 - pad), y0: Math.max(0, y0 - pad),
    x1: Math.min(W, x1 + pad), y1: Math.min(H, y1 + pad),
  };

  if (!plain) {
    const m = Math.max(pad, Math.round(0.2 * glyph));
    /** @type {Box} */
    const wide = m > pad
      ? { x0: Math.max(0, x0 - m), y0: Math.max(0, y0 - m), x1: Math.min(W, x1 + m), y1: Math.min(H, y1 + m) }
      : padded;
    const dark = luminance(mean) < 0.45;
    return { m: 1, bg: mean, fg: dark ? WHITE : INK, ol: dark ? INK : WHITE, patch: wide, area: wide, core: padded };
  }

  const ink = /** @type {RGB} */ (ic ? [ir / ic, ig / ic, ib / ic] : (luminance(bg) > 0.4 ? INK : WHITE));
  const fg = contrast(ink, bg) >= 3 ? ink : (luminance(bg) > 0.4 ? INK : WHITE);
  const ol = luminance(fg) > 0.5 ? INK : WHITE;

  const bubble = floodBubble(px, x0, y0, x1, y1, bg, 1.3 * T, 1, need) ?? floodBubble(px, x0, y0, x1, y1, bg, 1.3 * T, 2.6, need);
  if (!bubble) {
    const tall = padded.y1 - padded.y0 > 1.4 * (padded.x1 - padded.x0);
    const room = tall ? growPlain(px, padded, bg, T) : need && need.cap > 0 ? growRoom(px, padded, bg, T, need) : padded;
    return { m: 0, bg, fg, ol, patch: padded, area: room, core: padded };
  }
  /** @type {Box} */
  const patch = {
    x0: Math.max(padded.x0, bubble.bbox.x0 + 1), y0: Math.max(padded.y0, bubble.bbox.y0 + 1),
    x1: Math.min(padded.x1, bubble.bbox.x1 - 1), y1: Math.min(padded.y1, bubble.bbox.y1 - 1),
  };
  if (patch.x1 - patch.x0 < 2 || patch.y1 - patch.y0 < 2) {
    return { m: 0, bg, fg, ol, patch: padded, area: padded, core: padded };
  }
  const r = bubble.rect;
  if (!r) return { m: 0, bg, fg, ol, patch, area: patch, core: patch };
  const ix = (r.x1 - r.x0) * 0.08;
  const iy = (r.y1 - r.y0) * 0.08;
  /** @type {Box} */
  const room = { x0: r.x0 + ix, y0: r.y0 + iy, x1: r.x1 - ix, y1: r.y1 - iy };
  const size = (/** @type {Box} */ q) => (need ? fontFor(q.x1 - q.x0, q.y1 - q.y0, need) : 0);
  const roomArea = (room.x1 - room.x0) * (room.y1 - room.y0);
  const patchArea = (patch.x1 - patch.x0) * (patch.y1 - patch.y0);
  const area = size(room) > size(patch) || (size(room) === size(patch) && roomArea > patchArea) ? room : patch;
  return { m: 0, bg, fg, ol, patch, area, core: patch };
}

/**
 * @param {number} w
 * @param {number} h
 * @param {TextNeed} need
 */
export function fontFor(w, h, need) {
  if (w <= 0 || h <= 0) return 0;
  const byWord = w / (0.56 * Math.max(1, need.word));
  const byArea = 0.92 * Math.sqrt((w * h) / (0.56 * 1.15 * Math.max(1, need.chars)));
  const byLine = h / 1.15;
  const f = Math.min(byWord, byArea, byLine);
  return need.cap > 0 ? Math.min(f, need.cap) : f;
}

/**
 * @param {Pixels} px
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {RGB} bg
 * @param {number} tol
 * @param {number} reach
 * @param {TextNeed | null} need
 * @returns {{bbox: Box, rect: Box | null} | null}
 */
function floodBubble(px, x0, y0, x1, y1, bg, tol, reach, need) {
  const { data, W, H } = px;
  const ext = Math.round(Math.max(x1 - x0, y1 - y0) * 0.9 * reach) + 4;
  const cx0 = Math.max(0, x0 - ext); const cy0 = Math.max(0, y0 - ext);
  const cx1 = Math.min(W, x1 + ext); const cy1 = Math.min(H, y1 + ext);
  const area = (cx1 - cx0) * (cy1 - cy0);
  if (reach > 1 && area > 1_000_000) return null;
  const g = Math.max(1, Math.ceil(Math.sqrt(area / 250000)));
  const gw = Math.ceil((cx1 - cx0) / g);
  const gh = Math.ceil((cy1 - cy0) / g);
  const cells = gw * gh;
  ensureScratch(cells);
  const mask = MASK;
  mask.fill(0, 0, cells);
  const tol2 = tol * tol;

  /** @param {number} x @param {number} y */
  const near = (x, y) => {
    const i = (Math.min(y, H - 1) * W + Math.min(x, W - 1)) * 4;
    const dr = data[i] - bg[0]; const dg = data[i + 1] - bg[1]; const db = data[i + 2] - bg[2];
    return dr * dr + dg * dg + db * db <= tol2;
  };
  const match = (/** @type {number} */ gx, /** @type {number} */ gy) => {
    const x = cx0 + gx * g;
    const y = cy0 + gy * g;
    if (g === 1) return near(x, y);
    if (g === 2) return near(x, y) && near(x + 1, y) && near(x, y + 1) && near(x + 1, y + 1);
    const e = g - 1;
    const h = g >> 1;
    return near(x, y) && near(x + e, y) && near(x, y + e) && near(x + e, y + e) && near(x + h, y + h);
  };

  let sp = 0;
  const gx0 = Math.floor((x0 - cx0) / g); const gy0 = Math.floor((y0 - cy0) / g);
  const gx1 = Math.min(gw, Math.ceil((x1 - cx0) / g)); const gy1 = Math.min(gh, Math.ceil((y1 - cy0) / g));
  for (let gy = gy0; gy < gy1; gy++) {
    for (let gx = gx0; gx < gx1; gx++) {
      const k = gy * gw + gx;
      if (match(gx, gy)) { mask[k] = 1; STACK[sp++] = k; } else mask[k] = 2;
    }
  }
  if (!sp) return null;

  /** @param {number} q @param {number} qx @param {number} qy */
  const visit = (q, qx, qy) => {
    if (mask[q]) return;
    if (match(qx, qy)) { mask[q] = 1; STACK[sp++] = q; } else mask[q] = 2;
  };
  while (sp) {
    const k = STACK[--sp];
    const gx = k % gw;
    const gy = (k - gx) / gw;
    if (gx === 0 || gy === 0 || gx === gw - 1 || gy === gh - 1) return null;
    visit(k - 1, gx - 1, gy);
    visit(k + 1, gx + 1, gy);
    visit(k - gw, gx, gy - 1);
    visit(k + gw, gx, gy + 1);
  }

  const L = new Int32Array(gh).fill(-1);
  const R = new Int32Array(gh).fill(-1);
  let top = gh; let bottom = -1; let left = gw; let right = -1;
  for (let gy = 0; gy < gh; gy++) {
    const row = gy * gw;
    for (let gx = 0; gx < gw; gx++) {
      if (mask[row + gx] !== 1) continue;
      if (L[gy] < 0) L[gy] = gx;
      R[gy] = gx;
    }
    if (L[gy] >= 0) {
      if (gy < top) top = gy;
      bottom = gy;
      if (L[gy] < left) left = L[gy];
      if (R[gy] > right) right = R[gy];
    }
  }
  if (bottom < 0) return null;

  const cy = clamp(Math.floor(((y0 + y1) / 2 - cy0) / g), top, bottom);
  const cx = Math.floor(((x0 + x1) / 2 - cx0) / g);
  let bestArea = 0;
  let bestFont = 0;
  /** @type {Box | null} */
  let best = null;
  for (let a = cy; a >= top; a--) {
    if (L[a] < 0) break;
    let l = -1; let r = gw;
    for (let b = a; b <= bottom; b++) {
      if (L[b] < 0) break;
      if (L[b] > l) l = L[b];
      if (R[b] < r) r = R[b];
      if (r - l < 1 || cx < l || cx > r) break;
      if (b < cy) continue;
      const ar = (b - a + 1) * (r - l + 1);
      const font = need ? fontFor(0.84 * (r - l + 1) * g, 0.84 * (b - a + 1) * g, need) : 0;
      if (font > bestFont * 1.02 || (font >= bestFont * 0.98 && ar > bestArea)) {
        bestFont = Math.max(bestFont, font);
        bestArea = ar;
        best = { x0: l, y0: a, x1: r + 1, y1: b + 1 };
      }
    }
  }
  const toPx = (/** @type {Box} */ q) => ({
    x0: cx0 + q.x0 * g, y0: cy0 + q.y0 * g,
    x1: Math.min(W, cx0 + q.x1 * g), y1: Math.min(H, cy0 + q.y1 * g),
  });
  const bbox = toPx({ x0: left, y0: top, x1: right + 1, y1: bottom + 1 });
  return { bbox, rect: best ? toPx(best) : null };
}

/**
 * @param {Pixels} px
 * @param {Box} box
 * @param {RGB} bg
 * @param {number} tol
 * @returns {Box}
 */
export function growPlain(px, box, bg, tol) {
  const { data, W } = px;
  const tol2 = tol * tol;
  const h = box.y1 - box.y0;
  const target = 0.8 * h;
  const step = Math.max(1, Math.round(h / 40));
  /** @param {number} xa @param {number} xb */
  const plain = (xa, xb) => {
    for (let y = box.y0; y < box.y1; y++) {
      for (let x = xa; x < xb; x++) {
        const i = (y * W + x) * 4;
        const dr = data[i] - bg[0]; const dg = data[i + 1] - bg[1]; const db = data[i + 2] - bg[2];
        if (dr * dr + dg * dg + db * db > tol2) return false;
      }
    }
    return xb > xa;
  };
  let x0 = box.x0; let x1 = box.x1;
  let left = true; let right = true;
  while (x1 - x0 < target && (left || right)) {
    if (left) { if (x0 - step >= 0 && plain(x0 - step, x0)) x0 -= step; else left = false; }
    if (x1 - x0 >= target) break;
    if (right) { if (x1 + step <= W && plain(x1, x1 + step)) x1 += step; else right = false; }
  }
  return { x0, y0: box.y0, x1, y1: box.y1 };
}

/**
 * @param {Pixels} px
 * @param {Box} box
 * @param {RGB} bg
 * @param {number} tol
 * @param {TextNeed} need
 * @returns {Box}
 */
export function growRoom(px, box, bg, tol, need) {
  const { data, W, H } = px;
  const tol2 = tol * tol;
  const cap = need.cap;
  const step = Math.max(1, Math.round(cap / 8));
  const keep = Math.max(1, Math.round(0.2 * cap));
  const reachX = 4 * cap; const reachY = 1.5 * cap;
  /** @param {number} xa @param {number} ya @param {number} xb @param {number} yb */
  const plain = (xa, ya, xb, yb) => {
    if (xa < 0 || ya < 0 || xb > W || yb > H || xb <= xa || yb <= ya) return false;
    for (let y = ya; y < yb; y++) {
      for (let x = xa, i = (y * W + xa) * 4; x < xb; x++, i += 4) {
        const dr = data[i] - bg[0]; const dg = data[i + 1] - bg[1]; const db = data[i + 2] - bg[2];
        if (dr * dr + dg * dg + db * db > tol2) return false;
      }
    }
    return true;
  };
  const b = { ...box };
  const fits = () => fontFor(b.x1 - b.x0, b.y1 - b.y0, need) >= 0.85 * cap;
  let left = true; let right = true;
  for (let n = 0; n < 400 && (left || right) && !fits(); n++) {
    if (n % 2 ? left : !right) {
      if (box.x0 - b.x0 + step <= reachX && plain(b.x0 - step - keep, b.y0, b.x0, b.y1)) b.x0 -= step; else left = false;
    } else if (b.x1 - box.x1 + step <= reachX && plain(b.x1, b.y0, b.x1 + step + keep, b.y1)) b.x1 += step; else right = false;
  }
  for (let n = 0; n < 200 && !fits(); n++) {
    if (box.y0 - b.y0 + step > reachY || !plain(b.x0, b.y0 - step - keep, b.x1, b.y0) || !plain(b.x0, b.y1, b.x1, b.y1 + step + keep)) break;
    b.y0 -= step; b.y1 += step;
  }
  return b;
}

/** @param {Box} a @param {Box} b */
function intersects(a, b) {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0;
}

/**
 * @param {Style} st
 * @returns {Box}
 */
export function footprint(st) {
  const a = st.patch; const b = st.area;
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/**
 * @param {Style[]} styles
 * @param {Style[]} [fixed]
 * @param {Style[]} [settled]
 */
export function resolveCollisions(styles, fixed = [], settled = []) {
  const all = [...styles, ...settled, ...fixed];
  for (const st of styles) {
    if (all.some((o) => o !== st && (intersects(st.patch, o.patch) || intersects(st.patch, o.area)))) st.patch = st.core;
  }
  for (let i = 0; i < styles.length; i++) {
    for (let j = i + 1; j < styles.length; j++) split(styles[i], styles[j], true);
    for (const o of settled) split(styles[i], o, true);
    for (const f of fixed) split(styles[i], f, false);
  }
}

/** @param {Box} a @param {Box} b */
export function overlap(a, b) {
  return intersects(a, b);
}

/**
 * @param {Style} a
 * @param {Style} b
 * @param {boolean} both
 */
function split(a, b, both) {
  if (!intersects(a.area, b.area)) return;
  const la = a.text ?? a.core; const lb = b.text ?? b.core;
  const gx = Math.max(lb.x0 - la.x1, la.x0 - lb.x1);
  const gy = Math.max(lb.y0 - la.y1, la.y0 - lb.y1);
  const cax = (la.x0 + la.x1) / 2; const cbx = (lb.x0 + lb.x1) / 2;
  const cay = (la.y0 + la.y1) / 2; const cby = (lb.y0 + lb.y1) / 2;
  const alongX = gx >= 0 || gy >= 0
    ? gx >= gy
    : Math.abs(cax - cbx) / Math.max(1, la.x1 - la.x0 + lb.x1 - lb.x0) >= Math.abs(cay - cby) / Math.max(1, la.y1 - la.y0 + lb.y1 - lb.y0);
  const [lo, hi] = alongX ? /** @type {const} */ (['x0', 'x1']) : /** @type {const} */ (['y0', 'y1']);
  const before = alongX ? cax <= cbx : cay <= cby;
  const mid = (alongX ? gx : gy) >= 0
    ? (before ? (la[hi] + lb[lo]) / 2 : (lb[hi] + la[lo]) / 2)
    : (alongX ? cax + cbx : cay + cby) / 2;
  if (before) {
    const cut = both || b.area[lo] < la[hi] ? mid : b.area[lo];
    a.area = { ...a.area, [hi]: Math.max(a.area[lo] + 1, Math.min(a.area[hi], cut)) };
    if (both) b.area = { ...b.area, [lo]: Math.min(b.area[hi] - 1, Math.max(b.area[lo], mid)) };
  } else {
    const cut = both || b.area[hi] > la[lo] ? mid : b.area[hi];
    a.area = { ...a.area, [lo]: Math.min(a.area[hi] - 1, Math.max(a.area[lo], cut)) };
    if (both) b.area = { ...b.area, [hi]: Math.max(b.area[lo] + 1, Math.min(b.area[hi], mid)) };
  }
}
