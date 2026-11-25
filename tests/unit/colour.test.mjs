import test from 'node:test';
import assert from 'node:assert/strict';
import { colourLettering, adoptColourBlocks } from '../../background/colortext.js';
import { eraseLettering } from '../../background/inpaint.js';
import { patchFill } from '../../background/patchfill.js';
import { scene, blockOf, PINK } from './cgscene.mjs';

const lum = (r, g, b) => (r * 77 + g * 150 + b * 29) / 256;

test('colour lettering: a column of pink characters edged in white is one vertical block — not a flower of its colour, nor the text off to the side', () => {
  const { px, column, flower, other } = scene();
  const found = colourLettering(px, 30, Infinity);
  const col = found.find((b) => b.box.x0 < column[0].x1 && b.box.x1 > column[0].x0 && b.box.y0 < column[3].y1);
  assert.ok(col, 'found');
  assert.ok(col.colour && col.vertical && col.dark, 'colour lettering, vertical, light-ringed');
  assert.ok(col.box.y0 <= column[0].y0 + 2 && col.box.y1 >= column[column.length - 1].y1 - 2, `the whole column: ${col.box.y0}–${col.box.y1}`);
  assert.ok(col.box.y1 < flower[0].y0, 'without the unedged flower below it');
  assert.ok(col.box.x1 < other[0].x0, 'nor the other text');
  assert.ok(col.glyph >= 18 && col.glyph <= 34, `its size: ${col.glyph}`);
  assert.ok(found.some((b) => b !== col && b.box.x0 >= other[0].x0 - 2), 'the other text is a block of its own');
  assert.ok(!found.some((b) => b.box.y1 > flower[0].y0 + 2), 'the flower is no lettering');
});

test('colour lettering: the text map\'s blocks over it make way for it; others stay', () => {
  const { px, column, other } = scene();
  const colour = colourLettering(px, 30, Infinity);
  const over = blockOf(px, column.slice(2, 5));
  const elsewhere = { ...blockOf(px, column.slice(0, 1)), box: { x0: 200, y0: 300, x1: 230, y1: 330 }, mask: { x0: 200, y0: 300, w: 30, h: 30, s: 1, bits: new Uint8Array(900).fill(1) } };
  const ch = { box: column[6], mask: blockOf(px, [column[6]]).mask, inBlock: false };
  const map = adoptColourBlocks({ blocks: [over, elsewhere], chars: [ch] }, colour);
  assert.ok(!map.blocks.includes(over), 'the block over it gives way');
  assert.ok(map.blocks.includes(elsewhere), 'one elsewhere stays');
  assert.equal(map.blocks.filter((b) => b.colour).length, colour.length);
  assert.ok(ch.inBlock, 'its characters are in a block');
  void other;
});

test('erasing colour lettering in a colour picture: a wire behind it is carried straight on through', () => {
  const wire = 330;
  const { px, column } = scene({ wire });
  const e = eraseLettering(px, [blockOf(px, column)], [], undefined, true, 0, true);
  assert.ok(e, 'erased');
  const bw = e.box.x1 - e.box.x0;
  let dark = 0; let n = 0;
  for (let x = 98; x <= 122; x++) {
    const k = ((wire - e.box.y0) * bw + (x - e.box.x0)) * 4;
    if (e.rgba[k + 3] < 200) continue;
    n++;
    if (lum(e.rgba[k], e.rgba[k + 1], e.rgba[k + 2]) < 70) dark++;
  }
  assert.ok(n >= 15 && dark >= 0.9 * n, `the wire: ${dark}/${n} dark`);
});

function leaves() {
  const W = 240; const H = 300;
  const data = new Uint8ClampedArray(W * H * 4);
  let seed = 77;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const band = Math.floor((x + 0.6 * y) / 9) % 3;
      const n = rnd() * 30;
      const c = band === 0 ? [40 + n, 110 + n, 50] : band === 1 ? [70 + n, 160 + n, 60] : [190 + n, 200 + n * 0.5, 80];
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
    }
  }
  const magenta = { x0: 175, y0: 110, x1: 200, y1: 140 };
  for (let y = magenta.y0; y < magenta.y1; y++) for (let x = magenta.x0; x < magenta.x1; x++) { const i = (y * W + x) * 4; data[i] = 240; data[i + 1] = 20; data[i + 2] = 230; }
  const box = { x0: 80, y0: 20, w: 80, h: 260 };
  const mask = new Uint8Array(box.w * box.h);
  for (let y = 20; y < 240; y++) for (let x = 20; x < 60; x++) mask[y * box.w + x] = 1;
  return { px: { data, W, H }, magenta, box, mask };
}

test('filling from the artwork around: its colours and texture, not a grey blur — never other lettering\'s', () => {
  const { px, magenta, box, mask } = leaves();
  const start = new Float32Array(box.w * box.h * 3).fill(128);
  const out = patchFill(px, mask, box.x0, box.y0, box.w, box.h, start, [magenta], 4, 60, Infinity);
  const stats = (pick) => {
    let n = 0; const s = [0, 0, 0]; let l1 = 0; let l2 = 0;
    for (let y = 0; y < box.h; y++) {
      for (let x = 0; x < box.w; x++) {
        const v = pick(x, y);
        if (!v) continue;
        n++; for (let c = 0; c < 3; c++) s[c] += v[c];
        const l = lum(v[0], v[1], v[2]); l1 += l; l2 += l * l;
      }
    }
    return { mean: s.map((v) => v / n), sd: Math.sqrt(l2 / n - (l1 / n) ** 2), n };
  };
  const filled = stats((x, y) => (mask[y * box.w + x] ? [...out.subarray((y * box.w + x) * 3, (y * box.w + x) * 3 + 3)] : null));
  const around = stats((x, y) => {
    if (mask[y * box.w + x]) return null;
    const i = ((box.y0 + y) * px.W + box.x0 + x) * 4;
    return [px.data[i], px.data[i + 1], px.data[i + 2]];
  });
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(filled.mean[c] - around.mean[c]) < 18, `channel ${c}: ${filled.mean[c].toFixed(0)} vs ${around.mean[c].toFixed(0)} around`);
  assert.ok(filled.sd > 0.5 * around.sd, `textured: ${filled.sd.toFixed(1)} vs ${around.sd.toFixed(1)} around`);
  let pink = 0;
  for (let k = 0; k < box.w * box.h; k++) if (mask[k] && out[k * 3] > 180 && out[k * 3 + 2] > 160 && out[k * 3 + 1] < 120) pink++;
  assert.equal(pink, 0, 'nothing of the other lettering');
  assert.equal(out[0], 128);
  const again = patchFill(px, mask, box.x0, box.y0, box.w, box.h, start, [magenta], 4, 60, Infinity);
  assert.deepEqual(again, out);
});

test('colour lettering erased and polished: no outline white or ink pink left, the foliage carried in', () => {
  const { px, column } = scene();
  const e = eraseLettering(px, [blockOf(px, column)], [], undefined, false, 0, true);
  assert.ok(e, 'erased');
  const bw = e.box.x1 - e.box.x0;
  let n = 0; let light = 0; let pinkish = 0;
  for (let y = 210; y < 400; y++) {
    for (let x = 90; x < 131; x++) {
      const i = (y * px.W + x) * 4;
      const lettering = px.data[i] >= 200 && (px.data[i + 1] < 80 || px.data[i + 1] >= 245);
      if (!lettering) continue;
      const k = ((y - e.box.y0) * bw + (x - e.box.x0)) * 4;
      n++;
      if (lum(e.rgba[k], e.rgba[k + 1], e.rgba[k + 2]) > 150) light++;
      if (e.rgba[k] > 150 && e.rgba[k + 1] < 110) pinkish++;
    }
  }
  assert.ok(n > 300, `lettering pixels: ${n}`);
  assert.ok(light <= 0.03 * n && pinkish <= 0.01 * n, `${light} light, ${pinkish} pink of ${n}`);
  void PINK;
});
