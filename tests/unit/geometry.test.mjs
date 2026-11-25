import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../../content/geometry.js', import.meta.url), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(code + '\nthis.Geometry = Geometry;', ctx);
const { objectFitRect } = ctx.Geometry;

test('fill stretches to the content box', () => {
  assert.deepEqual({ ...objectFitRect(1000, 500, 300, 300, 'fill', '50% 50%') }, { x: 0, y: 0, w: 300, h: 300 });
});

test('contain letterboxes and centres', () => {
  const r = objectFitRect(1000, 500, 300, 300, 'contain', '50% 50%');
  assert.equal(r.w, 300);
  assert.equal(r.h, 150);
  assert.equal(r.y, 75);
});

test('cover crops and honours object-position', () => {
  const r = objectFitRect(1000, 500, 300, 300, 'cover', '0% 50%');
  assert.equal(r.h, 300);
  assert.equal(r.w, 600);
  assert.equal(r.x, 0);
  const right = objectFitRect(1000, 500, 300, 300, 'cover', '100% 50%');
  assert.equal(right.x, -300);
});

test('scale-down never enlarges; unknown positions fall back to centre', () => {
  const r = objectFitRect(100, 50, 300, 300, 'scale-down', 'calc(10% + 3px) 50%');
  assert.equal(r.w, 100);
  assert.equal(r.x, 100);
});
