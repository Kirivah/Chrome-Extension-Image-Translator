import test from 'node:test';
import assert from 'node:assert/strict';
import { guide, blockOfChars, cut } from '../../background/guided.js';
import { Matcher } from '../../background/match.js';

/**
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {{dark?: boolean, mark?: boolean, inBlock?: boolean, clear?: number}} [o]
 */
function ch(x0, y0, x1, y1, o = {}) {
  const w = x1 - x0; const h = y1 - y0;
  const dark = o.dark ?? true;
  return {
    box: { x0, y0, x1, y1 },
    size: Math.max(w, h),
    dark,
    mark: o.mark ?? false,
    inBlock: o.inBlock ?? false,
    ink: dark ? 110 : 235,
    paper: dark ? 240 : 50,
    clear: o.clear ?? 0.9,
    n: w * h,
    mask: { x0, y0, w, h, s: 1, bits: new Uint8Array(w * h).fill(1) },
  };
}

const column = (x, y, n, s = 30, gap = 5, o = {}) => Array.from({ length: n }, (_, i) => ch(x, y + i * (s + gap), x + s, y + i * (s + gap) + s, o));

function block(chars) {
  for (const c of chars) c.inBlock = true;
  return blockOfChars(chars);
}

const mapOf = (blocks, chars) => ({ W: 600, H: 600, s: 1, blocks, chars, ms: 0, partial: false });
const ownedBy = (blocks) => (c) => c.inBlock && blocks.some((b) => c.box.x0 >= b.box.x0 && c.box.x1 <= b.box.x1 && c.box.y0 >= b.box.y0 && c.box.y1 <= b.box.y1);

test('guided: a column found further only as its edging (light shapes round dark letters) runs on — not a pale patch beside it', () => {
  const top = column(100, 20, 4);
  const B = block(top);
  const rims = [ch(97, 162, 133, 198, { dark: false }), ch(97, 203, 133, 239, { dark: false })];
  const patch = ch(140, 60, 176, 96, { dark: false });
  const map = mapOf([B], [...top, ...rims, patch]);
  const g = guide(map, { x0: 90, y0: 10, x1: 180, y1: 250 }, new Set(), { like: [B], spoken: ownedBy([B]) });
  assert.ok(g, 'built');
  for (const r of rims) assert.ok(g.chars.includes(r), `edging ${JSON.stringify(r.box)} taken`);
  assert.ok(!g.chars.includes(patch), 'the patch beside it left alone');
  assert.equal(g.block.dark, true);
  assert.equal(g.block.ink, B.ink);
  assert.equal(g.block.paper, B.paper);
});

test('guided: a character merged with the drawing beside it is cut back to its column, and the column runs on past it', () => {
  const top = column(100, 20, 4);
  const B = block(top);
  const merged = ch(100, 162, 200, 230);
  const below = column(100, 236, 2);
  const map = mapOf([B], [...top, merged, ...below]);
  const g = guide(map, { x0: 90, y0: 10, x1: 150, y1: 320 }, new Set(), { like: [B], spoken: ownedBy([B]) });
  assert.ok(g, 'built');
  const part = g.chars.find((c) => c.of === merged);
  assert.ok(part, 'the merged character\'s part in the column taken');
  assert.ok(part.box.x1 <= 136 && part.box.x0 >= 95, `cut to the column: ${JSON.stringify(part.box)}`);
  assert.ok(!g.chars.includes(merged), 'not the whole of it');
  for (const c of below) assert.ok(g.chars.includes(c), `the column past it: ${JSON.stringify(c.box)}`);
  const m = part.mask;
  assert.ok(m.x0 >= 95 && m.x0 + m.w <= 136, 'mask cut');
  assert.equal(cut(merged, 300, 340, true), null);
});

test('guided: what continues a block lies in line with its characters — not drawing inside its box between them', () => {
  const long = column(100, 20, 7);
  const short = column(160, 20, 1);
  const B = block([...long, ...short]);
  const art = ch(176, 180, 206, 210);
  const next = column(50, 20, 4);
  const map = mapOf([B], [...long, ...short, art, ...next]);
  const g = guide(map, { x0: 40, y0: 10, x1: 215, y1: 270 }, new Set(), { like: [B], spoken: ownedBy([B]) });
  assert.ok(g, 'built');
  for (const c of next) assert.ok(g.chars.includes(c), `next column ${JSON.stringify(c.box)}`);
  assert.ok(!g.chars.includes(art), 'drawing left alone');
});

test('guided: the dots of "…" running on from a column are all taken', () => {
  const top = column(100, 20, 4);
  const B = block(top);
  const dots = [0, 1, 2].map((i) => ch(112, 165 + i * 12, 118, 171 + i * 12, { mark: true }));
  const map = mapOf([B], [...top, ...dots]);
  const g = guide(map, { x0: 90, y0: 10, x1: 140, y1: 210 }, new Set(), { like: [B], spoken: ownedBy([B]) });
  assert.ok(g, 'built');
  for (const d of dots) assert.ok(g.chars.includes(d), `dot ${JSON.stringify(d.box)}`);
});

test('matching: a box with a little of its lettering in blocks takes the characters around them, not a block further off', () => {
  const found = column(300, 20, 2);
  const S = block(found);
  const rest = [...column(300, 90, 6), ...column(250, 20, 8)];
  const far = column(120, 20, 3);
  const F = block(far);
  const map = mapOf([S, F], [...found, ...rest, ...far]);
  const m = new Matcher(map);
  const model = { x0: 240, y0: 10, x1: 340, y1: 310 };
  const acts = [...m.place(1, model, 40), ...m.finish()];
  const show = acts.filter((a) => a.type === 'show' && a.id === 1).pop();
  assert.ok(show, JSON.stringify(acts.map((a) => a.type)));
  assert.ok(show.blocks.includes(S), 'its block');
  assert.ok(!show.blocks.includes(F), 'not the block further off');
  const u = show.blocks.reduce((a, b) => ({ x0: Math.min(a.x0, b.box.x0), y0: Math.min(a.y0, b.box.y0), x1: Math.max(a.x1, b.box.x1), y1: Math.max(a.y1, b.box.y1) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
  assert.ok(u.x0 <= 250 && u.y1 >= 295, `all of its lettering: ${JSON.stringify(u)}`);
  assert.ok(!m.owner.has(F), 'the other block still free');
});
