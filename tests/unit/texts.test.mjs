import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTextMap } from '../../background/textmap.js';
import { findBubbles } from '../../background/bubbles.js';
import { textsOf, trimCell, clear } from '../../background/texts.js';
import { Matcher } from '../../background/match.js';
import { Placer } from '../../background/placement.js';
import { readPng } from './png.mjs';

const DIR = new URL('./fixtures/', import.meta.url);
const T = JSON.parse(readFileSync(new URL('texts.json', DIR), 'utf8'))['manga-8.png'];
const page = readPng(new URL('manga-8.png', DIR).pathname);
const labels = readPng(new URL('manga-8.labels.png', DIR).pathname);
const map = buildTextMap(page);
const bubbles = findBubbles(page, map);

const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const inter = (a, b) => area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const boxOf = (t) => ({ x0: t.box[0], y0: t.box[1], x1: t.box[2], y1: t.box[3] });
const grow = (b, m) => ({ x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m });
const union = (bs) => ({ x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)), x1: Math.max(...bs.map((b) => b.x1)), y1: Math.max(...bs.map((b) => b.y1)) });
const of = (s) => { const t = T.blocks.find((b) => b.text === s); assert.ok(t, s); return t; };
const fields = T.blocks.filter((b) => b.kind === 'field');

function textsUnder(t, texts) {
  const B = boxOf(t);
  const parts = texts.map.blocks.filter((b) => inter(b.box, B) > 0.5 * area(b.box));
  const out = new Set(parts.map((p) => texts.texts.get(p) ?? p));
  for (const x of new Set(texts.texts.values())) if (x.chars.some((c) => inter(c.box, B) > 0.5 * area(c.box))) out.add(x);
  return out;
}

test('texts: clear space is most of a character and well over the usual spacing — or a character and a half', () => {
  assert.ok(clear(26, 25, 4), 'a caption\'s two paragraphs, a column\'s width apart');
  assert.ok(!clear(12, 25, 10), 'columns of one text');
  assert.ok(!clear(27, 26, 14), 'a gap little over twice the usual one');
  assert.ok(clear(40, 26, 30), 'a character and a half, however the rest is spaced');
});

test('texts: a status window\'s fields are each a text; a caption\'s two paragraphs, a remark set apart, two; two lines of one text, one', () => {
  const texts = textsOf(map, bubbles);
  const under = new Map(fields.map((t) => [t, textsUnder(t, texts)]));
  for (const t of fields.filter((b) => !b.value)) assert.ok(under.get(t).size, `"${t.text}": found`);
  const together = new Set(['スタミナ', '40']);
  for (let i = 0; i < fields.length; i++) {
    for (let j = i + 1; j < fields.length; j++) {
      const a = fields[i]; const b = fields[j];
      if (together.has(a.text) && together.has(b.text)) continue;
      const shared = [...under.get(a)].filter((x) => under.get(b).has(x));
      assert.equal(shared.length, 0, `"${a.text}" and "${b.text}": one text`);
    }
  }
  for (const p of texts.map.blocks) {
    const over = fields.filter((t) => !together.has(t.text) && inter(p.box, boxOf(t)) > 0.3 * area(boxOf(t)));
    assert.ok(over.length <= 1, `${JSON.stringify(p.box)} over ${over.map((t) => t.text).join(', ')}`);
  }
  /** @param {string} a @param {string} b */
  const apart = (a, b) => {
    const x = textsUnder(of(a), texts); const y = textsUnder(of(b), texts);
    return ![...x].some((q) => y.has(q));
  };
  assert.ok(apart('見知らぬ場所で目を覚ました時', '全てはもう始まっていた'), 'the caption\'s paragraphs: two texts');
  assert.ok(apart('えっ…', 'ここは どこなんだ 一体'), 'a remark set apart: a text of its own');
  assert.equal(textsUnder(of('そうだね もう行こうか'), texts).size, 1, 'two lines of one text: one');
  assert.equal(textsUnder(of('ここは どこなんだ 一体'), texts).size, 1, 'a column the map made no block of goes with its text');
});

test('texts: a field a box takes in part is cut at the space where the box ends — not short of a word\'s end', () => {
  const texts = textsOf(map, bubbles);
  const label = boxOf(of('スタミナ')); const value = boxOf(of('40'));
  const cell = [...texts.cells.keys()].find((c) => inter(c.box, label) > 0.8 * area(label));
  assert.ok(cell, 'one field');
  assert.ok(inter(cell.box, value) > 0.8 * area(value), 'with its value');
  const cut = trimCell(cell, texts.cells.get(cell), grow(label, 3));
  assert.ok(cut, 'cut');
  assert.equal(cut.inside.length, 4, 'the label\'s four characters');
  assert.equal(cut.outside.flat().length, 2, 'the value\'s two');
  assert.equal(trimCell(cell, texts.cells.get(cell), { ...label, x1: label.x1 - 8 })?.inside.length, 4);
  const chars = texts.cells.get(cell);
  assert.equal(trimCell(cell, chars, { ...label, x1: chars[2].box.x1 + 2 }), null);
  assert.equal(trimCell(cell, texts.cells.get(cell), grow(union([label, value]), 3)), null);
});

async function place(models) {
  const patches = new Map();
  let n = 0;
  const placer = new Placer(page, {
    sensitivity: 0.5,
    lang: 'en',
    encode: async (rgba, w) => { const k = `P${++n}`; patches.set(k, { rgba: new Uint8ClampedArray(rgba), w }); return `${k}AAAA`; },
  });
  const shown = new Map();
  const apply = (u) => { for (const id of u.retract) shown.delete(id); for (const r of u.show) shown.set(r.i, r); };
  for (const [b, t] of models) apply(await placer.add([{ x0: b.x0 / page.W, y0: b.y0 / page.H, x1: b.x1 / page.W, y1: b.y1 / page.H, t }]));
  apply(await placer.finish());
  const regions = [...shown.values()];
  const hidden = (x, y) => regions.some((r) => {
    const x0 = Math.round(r.p.x * page.W); const y0 = Math.round(r.p.y * page.H);
    const x1 = Math.round((r.p.x + r.p.w) * page.W); const y1 = Math.round((r.p.y + r.p.h) * page.H);
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
        if (labels.data[(y * labels.W + x) * 4] !== t.id) continue;
        all++;
        if (hidden(x, y)) hid++;
      }
    }
    return hid / Math.max(1, all);
  };
  const pct = (t) => `${(100 * covered(t)).toFixed(0)}%`;
  return { regions, covered, pct };
}

const NAMES = { ステータス: 'Status', 職業: 'Class', 剣士: 'Swordsman', 攻撃: 'Attack', 防御: 'Defense', 魔力: 'Magic', 速さ: 'Speed', 器用: 'Dexterity', 幸運: 'Luck', スタミナ: 'Stamina', '500ゴールド': '500 gold' };

test('placing: a status window given field by field — each translation over its own field, the values given none left as they are', async () => {
  const models = Object.entries(NAMES).map(([jp, en]) => [grow(boxOf(of(jp)), 3), en]);
  const { regions, covered, pct } = await place(models);
  for (const [jp, en] of Object.entries(NAMES)) {
    const r = regions.filter((q) => q.t === en);
    assert.equal(r.length, 1, `"${en}" drawn once, on its own: ${regions.map((q) => q.t).join(' | ')}`);
    assert.ok(covered(of(jp)) >= 0.99, `"${jp}": ${pct(of(jp))} hidden`);
  }
  for (const t of fields.filter((b) => b.value)) assert.ok(covered(t) <= 0.01, `the value "${t.text}" left: ${pct(t)} hidden`);
});

test('placing: a status window given row by row, or all in one — each over its own', async () => {
  const rows = [['攻撃', '12', '防御', '8'], ['魔力', '5', '速さ', '20'], ['器用', '15', '幸運', '3']];
  const byRow = await place(rows.map((r) => [grow(union(r.map((s) => boxOf(of(s)))), 3), r.join(' ')]));
  for (const r of rows) {
    assert.equal(byRow.regions.filter((q) => q.t === r.join(' ')).length, 1, `row "${r.join(' ')}": ${byRow.regions.map((q) => q.t).join(' | ')}`);
    for (const s of r) assert.ok(byRow.covered(of(s)) >= 0.99, `"${s}": ${byRow.pct(of(s))} hidden`);
  }
  const table = fields.filter((b) => b.box[1] > 160 && b.box[3] < 340);
  const all = await place([[grow(union(table.map(boxOf)), 4), 'the whole table']]);
  assert.deepEqual(all.regions.map((q) => q.t), ['the whole table']);
  for (const t of table) assert.ok(all.covered(t) >= 0.99, `"${t.text}": ${all.pct(t)} hidden`);
});

test('placing: a caption\'s two paragraphs, given apart, are two translations; given as one, one over both', async () => {
  const [a, b] = [of('見知らぬ場所で目を覚ました時'), of('全てはもう始まっていた')];
  const apart = await place([[grow(boxOf(a), 4), 'When I woke up somewhere strange,'], [grow(boxOf(b), 4), 'it had all begun already.']]);
  assert.equal(apart.regions.length, 2, apart.regions.map((q) => q.t).join(' | '));
  for (const t of [a, b]) assert.ok(apart.covered(t) >= 0.99, `${t.text}: ${apart.pct(t)} hidden`);
  const one = await place([[grow(union([boxOf(a), boxOf(b)]), 4), 'When I woke up somewhere strange, it had all begun already.']]);
  assert.equal(one.regions.length, 1, one.regions.map((q) => q.t).join(' | '));
  for (const t of [a, b]) assert.ok(one.covered(t) >= 0.99, `${t.text}: ${one.pct(t)} hidden`);
});

test('placing: a remark set apart in a bubble keeps its own translation; the rest of the bubble its own', async () => {
  const [a, b] = [of('えっ…'), of('ここは どこなんだ 一体')];
  const { regions, covered, pct } = await place([[grow(boxOf(a), 3), 'Huh...'], [grow(boxOf(b), 3), 'Where on earth is this?']]);
  assert.deepEqual(regions.map((q) => q.t).sort(), ['Huh...', 'Where on earth is this?']);
  for (const t of [a, b]) assert.ok(covered(t) >= 0.99, `${t.text}: ${pct(t)} hidden`);
});

test('placing: a caption the model gives twice, once with its box on the sound effect beside it — drawn once, the sound effect keeps its own', async () => {
  const sfx = of('ドドン'); const cap = of('見知らぬ場所で目を覚ました時');
  const text = 'When I woke up in a place I did not know';
  for (const order of ['copy last', 'copy first']) {
    const models = [[grow(boxOf(sfx), 4), 'BOOM'], [grow(boxOf(cap), 4), text]];
    const copy = [grow(boxOf(sfx), 6), text];
    if (order === 'copy last') models.push(copy); else models.unshift(copy);
    const { regions, covered, pct } = await place(models);
    assert.equal(regions.filter((q) => q.t.includes(text)).length, 1, `${order}: drawn once: ${regions.map((q) => q.t).join(' | ')}`);
    assert.ok(regions.some((q) => q.t === 'BOOM'), `${order}: the sound effect's own: ${regions.map((q) => q.t).join(' | ')}`);
    assert.ok(covered(sfx) >= 0.95 && covered(cap) >= 0.99, `${order}: ${pct(sfx)}, ${pct(cap)} hidden`);
  }
});

test('matching: a box over part of a table\'s field, at a space, takes that part only', () => {
  const texts = textsOf(map, bubbles);
  const m = new Matcher(texts.map, texts.texts, texts.cells, texts.apart);
  const label = boxOf(of('スタミナ')); const value = boxOf(of('40'));
  const acts = [...m.place(1, grow(label, 3), 7), ...m.finish()];
  const show = acts.filter((a) => a.type === 'show' && a.id === 1).pop();
  assert.ok(show, JSON.stringify(acts.map((a) => a.type)));
  const got = union(show.blocks.map((b) => b.box));
  assert.ok(inter(got, label) >= 0.9 * area(label), 'the label');
  assert.equal(inter(got, value), 0, 'not its value');
});
