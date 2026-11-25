// @ts-check

/** @typedef {import('./analysis.js').Box} Box */
/** @typedef {import('./textmap.js').TextMap} TextMap */
/** @typedef {import('./textmap.js').TextBlock} TextBlock */
/** @typedef {import('./textmap.js').TextChar} TextChar */
/** @typedef {import('./textmap.js').Mask} Mask */
/** @typedef {import('./bubbles.js').Bubble} Bubble */

/**
 * @typedef {Object} Text
 * @property {Box} box
 * @property {Box} text
 * @property {TextBlock[]} blocks
 * @property {TextChar[]} chars
 * @property {Bubble} bubble
 */

/**
 * @typedef {Object} Texts
 * @property {TextMap} map
 * @property {Map<TextBlock, Text>} texts
 * @property {Map<TextBlock, TextChar[]>} cells
 * @property {Map<TextBlock, number>} count
 * @property {Set<TextChar>} apart
 */

const SMALL = 0.6;
const USUAL = 0.35;
const ALONG = 0.8;

/** @param {Box} b */
const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
/** @param {Box[]} boxes @returns {Box} */
const union = (boxes) => ({
  x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)),
  x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)),
});
const gap = (/** @type {number} */ a0, /** @type {number} */ a1, /** @type {number} */ b0, /** @type {number} */ b1) => Math.max(a0, b0) - Math.min(a1, b1);
/** @param {number[]} v */
const median = (v) => { const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };

/**
 * @param {number} g
 * @param {number} size
 * @param {number} usual
 */
export function clear(g, size, usual) {
  return g >= 1.5 * size || (g >= 0.75 * size && g >= 2 * usual + 0.1 * size);
}

/**
 * @param {Box} a
 * @param {Box} b
 * @param {number} size
 * @param {boolean} vertical
 * @param {number} usual
 * @param {boolean} [field]
 */
function together(a, b, size, vertical, usual, field = false) {
  const gx = gap(a.x0, a.x1, b.x0, b.x1); const gy = gap(a.y0, a.y1, b.y0, b.y1);
  if (gx < 0 && gy < 0) return true;
  if (field) return !vertical && gy < -0.5 * Math.min(a.y1 - a.y0, b.y1 - b.y0) && gx < ALONG * size;
  const [ga, gb] = vertical ? [gx, gy] : [gy, gx];
  if (gb < 0) return !clear(ga, size, usual);
  if (ga < 0) return gb < ALONG * size;
  return !clear(Math.max(ga, gb), size, usual);
}

/**
 * @typedef {{a0: number, a1: number, m0: number, m1: number, b0: number, b1: number, size: number,
 *   chars: TextChar[], ruby: TextChar[]}} Row
 */

/**
 * @param {TextChar[]} chars
 * @param {boolean} vertical
 * @returns {Row[]}
 */
function rowsOf(chars, vertical) {
  /** @param {TextChar} c @returns {[number, number]} */
  const across = (c) => (vertical ? [c.box.x0, c.box.x1] : [c.box.y0, c.box.y1]);
  /** @param {TextChar} c @returns {[number, number]} */
  const along = (c) => (vertical ? [c.box.y0, c.box.y1] : [c.box.x0, c.box.x1]);
  /** @type {Row[]} */
  const rows = [];
  for (const c of [...chars].sort((p, q) => across(p)[0] - across(q)[0])) {
    const [a0, a1] = across(c); const [b0, b1] = along(c);
    const r = rows.find((q) => -gap(q.m0, q.m1, a0, a1) >= 0.5 * Math.min(q.m1 - q.m0, a1 - a0));
    if (r) {
      r.m0 = Math.min(r.m0, a0); r.m1 = Math.max(r.m1, a1); r.b0 = Math.min(r.b0, b0); r.b1 = Math.max(r.b1, b1);
      r.chars.push(c);
    } else {
      rows.push({ a0, a1, m0: a0, m1: a1, b0, b1, size: 0, chars: [c], ruby: [] });
    }
  }
  for (const r of rows) r.size = median(r.chars.map((c) => c.size));
  /** @type {Row[]} */
  const kept = [];
  for (const r of [...rows].sort((p, q) => q.size - p.size)) {
    let host = null; let best = Infinity;
    for (const k of kept) {
      if (r.size >= SMALL * k.size || gap(k.b0, k.b1, r.b0, r.b1) > 0) continue;
      const d = gap(k.m0, k.m1, r.m0, r.m1);
      if (d > 0.5 * k.size) continue;
      const own = vertical ? k.m0 < r.m0 : k.m1 > r.m1;
      const score = d - (own ? 0.5 * k.size : 0);
      if (score < best) { best = score; host = k; }
    }
    if (host) {
      host.ruby.push(...r.chars);
      host.a0 = Math.min(host.a0, r.m0); host.a1 = Math.max(host.a1, r.m1);
    } else {
      kept.push(r);
    }
  }
  return kept.sort((p, q) => p.a0 - q.a0);
}

/**
 * @param {Row[]} rows
 * @returns {number[]}
 */
function spacings(rows) {
  /** @type {number[]} */
  const out = [];
  for (let k = 1; k < rows.length; k++) {
    const p = rows[k - 1]; const q = rows[k];
    if (gap(p.b0, p.b1, q.b0, q.b1) >= 0) continue;
    out.push(Math.max(0, q.a0 - p.a1));
  }
  return out;
}

/**
 * @param {Row} r
 * @param {TextChar[]} marks
 * @returns {TextChar[][]}
 */
function fieldsOf(r, marks) {
  const inLine = marks.filter((m) => m.box.y0 >= r.m0 - 1 && m.box.y1 <= r.m1 + 1);
  const items = [...r.chars.map((c) => ({ c, mark: false })), ...inLine.map((c) => ({ c, mark: true }))]
    .sort((p, q) => p.c.box.x0 - q.c.box.x0);
  /** @type {TextChar[][]} */
  const out = [[]];
  let end = -Infinity; let last = 0;
  for (const it of items) {
    if (!it.mark && out[out.length - 1].length && it.c.box.x0 - end >= ALONG * Math.max(last, it.c.size)) out.push([]);
    if (!it.mark) { out[out.length - 1].push(it.c); last = it.c.size; }
    end = Math.max(end, it.c.box.x1);
  }
  return out.filter((f) => f.length);
}

/**
 * @param {TextChar} c
 * @param {Mask} m
 */
function inMask(c, m) {
  const q = c.mask;
  if (q.s !== m.s) return 0;
  let all = 0; let hit = 0;
  for (let y = 0; y < q.h; y++) {
    const my = q.y0 + y - m.y0;
    for (let x = 0; x < q.w; x++) {
      if (!q.bits[y * q.w + x]) continue;
      all++;
      const mx = q.x0 + x - m.x0;
      if (my >= 0 && my < m.h && mx >= 0 && mx < m.w && m.bits[my * m.w + mx]) hit++;
    }
  }
  return all ? hit / all : 0;
}

/**
 * @param {TextBlock[]} blocks
 * @param {TextChar[]} chars
 * @returns {Map<TextBlock, TextChar[]>}
 */
function owners(blocks, chars) {
  /** @type {Map<TextBlock, TextChar[]>} */
  const out = new Map(blocks.map((b) => [b, []]));
  for (const c of chars) {
    let best = null; let most = 0.5;
    for (const b of blocks) {
      if (b.dark !== c.dark || gap(b.box.x0, b.box.x1, c.box.x0, c.box.x1) >= 0 || gap(b.box.y0, b.box.y1, c.box.y0, c.box.y1) >= 0) continue;
      const k = inMask(c, b.mask);
      if (k >= most) { most = k; best = b; }
    }
    if (best) /** @type {TextChar[]} */ (out.get(best)).push(c);
  }
  return out;
}

/**
 * @param {TextBlock} b
 * @param {TextChar[]} own
 * @param {boolean} [table]
 * @returns {{parts: TextChar[][], fields: boolean[], rows: Row[], faint: TextChar[]} | null}
 */
function cut(b, own, table = false) {
  const span = Math.max(30, Math.abs(b.paper - b.ink));
  const faint = own.filter((c) => Math.abs(c.ink - b.ink) > 0.55 * span);
  const text = own.filter((c) => !faint.includes(c));
  const marks = text.filter((c) => c.mark);
  const rows = rowsOf(text.filter((c) => !c.mark), b.vertical);
  if (!rows.length || (!table && rows.reduce((n, r) => n + r.chars.length, 0) < 2)) return null;
  const spacing = spacings(rows);
  const usual = spacing.length ? median(spacing) : USUAL * b.glyph;
  const up = rows.map((_, i) => i);
  /** @param {number} i @returns {number} */
  const top = (i) => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
  /** @param {Row} r @returns {Box} */
  const boxOf = (r) => (b.vertical ? { x0: r.a0, x1: r.a1, y0: r.b0, y1: r.b1 } : { x0: r.b0, x1: r.b1, y0: r.a0, y1: r.a1 });
  const lines = table && !b.vertical;
  for (let i = 0; i < rows.length && !lines; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (together(boxOf(rows[i]), boxOf(rows[j]), b.glyph, b.vertical, usual)) up[top(i)] = top(j);
    }
  }
  /** @type {Map<number, Row[]>} */
  const groups = new Map();
  rows.forEach((r, i) => { const k = top(i); const g = groups.get(k); if (g) g.push(r); else groups.set(k, [r]); });
  /** @type {TextChar[][]} */
  const parts = [];
  /** @type {boolean[]} */
  const fields = [];
  /** @param {TextChar[][]} f */
  const isFields = (f) => {
    if (f.length < 2) return false;
    const sizes = f.flat().map((c) => c.size);
    return Math.max(...sizes) <= 1.5 * Math.min(...sizes);
  };
  for (const g of groups.values()) {
    const split = b.vertical ? null : g.map((r) => fieldsOf(r, marks));
    if (split && (lines || split.some(isFields))) {
      g.forEach((r, k) => {
        for (const f of /** @type {TextChar[][][]} */ (split)[k]) {
          const fx0 = Math.min(...f.map((c) => c.box.x0)); const fx1 = Math.max(...f.map((c) => c.box.x1));
          parts.push([...f, ...r.ruby.filter((c) => gap(c.box.x0, c.box.x1, fx0, fx1) < 0)]);
          fields.push(true);
        }
      });
      continue;
    }
    parts.push(g.flatMap((r) => [...r.chars, ...r.ruby]));
    fields.push(false);
  }
  if (parts.length < 2 && !lines) return null;
  return { parts, fields, rows, faint };
}

/**
 * @param {TextBlock} b
 * @param {TextChar[][]} parts
 * @param {TextChar[]} [drop]
 * @returns {TextBlock[]}
 */
export function share(b, parts, drop = []) {
  const s = b.mask.s;
  /** @type {Mask} */
  const m = { ...b.mask, bits: drop.length ? new Uint8Array(b.mask.bits) : b.mask.bits };
  for (const c of drop) {
    const q = c.mask;
    for (let y = 0; y < q.h; y++) {
      for (let x = 0; x < q.w; x++) {
        const mx = q.x0 + x - m.x0; const my = q.y0 + y - m.y0;
        if (q.bits[y * q.w + x] && mx >= 0 && my >= 0 && mx < m.w && my < m.h) m.bits[my * m.w + mx] = 0;
      }
    }
  }
  const boxes = parts.map((p) => union(p.map((c) => c.box)));
  const n = parts.length;
  const reach = 0.6 * b.glyph;
  const comp = new Int32Array(m.w * m.h).fill(-1);
  /** @type {boolean[]} */
  const near = [];
  const stack = [];
  for (let k0 = 0; k0 < m.w * m.h; k0++) {
    if (!m.bits[k0] || comp[k0] >= 0) continue;
    const id = near.length;
    let x0 = m.w; let y0 = m.h; let x1 = -1; let y1 = -1;
    comp[k0] = id; stack.push(k0);
    while (stack.length) {
      const k = /** @type {number} */ (stack.pop());
      const x = k % m.w; const y = (k - x) / m.w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= m.w || yy >= m.h) continue;
          const q = yy * m.w + xx;
          if (m.bits[q] && comp[q] < 0) { comp[q] = id; stack.push(q); }
        }
      }
    }
    const box = { x0: (m.x0 + x0) * s, y0: (m.y0 + y0) * s, x1: (m.x0 + x1 + 1) * s, y1: (m.y0 + y1 + 1) * s };
    near.push(boxes.some((q) => Math.max(gap(q.x0, q.x1, box.x0, box.x1), gap(q.y0, q.y1, box.y0, box.y1)) <= reach));
  }
  const owner = new Int16Array(m.w * m.h).fill(-1);
  const ex0 = new Int32Array(n).fill(m.w); const ey0 = new Int32Array(n).fill(m.h);
  const ex1 = new Int32Array(n).fill(-1); const ey1 = new Int32Array(n).fill(-1);
  for (let y = 0; y < m.h; y++) {
    const py = (m.y0 + y + 0.5) * s;
    for (let x = 0; x < m.w; x++) {
      const k = y * m.w + x;
      if (!m.bits[k] || !near[comp[k]]) continue;
      const pxv = (m.x0 + x + 0.5) * s;
      let best = 0; let bestD = Infinity;
      for (let j = 0; j < n; j++) {
        const q = boxes[j];
        const dx = Math.max(q.x0 - pxv, 0, pxv - q.x1); const dy = Math.max(q.y0 - py, 0, py - q.y1);
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = j; }
      }
      owner[k] = best;
      if (x < ex0[best]) ex0[best] = x;
      if (x > ex1[best]) ex1[best] = x;
      if (y < ey0[best]) ey0[best] = y;
      if (y > ey1[best]) ey1[best] = y;
    }
  }
  return parts.map((p, j) => {
    const x0 = ex0[j]; const y0 = ey0[j]; const x1 = ex1[j]; const y1 = ey1[j];
    const full = p.filter((c) => !c.mark);
    const sizes = (full.length ? full : p).map((c) => c.size);
    const big = Math.max(...sizes);
    const glyph = median(sizes.filter((v) => v >= SMALL * big));
    const cells = full.filter((c) => c.size >= SMALL * big).length || 1;
    if (x1 < 0) {
      const box = boxes[j];
      return { ...b, box, glyph, cells, mask: { x0: Math.floor(box.x0 / s), y0: Math.floor(box.y0 / s), w: 1, h: 1, s, bits: new Uint8Array(1) } };
    }
    const w = x1 - x0 + 1; const h = y1 - y0 + 1;
    const bits = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (owner[(y + y0) * m.w + x + x0] === j) bits[y * w + x] = 1;
    return {
      box: {
        x0: Math.max(b.box.x0, Math.floor((m.x0 + x0) * s)), y0: Math.max(b.box.y0, Math.floor((m.y0 + y0) * s)),
        x1: Math.min(b.box.x1, Math.ceil((m.x0 + x0 + w) * s)), y1: Math.min(b.box.y1, Math.ceil((m.y0 + y0 + h) * s)),
      },
      glyph,
      dark: b.dark,
      vertical: b.vertical,
      cells,
      ink: b.ink,
      paper: b.paper,
      mask: { x0: m.x0 + x0, y0: m.y0 + y0, w, h, s, bits },
    };
  });
}

/**
 * @param {TextMap} map
 * @param {Map<TextBlock, Bubble>} bubbles
 * @returns {Texts}
 */
export function textsOf(map, bubbles) {
  const chars = map.chars ?? [];
  const own = owners(map.blocks, chars.filter((c) => c.inBlock));
  const cuts = new Map(map.blocks.map((b) => [b, cut(b, own.get(b) ?? [])]));
  for (const bub of new Set(bubbles.values())) {
    if (!bub.blocks.some((b) => cuts.get(b)?.fields.some(Boolean))) continue;
    for (const b of bub.blocks) if (!b.vertical) cuts.set(b, cut(b, own.get(b) ?? [], true));
  }
  /** @type {Map<TextBlock, TextBlock[]>} */
  const into = new Map();
  /** @type {Map<TextBlock, TextChar[]>} */
  const cells = new Map();
  /** @type {Set<TextChar>} */
  const apart = new Set();
  /** @type {Map<TextBlock, number[]>} */
  const spacing = new Map();
  /** @type {Map<TextBlock, number>} */
  const count = new Map();
  /** @param {Row[]} rows */
  const charsIn = (rows) => rows.reduce((n, r) => n + r.chars.length, 0);
  /** @type {TextBlock[]} */
  const blocks = [];
  for (const b of map.blocks) {
    const mine = own.get(b) ?? [];
    const c = cuts.get(b);
    if (!c) {
      const rows = rowsOf(mine.filter((q) => !q.mark), b.vertical);
      blocks.push(b);
      spacing.set(b, spacings(rows));
      count.set(b, charsIn(rows) || b.cells);
      continue;
    }
    const gaps = spacings(c.rows);
    /** @param {TextChar[]} q */
    const along = (q) => q.filter((x) => !x.mark).sort((u, v) => u.box.x0 - v.box.x0);
    if (c.parts.length === 1) {
      blocks.push(b);
      spacing.set(b, gaps);
      count.set(b, charsIn(c.rows) || b.cells);
      if (c.fields[0]) cells.set(b, along(c.parts[0]));
      continue;
    }
    const parts = share(b, c.parts, c.faint);
    into.set(b, parts);
    parts.forEach((p, k) => {
      blocks.push(p);
      spacing.set(p, gaps);
      count.set(p, p.cells);
      for (const q of c.parts[k]) apart.add(q);
      if (c.fields[k]) cells.set(p, along(c.parts[k]));
    });
  }

  /** @type {Map<TextBlock, Text>} */
  const texts = new Map();
  for (const bub of new Set(bubbles.values())) {
    const parts = bub.blocks.flatMap((b) => into.get(b) ?? [b]);
    if (!parts.length) continue;
    const size = Math.max(...parts.map((p) => p.glyph));
    const usualV = median([...parts.filter((p) => p.vertical).flatMap((p) => spacing.get(p) ?? []), USUAL * size]);
    const usualH = median([...parts.filter((p) => !p.vertical).flatMap((p) => spacing.get(p) ?? []), USUAL * size]);
    /** @param {TextBlock} p @param {Box} box @param {number} g @param {boolean} [field] */
    const reads = (p, box, g, field) => together(p.box, box, g, p.vertical, p.vertical ? usualV : usualH, field);
    const up = parts.map((_, i) => i);
    /** @param {number} i @returns {number} */
    const top = (i) => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const p = parts[i]; const q = parts[j];
        const main = p.glyph * p.cells >= q.glyph * q.cells ? p : q;
        const other = main === p ? q : p;
        if (reads(main, other.box, Math.max(p.glyph, q.glyph), cells.has(p) || cells.has(q))) up[top(i)] = top(j);
      }
    }
    /** @type {Map<number, TextBlock[]>} */
    const groups = new Map();
    parts.forEach((p, i) => { const k = top(i); const g = groups.get(k); if (g) g.push(p); else groups.set(k, [p]); });
    const list = [...groups.values()].map((g) => ({ blocks: g, chars: /** @type {TextChar[]} */ ([]) }));
    let rest = [...bub.chars];
    for (let grew = true; grew && rest.length;) {
      grew = false;
      for (const c of [...rest]) {
        let best = null; let bestD = Infinity;
        for (const t of list) {
          for (const p of t.blocks) {
            for (const box of [p.box, ...t.chars.map((q) => q.box)]) {
              const ok = c.mark
                ? Math.max(gap(box.x0, box.x1, c.box.x0, c.box.x1), gap(box.y0, box.y1, c.box.y0, c.box.y1)) <= 0.7 * p.glyph
                : together(box, c.box, Math.max(p.glyph, c.size), p.vertical, p.vertical ? usualV : usualH, cells.has(p));
              if (!ok) continue;
              const d = Math.max(gap(box.x0, box.x1, c.box.x0, c.box.x1), gap(box.y0, box.y1, c.box.y0, c.box.y1));
              if (d < bestD) { bestD = d; best = t; }
            }
          }
        }
        if (!best) continue;
        best.chars.push(c);
        rest = rest.filter((q) => q !== c);
        grew = true;
      }
    }
    for (const t of list) {
      /** @type {Text} */
      const text = {
        box: bub.box,
        text: union([...t.blocks.map((p) => p.box), ...t.chars.map((c) => c.box)]),
        blocks: t.blocks,
        chars: t.chars,
        bubble: bub,
      };
      const big = Math.max(...t.blocks.map((p) => p.glyph));
      for (const p of t.blocks) {
        texts.set(p, text);
        if (p.glyph < SMALL * big) count.set(p, 0);
      }
    }
  }
  return { map: { ...map, blocks }, texts, cells, count, apart };
}

/**
 * @param {TextBlock} cell
 * @param {TextChar[]} chars
 * @param {Box} box
 * @returns {{inside: TextChar[], outside: TextChar[][]} | null}
 */
export function trimCell(cell, chars, box) {
  if (chars.length < 2) return null;
  const S = cell.glyph;
  const X = { x0: box.x0 - 0.1 * S, y0: box.y0 - 0.1 * S, x1: box.x1 + 0.1 * S, y1: box.y1 + 0.1 * S };
  /** @param {TextChar} c */
  const shareIn = (c) => area({ x0: Math.max(c.box.x0, X.x0), y0: Math.max(c.box.y0, X.y0), x1: Math.min(c.box.x1, X.x1), y1: Math.min(c.box.y1, X.y1) }) / Math.max(1, area(c.box));
  const inside = chars.map((c) => shareIn(c) >= 0.5);
  const first = inside.indexOf(true); const last = inside.lastIndexOf(true);
  if (first < 0 || (first === 0 && last === chars.length - 1)) return null;
  for (let k = first; k <= last; k++) if (!inside[k]) return null;
  const before = chars.slice(0, first); const after = chars.slice(last + 1);
  /** @param {TextChar[]} rest @param {number} space */
  const away = (rest, space) => rest.length >= 2 && space >= 0.35 * Math.max(...rest.map((c) => c.size), chars[first].size);
  if (before.length && !away(before, chars[first].box.x0 - before[before.length - 1].box.x1)) return null;
  if (after.length && !away(after, after[0].box.x0 - chars[last].box.x1)) return null;
  return { inside: chars.slice(first, last + 1), outside: [before, after].filter((p) => p.length) };
}
