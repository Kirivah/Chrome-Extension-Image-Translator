// @ts-check

/** @typedef {import('./analysis.js').Pixels} Pixels */
/** @typedef {import('./analysis.js').Box} Box */
/** @typedef {import('./textmap.js').TextMap} TextMap */
/** @typedef {import('./textmap.js').TextBlock} TextBlock */
/** @typedef {import('./textmap.js').TextChar} TextChar */

/**
 * @typedef {Object} Bubble
 * @property {Box} box
 * @property {Box} text
 * @property {TextBlock[]} blocks
 * @property {TextChar[]} chars
 * @property {(b: Box) => number} [within]
 */

const MAX_SHARE = 0.2;
const MAX_SPREAD = 40;
const MIN_FILL = 0.12;
const DRAWN = 2.5;
const BUDGET_MS = 300;

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * @param {number} fx0
 * @param {number} fy0
 * @param {number} fx1
 * @param {number} fy1
 * @param {Int32Array} rowA
 * @param {Int32Array} rowB
 * @param {Int32Array} colA
 * @param {Int32Array} colB
 * @param {number} g
 * @param {number} gw
 * @param {number} gh
 * @returns {(box: Box) => number}
 */
function insideTest(fx0, fy0, fx1, fy1, rowA, rowB, colA, colB, g, gw, gh) {
  const X0 = fx0 * g; const Y0 = fy0 * g; const X1 = (fx1 + 1) * g; const Y1 = (fy1 + 1) * g;
  return (box) => {
    if (box.x1 <= X0 || box.x0 >= X1 || box.y1 <= Y0 || box.y0 >= Y1) return 0;
    const cx0 = clamp(Math.floor(box.x0 / g), 0, gw); const cy0 = clamp(Math.floor(box.y0 / g), 0, gh);
    const cx1 = clamp(Math.ceil(box.x1 / g), 0, gw); const cy1 = clamp(Math.ceil(box.y1 / g), 0, gh);
    let n = 0; let m = 0;
    for (let y = cy0; y < cy1; y++) {
      for (let x = cx0; x < cx1; x++) {
        n++;
        if (x < fx0 || x > fx1 || y < fy0 || y > fy1) continue;
        const ix = x - fx0; const iy = y - fy0;
        if ((ix >= rowA[iy] && ix <= rowB[iy]) || (iy >= colA[ix] && iy <= colB[ix])) m++;
      }
    }
    return n ? m / n : 0;
  };
}

/**
 * @param {Pixels} px
 * @param {TextMap} map
 * @param {number} [deadline]
 * @param {(d: unknown) => void} [debug]
 * @returns {Map<TextBlock, Bubble>}
 */
export function findBubbles(px, map, deadline = performance.now() + BUDGET_MS, debug) {
  /** @type {Map<TextBlock, Bubble>} */
  const out = new Map();
  const blocks = map.blocks;
  if (!blocks.length) return out;
  const { data, W, H } = px;
  const glyphs = blocks.map((b) => b.glyph).sort((a, b) => a - b);
  const g = clamp(Math.round(glyphs[glyphs.length >> 1] / 7), 2, 8);
  const gw = Math.ceil(W / g);
  const gh = Math.ceil(H / g);
  const lo = new Int16Array(gw * gh).fill(-1);
  const hi = new Int16Array(gw * gh).fill(-1);
  /** @param {number} k */
  const measure = (k) => {
    const cx = k % gw; const cy = (k - cx) / gw;
    const x0 = cx * g; const y0 = cy * g;
    const x1 = Math.min(W, x0 + g); const y1 = Math.min(H, y0 + g);
    let a = 255; let b = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0, i = (y * W + x0) * 4; x < x1; x++, i += 4) {
        const l = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
        if (l < a) a = l;
        if (l > b) b = l;
      }
    }
    lo[k] = a; hi[k] = b;
  };
  const seen = new Int32Array(gw * gh);
  let fills = 0;
  const stack = new Int32Array(gw * gh);
  let sp = 0;
  /** @param {Box} b */
  const cellsOf = (b) => ({
    x0: clamp(Math.floor(b.x0 / g), 0, gw), y0: clamp(Math.floor(b.y0 / g), 0, gh),
    x1: clamp(Math.ceil(b.x1 / g), 0, gw), y1: clamp(Math.ceil(b.y1 / g), 0, gh),
  });

  for (const b of blocks) {
    if (out.has(b)) continue;
    if (performance.now() > deadline) break;
    const span = Math.abs(b.paper - b.ink);
    const dark = b.dark;
    const thr = dark ? b.paper - Math.max(30, 0.3 * span) : b.paper + Math.max(30, 0.3 * span);
    /** @param {number} k */
    const tone = (k) => {
      if (lo[k] < 0) measure(k);
      return dark ? lo[k] >= thr : hi[k] <= thr;
    };
    /** @param {number} k */
    const paper = (k) => {
      if (!tone(k)) return false;
      const x = k % gw;
      if (x === 0 || x === gw - 1 || k < gw || k >= gw * (gh - 1)) return false;
      return tone(k - 1) && tone(k + 1) && tone(k - gw) && tone(k + gw)
        && tone(k - gw - 1) && tone(k - gw + 1) && tone(k + gw - 1) && tone(k + gw + 1);
    };
    const E = Math.max(8 * b.glyph, 2 * (b.box.x1 - b.box.x0), 2 * (b.box.y1 - b.box.y0));
    const win = cellsOf({ x0: b.box.x0 - E, y0: b.box.y0 - E, x1: b.box.x1 + E, y1: b.box.y1 + E });
    const own = cellsOf(b.box);
    const id = ++fills;
    sp = 0;
    for (let y = Math.max(win.y0, own.y0 - 1); y < Math.min(win.y1, own.y1 + 1); y++) {
      for (let x = Math.max(win.x0, own.x0 - 1); x < Math.min(win.x1, own.x1 + 1); x++) {
        const k = y * gw + x;
        if (seen[k] !== id && paper(k)) { seen[k] = id; stack[sp++] = k; }
      }
    }
    if (!sp) continue;
    let open = false;
    let fx0 = gw; let fy0 = gh; let fx1 = -1; let fy1 = -1;
    while (sp) {
      const k = stack[--sp];
      const x = k % gw; const y = (k - x) / gw;
      if (x <= win.x0 || y <= win.y0 || x >= win.x1 - 1 || y >= win.y1 - 1) { open = true; break; }
      if (x < fx0) fx0 = x;
      if (x > fx1) fx1 = x;
      if (y < fy0) fy0 = y;
      if (y > fy1) fy1 = y;
      if (seen[k - 1] !== id && paper(k - 1)) { seen[k - 1] = id; stack[sp++] = k - 1; }
      if (seen[k + 1] !== id && paper(k + 1)) { seen[k + 1] = id; stack[sp++] = k + 1; }
      if (seen[k - gw] !== id && paper(k - gw)) { seen[k - gw] = id; stack[sp++] = k - gw; }
      if (seen[k + gw] !== id && paper(k + gw)) { seen[k + gw] = id; stack[sp++] = k + gw; }
    }
    if (open || fx1 < 0) continue;
    const bw = fx1 - fx0 + 1; const bh = fy1 - fy0 + 1;
    if (bw * bh > MAX_SHARE * gw * gh) continue;
    const rowA = new Int32Array(bh).fill(bw); const rowB = new Int32Array(bh).fill(-1);
    const colA = new Int32Array(bw).fill(bh); const colB = new Int32Array(bw).fill(-1);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        if (seen[(fy0 + y) * gw + fx0 + x] !== id) continue;
        if (x < rowA[y]) rowA[y] = x;
        if (x > rowB[y]) rowB[y] = x;
        if (y < colA[x]) colA[x] = y;
        if (y > colB[x]) colB[x] = y;
      }
    }
    /** @param {number} x @param {number} y */
    const inside = (x, y) => (x >= rowA[y] && x <= rowB[y]) || (y >= colA[x] && y <= colB[x]);
    const within = insideTest(fx0, fy0, fx1, fy1, rowA, rowB, colA, colB, g, gw, gh);
    if (within(b.box) < 0.9) continue;
    let inner = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (inside(x, y)) inner++;
    if (inner * g * g > MAX_SPREAD * (b.box.x1 - b.box.x0) * (b.box.y1 - b.box.y0)) continue;
    const inBubble = blocks.filter((o) => o.dark === b.dark && !out.has(o) && within(o.box) >= 0.6);
    if (!inBubble.includes(b)) inBubble.push(b);
    const bySize = inBubble.map((o) => [o.glyph, Math.max(1, o.cells)]).sort((p, q) => p[0] - q[0]);
    const total = bySize.reduce((a, [, c]) => a + c, 0);
    let typical = bySize[0][0];
    for (let i = 0, acc = 0; i < bySize.length; i++) { acc += bySize[i][1]; if (acc >= total / 2) { typical = bySize[i][0]; break; } }
    /** @param {number} size @param {number} cells */
    const drawn = (size, cells) => cells <= 2 && size > DRAWN * typical;
    const lettering = inBubble.filter((o) => !drawn(o.glyph, o.cells));
    if (!lettering.includes(b)) continue;
    const G = Math.max(...lettering.map((o) => o.glyph));
    /** @param {Box} a @param {Box} c @param {number} r */
    const by = (a, c, r) => c.x1 > a.x0 - r && c.x0 < a.x1 + r && c.y1 > a.y0 - r && c.y0 < a.y1 + r;
    const loose = (map.chars ?? []).filter((c) => c.dark === b.dark && !c.inBlock && within(c.box) >= 0.6);
    const letters = loose.filter((c) => !c.mark && c.size >= 0.35 * G && !drawn(c.size, 1) && lettering.some((o) => by(o.box, c.box, 1.5 * G)));
    const chars = [...letters, ...loose.filter((c) => c.mark
      && [...lettering.map((o) => o.box), ...letters.map((l) => l.box)].some((q) => by(q, c.box, 0.6 * G)))];
    const fill = [...lettering, ...chars].reduce((a, o) => a + (o.box.x1 - o.box.x0) * (o.box.y1 - o.box.y0), 0) / (inner * g * g);
    debug?.({ box: [fx0 * g, fy0 * g, (fx1 + 1) * g, (fy1 + 1) * g], blocks: lettering.length, chars: chars.length, fill: +fill.toFixed(3) });
    if (lettering.length > 1 && fill < MIN_FILL) continue;
    const all = [...lettering, ...chars].map((o) => o.box);
    /** @type {Bubble} */
    const bubble = {
      box: { x0: fx0 * g, y0: fy0 * g, x1: Math.min(W, (fx1 + 1) * g), y1: Math.min(H, (fy1 + 1) * g) },
      text: {
        x0: Math.min(...all.map((q) => q.x0)), y0: Math.min(...all.map((q) => q.y0)),
        x1: Math.max(...all.map((q) => q.x1)), y1: Math.max(...all.map((q) => q.y1)),
      },
      blocks: lettering,
      chars,
      within,
    };
    for (const o of lettering) out.set(o, bubble);
  }
  return out;
}
