// @ts-check

/** @typedef {import('./analysis.js').Box} Box */
/** @typedef {import('./textmap.js').TextMap} TextMap */
/** @typedef {import('./textmap.js').TextChar} TextChar */
/** @typedef {import('./textmap.js').TextBlock} TextBlock */

/** @param {Box} b */
const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
/** @param {Box} a @param {Box} b */
const inter = (a, b) => area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
/** @param {Box} a @param {Box} b */
const gapX = (a, b) => Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
/** @param {Box} a @param {Box} b */
const gapY = (a, b) => Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);

/**
 * @param {Box} a
 * @param {Box} b
 * @param {number} g
 * @param {boolean | null} [vertical]
 */
function inLine(a, b, g, vertical = null) {
  const col = vertical !== false && -gapX(a, b) >= 0.5 * Math.min(a.x1 - a.x0, b.x1 - b.x0) && gapY(a, b) <= g;
  return col || (vertical !== true && -gapY(a, b) >= 0.5 * Math.min(a.y1 - a.y0, b.y1 - b.y0) && gapX(a, b) <= g);
}

/**
 * @param {TextChar[]} all
 * @param {number} M
 * @returns {boolean | null}
 */
function arrangement(all, M) {
  const chars = all.filter((c) => Math.min(c.box.x1 - c.box.x0, c.box.y1 - c.box.y0) >= 0.5 * M);
  let down = 0; let across = 0;
  for (const a of chars) {
    let best = Infinity; let col = false;
    for (const b of chars) {
      if (b === a) continue;
      const d = Math.max(gapX(a.box, b.box), gapY(a.box, b.box));
      if (d >= best) continue;
      best = d;
      col = -gapX(a.box, b.box) >= 0.5 * Math.min(a.box.x1 - a.box.x0, b.box.x1 - b.box.x0);
    }
    if (best === Infinity) continue;
    if (col) down++; else across++;
  }
  return down + across < 2 ? null : down >= 2 * across ? true : across >= 2 * down ? false : null;
}

/**
 * @param {TextChar} c
 * @param {number} a0
 * @param {number} a1
 * @param {boolean} vertical
 * @returns {TextChar | null}
 */
export function cut(c, a0, a1, vertical) {
  const m = c.mask;
  const lo = Math.ceil(a0 / m.s) - (vertical ? m.x0 : m.y0);
  const hi = Math.floor(a1 / m.s) - (vertical ? m.x0 : m.y0);
  let x0 = m.w; let y0 = m.h; let x1 = -1; let y1 = -1; let n = 0;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const v = vertical ? x : y;
      if (v < lo || v >= hi || !m.bits[y * m.w + x]) continue;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!n) return null;
  const w = x1 - x0 + 1; const h = y1 - y0 + 1;
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = vertical ? x + x0 : y + y0;
      if (v >= lo && v < hi && m.bits[(y + y0) * m.w + x + x0]) bits[y * w + x] = 1;
    }
  }
  const mask = { x0: m.x0 + x0, y0: m.y0 + y0, w, h, s: m.s, bits };
  const box = {
    x0: Math.max(c.box.x0, Math.floor(mask.x0 * m.s)), y0: Math.max(c.box.y0, Math.floor(mask.y0 * m.s)),
    x1: Math.min(c.box.x1, Math.ceil((mask.x0 + w) * m.s)), y1: Math.min(c.box.y1, Math.ceil((mask.y0 + h) * m.s)),
  };
  return { ...c, box, size: vertical ? box.x1 - box.x0 : box.y1 - box.y0, n, mask, of: c };
}

/**
 * @param {TextChar[]} chars
 * @param {TextBlock} [like]
 * @returns {TextBlock}
 */
export function blockOfChars(chars, like) {
  const s = chars[0].mask.s;
  let mx0 = Infinity; let my0 = Infinity; let mx1 = -Infinity; let my1 = -Infinity;
  for (const c of chars) {
    mx0 = Math.min(mx0, c.mask.x0); my0 = Math.min(my0, c.mask.y0);
    mx1 = Math.max(mx1, c.mask.x0 + c.mask.w); my1 = Math.max(my1, c.mask.y0 + c.mask.h);
  }
  const w = mx1 - mx0; const h = my1 - my0;
  const bits = new Uint8Array(w * h);
  for (const c of chars) {
    const m = c.mask;
    for (let y = 0; y < m.h; y++) {
      const row = (m.y0 - my0 + y) * w + (m.x0 - mx0);
      for (let x = 0; x < m.w; x++) if (m.bits[y * m.w + x]) bits[row + x] = 1;
    }
  }
  const dark = like ? like.dark : chars[0].dark;
  const own = chars.filter((c) => c.dark === dark);
  const all = (own.length ? own : chars).filter((c) => !c.mark).map((c) => c.size).sort((a, b) => a - b);
  const sizes = all.length ? all.filter((v) => v >= 0.5 * all[Math.floor(0.75 * all.length)]) : chars.map((c) => c.size).sort((a, b) => a - b);
  let n = 0; let ink = 0; let paper = 0;
  for (const c of own) { n += c.n; ink += c.ink * c.n; paper += c.paper * c.n; }
  const box = {
    x0: Math.min(...chars.map((c) => c.box.x0)), y0: Math.min(...chars.map((c) => c.box.y0)),
    x1: Math.max(...chars.map((c) => c.box.x1)), y1: Math.max(...chars.map((c) => c.box.y1)),
  };
  return {
    box,
    glyph: sizes[sizes.length >> 1],
    dark,
    vertical: box.y1 - box.y0 > 1.3 * (box.x1 - box.x0),
    cells: all.length ? sizes.length : 0,
    ink: n ? ink / n : like ? like.ink : 0,
    paper: n ? paper / n : like ? like.paper : 0,
    mask: { x0: mx0, y0: my0, w, h, s, bits },
  };
}

/**
 * @param {TextMap} map
 * @param {Box} box
 * @param {Set<TextChar>} taken
 * @param {{like?: TextBlock[], spoken?: (c: TextChar) => boolean, fill?: boolean}} [opt]
 * @returns {{block: TextBlock, chars: TextChar[]} | null}
 */
export function guide(map, box, taken, opt = {}) {
  const bw = box.x1 - box.x0; const bh = box.y1 - box.y0;
  if (bw <= 0 || bh <= 0 || !map.chars?.length) return null;
  const m = 0.12 * Math.min(bw, bh);
  const X = { x0: box.x0 - m, y0: box.y0 - m, x1: box.x1 + m, y1: box.y1 + m };
  const spoken = opt.spoken ?? ((/** @type {TextChar} */ c) => c.inBlock);
  /** @param {TextChar} c */
  const free = (c) => !spoken(c) && !taken.has(c) && inter(c.box, X) >= 0.5 * area(c.box);
  /** @type {{dark: boolean, kept: TextChar[], M: number, score: number, anchors: Box[], along: boolean | null} | null} */
  let best = null;
  const like = opt.like?.length ? opt.like : null;
  for (const dark of [true, false]) {
    if (like && like[0].dark !== dark) continue;
    const own = map.chars.filter((c) => c.dark === dark && !c.mark && free(c));
    if (!own.length && !like) continue;
    const sizes = own.map((c) => c.size).sort((a, b) => a - b);
    const M = like ? like.map((b) => b.glyph).sort((a, b) => a - b)[like.length >> 1] : sizes[sizes.length >> 1];
    const alike = own.filter((c) => c.size >= 0.5 * M && c.size <= 2 * M && c.clear >= 0.55);
    const up = alike.map((_, i) => i);
    /** @param {number} i @returns {number} */
    const top = (i) => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
    const reach = 0.9 * M;
    for (let i = 0; i < alike.length; i++) {
      for (let j = i + 1; j < alike.length; j++) {
        if (gapX(alike[i].box, alike[j].box) <= reach && gapY(alike[i].box, alike[j].box) <= reach) up[top(i)] = top(j);
      }
    }
    /** @type {Map<number, TextChar[]>} */
    const groups = new Map();
    alike.forEach((c, i) => { const r = top(i); const g = groups.get(r); if (g) g.push(c); else groups.set(r, [c]); });
    const big = 0.3 * Math.max(bw, bh);
    const anchors = like ? map.chars.filter((c) => c.dark === dark && c.inBlock && !c.mark
      && like.some((b) => inter(c.box, b.box) >= 0.6 * area(c.box))).map((c) => c.box) : [];
    if (like && anchors.length < 0.5 * like.reduce((n, b) => n + b.cells, 0)) anchors.push(...like.map((b) => b.box));
    const by = (/** @type {TextChar} */ c) => anchors.some((q) => q.x1 - q.x0 > 2 * M || q.y1 - q.y0 > 2 * M
      ? gapX(c.box, q) <= 1.2 * M && gapY(c.box, q) <= 1.2 * M : inLine(c.box, q, 1.2 * M));
    const kept = [...groups.values()].filter((g) => (like && g.some(by)) || ((!like || opt.fill) && (g.length >= 2 || g[0].size >= big))).flat();
    if (!kept.length && !like) continue;
    const along = like ? like.some((b) => b.vertical) : arrangement(kept, M);
    const found = new Set(kept);
    const rest = map.chars.filter((c) => !c.mark && !spoken(c) && !taken.has(c) && !found.has(c) && c.clear >= 0.55
      && (c.dark === dark ? c.size >= 0.6 * M && c.size <= 1.6 * M : !!like && free(c) && c.size >= 0.7 * M && c.size <= 1.7 * M));
    const merged = along === null ? [] : map.chars.filter((c) => c.dark === dark && !c.mark && !c.inBlock && !spoken(c) && !taken.has(c)
      && c.size > 1.6 * M && c.size <= 6 * M && inter(c.box, X) > 0);
    const ends = !merged.length || !like ? [] : map.chars.filter((c) => c.dark === dark && c.inBlock && c.size <= 2 * M
      && like.some((b) => inter(c.box, b.box) >= 0.6 * area(c.box)));
    /** @type {Map<TextChar, [number, number][]>} */
    const cuts = new Map();
    for (let grew = true; grew;) {
      grew = false;
      for (const c of rest) {
        if (found.has(c)) continue;
        const rim = c.dark !== dark;
        let on = false;
        for (const k of found) if (inLine(c.box, k.box, 0.6 * M, rim || k.dark !== dark ? along : null)) { on = true; break; }
        if (!on && rim) on = anchors.some((q) => inLine(c.box, q, 0.6 * M, along));
        if (on) { found.add(c); grew = true; }
      }
      for (const c of merged) {
        if (found.has(c)) continue;
        for (const k of [...found, ...ends]) {
          if (k.dark !== dark || k.of === c) continue;
          const [a0, a1, c0, c1] = along ? [k.box.x0, k.box.x1, c.box.x0, c.box.x1] : [k.box.y0, k.box.y1, c.box.y0, c.box.y1];
          if (Math.min(a1, c1) - Math.max(a0, c0) < 0.5 * (a1 - a0) || (along ? gapY(c.box, k.box) : gapX(c.box, k.box)) > 0.8 * M) continue;
          const mid = (a0 + a1) / 2; const half = Math.max((a1 - a0) / 2, 0.5 * M) + 0.15 * M;
          const done = cuts.get(c) ?? [];
          if (done.some(([d0, d1]) => Math.min(d1, mid + half) - Math.max(d0, mid - half) > half)) continue;
          cuts.set(c, [...done, [mid - half, mid + half]]);
          const part = cut(c, mid - half, mid + half, !!along);
          if (part) { found.add(part); grew = true; }
        }
      }
    }
    if (!found.size && !like) continue;
    kept.splice(0, kept.length, ...found);
    kept.sort((a, b) => (a.dark === dark ? 0 : 1) - (b.dark === dark ? 0 : 1));
    const score = kept.reduce((a, c) => a + c.n * c.clear, 0);
    if (!best || score > best.score) best = { dark, kept, M, score, anchors, along };
  }
  if (!best) return null;
  if (!like && best.kept.length < 3) {
    const u = {
      x0: Math.min(...best.kept.map((c) => c.box.x0)), y0: Math.min(...best.kept.map((c) => c.box.y0)),
      x1: Math.max(...best.kept.map((c) => c.box.x1)), y1: Math.max(...best.kept.map((c) => c.box.y1)),
    };
    if (inter(u, box) < 0.15 * area(box)) return null;
  }
  const { dark, kept, along } = best;
  const near = 0.7 * best.M;
  const by = [...kept.map((k) => k.box), ...best.anchors];
  const small = map.chars.filter((c) => (c.mark || c.size < 0.5 * best.M) && c.dark === dark && !spoken(c)
    && !taken.has(c) && !kept.includes(c));
  const marks = small.filter((c) => by.some((q) => gapX(q, c.box) <= near && gapY(q, c.box) <= near));
  const inMarks = new Set(marks);
  for (let i = 0; i < marks.length; i++) {
    const p = marks[i];
    const next = small.filter((c) => !inMarks.has(c) && free(c) && Math.abs(c.size - p.size) <= 0.5 * Math.max(c.size, p.size)
      && inLine(c.box, p.box, 1.5 * Math.max(c.size, p.size), along));
    if (next.length > 2) continue;
    for (const c of next) { marks.push(c); inMarks.add(c); }
  }
  const chars = [...kept, ...marks];
  if (!chars.length) return null;
  return { block: blockOfChars(chars, like?.[0]), chars };
}
