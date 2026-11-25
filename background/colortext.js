// @ts-check

/** @typedef {import('./analysis.js').Pixels} Pixels */
/** @typedef {import('./analysis.js').Box} Box */
/** @typedef {import('./textmap.js').TextBlock} TextBlock */
/** @typedef {import('./textmap.js').TextMap} TextMap */

const CHROMA = 60;
const STEP = 44;
const RINGED = 0.7;
const MAX_PIECES = 30_000;

const BUDGET_MS = 400;

/**
 * @param {Pixels} px
 * @param {number} size
 * @param {number} [deadline]
 * @returns {TextBlock[]}
 */
export function colourLettering(px, size, deadline = performance.now() + BUDGET_MS) {
  const { data, W, H } = px;
  const n = W * H;
  if (!(size >= 8) || n < 64) return [];
  /** @param {number} k */
  const lumAt = (k) => (data[k * 4] * 77 + data[k * 4 + 1] * 150 + data[k * 4 + 2] * 29) >> 8;
  /** @param {number} k */
  const chromaAt = (k) => {
    const r = data[k * 4]; const g = data[k * 4 + 1]; const b = data[k * 4 + 2];
    return Math.max(r, g, b) - Math.min(r, g, b);
  };
  /** @param {number} k */
  const coloured = (k) => { const l = lumAt(k); return l >= 70 && l <= 235 && chromaAt(k) >= CHROMA; };
  /** @param {number} k */
  const lightRing = (k) => lumAt(k) >= 210 && chromaAt(k) <= 50;
  /** @param {number} k */
  const darkRing = (k) => lumAt(k) <= 55 && chromaAt(k) <= 60;

  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  /** @type {{n: number, x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, first: number, light: number, dark: number, ring: number, edge: number}[]} */
  const pieces = [];
  const huge = 6 * size * size;
  for (let k0 = 0; k0 < n; k0++) {
    if (label[k0] !== -1 || !coloured(k0)) continue;
    if (pieces.length >= MAX_PIECES || ((pieces.length & 255) === 255 && performance.now() > deadline)) return [];
    const id = pieces.length;
    const p = { n: 0, x0: W, y0: H, x1: -1, y1: -1, r: 0, g: 0, b: 0, first: k0, light: 0, dark: 0, ring: 0, edge: 0 };
    let top = 0;
    stack[top++] = k0; label[k0] = id;
    while (top) {
      const k = stack[--top];
      const x = k % W; const y = (k - x) / W;
      p.n++;
      p.r += data[k * 4]; p.g += data[k * 4 + 1]; p.b += data[k * 4 + 2];
      if (x < p.x0) p.x0 = x;
      if (x > p.x1) p.x1 = x;
      if (y < p.y0) p.y0 = y;
      if (y > p.y1) p.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const q = yy * W + xx;
          if (label[q] !== -1 || !coloured(q)) continue;
          if (Math.abs(data[q * 4] - data[k * 4]) > STEP || Math.abs(data[q * 4 + 1] - data[k * 4 + 1]) > STEP || Math.abs(data[q * 4 + 2] - data[k * 4 + 2]) > STEP) continue;
          label[q] = id;
          stack[top++] = q;
        }
      }
    }
    pieces.push(p);
  }
  const big = 2.2 * size;
  /** @type {boolean[]} */
  const keep = new Array(pieces.length).fill(false);
  for (let id = 0; id < pieces.length; id++) {
    const p = pieces[id];
    if (p.n < 6 || p.n > huge || p.x1 - p.x0 + 1 > big || p.y1 - p.y0 + 1 > big) continue;
    const step = Math.max(1, Math.round(Math.sqrt(p.n / 300)));
    const mr = p.r / p.n; const mg = p.g / p.n; const mb = p.b / p.n;
    for (let y = p.y0; y <= p.y1; y += step) {
      for (let x = p.x0; x <= p.x1; x++) {
        const k = y * W + x;
        if (label[k] !== id) continue;
        for (const [dx, dy] of DIRS) {
          const x1 = x + dx; const y1 = y + dy;
          if (x1 < 0 || y1 < 0 || x1 >= W || y1 >= H || label[y1 * W + x1] === id) continue;
          const x3 = x + 3 * dx; const y3 = y + 3 * dy;
          if (x3 < 0 || y3 < 0 || x3 >= W || y3 >= H) continue;
          const q = y3 * W + x3;
          if (label[q] >= 0) {
            if (Math.abs(data[q * 4] - mr) + Math.abs(data[q * 4 + 1] - mg) + Math.abs(data[q * 4 + 2] - mb) > 60) p.edge++;
            continue;
          }
          p.edge++;
          p.ring++;
          if (lightRing(q)) p.light++;
          else if (darkRing(q)) p.dark++;
        }
      }
    }
    keep[id] = p.ring >= 10 && p.ring >= 0.5 * p.edge && (p.light >= RINGED * p.ring || p.dark >= RINGED * p.ring);
  }

  /** @type {number[]} */
  const kept = [];
  for (let id = 0; id < pieces.length; id++) if (keep[id]) kept.push(id);
  if (kept.length < 3) return [];
  const sides = kept.map((id) => Math.max(pieces[id].x1 - pieces[id].x0, pieces[id].y1 - pieces[id].y0) + 1).sort((a, b) => a - b);
  const est = sides[Math.floor(0.75 * (sides.length - 1))];
  const glyphSize = Math.max(8, Math.min(est, 3 * size));
  const link = Math.max(2, Math.round(0.45 * glyphSize));
  /** @param {typeof pieces[number]} p */
  const sideOf = (p) => Math.max(p.x1 - p.x0, p.y1 - p.y0) + 1;
  const colour = (/** @type {number} */ id) => { const p = pieces[id]; return [p.r / p.n, p.g / p.n, p.b / p.n]; };
  /** @param {number[]} a @param {number[]} b */
  const far = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const up = kept.map((_, i) => i);
  /** @param {number} i @returns {number} */
  const root = (i) => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
  const cell = glyphSize;
  /** @type {Map<number, number[]>} */
  const grid = new Map();
  kept.forEach((id, i) => {
    const p = pieces[id];
    for (let gy = Math.floor((p.y0 - link) / cell); gy <= Math.floor((p.y1 + link) / cell); gy++) {
      for (let gx = Math.floor((p.x0 - link) / cell); gx <= Math.floor((p.x1 + link) / cell); gx++) {
        const key = gy * 100_000 + gx;
        const list = grid.get(key);
        if (list) list.push(i); else grid.set(key, [i]);
      }
    }
  });
  const cols = kept.map(colour);
  for (const list of grid.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a]; const j = list[b];
        if (root(i) === root(j)) continue;
        const p = pieces[kept[i]]; const q = pieces[kept[j]];
        const reach = Math.max(2, 0.45 * Math.max(sideOf(p), sideOf(q)), 0.35 * glyphSize);
        if (Math.max(p.x0, q.x0) - Math.min(p.x1, q.x1) > reach || Math.max(p.y0, q.y0) - Math.min(p.y1, q.y1) > reach) continue;
        if (far(cols[i], cols[j]) > 55) continue;
        up[root(i)] = root(j);
      }
    }
  }
  /** @type {Map<number, {x0: number, y0: number, x1: number, y1: number, pieces: number[], r: number, g: number, b: number, px: number}>} */
  const byRoot = new Map();
  kept.forEach((id, i) => {
    const r = root(i);
    const p = pieces[id];
    let g = byRoot.get(r);
    if (!g) byRoot.set(r, (g = { x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1, pieces: [], r: 0, g: 0, b: 0, px: 0 }));
    g.x0 = Math.min(g.x0, p.x0); g.y0 = Math.min(g.y0, p.y0); g.x1 = Math.max(g.x1, p.x1); g.y1 = Math.max(g.y1, p.y1);
    g.pieces.push(id);
    g.r += p.r; g.g += p.g; g.b += p.b; g.px += p.n;
  });
  const live = [...byRoot.values()];
  for (const g of live) { g.r /= g.px; g.g /= g.px; g.b /= g.px; }

  /** @param {typeof live[number]} g */
  const shape = (g) => {
    const w = g.x1 - g.x0 + 1; const h = g.y1 - g.y0 + 1;
    return h >= 1.6 * w ? { v: 1, across: w } : w >= 1.6 * h ? { v: 2, across: h } : { v: 0, across: Math.max(w, h) };
  };
  const parent = live.map((_, i) => i);
  /** @param {number} i @returns {number} */
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]; const b = live[j];
      const gx = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
      const gy = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
      if (gx > 2.5 * glyphSize || gy > 2.5 * glyphSize) continue;
      const sa = shape(a); const sb = shape(b);
      const across = Math.max(sa.across, sb.across);
      const alike = across <= 1.45 * Math.min(sa.across, sb.across);
      const ox = -gx; const oy = -gy;
      const wa = a.x1 - a.x0 + 1; const wb = b.x1 - b.x0 + 1; const ha = a.y1 - a.y0 + 1; const hb = b.y1 - b.y0 + 1;
      const sideV = alike && sa.v !== 2 && sb.v !== 2 && gx <= 1.3 * across && oy >= 0.3 * Math.min(ha, hb);
      const sideH = alike && sa.v !== 1 && sb.v !== 1 && gy <= 1.3 * across && ox >= 0.3 * Math.min(wa, wb);
      const inV = alike || (sa.v === 1 && wb <= 1.3 * wa) || (sb.v === 1 && wa <= 1.3 * wb);
      const inH = alike || (sa.v === 2 && hb <= 1.3 * ha) || (sb.v === 2 && ha <= 1.3 * hb);
      const markV = (sa.v !== 2 && Math.max(wb, hb) <= Math.min(1.3 * wa, 0.8 * ha)) || (sb.v !== 2 && Math.max(wa, ha) <= Math.min(1.3 * wb, 0.8 * hb));
      const markH = (sa.v !== 1 && Math.max(wb, hb) <= Math.min(1.3 * ha, 0.8 * wa)) || (sb.v !== 1 && Math.max(wa, ha) <= Math.min(1.3 * hb, 0.8 * wb));
      const onV = ((inV && sa.v !== 2 && sb.v !== 2) || markV) && ox >= 0.5 * Math.min(wa, wb) && gy <= 2 * across;
      const onH = ((inH && sa.v !== 1 && sb.v !== 1) || markH) && oy >= 0.5 * Math.min(ha, hb) && gx <= 2 * across;
      const dc = Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
      const right = (onV && gy <= 0.6 * across) || (onH && gx <= 0.6 * across);
      if (dc > (right ? 100 : 55)) continue;
      if (sideV || sideH || onV || onH) parent[find(i)] = find(j);
    }
  }
  /** @type {Map<number, number[]>} */
  const groups = new Map();
  live.forEach((_, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]); });

  /** @type {TextBlock[]} */
  const out = [];
  /** @type {number[]} */
  const whiteRing = [];
  for (const members of groups.values()) {
    const gs = members.map((i) => live[i]);
    const x0 = Math.min(...gs.map((g) => g.x0)); const y0 = Math.min(...gs.map((g) => g.y0));
    const x1 = Math.max(...gs.map((g) => g.x1)) + 1; const y1 = Math.max(...gs.map((g) => g.y1)) + 1;
    const ids = new Set(gs.flatMap((g) => g.pieces));
    let inkN = 0; let inkSum = 0; let light = 0; let dark = 0;
    for (const id of ids) { inkN += pieces[id].n; light += pieces[id].light; dark += pieces[id].dark; }
    if (inkN < 0.3 * glyphSize * glyphSize) continue;
    if (ids.size < 3 && Math.max(x1 - x0, y1 - y0) < 1.2 * glyphSize) continue;
    const w = x1 - x0; const h = y1 - y0;
    const bits = new Uint8Array(w * h);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const k = y * W + x;
        if (label[k] >= 0 && ids.has(label[k])) { bits[(y - y0) * w + (x - x0)] = 1; inkSum += lumAt(k); }
      }
    }
    const shapes = gs.map(shape);
    const lenV = gs.reduce((a, g, i) => a + (shapes[i].v === 1 ? g.y1 - g.y0 + 1 : 0), 0);
    const lenH = gs.reduce((a, g, i) => a + (shapes[i].v === 2 ? g.x1 - g.x0 + 1 : 0), 0);
    const vertical = lenV >= lenH && h > w;
    const most = Math.max(...gs.map((g) => g.px));
    const real = shapes.filter((_, i) => gs[i].px >= 0.15 * most);
    const runs = real.filter((s) => s.v === (vertical ? 1 : 2));
    const acr = runs.length ? median(runs.map((s) => s.across)) : Math.max(...real.map((s) => s.across));
    const glyph = Math.max(Math.min(acr, 1.6 * glyphSize), 0.5 * glyphSize);
    const length = gs.reduce((a, g) => a + (vertical ? g.y1 - g.y0 + 1 : g.x1 - g.x0 + 1), 0);
    const inkLum = inkSum / Math.max(1, inkN);
    const lightRinged = light >= dark;
    whiteRing.push(light / Math.max(1, light + dark));
    out.push({
      box: { x0, y0, x1, y1 },
      glyph,
      dark: lightRinged,
      vertical,
      cells: Math.max(1, Math.round(length / Math.max(1, glyph))),
      ink: inkLum,
      paper: lightRinged ? 245 : 20,
      mask: { x0, y0, w, h, s: 1, bits },
      colour: true,
    });
  }
  const main = out.reduce((a, b) => (b.cells > a.cells ? b : a), out[0]);
  /** @param {Box} a @param {Box} b */
  const inter = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const area = (/** @type {Box} */ a) => (a.x1 - a.x0) * (a.y1 - a.y0);
  return out.filter((b, i) => b.glyph >= 0.65 * main.glyph
    && (b.cells > 3 || (whiteRing[i] >= 0.85 && b.glyph >= 0.8 * main.glyph))
    && !out.some((a) => a !== b && a.cells > b.cells && inter(a.box, b.box) >= 0.6 * area(b.box)));
}

/**
 * @param {TextMap} map
 * @param {TextBlock[]} colour
 * @returns {TextMap}
 */
export function adoptColourBlocks(map, colour) {
  if (!colour.length) return map;
  const near = colour.map((c) => ({ c, r: Math.max(2, Math.round(0.3 * c.glyph)) }));
  /** @param {number} X @param {number} Y */
  const covered = (X, Y) => {
    for (const { c, r } of near) {
      if (X < c.box.x0 - r || X >= c.box.x1 + r || Y < c.box.y0 - r || Y >= c.box.y1 + r) continue;
      const m = c.mask;
      for (let y = Math.max(0, Y - r - m.y0); y <= Math.min(m.h - 1, Y + r - m.y0); y += Math.max(1, r >> 1)) {
        for (let x = Math.max(0, X - r - m.x0); x <= Math.min(m.w - 1, X + r - m.x0); x += Math.max(1, r >> 1)) if (m.bits[y * m.w + x]) return true;
      }
    }
    return false;
  };
  /** @param {import('./textmap.js').Mask} m */
  const share = (m) => {
    let on = 0; let all = 0;
    const step = Math.max(1, Math.round(Math.sqrt((m.w * m.h) / 2000)));
    for (let y = 0; y < m.h; y += step) {
      for (let x = 0; x < m.w; x += step) {
        if (!m.bits[y * m.w + x]) continue;
        all++;
        if (covered(Math.floor((m.x0 + x + 0.5) * m.s), Math.floor((m.y0 + y + 0.5) * m.s))) on++;
      }
    }
    return all ? on / all : 0;
  };
  const blocks = map.blocks.filter((b) => !colour.some((c) => overlaps(b.box, c.box)) || share(b.mask) < 0.25);
  for (const ch of map.chars) if (!ch.inBlock && colour.some((c) => overlaps(ch.box, c.box)) && share(ch.mask) >= 0.5) ch.inBlock = true;
  return { ...map, blocks: [...blocks, ...colour] };
}

const DIRS = /** @type {const} */ ([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]);

/** @param {Box} a @param {Box} b */
function overlaps(a, b) {
  return Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
}

/** @param {number[]} v */
function median(v) {
  const s = v.slice().sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
}

/**
 * @param {Uint8Array} m
 * @param {number} w
 * @param {number} h
 * @param {number} r
 * @returns {Uint8Array}
 */
function grow(m, w, h, r) {
  const rows = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let cnt = 0;
    for (let x = -r; x < w; x++) {
      if (x + r < w && m[y * w + x + r]) cnt++;
      if (x - r - 1 >= 0 && m[y * w + x - r - 1]) cnt--;
      if (x >= 0 && cnt > 0) rows[y * w + x] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let cnt = 0;
    for (let y = -r; y < h; y++) {
      if (y + r < h && rows[(y + r) * w + x]) cnt++;
      if (y - r - 1 >= 0 && rows[(y - r - 1) * w + x]) cnt--;
      if (y >= 0 && cnt > 0) out[y * w + x] = 1;
    }
  }
  return out;
}
