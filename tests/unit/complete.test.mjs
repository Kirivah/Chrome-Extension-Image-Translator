import test from 'node:test';
import assert from 'node:assert/strict';
import { completeLettering } from '../../background/complete.js';
import { eraseLettering } from '../../background/inpaint.js';
import { covers, artRoom } from '../../background/placement.js';
import { scene, blockOf, PINK } from './cgscene.mjs';

test('completion: the rest of a column of outlined colour lettering, both ways along it — not a flower of its colour, nor another text off to the side', () => {
  const { px, column, flower, other } = scene();
  const found = [blockOf(px, column.slice(5, 9))];
  const more = completeLettering(px, found, []);
  assert.ok(more, 'completed');
  for (const c of column) {
    let n = 0; let got = 0;
    for (let y = c.y0; y < c.y1; y++) {
      for (let x = c.x0; x < c.x1; x++) {
        const i = (y * px.W + x) * 4;
        if (!(Math.abs(px.data[i] - PINK[0]) < 20 && Math.abs(px.data[i + 1] - PINK[1]) < 20)) continue;
        n++;
        const m = more.mask;
        const mx = x - m.x0; const my = y - m.y0;
        if (mx >= 0 && my >= 0 && mx < m.w && my < m.h && m.bits[my * m.w + mx]) got++;
      }
    }
    assert.ok(got >= 0.95 * n, `character at y ${c.y0}: ${got}/${n}`);
  }
  assert.ok(more.box.y1 <= flower[0].y0, `the flower isn't taken (box ends at ${more.box.y1})`);
  assert.ok(more.box.x1 < other[0].x0, 'nor the text off to the side');
});

test('completion: never takes another translation\'s lettering, and leaves plain black lettering on artwork alone', () => {
  const { px, column } = scene();
  const found = [blockOf(px, column.slice(5, 9))];
  const theirs = blockOf(px, column.slice(0, 3)).box;
  const more = completeLettering(px, found, [theirs]);
  assert.ok(more && more.box.y0 >= theirs.y1 - 1, 'stops at the lettering another translation has');
  const plain = { ...px, data: new Uint8ClampedArray(px.data) };
  for (let i = 0; i < plain.data.length; i += 4) {
    if (Math.abs(plain.data[i] - PINK[0]) < 20 && Math.abs(plain.data[i + 1] - PINK[1]) < 20) { plain.data[i] = 10; plain.data[i + 1] = 10; plain.data[i + 2] = 10; }
    else if (plain.data[i] >= 250 && plain.data[i + 1] >= 250) { plain.data[i] = 40; plain.data[i + 1] = 90; plain.data[i + 2] = 60; }
  }
  assert.equal(completeLettering(plain, [{ ...found[0], ink: 10, paper: 80 }], []), null);
});

test('erasing lettering edged in white over artwork: the artwork comes back, not the edging\'s white — beside a white wall too', () => {
  const { px, column } = scene();
  const block = blockOf(px, column);
  const e = eraseLettering(px, [block], [], undefined, true);
  assert.ok(e, 'erased');
  let n = 0; let covered = 0; let bright = 0; let foliage = 0;
  const bw = e.box.x1 - e.box.x0;
  for (let y = 210; y < 300; y++) {
    for (let x = 90; x < 131; x++) {
      const i = (y * px.W + x) * 4;
      const lettering = px.data[i] >= 200 && (px.data[i + 1] < 80 || px.data[i + 1] >= 245);
      if (!lettering) continue;
      n++;
      const k = ((y - e.box.y0) * bw + (x - e.box.x0)) * 4;
      if (e.rgba[k + 3] >= 200) covered++;
      foliage++;
      if ((e.rgba[k] * 77 + e.rgba[k + 1] * 150 + e.rgba[k + 2] * 29) / 256 > 150) bright++;
    }
  }
  assert.ok(n > 300 && covered >= 0.98 * n, `letters and edging erased: ${covered}/${n}`);
  assert.ok(bright <= 0.05 * foliage, `over the foliage, filled with foliage: ${bright}/${foliage} bright`);
});

test('a translation given again in part: its words are in the whole one, in order', () => {
  const whole = "It's not that I want to get that pretty, it's just that I can't surpass it (laughs)";
  assert.ok(covers(whole, "It's not that I want to get that pretty, you know"));
  assert.ok(covers(whole, "it's just that I can't surpass it"));
  assert.ok(!covers(whole, 'Well, if I wanted to surpass it, I could do it anytime'));
  assert.ok(!covers('Huh?', 'Huh?'), 'a word or two may well be said twice');
  assert.ok(covers('今でも余裕で超えれるし（笑）まあ私が化粧して', '余裕で超えれるし'), 'by character where words have no spaces');
});

test('the room for a translation over artwork: its lettering\'s own, widened only as far as the text needs', () => {
  const need = (t) => ({ chars: [...t].length, word: Math.max(...t.split(' ').map((w) => w.length)), cap: 36 });
  const two = artRoom({ x0: 50, y0: 40, x1: 160, y1: 600 }, 33, 1280, 960, need('Well, if I wanted to surpass it, I could do it anytime, yeah (laughs)'));
  assert.ok(two.x0 >= 40 && two.x1 <= 170, `two columns: no wider (${Math.round(two.x0)}–${Math.round(two.x1)})`);
  const one = artRoom({ x0: 976, y0: 46, x1: 1015, y1: 653 }, 38, 1280, 960, need("Well, but it's kind of a hassle..."));
  const w = one.x1 - one.x0;
  assert.ok(w > 80 && w <= 39 + 2 * 0.15 * 38 + 3 * 38 + 1, `one column: widened to ${Math.round(w)} px`);
  assert.ok(Math.abs((one.x0 + one.x1) / 2 - 995.5) < 1, 'about its middle');
});
