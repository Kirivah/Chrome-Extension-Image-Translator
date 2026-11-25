import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { refineBox } from '../../background/refine.js';
import { readPng } from './png.mjs';

const DIR = new URL('./fixtures/', import.meta.url);
const truth = JSON.parse(readFileSync(new URL('pages.json', DIR), 'utf8'));
const pages = Object.fromEntries(Object.keys(truth).map((name) => [name, readPng(new URL(name, DIR).pathname)]));

const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const inter = (a, b) => area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const box = (a) => ({ x0: a[0], y0: a[1], x1: a[2], y1: a[3] });

function wrong(t, far = true) {
  const w = t.x1 - t.x0;
  const h = t.y1 - t.y0;
  const sh = (dx, dy) => ({ x0: t.x0 + dx, y0: t.y0 + dy, x1: t.x1 + dx, y1: t.y1 + dy });
  const sc = (k) => ({ x0: t.x0 + (w * (1 - k)) / 2, y0: t.y0 + (h * (1 - k)) / 2, x1: t.x1 - (w * (1 - k)) / 2, y1: t.y1 - (h * (1 - k)) / 2 });
  return {
    exact: t,
    'half left': sh(-0.5 * w, 0), 'half right': sh(0.5 * w, 0), 'half up': sh(0, -0.5 * h), 'half down': sh(0, 0.5 * h),
    diagonal: sh(0.35 * w, 0.35 * h), shrunk: sc(0.6), enlarged: sc(1.4),
    'one column': { x0: t.x1 - 0.4 * w, y0: t.y0, x1: t.x1, y1: t.y1 },
    'top half': { x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y0 + 0.5 * h },
    ...(far ? { 'beside, right': sh(0.9 * w, 0.1 * h), 'beside, left': sh(-0.9 * w, -0.1 * h) } : {}),
  };
}

for (const [name, page] of Object.entries(truth)) {
  for (const blk of page.blocks) {
    const sfx = blk.id === 'sfx';
    test(`${name} ${blk.id}: a wrong box still lands on all of the lettering`, () => {
      const t = box(blk.box);
      const others = page.blocks.filter((b) => b.id !== blk.id).map((b) => ({ id: b.id, box: box(b.box) }));
      const misses = [];
      for (const [how, mb] of Object.entries(wrong(t, !sfx))) {
        const r = refineBox(pages[name], mb, []);
        if (!r || r === 'duplicate') { misses.push(`${how}: ${r}`); continue; }
        const cover = inter(r.box, t) / area(t);
        const excess = area(r.box) / area(t);
        const stray = others.find((o) => inter(r.box, o.box) > 0.5 * area(o.box));
        if (cover < 0.95 || excess > 1.6 || stray) {
          misses.push(`${how}: covers ${(cover * 100).toFixed(0)}%, ×${excess.toFixed(2)} the size${stray ? `, includes ${stray.id}` : ''}`);
        }
        assert.ok(r.glyph >= 0.6 * blk.size && r.glyph <= 1.15 * blk.size, `${how}: glyph ${r.glyph} vs font ${blk.size}`);
      }
      assert.deepEqual(misses, []);
    });
  }
}

test('neighbouring bubbles: each translation finds its own text, even when its box leans on the other', () => {
  const px = pages['page-b.png'];
  const [row0, row1, row2] = ['row0', 'row1', 'row2'].map((id) => box(truth['page-b.png'].blocks.find((b) => b.id === id).box));
  const first = refineBox(px, row0, []);
  assert.ok(first && first !== 'duplicate');
  const taken = [{ box: first.box, model: row0 }];
  const w = row1.x1 - row1.x0;
  const leaning = { x0: row1.x0 - 0.6 * w, y0: row1.y0, x1: row1.x1 - 0.6 * w, y1: row1.y1 };
  const second = refineBox(px, leaning, taken);
  assert.ok(second && second !== 'duplicate', String(second));
  assert.ok(inter(second.box, row1) / area(row1) > 0.95, 'landed on row1');
  taken.push({ box: second.box, model: leaning });
  const third = refineBox(px, row2, taken);
  assert.ok(third && third !== 'duplicate' && inter(third.box, row2) / area(row2) > 0.95);
});

test('the same bubble described twice: the second translation is a duplicate', () => {
  const px = pages['page-a.png'];
  const nah = box(truth['page-a.png'].blocks.find((b) => b.id === 'nah').box);
  const first = refineBox(px, nah, []);
  assert.ok(first && first !== 'duplicate');
  const h = nah.y1 - nah.y0;
  const again = { x0: nah.x0 - 4, y0: nah.y0 + 0.3 * h, x1: nah.x1 + 4, y1: nah.y1 + 0.3 * h };
  assert.equal(refineBox(px, again, [{ box: first.box, model: nah }]), 'duplicate');
  const elsewhere = { x0: nah.x0, y0: nah.y1 + 60, x1: nah.x1, y1: nah.y1 + 60 + h };
  assert.notEqual(refineBox(px, elsewhere, [{ box: first.box, model: nah }]), 'duplicate');
});

test('a bubble\'s white inside is paper, not one huge light-on-dark glyph', () => {
  const px = pages['page-c.png'];
  const blk = truth['page-c.png'].blocks.find((b) => b.id === 'touch');
  const t = box(blk.box);
  for (const mb of [{ x0: t.x0 - 70, y0: t.y0 - 50, x1: t.x1 + 70, y1: t.y1 }, { x0: t.x0 + 5, y0: t.y0 + 30, x1: t.x1 + 5, y1: t.y1 + 14 }]) {
    const r = refineBox(px, mb, []);
    assert.ok(r && r !== 'duplicate', String(r));
    assert.ok(r.glyph <= 1.15 * blk.size, `glyph ${r.glyph}`);
    assert.ok(inter(r.box, t) / area(t) >= 0.95 && area(r.box) / area(t) <= 1.6, JSON.stringify(r.box));
  }
});

test('furigana or half a bubble boxed on their own: a duplicate, not a second translation', () => {
  const px = pages['page-a.png'];
  const hello = box(truth['page-a.png'].blocks.find((b) => b.id === 'hello').box);
  const col = { x0: 160, y0: hello.y0, x1: hello.x1, y1: hello.y1 };
  const first = refineBox(px, col, []);
  assert.ok(first && first !== 'duplicate');
  const taken = [{ box: first.box, model: col }];
  assert.equal(refineBox(px, { x0: 140, y0: 80, x1: 158, y1: 138 }, taken), 'duplicate');
  const bugs = box(truth['page-a.png'].blocks.find((b) => b.id === 'bugs').box);
  const mid = (bugs.x0 + bugs.x1) / 2;
  const right = refineBox(px, { ...bugs, x0: mid }, []);
  assert.ok(right && right !== 'duplicate');
  assert.equal(refineBox(px, { ...bugs, x1: mid - 1 }, [{ box: right.box, model: { ...bugs, x0: mid } }]), 'duplicate');
});

test('no lettering near the box (artwork, hatching): keep the model\'s box', () => {
  const px = pages['page-a.png'];
  assert.equal(refineBox(px, { x0: 300, y0: 380, x1: 420, y1: 460 }, []), null);
  const b = pages['page-b.png'];
  assert.equal(refineBox(b, { x0: 400, y0: 200, x1: 480, y1: 300 }, []), null);
});

test('an image built to be expensive (fields of evenly spaced marks) can\'t hold up the worker', () => {
  const field = (N, sz, isoGap, chainGap) => {
    const data = new Uint8ClampedArray(N * N * 4).fill(255);
    const sq = (x0, y0) => {
      for (let y = y0; y < y0 + sz; y++) for (let x = x0; x < x0 + sz; x++) data.fill(0, (y * N + x) * 4, (y * N + x) * 4 + 3);
    };
    for (let y = 4; y + sz < N / 2; y += sz + isoGap) for (let x = 4; x + sz < N - 4; x += sz + isoGap) sq(x, y);
    for (let y = N / 2 + 2 * sz + isoGap; y + sz < N - 4; y += sz + chainGap) for (let x = 4; x + sz < N - 4; x += sz + chainGap) sq(x, y);
    return { data, W: N, H: N };
  };
  for (const [N, sz, iso, chain] of [[880, 8, 13, 10], [890, 6, 10, 8]]) {
    const px = field(N, sz, iso, chain);
    for (const b of [{ x0: 0, y0: 0, x1: N, y1: N }, { x0: N / 2 - 300, y0: N / 2 - 300, x1: N / 2 + 300, y1: N / 2 + 300 }]) {
      const t0 = performance.now();
      refineBox(px, b, []);
      const ms = performance.now() - t0;
      assert.ok(ms < 1500, `${N}px field, ${sz}px marks: ${ms.toFixed(0)} ms`);
    }
  }
});

test('fast enough to run on every block', () => {
  const t0 = performance.now();
  let n = 0;
  for (const [name, page] of Object.entries(truth)) {
    for (const blk of page.blocks) {
      for (const mb of Object.values(wrong(box(blk.box)))) { refineBox(pages[name], mb, []); n++; }
    }
  }
  const per = (performance.now() - t0) / n;
  assert.ok(per < 60, `${per.toFixed(1)} ms per box`);
});
