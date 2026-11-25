import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTextMap } from '../../background/textmap.js';
import { Matcher, assign, greedy } from '../../background/match.js';
import { eraseLettering } from '../../background/inpaint.js';
import { Placer, dialogueSize } from '../../background/placement.js';
import { overlap } from '../../background/analysis.js';
import { findBubbles } from '../../background/bubbles.js';
import { readPng } from './png.mjs';

const DIR = new URL('./fixtures/', import.meta.url);
const truth = JSON.parse(readFileSync(new URL('manga.json', DIR), 'utf8'));
const pages = Object.keys(truth);
const load = (name) => readPng(new URL(name, DIR).pathname);
const px = Object.fromEntries(pages.map((n) => [n, load(n)]));
const labels = Object.fromEntries(pages.map((n) => [n, load(n.replace('.png', '.labels.png'))]));
const maps = Object.fromEntries(pages.map((n) => [n, buildTextMap(px[n])]));

const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const inter = (a, b) => area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const boxOf = (t) => ({ x0: t.box[0], y0: t.box[1], x1: t.box[2], y1: t.box[3] });
const label = (name, x, y) => labels[name].data[(y * labels[name].W + x) * 4];

for (const name of pages) {
  const map = maps[name];
  for (const t of truth[name].blocks) {
    test(`text map, ${name} #${t.id} (${t.kind}, ${t.polarity}, ${t.vertical ? 'vertical' : 'horizontal'}): found, all of it`, () => {
      const B = boxOf(t);
      let total = 0; let covered = 0;
      for (let y = B.y0; y < B.y1; y++) {
        for (let x = B.x0; x < B.x1; x++) {
          if (label(name, x, y) !== t.id) continue;
          total++;
          if (map.blocks.some((b) => { const m = 0.2 * b.glyph; return x >= b.box.x0 - m && x < b.box.x1 + m && y >= b.box.y0 - m && y < b.box.y1 + m; })) covered++;
        }
      }
      assert.ok(covered >= 0.97 * total, `${covered}/${total} of its pixels covered`);
      const hits = map.blocks.filter((b) => inter(b.box, B) > 0.3 * Math.min(area(b.box), area(B)));
      assert.ok(hits.length >= 1 && hits.length <= 2, `${hits.length} blocks`);
      for (const b of hits) assert.equal(b.dark, t.polarity === 'dark', 'polarity');
    });
  }
  test(`text map, ${name}: nothing but lettering (no artwork taken for text)`, () => {
    const T = truth[name].blocks.map(boxOf);
    const stray = map.blocks.filter((b) => !T.some((B) => inter(b.box, B) > 0.3 * Math.min(area(b.box), area(B))));
    assert.equal(stray.length, 0, stray.map((b) => JSON.stringify(b.box)).join(' '));
  });
  test(`text map, ${name}: block masks are glyphs only`, () => {
    for (const b of map.blocks) {
      const m = b.mask;
      let n = 0; let off = 0;
      for (let y = 0; y < m.h; y++) {
        for (let x = 0; x < m.w; x++) {
          if (!m.bits[y * m.w + x]) continue;
          n++;
          const X = Math.floor((m.x0 + x) * m.s); const Y = Math.floor((m.y0 + y) * m.s);
          let near = false;
          for (let dy = -2; dy <= 2 && !near; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const xx = X + dx; const yy = Y + dy;
              if (xx >= 0 && yy >= 0 && xx < labels[name].W && yy < labels[name].H && label(name, xx, yy)) { near = true; break; }
            }
          }
          if (!near) off++;
        }
      }
      assert.ok(off <= 0.05 * n, `${JSON.stringify(b.box)}: ${off}/${n} mask pixels away from any lettering`);
    }
  });
}

test('text map: pages with no lettering — flat, screentone, hatching, stripes, dots — give no blocks', () => {
  const mk = (W, H, f) => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [r, g, b] = f(x, y);
        const i = (y * W + x) * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
      }
    }
    return { W, H, data };
  };
  const cases = {
    blank: mk(600, 400, () => [255, 255, 255]),
    black: mk(600, 400, () => [0, 0, 0]),
    screentone: mk(600, 400, (x, y) => { const dx = (x % 6) - 3; const dy = (y % 6) - 3; return dx * dx + dy * dy < 3 ? [60, 60, 60] : [255, 255, 255]; }),
    hatching: mk(600, 400, (x, y) => ((x + y) % 7 < 2 ? [40, 40, 40] : [250, 250, 250])),
    checker: mk(600, 400, (x, y) => (((x >> 4) + (y >> 4)) % 2 ? [0, 0, 0] : [255, 255, 255])),
    gradient: mk(600, 400, (x) => { const v = Math.floor((x / 600) * 255); return [v, v, 255 - v]; }),
    dots: mk(600, 400, (x, y) => { const cx = (x % 40) - 20; const cy = (y % 40) - 20; return cx * cx + cy * cy < 64 ? [0, 0, 0] : [255, 255, 255]; }),
    stripes: mk(600, 400, (x) => (x % 30 < 8 ? [0, 0, 0] : [255, 255, 255])),
  };
  for (const [name, p] of Object.entries(cases)) assert.equal(buildTextMap(p).blocks.length, 0, name);
});

function resample(src, k) {
  const W = Math.round(src.W * k); const H = Math.round(src.H * k);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = (y * W + x) * 4;
      data[d + 3] = 255;
      if (k >= 1) {
        const fx = Math.max(0, (x + 0.5) / k - 0.5); const fy = Math.max(0, (y + 0.5) / k - 0.5);
        const x0 = Math.min(src.W - 1, Math.floor(fx)); const y0 = Math.min(src.H - 1, Math.floor(fy));
        const x1 = Math.min(src.W - 1, x0 + 1); const y1 = Math.min(src.H - 1, y0 + 1);
        const ax = fx - x0; const ay = fy - y0;
        for (let c = 0; c < 3; c++) {
          const p = (yy, xx) => src.data[(yy * src.W + xx) * 4 + c];
          data[d + c] = (p(y0, x0) * (1 - ax) + p(y0, x1) * ax) * (1 - ay) + (p(y1, x0) * (1 - ax) + p(y1, x1) * ax) * ay;
        }
        continue;
      }
      const sx0 = x / k; const sx1 = (x + 1) / k; const sy0 = y / k; const sy1 = (y + 1) / k;
      const acc = [0, 0, 0]; let wsum = 0;
      for (let yy = Math.floor(sy0); yy < Math.min(src.H, Math.ceil(sy1)); yy++) {
        const wy = Math.min(yy + 1, sy1) - Math.max(yy, sy0);
        for (let xx = Math.floor(sx0); xx < Math.min(src.W, Math.ceil(sx1)); xx++) {
          const wgt = wy * (Math.min(xx + 1, sx1) - Math.max(xx, sx0));
          for (let c = 0; c < 3; c++) acc[c] += wgt * src.data[(yy * src.W + xx) * 4 + c];
          wsum += wgt;
        }
      }
      for (let c = 0; c < 3; c++) data[d + c] = acc[c] / wsum;
    }
  }
  return { W, H, data };
}

for (const k of [0.7, 1.3, 1.6, 2]) {
  test(`text map: the pages at ${k}× their size — lettering still found, screentone, hatching and hair still not taken for it`, () => {
    let found = 0; let total = 0;
    /** @type {string[]} */
    const stray = [];
    for (const name of pages) {
      const map = buildTextMap(resample(px[name], k));
      const T = truth[name].blocks.map((t) => ({ x0: t.box[0] * k, y0: t.box[1] * k, x1: t.box[2] * k, y1: t.box[3] * k }));
      for (const B of T) { total++; if (map.blocks.some((b) => inter(b.box, B) > 0.5 * area(b.box))) found++; }
      for (const b of map.blocks) if (!T.some((B) => inter(b.box, B) > 0.3 * area(b.box))) stray.push(`${name} ${JSON.stringify(b.box)}`);
    }
    assert.ok(found >= 0.9 * total, `${found}/${total} blocks found`);
    assert.ok(stray.length <= 4, `${stray.length} blocks of artwork: ${stray.join(' ')}`);
  });
}

let seed = 1;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const shift = (b, k) => {
  const a = rand() * 2 * Math.PI; const w = b.x1 - b.x0; const h = b.y1 - b.y0;
  return { x0: b.x0 + Math.cos(a) * k * w, y0: b.y0 + Math.sin(a) * k * h, x1: b.x1 + Math.cos(a) * k * w, y1: b.y1 + Math.sin(a) * k * h };
};
const scale = (b, k) => {
  const cx = (b.x0 + b.x1) / 2; const cy = (b.y0 + b.y1) / 2; const w = ((b.x1 - b.x0) * k) / 2; const h = ((b.y1 - b.y0) * k) / 2;
  return { x0: cx - w, y0: cy - h, x1: cx + w, y1: cy + h };
};

function matchPage(name, err) {
  const map = maps[name];
  const T = truth[name].blocks.map((t) => ({ ...t, B: boxOf(t) }));
  const order = [...T].sort((a, b) => (Math.abs(a.B.y0 - b.B.y0) > 120 ? a.B.y0 - b.B.y0 : b.B.x1 - a.B.x1));
  const boxes = new Map(order.map((t) => [t.id, err(t.B)]));
  const m = new Matcher(map);
  const shown = new Map();
  const apply = (acts) => {
    for (const a of acts) {
      if (a.type === 'show') shown.set(a.id, a.blocks);
      else shown.delete(a.id);
    }
  };
  for (const t of order) apply(m.place(t.id, boxes.get(t.id), t.chars));
  apply(m.finish());
  let ok = 0;
  const bad = [];
  for (const t of T) {
    const blocks = shown.get(t.id) || [];
    const patches = blocks.map((b) => { const g = Math.max(4, 0.25 * b.glyph); return { x0: b.box.x0 - g, y0: b.box.y0 - g, x1: b.box.x1 + g, y1: b.box.y1 + g }; });
    let total = 0; let cov = 0; let foreign = 0;
    for (let y = Math.max(0, t.B.y0 - 60); y < Math.min(labels[name].H, t.B.y1 + 60); y++) {
      for (let x = Math.max(0, t.B.x0 - 60); x < Math.min(labels[name].W, t.B.x1 + 60); x++) {
        const v = label(name, x, y);
        if (!v) continue;
        const inPatch = patches.some((p) => x >= p.x0 && x < p.x1 && y >= p.y0 && y < p.y1);
        if (v === t.id) { total++; if (inPatch) cov++; } else if (inPatch) foreign++;
      }
    }
    if (cov >= 0.98 * total && foreign < 0.02 * total) ok++;
    else bad.push(`#${t.id} ${blocks.length ? `covers ${Math.round((100 * cov) / total)}%${foreign ? ` +${foreign}px foreign` : ''}` : 'not shown'} (box ${['x0', 'y0', 'x1', 'y1'].map((k) => Math.round(boxes.get(t.id)[k])).join(',')})`);
  }
  return { ok, n: T.length, bad };
}

const scenarios = {
  'exact boxes': () => (b) => b,
  'boxes half a box off': () => (b) => shift(b, 0.5),
  'boxes a whole box off, each its own way': () => (b) => shift(b, 1),
  'boxes too small': () => (b) => scale(b, 0.6),
  'boxes too large': () => (b) => scale(b, 1.5),
  'boxes around one column': () => (b) => ({ ...b, x0: b.x1 - 0.4 * (b.x1 - b.x0) }),
  'boxes around the top half': () => (b) => ({ ...b, y1: b.y0 + 0.5 * (b.y1 - b.y0) }),
  'all boxes 150 px off the same way': () => { const a = rand() * 2 * Math.PI; return (b) => ({ x0: b.x0 + 150 * Math.cos(a), y0: b.y0 + 150 * Math.sin(a), x1: b.x1 + 150 * Math.cos(a), y1: b.y1 + 150 * Math.sin(a) }); },
  'coordinates scaled as if the image were 0.85× its size': () => (b) => ({ x0: b.x0 * 0.85, y0: b.y0 * 0.85, x1: b.x1 * 0.85, y1: b.y1 * 0.85 }),
  'coordinates scaled 1.12×': () => (b) => ({ x0: b.x0 * 1.12, y0: b.y0 * 1.12, x1: b.x1 * 1.12, y1: b.y1 * 1.12 }),
};
for (const [how, make] of Object.entries(scenarios)) {
  test(`matching: ${how} — every translation over all of its own text`, () => {
    for (const name of pages) {
      const trials = how.includes('off') ? 3 : 1;
      for (let i = 0; i < trials; i++) {
        const r = matchPage(name, make());
        assert.equal(r.ok, r.n, `${name}: ${r.ok}/${r.n}: ${r.bad.join('; ')}`);
      }
    }
  });
}

test('matching: a realistic mix (most boxes roughly right, one in three badly off) — 98% or better', () => {
  seed = 7;
  const bad = [(b) => shift(b, 1), (b) => shift(b, 1.5), (b) => scale(b, 0.6), (b) => scale(b, 1.5), (b) => ({ ...b, x0: b.x1 - 0.4 * (b.x1 - b.x0) })];
  let ok = 0; let n = 0;
  for (let trial = 0; trial < 8; trial++) {
    for (const name of pages) {
      const r = matchPage(name, (b) => {
        if (rand() < 0.67) {
          const jit = (v, w) => v + (rand() - 0.5) * 0.3 * w;
          const w = b.x1 - b.x0; const h = b.y1 - b.y0;
          return { x0: jit(b.x0, w), y0: jit(b.y0, h), x1: jit(b.x1, w), y1: jit(b.y1, h) };
        }
        return bad[Math.floor(rand() * bad.length)](b);
      });
      ok += r.ok; n += r.n;
    }
  }
  assert.ok(ok >= 0.98 * n, `${ok}/${n}`);
});

test('matching: the same text described twice is drawn once', () => {
  const name = 'manga-1.png';
  const t = truth[name].blocks.find((b) => b.kind === 'bubble');
  const m = new Matcher(maps[name]);
  const shown = new Map();
  const apply = (acts) => { for (const a of acts) { if (a.type === 'show') shown.set(a.id, a.blocks); else shown.delete(a.id); } };
  apply(m.place(1, boxOf(t), t.chars));
  apply(m.place(2, scale(boxOf(t), 0.9), t.chars));
  apply(m.finish());
  assert.equal(shown.size, 1, `shown: ${[...shown.keys()]}`);
  const [blocks] = shown.values();
  assert.ok(blocks.some((b) => inter(b.box, boxOf(t)) > 0.5 * area(b.box)), 'over the bubble\'s text');
});

test('assignment: the cheapest matching, leaving rows unmatched when that is cheaper', () => {
  assert.deepEqual(assign([[1, 5], [2, 1]], 10), [0, 1]);
  assert.deepEqual(assign([[1, 2], [1, 9]], 10), [1, 0]);
  assert.deepEqual(assign([[20, 30]], 10), [-1]);
  const r = assign([[1], [1]], 10);
  assert.equal(r.filter((v) => v === 0).length, 1);
  assert.equal(r.filter((v) => v === -1).length, 1);
});

test('assignment: greedy (for very large pages) takes the cheapest pairs first, never a column twice', () => {
  assert.deepEqual(greedy([[1, 5], [2, 1]], 10), [0, 1]);
  assert.deepEqual(greedy([[20, 30]], 10), [-1]);
  assert.deepEqual(greedy([[1, 9], [2, 9]], 5), [0, -1]);
});

test('assignment: hundreds of boxes against thousands of blocks in well under a second', () => {
  let s = 3; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const cost = [];
  for (let i = 0; i < 300; i++) {
    const row = new Array(2000).fill(1e9);
    const c = Math.floor((i / 300) * 2000);
    for (let k = -10; k <= 10; k++) if (c + k >= 0 && c + k < 2000) row[c + k] = 1 + 2 * r();
    cost.push(row);
  }
  const t0 = performance.now();
  const p = assign(cost, 3.6);
  assert.ok(performance.now() - t0 < 1000, `${Math.round(performance.now() - t0)} ms`);
  assert.equal(new Set(p.filter((v) => v >= 0)).size, p.filter((v) => v >= 0).length, 'no column twice');
});

const splits = [];
for (const name of pages) {
  for (const t of truth[name].blocks.filter((b) => b.kind === 'bubble' || b.kind === 'caption')) {
    const X = maps[name].blocks.filter((b) => inter(b.box, boxOf(t)) > 0.5 * area(b.box));
    if (X.length !== 1) continue;
    const bx = X[0].box;
    const halves = t.vertical
      ? [{ ...bx, x0: (bx.x0 + bx.x1) / 2 }, { ...bx, x1: (bx.x0 + bx.x1) / 2 }]
      : [{ ...bx, y1: (bx.y0 + bx.y1) / 2 }, { ...bx, y0: (bx.y0 + bx.y1) / 2 }];
    splits.push({ name, t, X: X[0], halves });
  }
}
for (const withOthers of [false, true]) {
  test(`matching: a bubble given in two parts${withOthers ? ', among the rest of the page' : ''} — one translation over all of it, the other joined to it`, () => {
    assert.ok(splits.length >= 12, `${splits.length} bubbles`);
    for (const { name, t, X, halves } of splits) {
      const m = new Matcher(maps[name]);
      const acts = [];
      let id = 10;
      if (withOthers) for (const o of truth[name].blocks) if (o !== t) acts.push(...m.place(id++, boxOf(o), o.chars));
      acts.push(...m.place(1, halves[0], Math.ceil(t.chars / 2)), ...m.place(2, halves[1], Math.ceil(t.chars / 2)), ...m.finish());
      const shown = new Map(); const into = new Map();
      for (const a of acts) {
        if (a.type === 'show') shown.set(a.id, a.blocks);
        else shown.delete(a.id);
        if (a.type === 'join') into.set(a.id, a.into);
      }
      const root = (i) => { for (let n = 0; into.has(i) && n < 50; n++) i = into.get(i); return i; };
      const where = `${name} #${t.id}: ${JSON.stringify(acts.filter((a) => a.id <= 2).map((a) => a.type + a.id))}`;
      assert.equal([1, 2].filter((i) => shown.get(i)?.includes(X)).length, 1, `${where}: drawn over it once`);
      assert.equal([1, 2].filter((i) => shown.has(i) && !shown.get(i).includes(X)).length, 0, `${where}: drawn elsewhere`);
      assert.equal(root(1), root(2), `${where}: joined`);
    }
  });
}

test('placing: a bubble given in two parts is drawn once, with both parts\' text in order', async () => {
  for (const { name, halves } of splits.slice(0, 6)) {
    const p = px[name];
    const placer = new Placer(p, { sensitivity: 0.5, lang: 'en', encode: async () => 'AAAA' });
    const screen = new Map();
    const apply = (u) => { for (const i of u.retract) screen.delete(i); for (const r of u.show) screen.set(r.i, r); };
    const norm = (b, s) => ({ x0: b.x0 / p.W, y0: b.y0 / p.H, x1: b.x1 / p.W, y1: b.y1 / p.H, t: s });
    apply(await placer.add([norm(halves[0], 'The first half')]));
    apply(await placer.add([norm(halves[1], 'and the second.')]));
    apply(await placer.finish());
    assert.deepEqual([...screen.values()].map((r) => r.t), ['The first half and the second.'], name);
  }
});

test('matching: lettering the map made no block of is built from its characters where the model\'s box is', () => {
  const ART_KINDS = new Set(['art', 'art-light', 'sfx', 'aside', 'open']);
  const misses = [];
  let n = 0;
  for (const name of pages) {
    const map = maps[name];
    for (const t of truth[name].blocks.filter((b) => ART_KINDS.has(b.kind))) {
      const B = boxOf(t);
      const blind = {
        ...map,
        blocks: map.blocks.filter((b) => inter(b.box, B) <= 0.3 * Math.min(area(b.box), area(B))),
        chars: map.chars.map((c) => (inter(c.box, B) >= 0.5 * area(c.box) ? { ...c, inBlock: false } : c)),
      };
      const m = new Matcher(blind);
      const acts = [...m.place(1, B, t.chars), ...m.finish()];
      const show = acts.filter((a) => a.type === 'show' && a.id === 1).pop();
      n++;
      if (!show) { misses.push(`${name} #${t.id}: not placed (${acts.map((a) => a.type).join(',')})`); continue; }
      /** @param {import('../../background/textmap.js').TextBlock[]} blocks */
      const share = (blocks) => {
        let all = 0; let hit = 0;
        for (let y = B.y0; y < B.y1; y++) {
          for (let x = B.x0; x < B.x1; x++) {
            if (label(name, x, y) !== t.id) continue;
            all++;
            const on = blocks.some((b) => {
              const mk = b.mask;
              for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                  const mx = Math.floor((x + dx) / mk.s) - mk.x0; const my = Math.floor((y + dy) / mk.s) - mk.y0;
                  if (mx >= 0 && my >= 0 && mx < mk.w && my < mk.h && mk.bits[my * mk.w + mx]) return true;
                }
              }
              return false;
            });
            if (on) hit++;
          }
        }
        return hit / Math.max(1, all);
      };
      const own = share(map.blocks.filter((b) => inter(b.box, B) > 0.3 * Math.min(area(b.box), area(B))));
      const built = share(show.blocks);
      if (built < 0.92 * own) misses.push(`${name} #${t.id} (${t.kind}): ${Math.round(100 * built)}% (its block: ${Math.round(100 * own)}%)`);
    }
  }
  assert.ok(misses.length <= Math.floor(0.15 * n), `${misses.length}/${n}: ${misses.join('; ')}`);
});

test('placing: a translation taken over within one batch is drawn once', async () => {
  const name = 'manga-1.png';
  const p = px[name];
  const t = truth[name].blocks.find((b) => b.kind === 'bubble');
  const X = maps[name].blocks.find((b) => inter(b.box, boxOf(t)) > 0.5 * area(b.box));
  const small = scale(X.box, 0.6);
  const norm = (b, s) => ({ x0: b.x0 / p.W, y0: b.y0 / p.H, x1: b.x1 / p.W, y1: b.y1 / p.H, t: s });
  const placer = new Placer(p, { sensitivity: 0.5, lang: 'en', encode: async () => 'AAAA' });
  const screen = new Map();
  const apply = (u) => { for (const i of u.retract) screen.delete(i); for (const r of u.show) screen.set(r.i, r); };
  apply(await placer.add([norm(small, 'Who is that?'), norm(X.box, 'Who is that?')]));
  apply(await placer.finish());
  assert.equal(screen.size, 1, [...screen.values()].map((r) => r.t).join(' | '));
});

const ART = new Set(['art', 'art-light', 'sfx', 'aside']);
for (const name of pages) {
  for (const t of truth[name].blocks.filter((b) => ART.has(b.kind))) {
    test(`eraser, ${name} #${t.id} (${t.kind}): every pixel of the lettering, little else`, () => {
      const map = maps[name];
      const B = boxOf(t);
      const blocks = map.blocks.filter((b) => inter(b.box, B) > 0.3 * Math.min(area(b.box), area(B)));
      assert.ok(blocks.length, 'found');
      const others = map.blocks.filter((b) => !blocks.includes(b)).map((b) => b.box);
      const e = eraseLettering(px[name], blocks, others);
      assert.ok(e, 'erased');
      const w = e.box.x1 - e.box.x0;
      const src = px[name].data;
      let total = 0; let hit = 0; let stray = 0; let change = 0;
      for (let y = e.box.y0; y < e.box.y1; y++) {
        for (let x = e.box.x0; x < e.box.x1; x++) {
          const k = ((y - e.box.y0) * w + (x - e.box.x0)) * 4;
          const a = e.rgba[k + 3];
          const v = label(name, x, y);
          if (v === t.id) { total++; if (a >= 128) hit++; }
          if (a < 128) continue;
          let close = false;
          for (let dy = -3; dy <= 3 && !close; dy++) {
            for (let dx = -3; dx <= 3; dx++) {
              const xx = x + dx; const yy = y + dy;
              if (xx >= 0 && yy >= 0 && xx < labels[name].W && yy < labels[name].H && label(name, xx, yy) === t.id) { close = true; break; }
            }
          }
          if (close) continue;
          stray++;
          const i = (y * px[name].W + x) * 4;
          change += Math.abs(0.3 * (e.rgba[k] - src[i]) + 0.59 * (e.rgba[k + 1] - src[i + 1]) + 0.11 * (e.rgba[k + 2] - src[i + 2]));
        }
      }
      const all = (() => { let n = 0; for (let y = B.y0; y < B.y1; y++) for (let x = B.x0; x < B.x1; x++) if (label(name, x, y) === t.id) n++; return n; })();
      assert.ok(hit >= 0.99 * all, `erased ${hit}/${all} of its lettering`);
      assert.equal(total, all);
      assert.ok(stray === 0 || change / stray <= 24, `${stray} pixels away from the lettering changed by ${(change / Math.max(1, stray)).toFixed(1)} on average`);
    });
  }
}

function stats(p, box, pick) {
  let s = 0; let q = 0; let n = 0;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      if (!pick(x, y)) continue;
      const i = (y * p.W + x) * 4;
      const v = 0.3 * p.data[i] + 0.59 * p.data[i + 1] + 0.11 * p.data[i + 2];
      s += v; q += v * v; n++;
    }
  }
  return { mean: s / n, sd: Math.sqrt(Math.max(0, q / n - (s / n) ** 2)), n };
}

function composite(name, e) {
  const src = px[name];
  const data = new Uint8ClampedArray(src.data);
  const w = e.box.x1 - e.box.x0;
  for (let y = e.box.y0; y < e.box.y1; y++) {
    for (let x = e.box.x0; x < e.box.x1; x++) {
      const k = ((y - e.box.y0) * w + (x - e.box.x0)) * 4;
      const a = e.rgba[k + 3] / 255;
      const i = (y * src.W + x) * 4;
      for (let c = 0; c < 3; c++) data[i + c] = Math.round(a * e.rgba[k + c] + (1 - a) * data[i + c]);
    }
  }
  return { W: src.W, H: src.H, data, alpha: (x, y) => (x >= e.box.x0 && y >= e.box.y0 && x < e.box.x1 && y < e.box.y1 ? e.rgba[((y - e.box.y0) * w + (x - e.box.x0)) * 4 + 3] : 0) };
}

test('eraser: over screentone, the tone carries on where the letters were (no smooth silhouette)', () => {
  const name = 'manga-1.png';
  const t = truth[name].blocks.find((b) => b.kind === 'sfx');
  const B = boxOf(t);
  const blocks = maps[name].blocks.filter((b) => inter(b.box, B) > 0.3 * Math.min(area(b.box), area(B)));
  const e = eraseLettering(px[name], blocks, maps[name].blocks.filter((b) => !blocks.includes(b)).map((b) => b.box));
  const out = composite(name, e);
  const inside = stats(out, e.box, (x, y) => out.alpha(x, y) === 255);
  const ring = { x0: Math.max(0, e.box.x0 - 20), y0: Math.max(0, e.box.y0 - 20), x1: e.box.x1 + 20, y1: e.box.y1 + 20 };
  const around = stats(px[name], ring, (x, y) => (x < e.box.x0 || y < e.box.y0 || x >= e.box.x1 || y >= e.box.y1) && x < 400);
  assert.ok(Math.abs(inside.mean - around.mean) < 20, `mean ${inside.mean.toFixed(0)} vs ${around.mean.toFixed(0)}`);
  assert.ok(inside.sd > 0.6 * around.sd, `texture: sd ${inside.sd.toFixed(0)} vs ${around.sd.toFixed(0)}`);
});

test('eraser: on a flat colour, the colour (and the lettering\'s own colours reported)', () => {
  const name = 'manga-2.png';
  const t = truth[name].blocks.find((b) => b.kind === 'sfx' && b.polarity === 'light');
  const B = boxOf(t);
  const blocks = maps[name].blocks.filter((b) => inter(b.box, B) > 0.3 * Math.min(area(b.box), area(B)));
  const e = eraseLettering(px[name], blocks);
  const out = composite(name, e);
  const inside = stats(out, e.box, (x, y) => out.alpha(x, y) === 255);
  const around = stats(px[name], { x0: e.box.x0 - 12, y0: e.box.y0, x1: e.box.x0 - 2, y1: e.box.y1 }, () => true);
  assert.ok(Math.abs(inside.mean - around.mean) < 12, `${inside.mean.toFixed(0)} vs ${around.mean.toFixed(0)}`);
  assert.ok(inside.sd < 12, `smooth: sd ${inside.sd.toFixed(1)}`);
  assert.ok(e.ink.every((v) => v > 200), `white letters: ${e.ink.map(Math.round)}`);
  assert.ok(e.outline && e.outline.every((v) => v < 80), `dark outline: ${e.outline?.map(Math.round)}`);
});

test('eraser: over speed lines on paper, paper stays paper (copies aren\'t greyed by lines that don\'t line up)', () => {
  const name = 'manga-3.png';
  const t = truth[name].blocks.find((b) => b.id === 3);
  assert.equal(t.kind, 'sfx');
  const B = boxOf(t);
  const blocks = maps[name].blocks.filter((b) => inter(b.box, B) > 0.3 * Math.min(area(b.box), area(B)));
  const e = eraseLettering(px[name], blocks, maps[name].blocks.filter((b) => !blocks.includes(b)).map((b) => b.box));
  assert.ok(e, 'erased');
  const w = e.box.x1 - e.box.x0;
  let n = 0; let grey = 0;
  for (let k = 0; k < e.rgba.length; k += 4) {
    if (e.rgba[k + 3] < 255) continue;
    const l = 0.3 * e.rgba[k] + 0.59 * e.rgba[k + 1] + 0.11 * e.rgba[k + 2];
    n++;
    if (l > 200 && l <= 245) grey++;
  }
  assert.ok(n > 0.5 * w * (e.box.y1 - e.box.y0) * 0.2, `erased ${n}`);
  assert.ok(grey <= 0.15 * n, `light grey: ${(grey / n).toFixed(2)} of the erased pixels`);
});

test('eraser: amid line art, the lines carry on through a column set with a soft glow (no pale silhouette)', () => {
  const W = 200; const H = 300;
  const stripe = (x) => (x % 4 === 0 ? 60 : 225);
  const glyph = new Uint8Array(W * H);
  for (let g = 0; g < 4; g++) {
    const gx = 88; const gy = 50 + g * 48;
    for (let y = gy; y < gy + 24; y++) for (let x = gx; x < gx + 24; x++) if (x < gx + 4 || x >= gx + 20 || y < gy + 4 || y >= gy + 20) glyph[y * W + x] = 1;
  }
  /** @type {[number, number][]} */
  const ink = [];
  for (let k = 0; k < W * H; k++) if (glyph[k]) ink.push([k % W, Math.floor(k / W)]);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let d = Infinity;
      if (Math.abs(x - 100) < 30 && y > 30 && y < 270) for (const [gx, gy] of ink) d = Math.min(d, Math.hypot(gx - x, gy - y));
      let v = stripe(x);
      if (glyph[y * W + x]) v = 20;
      else if (d <= 5) v = 255;
      else if (d <= 12) { const a = (12 - d) / 7; v = a * 255 + (1 - a) * v; }
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
    }
  }
  const box = { x0: 88, y0: 50, x1: 112, y1: 218 };
  const bw = box.x1 - box.x0;
  const bits = new Uint8Array(bw * (box.y1 - box.y0));
  for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) bits[(y - box.y0) * bw + x - box.x0] = glyph[y * W + x];
  const block = { box, glyph: 24, dark: true, vertical: true, cells: 4, ink: 20, paper: 255, mask: { x0: box.x0, y0: box.y0, w: bw, h: box.y1 - box.y0, s: 1, bits } };
  const e = eraseLettering({ W, H, data }, [block], []);
  assert.ok(e, 'erased');
  const ew = e.box.x1 - e.box.x0;
  let err = 0; let sum = 0; let n = 0;
  for (let y = e.box.y0; y < e.box.y1; y++) {
    for (let x = e.box.x0; x < e.box.x1; x++) {
      const k = ((y - e.box.y0) * ew + (x - e.box.x0)) * 4;
      if (e.rgba[k + 3] < 255) continue;
      err += Math.abs(e.rgba[k] - stripe(x)); sum += e.rgba[k]; n++;
    }
  }
  const mean = 0.25 * 60 + 0.75 * 225;
  assert.ok(n > 4000, `erased ${n}`);
  assert.ok(err / n <= 10, `off the stripes by ${(err / n).toFixed(1)} on average`);
  assert.ok(Math.abs(sum / n - mean) <= 8, `mean ${(sum / n).toFixed(0)} vs ${mean}`);
});

test('eraser: in a white bubble, the letters\' place is white again — no grey from the dark beside them, no JPEG ghost, no ruby or dash left', () => {
  const W = 240; const H = 280; const PAPER = 250;
  let seed = 3;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const glyph = new Uint8Array(W * H);
  for (let g = 0; g < 4; g++) {
    const gx = 100; const gy = 40 + g * 48;
    for (let y = gy; y < gy + 24; y++) for (let x = gx; x < gx + 24; x++) if (x < gx + 4 || x >= gx + 20 || y < gy + 4 || y >= gy + 20) glyph[y * W + x] = 1;
  }
  const shape = (x, y) => x >= 129 && x < 160 && y >= 20 && y < 250;
  const ruby = (x, y) => x >= 92 && x < 97 && y >= 40 && y < 208 && (y - 40) % 16 < 6;
  const dash = (x, y) => x >= 110 && x < 114 && y >= 114 && y < 134;
  const data = new Uint8ClampedArray(W * H * 4);
  /** @type {number[]} */
  const ringing = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = PAPER + Math.round((rand() - 0.5) * 4);
      if (glyph[y * W + x]) v = 25;
      else if (shape(x, y)) v = 15;
      else if (ruby(x, y)) v = 90;
      else if (dash(x, y)) v = 30;
      else {
        let near = false;
        for (let dy = -4; dy <= 4 && !near; dy++) for (let dx = -4; dx <= 4; dx++) { const xx = x + dx; const yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && glyph[yy * W + xx]) { near = true; break; } }
        if (near && rand() < 0.35) { v = 222 + Math.round(rand() * 18); ringing.push(y * W + x); }
      }
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
    }
  }
  const box = { x0: 100, y0: 40, x1: 124, y1: 208 };
  const bw = box.x1 - box.x0;
  const bits = new Uint8Array(bw * (box.y1 - box.y0));
  for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) bits[(y - box.y0) * bw + x - box.x0] = glyph[y * W + x];
  const block = { box, glyph: 24, dark: true, vertical: true, cells: 4, ink: 25, paper: PAPER, mask: { x0: box.x0, y0: box.y0, w: bw, h: box.y1 - box.y0, s: 1, bits } };
  const px = { W, H, data };
  const e = eraseLettering(px, [block], []);
  assert.ok(e, 'erased');
  const ew = e.box.x1 - e.box.x0;
  const shown = (x, y) => {
    const i = (y * W + x) * 4;
    if (x < e.box.x0 || y < e.box.y0 || x >= e.box.x1 || y >= e.box.y1) return data[i];
    const k = ((y - e.box.y0) * ew + (x - e.box.x0)) * 4;
    const a = e.rgba[k + 3] / 255;
    return a * e.rgba[k] + (1 - a) * data[i];
  };
  let worst = 0; let n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (glyph[y * W + x]) { n++; worst = Math.max(worst, PAPER - shown(x, y)); }
  assert.ok(n > 1000 && worst <= 10, `the glyphs' place: at worst ${worst.toFixed(0)} levels darker than the paper`);
  const left = ringing.filter((k) => shown(k % W, Math.floor(k / W)) < PAPER - 12).length;
  assert.ok(left <= 0.05 * ringing.length, `ringing left: ${left}/${ringing.length}`);
  let rubyLeft = 0; let rubyAll = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ruby(x, y)) { rubyAll++; if (shown(x, y) < PAPER - 12) rubyLeft++; }
  assert.ok(rubyLeft === 0, `ruby left: ${rubyLeft}/${rubyAll}`);
  let dashLeft = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (dash(x, y) && shown(x, y) < PAPER - 12) dashLeft++;
  assert.equal(dashLeft, 0, 'the dash gone');
  let changed = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (shape(x, y) && Math.abs(shown(x, y) - data[(y * W + x) * 4]) > 8) changed++;
  assert.equal(changed, 0, `${changed} of the shape's pixels changed`);
});

test('eraser: copies are never taken from other lettering', () => {
  const name = 'manga-1.png';
  const src = px[name];
  const data = new Uint8ClampedArray(src.data);
  const t = truth[name].blocks.find((b) => b.kind === 'sfx');
  const B = boxOf(t);
  const blocks = maps[name].blocks.filter((b) => inter(b.box, B) > 0.3 * Math.min(area(b.box), area(B)));
  const others = maps[name].blocks.filter((b) => !blocks.includes(b)).map((b) => b.box);
  for (const o of others) {
    for (let y = o.y0; y < o.y1; y++) for (let x = o.x0; x < o.x1; x++) { const i = (y * src.W + x) * 4; data[i] = 255; data[i + 1] = 0; data[i + 2] = 255; }
  }
  const e = eraseLettering({ W: src.W, H: src.H, data }, blocks, others);
  for (let k = 0; k < e.rgba.length; k += 4) {
    if (e.rgba[k + 3] < 128) continue;
    assert.ok(!(e.rgba[k] > 200 && e.rgba[k + 1] < 60 && e.rgba[k + 2] > 200), 'magenta copied');
  }
});

const B6 = 'manga-6.png';
const b6 = JSON.parse(readFileSync(new URL('bubbles.json', DIR), 'utf8'))[B6];
const b6px = load(B6);
const b6labels = load('manga-6.labels.png');
const b6map = buildTextMap(b6px);
const blocksOver = (t) => b6map.blocks.filter((b) => inter(b.box, boxOf(t)) > 0.5 * area(b.box));
const b6block = (cond) => b6.blocks.find(cond);
const b6model = (t, text) => {
  const B = boxOf(t);
  return { x0: B.x0 / b6px.W, y0: B.y0 / b6px.H, x1: B.x1 / b6px.W, y1: B.y1 / b6px.H, t: text };
};

async function placeOn6(models) {
  const patches = new Map();
  let n = 0;
  const placer = new Placer(b6px, {
    sensitivity: 0.5,
    lang: 'en',
    encode: async (rgba, w, h) => { const k = `P${++n}`; patches.set(k, { rgba: new Uint8ClampedArray(rgba), w }); return `${k}AAAA`; },
  });
  const shown = new Map();
  const apply = (u) => { for (const id of u.retract) shown.delete(id); for (const r of u.show) shown.set(r.i, r); };
  for (const m of models) apply(await placer.add([m]));
  apply(await placer.finish());
  const regions = [...shown.values()];
  const hidden = (x, y) => regions.some((r) => {
    const x0 = Math.round(r.p.x * b6px.W); const y0 = Math.round(r.p.y * b6px.H);
    const x1 = Math.round((r.p.x + r.p.w) * b6px.W); const y1 = Math.round((r.p.y + r.p.h) * b6px.H);
    if (x < x0 || y < y0 || x >= x1 || y >= y1) return false;
    if (r.m !== 2) return true;
    const P = patches.get(r.im.slice(0, -4));
    return P.rgba[((y - y0) * P.w + (x - x0)) * 4 + 3] >= 128;
  });
  const covered = (t) => {
    const B = boxOf(t);
    let all = 0; let hid = 0;
    for (let y = B.y0; y < B.y1; y++) {
      for (let x = B.x0; x < B.x1; x++) {
        if (b6labels.data[(y * b6labels.W + x) * 4] !== t.id) continue;
        all++;
        if (hidden(x, y)) hid++;
      }
    }
    return hid / Math.max(1, all);
  };
  return { regions, covered };
}

test('bubbles: lettering in parts is one bubble\'s; touching bubbles stay two; open paper is none', () => {
  const bub = findBubbles(b6px, b6map);
  /** @param {object} t @returns {object | null} */
  const bubbleOf = (t) => {
    const bs = blocksOver(t);
    assert.ok(bs.length, `#${t.id} found`);
    const set = new Set(bs.map((b) => bub.get(b) ?? null));
    assert.equal(set.size, 1, `#${t.id}: its blocks in one bubble`);
    return [...set][0];
  };
  const groups = new Map();
  for (const t of b6.blocks.filter((b) => b.group)) {
    const b = bubbleOf(t);
    assert.ok(b, `#${t.id} (bubble ${t.group}) in a bubble`);
    if (groups.has(t.group)) assert.equal(b, groups.get(t.group), `bubble ${t.group}: its parts together`);
    groups.set(t.group, b);
  }
  assert.equal(new Set(groups.values()).size, groups.size, 'each bubble its own');
  const lone = b6.blocks.filter((b) => b.kind === 'bubble' && !b.group).map(bubbleOf);
  assert.equal(lone.length, 2);
  assert.ok(lone[0] && lone[1] && lone[0] !== lone[1], 'touching bubbles: two');
  for (const t of b6.blocks.filter((b) => b.kind === 'open')) assert.equal(bubbleOf(t), null, `#${t.id} on open paper: no bubble`);
});

test('placement: a box over part of a text\'s lettering hides all of that text (and its characters that made no block) — not another text set apart in the same bubble', async () => {
  const models = ['A', 'B', 'C'].map((g) => b6model(b6block((b) => b.group === g), `the text of bubble ${g}`));
  const { regions, covered } = await placeOn6(models);
  assert.equal(regions.length, 3, regions.map((r) => r.t).join(' | '));
  for (const t of b6.blocks.filter((b) => b.group === 'B')) {
    const c = covered(t);
    assert.ok(c >= 0.99, `#${t.id} (bubble B): ${(100 * c).toFixed(0)}% hidden`);
  }
  for (const g of ['A', 'C']) {
    const [first, second] = b6.blocks.filter((b) => b.group === g);
    assert.ok(covered(first) >= 0.99, `#${first.id} (bubble ${g}): ${(100 * covered(first)).toFixed(0)}% hidden`);
    assert.ok(covered(second) <= 0.01, `#${second.id} (bubble ${g}), set apart: ${(100 * covered(second)).toFixed(0)}% hidden`);
  }
});

test('placement: two boxes for two remarks set apart in one bubble are two translations, each over its own; two for one text\'s parts, one; touching bubbles keep theirs', async () => {
  const [a1, a2] = b6.blocks.filter((b) => b.group === 'A');
  const [b1, b2] = b6.blocks.filter((b) => b.group === 'B');
  const [d, e] = b6.blocks.filter((b) => b.kind === 'bubble' && !b.group);
  const { regions, covered } = await placeOn6([
    b6model(a1, 'What is this...'), b6model(a2, 'This must be a dream.'),
    b6model(b1, 'Yes.'), b6model(b2, 'About that... I...'),
    b6model(d, 'Let us go, everyone!'), b6model(e, 'Wait for me!'),
  ]);
  assert.equal(regions.length, 5, regions.map((r) => r.t).join(' | '));
  const patch = (r) => ({ x0: r.p.x * b6px.W, y0: r.p.y * b6px.H, x1: (r.p.x + r.p.w) * b6px.W, y1: (r.p.y + r.p.h) * b6px.H });
  for (const [t, own, other] of [['What is this...', a1, a2], ['This must be a dream.', a2, a1]]) {
    const r = regions.find((q) => q.t === t);
    assert.ok(r, `"${t}" on its own`);
    assert.ok(inter(patch(r), boxOf(own)) >= 0.9 * area(boxOf(own)) && !inter(patch(r), boxOf(other)), `"${t}" over its own remark only`);
  }
  const b = regions.find((r) => r.t.includes('Yes.'));
  assert.equal(b?.t, 'Yes. About that... I...', 'one text, one translation, in the order given');
  for (const t of [a1, a2, b1, b2]) assert.ok(covered(t) >= 0.99, `#${t.id}: ${(100 * covered(t)).toFixed(0)}% hidden`);
  assert.ok(regions.some((r) => r.t === 'Let us go, everyone!') && regions.some((r) => r.t === 'Wait for me!'), 'two bubbles, two translations');
});

test('placement: bubbles painted over, lettering on artwork erased exactly, one region per translation', async () => {
  const name = 'manga-1.png';
  const p = px[name];
  let encoded = 0;
  const placer = new Placer(p, {
    sensitivity: 0.5,
    lang: 'en',
    encode: async (rgba, w, h) => { assert.equal(rgba.length, w * h * 4); encoded++; return 'AAAA'; },
  });
  const blocks = truth[name].blocks.map((t, i) => {
    const B = shift(boxOf(t), 0.4);
    return { x0: B.x0 / p.W, y0: B.y0 / p.H, x1: B.x1 / p.W, y1: B.y1 / p.H, t: `translation ${i + 1}` };
  });
  const shown = new Map();
  const apply = (u) => {
    for (const id of u.retract) shown.delete(id);
    for (const r of u.show) shown.set(r.i, r);
  };
  apply(await placer.add(blocks.slice(0, 4)));
  apply(await placer.add(blocks.slice(4)));
  apply(await placer.finish());
  assert.equal(shown.size, blocks.length, 'every translation shown once');
  for (const [i, t] of truth[name].blocks.entries()) {
    const r = [...shown.values()].find((x) => x.t === `translation ${i + 1}`);
    assert.ok(r, `#${t.id} shown`);
    if (t.kind === 'bubble' || t.kind === 'open') assert.equal(r.m, 0, `#${t.id} ${t.kind}: painted over`);
    if (t.kind === 'art' || t.kind === 'sfx') {
      assert.equal(r.m, 2, `#${t.id} ${t.kind}: erased`);
      assert.equal(r.im, 'AAAA');
    }
    const B = boxOf(t);
    const P = { x0: r.p.x * p.W, y0: r.p.y * p.H, x1: (r.p.x + r.p.w) * p.W, y1: (r.p.y + r.p.h) * p.H };
    assert.ok(inter(P, B) >= 0.97 * area(B), `#${t.id}: patch over its lettering`);
  }
  assert.ok(encoded >= 2, 'art lettering encoded as patches');
});

test('placement: lettering on artwork shows at once, erased plainly; then the artwork\'s texture comes in — the same translations, their patches made again', async () => {
  const name = 'manga-1.png';
  const p = px[name];
  /** @type {Map<string, Uint8ClampedArray>} */
  const pics = new Map();
  let n = 0;
  const placer = new Placer(p, { sensitivity: 0.5, lang: 'en', encode: async (rgba) => { const k = `P${++n}`; pics.set(k, rgba.slice()); return k; } });
  const shown = new Map();
  const apply = (u) => { for (const id of u.retract) shown.delete(id); for (const r of u.show) shown.set(r.i, r); };
  const art = truth[name].blocks.filter((t) => t.kind === 'art' || t.kind === 'sfx');
  apply(await placer.add(art.map((t, i) => { const B = boxOf(t); return { x0: B.x0 / p.W, y0: B.y0 / p.H, x1: B.x1 / p.W, y1: B.y1 / p.H, t: `translation ${i + 1}` }; })));
  apply(await placer.finish());
  assert.equal(shown.size, art.length);
  const first = new Map(shown);
  for (const r of first.values()) assert.equal(r.m, 2, `${r.t}: erased, not blurred`);
  const updates = [];
  for (let u; (u = await placer.polishNext());) {
    assert.equal(u.retract.length, 0, 'nothing withdrawn');
    updates.push(...u.show);
    apply(u);
  }
  assert.equal(updates.length, first.size, 'each made again once');
  let textured = 0;
  for (const r of updates) {
    const was = first.get(r.i);
    assert.ok(was, `${r.t}: a translation shown before`);
    assert.deepEqual([r.t, r.p, r.a, r.m], [was.t, was.p, was.a, was.m], `${r.t}: the same but for its patch`);
    assert.notEqual(r.im, was.im);
    const a = pics.get(was.im); const b = pics.get(r.im);
    if (a.some((v, k) => Math.abs(v - b[k]) > 24)) textured++;
  }
  assert.ok(textured >= 1, 'the texture carried in somewhere (the sound effect over screentone)');
  assert.equal(placer.rough, false, 'done: saved as final');
});

test('placement: out of time for the texture, lettering on artwork stays erased exactly (plainly), and isn\'t saved as final', async () => {
  const name = 'manga-1.png';
  const p = px[name];
  const placer = new Placer(p, { sensitivity: 0.5, lang: 'en', encode: async () => 'AAAA' });
  placer.eraseMs = Infinity;
  const shown = new Map();
  const apply = (u) => { for (const id of u.retract) shown.delete(id); for (const r of u.show) shown.set(r.i, r); };
  const art = truth[name].blocks.filter((t) => t.kind === 'art' || t.kind === 'sfx');
  apply(await placer.add(art.map((t, i) => { const B = boxOf(t); return { x0: B.x0 / p.W, y0: B.y0 / p.H, x1: B.x1 / p.W, y1: B.y1 / p.H, t: `translation ${i + 1}` }; })));
  apply(await placer.finish());
  assert.equal(await placer.polishNext(), null, 'no time left for the texture');
  assert.equal(shown.size, art.length);
  for (const r of shown.values()) {
    assert.equal(r.m, 2, `${r.t}: erased, not blurred`);
    assert.equal(r.im, 'AAAA');
  }
  assert.ok(placer.rough, 'not saved as final');
});

test('placement: a sound effect\'s translation is set at most 1.5× the size of the page\'s dialogue', async () => {
  assert.equal(dialogueSize([{ glyph: 100, cells: 3 }, { glyph: 30, cells: 20 }, { glyph: 24, cells: 10 }]), 30);
  assert.equal(dialogueSize([]), 0);
  let capped = 0;
  for (const name of ['manga-1.png', 'manga-4.png', 'manga-5.png']) {
    const p = px[name];
    const dialogue = dialogueSize(maps[name].blocks);
    assert.ok(dialogue > 0, name);
    const placer = new Placer(p, { sensitivity: 0.5, lang: 'en', encode: async () => 'AAAA' });
    const shown = new Map();
    const apply = (u) => { for (const id of u.retract) shown.delete(id); for (const r of u.show) shown.set(r.i, r); };
    const T = truth[name].blocks;
    apply(await placer.add(T.map((t, i) => { const B = boxOf(t); return { x0: B.x0 / p.W, y0: B.y0 / p.H, x1: B.x1 / p.W, y1: B.y1 / p.H, t: `translation ${i + 1}` }; })));
    apply(await placer.finish());
    for (const [i, t] of T.entries()) {
      const r = [...shown.values()].find((x) => x.t === `translation ${i + 1}`);
      assert.ok(r, `${name} #${t.id} shown`);
      const size = r.g * p.W;
      if (t.kind === 'sfx') {
        assert.ok(size <= 1.5 * dialogue + 0.5, `${name} #${t.id} (sfx, ${t.size}px): set by ${size.toFixed(1)}px, dialogue ${dialogue}`);
        if (t.size > 1.6 * dialogue) capped++;
      } else if (t.kind === 'bubble') {
        assert.ok(size >= 0.6 * t.size && size <= 1.6 * t.size, `${name} #${t.id} (bubble, ${t.size}px): ${size.toFixed(1)}px`);
      }
    }
  }
  assert.ok(capped >= 2, `${capped} sound effects larger than the cap`);
});

test('eraser: what the glyph mask closes in goes with it (letters found as their edging only) — not a whole drawing a large outline rings', () => {
  const W = 240; const H = 140;
  const data = new Uint8ClampedArray(W * H * 4);
  const put = (x0, y0, x1, y1, c) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([...c, 255], (y * W + x) * 4); };
  put(0, 0, W, H, [40, 120, 40]);
  put(20, 30, 80, 90, [255, 255, 255]); put(30, 40, 70, 80, [226, 52, 140]);
  put(110, 10, 230, 130, [255, 255, 255]); put(118, 18, 222, 122, [200, 60, 60]);
  const ring = (x0, y0, x1, y1, t, glyph) => {
    const w = x1 - x0; const h = y1 - y0;
    const bits = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < t || y < t || x >= w - t || y >= h - t) bits[y * w + x] = 1;
    return { box: { x0, y0, x1, y1 }, glyph, dark: false, vertical: false, cells: 1, ink: 255, paper: 90, mask: { x0, y0, w, h, s: 1, bits } };
  };
  const p = { W, H, data };
  const alphaAt = (e, x, y) => e.rgba[((y - e.box.y0) * (e.box.x1 - e.box.x0) + (x - e.box.x0)) * 4 + 3];
  const letter = eraseLettering(p, [ring(20, 30, 80, 90, 10, 60)]);
  assert.ok(letter, 'erased');
  assert.ok(alphaAt(letter, 50, 60) >= 128, 'the letter inside its edging erased too');
  const at = ((60 - letter.box.y0) * (letter.box.x1 - letter.box.x0) + (50 - letter.box.x0)) * 4;
  assert.ok(Math.abs(letter.rgba[at + 1] - 120) <= 30 && letter.rgba[at] <= 90, `filled with the artwork round it: ${[...letter.rgba.slice(at, at + 3)]}`);
  const frame = eraseLettering(p, [ring(110, 10, 230, 130, 8, 30)]);
  assert.ok(frame, 'erased');
  assert.ok(alphaAt(frame, 170, 70) < 128, 'the picture inside a large frame left alone');
});

const cg = JSON.parse(readFileSync(new URL('cg.json', DIR), 'utf8'))['cg-1.png'];
const cgPx = load('cg-1.png');
const cgLabels = load('cg-1.labels.png');

test('placement: a game CG\'s lettering, edged in white over sky, a house and foliage, is erased — all of it — and each translation keeps its own space', async () => {
  let seed = 5;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const J of [0, 0.1, 0.1]) {
    const blocks = cg.blocks.map((t, i) => {
      const [x0, y0, x1, y1] = t.box; const w = x1 - x0; const h = y1 - y0;
      const j = (v, s) => v + (rand() - 0.5) * 2 * J * s;
      return { x0: j(x0 - 6, w) / cgPx.W, y0: j(y0 - 6, h) / cgPx.H, x1: j(x1 + 6, w) / cgPx.W, y1: j(y1 + 6, h) / cgPx.H, t: `${i + 1} ${'word '.repeat(Math.ceil(t.chars / 5)).trim()}` };
    });
    const patches = new Map(); let n = 0;
    const placer = new Placer(cgPx, { sensitivity: 0.5, lang: 'en', encode: async (rgba, w, h) => { const k = `P${++n}`; patches.set(k, { rgba: new Uint8ClampedArray(rgba), w, h }); return k; } });
    const shown = new Map();
    const again = new Set();
    const apply = (u) => {
      for (const id of u.retract) shown.delete(id);
      for (const r of u.show) { if (shown.has(r.i) || u.retract.includes(r.i)) again.add(r.i); shown.set(r.i, r); }
    };
    for (const b of blocks) apply(await placer.add([b]));
    apply(await placer.finish());
    const regions = [...shown.values()];
    assert.equal(regions.length, 3, regions.map((r) => r.t).join(' | '));
    for (const r of regions) assert.equal(r.m, 2, `${r.t.slice(0, 2)}: erased exactly`);
    for (const t of cg.blocks) {
      let all = 0; let hid = 0;
      for (let y = t.box[1]; y < t.box[3]; y++) {
        for (let x = t.box[0]; x < t.box[2]; x++) {
          if (cgLabels.data[(y * cgLabels.W + x) * 4] !== t.id) continue;
          all++;
          if (regions.some((r) => {
            const x0 = Math.round(r.p.x * cgPx.W); const y0 = Math.round(r.p.y * cgPx.H);
            const P = patches.get(r.im);
            if (x < x0 || y < y0 || x >= x0 + P.w || y >= y0 + P.h) return false;
            return P.rgba[((y - y0) * P.w + (x - x0)) * 4 + 3] >= 128;
          })) hid++;
        }
      }
      assert.ok(hid >= 0.97 * all, `±${J}: #${t.id}: ${hid}/${all} of its letters and edging erased`);
    }
    const rooms = regions.map((r) => ({ x0: r.a.x * cgPx.W, y0: r.a.y * cgPx.H, x1: (r.a.x + r.a.w) * cgPx.W, y1: (r.a.y + r.a.h) * cgPx.H }));
    for (let i = 0; i < rooms.length; i++) for (let k = i + 1; k < rooms.length; k++) assert.ok(!overlap(rooms[i], rooms[k]), `±${J}: ${regions[i].t.slice(0, 2)} and ${regions[k].t.slice(0, 2)} apart`);
    for (const [i, r] of regions.entries()) {
      const t = cg.blocks[Number(r.t.split(' ')[0]) - 1];
      const room = rooms[i];
      const [x0, y0, x1, y1] = t.box;
      assert.ok(room.x0 <= (x0 + x1) / 2 && room.x1 >= (x0 + x1) / 2 && room.y0 <= (y0 + y1) / 2 && room.y1 >= (y0 + y1) / 2, `±${J}: #${t.id}'s room over its lettering`);
      assert.ok(room.x1 - room.x0 <= x1 - x0 + 3.5 * t.size, `±${J}: #${t.id}'s room ${Math.round(room.x1 - room.x0)} px wide for lettering ${x1 - x0} px wide`);
    }
    void again;
  }
});
