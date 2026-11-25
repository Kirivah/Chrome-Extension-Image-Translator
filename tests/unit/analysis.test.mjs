import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBox, resolveCollisions, contrast, fontFor } from '../../background/analysis.js';

function canvas(W, H, fill = [255, 255, 255]) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([...fill, 255], i * 4);
  return { data, W, H };
}
function px(c, x, y, rgb) {
  if (x < 0 || y < 0 || x >= c.W || y >= c.H) return;
  c.data.set(rgb, (y * c.W + x) * 4);
}
function rect(c, x0, y0, x1, y1, rgb) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px(c, x, y, rgb);
}
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
function noise(c, x0, y0, x1, y1) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px(c, x, y, [rnd() * 255, rnd() * 255, rnd() * 255]);
}
function ellipse(c, cx, cy, rx, ry, fill, stroke, sw) {
  for (let y = cy - ry - sw; y <= cy + ry + sw; y++) {
    for (let x = cx - rx - sw; x <= cx + rx + sw; x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      const dOut = ((x - cx) / (rx + sw)) ** 2 + ((y - cy) / (ry + sw)) ** 2;
      if (d <= 1) px(c, x, y, fill);
      else if (dOut <= 1) px(c, x, y, stroke);
    }
  }
}
function glyphs(c, x0, y0, x1, y1, rgb) {
  for (let y = y0; y < y1; y += 14) {
    for (let x = x0; x < x1; x += 12) {
      rect(c, x, y, Math.min(x + 3, x1), Math.min(y + 10, y1), rgb);
      rect(c, x, y + 4, Math.min(x + 9, x1), Math.min(y + 6, y1), rgb);
    }
  }
}
const W = 420; const H = 320;

test('text inside an enclosed white bubble → fill, and the bubble gives the text more room', () => {
  const c = canvas(W, H);
  noise(c, 0, 0, W, H);
  ellipse(c, 210, 160, 130, 100, [255, 255, 255], [0, 0, 0], 4);
  const box = { x0: 192, y0: 95, x1: 228, y1: 225 };
  glyphs(c, box.x0, box.y0, box.x1, box.y1, [10, 10, 10]);
  const st = analyzeBox(c, box, 0.5);
  assert.equal(st.m, 0);
  assert.ok(st.bg.every((v) => v > 245), `bg ${st.bg}`);
  assert.ok(contrast(st.fg, st.bg) >= 3);
  assert.ok(st.patch.x0 <= box.x0 && st.patch.x1 >= box.x1 && st.patch.y0 <= box.y0 && st.patch.y1 >= box.y1, JSON.stringify(st.patch));
  const aw = st.area.x1 - st.area.x0;
  assert.ok(aw > (box.x1 - box.x0) * 2, `area width ${aw}`);
  assert.ok(st.area.x0 >= 210 - 130 && st.area.x1 <= 210 + 130 && st.area.y0 >= 160 - 100 && st.area.y1 <= 160 + 100, JSON.stringify(st.area));
  for (const [x, y] of [[st.area.x0, st.area.y0], [st.area.x1, st.area.y0], [st.area.x0, st.area.y1], [st.area.x1, st.area.y1]]) {
    assert.ok(((x - 210) / 130) ** 2 + ((y - 160) / 100) ** 2 <= 1.02, `corner ${x},${y}`);
  }
});

test('text on busy artwork → blur with a readable outline', () => {
  const c = canvas(W, H);
  noise(c, 0, 0, W, H);
  const box = { x0: 100, y0: 100, x1: 300, y1: 160 };
  glyphs(c, box.x0, box.y0, box.x1, box.y1, [255, 255, 255]);
  const st = analyzeBox(c, box, 0.5);
  assert.equal(st.m, 1);
  assert.ok(contrast(st.fg, st.ol) > 10);
  assert.deepEqual(st.area, st.patch);
  const big = analyzeBox(c, box, 0.5, 60);
  assert.equal(big.m, 1);
  assert.ok(box.x0 - big.patch.x0 >= 12 && big.patch.x1 - box.x1 >= 12 && box.y0 - big.patch.y0 >= 12 && big.patch.y1 - box.y1 >= 12, JSON.stringify(big.patch));
});

test('solid coloured caption box with white text → fill in the box colour, white text', () => {
  const c = canvas(W, H);
  noise(c, 0, 0, W, H);
  rect(c, 40, 40, 380, 130, [30, 60, 200]);
  const box = { x0: 70, y0: 60, x1: 350, y1: 110 };
  glyphs(c, box.x0, box.y0, box.x1, box.y1, [250, 250, 250]);
  const st = analyzeBox(c, box, 0.5);
  assert.equal(st.m, 0);
  assert.ok(Math.abs(st.bg[0] - 30) < 12 && Math.abs(st.bg[2] - 200) < 12, `bg ${st.bg}`);
  assert.ok(st.fg.every((v) => v > 200), `fg ${st.fg}`);
});

test('text on an open white page → fill without expanding (no enclosing bubble)', () => {
  const c = canvas(W, H);
  const box = { x0: 150, y0: 140, x1: 270, y1: 180 };
  glyphs(c, box.x0, box.y0, box.x1, box.y1, [0, 0, 0]);
  const st = analyzeBox(c, box, 0.5);
  assert.equal(st.m, 0);
  assert.deepEqual(st.area, st.patch);
});

test('a strict sensitivity turns borderline backgrounds into blur', () => {
  const c = canvas(W, H, [240, 240, 240]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x + y) % 3 === 0) px(c, x, y, [175, 175, 175]);
  const box = { x0: 150, y0: 140, x1: 270, y1: 180 };
  glyphs(c, box.x0, box.y0, box.x1, box.y1, [0, 0, 0]);
  assert.equal(analyzeBox(c, box, 0).m, 1);
});

function softGlyphs(c, x0, y0, x1, y1, core, edge) {
  glyphs(c, x0 - 1, y0 - 1, x1 + 1, y1 + 1, edge);
  for (let y = y0; y < y1; y += 14) {
    for (let x = x0; x < x1; x += 12) {
      rect(c, x, y, Math.min(x + 1, x1), Math.min(y + 8, y1), core);
      rect(c, x, y + 4, Math.min(x + 7, x1), Math.min(y + 5, y1), core);
    }
  }
}

test('the text colour is the strokes\' own, not lightened by their anti-aliased edges', () => {
  const c = canvas(W, H);
  const box = { x0: 150, y0: 140, x1: 270, y1: 180 };
  softGlyphs(c, box.x0, box.y0, box.x1, box.y1, [0, 0, 0], [150, 150, 150]);
  const st = analyzeBox(c, box, 0.5);
  assert.ok(st.fg.every((v) => v < 30), `black lettering came out as ${st.fg}`);
  const g = canvas(W, H);
  softGlyphs(g, box.x0, box.y0, box.x1, box.y1, [96, 96, 96], [190, 190, 190]);
  const sg = analyzeBox(g, box, 0.5);
  assert.ok(sg.fg.every((v) => v > 80 && v < 120), `grey lettering came out as ${sg.fg}`);
});

test('a tall column on open white: the text may spread over plain paper, the paint stays on the lettering', () => {
  const c = canvas(W, H);
  const box = { x0: 200, y0: 60, x1: 230, y1: 260 };
  glyphs(c, box.x0, box.y0, box.x1, box.y1, [0, 0, 0]);
  const st = analyzeBox(c, box, 0.5);
  assert.equal(st.m, 0);
  assert.ok(st.area.x1 - st.area.x0 > 2 * (box.x1 - box.x0), `area ${JSON.stringify(st.area)}`);
  assert.ok(st.patch.x0 >= box.x0 - 4 && st.patch.x1 <= box.x1 + 4, `patch ${JSON.stringify(st.patch)}`);
  for (const [what, draw] of [
    ['small print', (d) => glyphs(d, 262, 150, 330, 160, [0, 0, 0])],
    ['a 1-px rule', (d) => rect(d, 140, 100, 141, 230, [60, 60, 60])],
  ]) {
    const d = canvas(W, H);
    glyphs(d, box.x0, box.y0, box.x1, box.y1, [0, 0, 0]);
    draw(d);
    const sd = analyzeBox(d, box, 0.5);
    const hit = what === 'small print' ? sd.area.x1 > 262 : sd.area.x0 < 141;
    assert.ok(!hit, `${what}: area ${JSON.stringify(sd.area)}`);
  }
});

test('blurred patches with their margins: neighbours shrink back rather than blur each other\'s text', () => {
  const c = canvas(W, H);
  noise(c, 0, 0, W, H);
  const a = analyzeBox(c, { x0: 60, y0: 100, x1: 180, y1: 160 }, 0.5, 60);
  const b = analyzeBox(c, { x0: 196, y0: 100, x1: 316, y1: 160 }, 0.5, 60);
  assert.equal(a.m, 1);
  resolveCollisions([a, b]);
  assert.deepEqual(a.patch, a.core);
  assert.deepEqual(b.patch, b.core);
  assert.ok(a.patch.x1 <= b.patch.x0, 'the shrunk patches no longer overlap');
});

test('a tall, narrow bubble (vertical source text): the room is the one that sets the translation largest', () => {
  const c = canvas(W, H);
  noise(c, 0, 0, W, H);
  ellipse(c, 210, 160, 34, 130, [255, 255, 255], [0, 0, 0], 3);
  const box = { x0: 198, y0: 60, x1: 222, y1: 260 };
  glyphs(c, box.x0, box.y0, box.x1, box.y1, [10, 10, 10]);
  const need = { chars: 24, word: 7, cap: 0 };
  const biggest = analyzeBox(c, box, 0.5);
  const fitted = analyzeBox(c, box, 0.5, 0, need);
  const font = (a) => fontFor(a.x1 - a.x0, a.y1 - a.y0, need);
  assert.ok(font(fitted.area) > 1.25 * font(biggest.area), `${font(fitted.area).toFixed(1)} px vs ${font(biggest.area).toFixed(1)} px`);
  assert.ok(fitted.area.x1 - fitted.area.x0 > biggest.area.x1 - biggest.area.x0, 'wider than the tallest column');
  for (const [x, y] of [[fitted.area.x0, fitted.area.y0], [fitted.area.x1, fitted.area.y0], [fitted.area.x0, fitted.area.y1], [fitted.area.x1, fitted.area.y1]]) {
    assert.ok(((x - 210) / 34) ** 2 + ((y - 160) / 130) ** 2 <= 1.02, `corner ${x},${y} outside the bubble`);
  }
});

test('text areas that meet split the space between their lettering, each keeping its side', () => {
  const style = (core, area) => ({ m: 0, bg: [255, 255, 255], fg: [0, 0, 0], ol: [255, 255, 255], patch: core, area, core });
  const a = style({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 0, y0: 0, x1: 50, y1: 50 });
  const b = style({ x0: 40, y0: 40, x1: 60, y1: 60 }, { x0: 30, y0: 30, x1: 70, y1: 70 });
  resolveCollisions([a, b]);
  const meet = (p, q) => Math.min(p.x1, q.x1) > Math.max(p.x0, q.x0) && Math.min(p.y1, q.y1) > Math.max(p.y0, q.y0);
  const holds = (p, q) => p.x0 <= q.x0 && p.y0 <= q.y0 && p.x1 >= q.x1 && p.y1 >= q.y1;
  assert.ok(!meet(a.area, b.area), `${JSON.stringify(a.area)} / ${JSON.stringify(b.area)}`);
  assert.ok(holds(a.area, a.core) && holds(b.area, b.core), 'each keeps its lettering');
  assert.equal(a.area.x1, 25, 'cut half-way between the two');
  const cols = [0, 1, 2].map((k) => {
    const x = 100 + 60 * k;
    return { ...style({ x0: x, y0: 20, x1: x + 30, y1: 300 }, { x0: x - 60, y0: 20, x1: x + 90, y1: 300 }), text: { x0: x + 4, y0: 24, x1: x + 26, y1: 296 } };
  });
  resolveCollisions(cols);
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) assert.ok(!meet(cols[i].area, cols[j].area), `columns ${i} and ${j}`);
    assert.ok(holds(cols[i].area, cols[i].text), `column ${i} keeps its lettering`);
  }
  assert.ok(cols[1].area.x1 - cols[1].area.x0 > 50, 'the middle one wider than its lettering');
  const c = style({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 0, y0: 0, x1: 50, y1: 50 });
  const f = style({ x0: 45, y0: 45, x1: 90, y1: 90 }, { x0: 45, y0: 45, x1: 90, y1: 90 });
  resolveCollisions([c], [f]);
  assert.ok(!meet(c.area, f.area));
  assert.deepEqual(f.area, { x0: 45, y0: 45, x1: 90, y1: 90 });
  const d = style({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 0, y0: 0, x1: 50, y1: 50 });
  const e = style({ x0: 40, y0: 0, x1: 50, y1: 10 }, { x0: 0, y0: 0, x1: 90, y1: 50 });
  resolveCollisions([d], [], [e]);
  assert.ok(!meet(d.area, e.area) && holds(e.area, e.core) && holds(d.area, d.core));
});
