import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheGet, cachePut } from '../../background/cache.js';

test('cache: an answer to an older prompt is used as it is — but not when the user asked to rescan', async () => {
  await cachePut('raw', 'page-a', [{ t: 'old' }], false, 1);
  assert.deepEqual((await cacheGet('raw', 'page-a', { rev: 2 }))?.value, [{ t: 'old' }], 'a visit: the saved answer, no request');
  assert.equal(await cacheGet('raw', 'page-a', { fresh: true, rev: 2 }), undefined, 'a rescan: asked again');
  await cachePut('raw', 'page-a', [{ t: 'new' }], false, 2);
  assert.deepEqual((await cacheGet('raw', 'page-a', { fresh: true, rev: 2 }))?.value, [{ t: 'new' }], 'a rescan of an answer to this prompt: kept');
  assert.equal((await cacheGet('raw', 'page-a'))?.rev, 2);
});

test('cache: an answer cut short is asked again on a rescan; answers from before revisions count as the oldest', async () => {
  await cachePut('final', 'page-b', [{ i: 1 }], true, 2);
  assert.ok(await cacheGet('final', 'page-b', { rev: 2 }), 'a visit: kept');
  assert.equal(await cacheGet('final', 'page-b', { fresh: true, rev: 2 }), undefined, 'a rescan: asked again');
  await cachePut('final', 'page-c', [{ i: 1 }]);
  assert.equal((await cacheGet('final', 'page-c'))?.rev, 0);
  assert.equal(await cacheGet('final', 'page-c', { fresh: true, rev: 1 }), undefined);
});
