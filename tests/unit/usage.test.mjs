import test from 'node:test';
import assert from 'node:assert/strict';
import { reserve, settle, spendBlock, usageSnapshot, estimate } from '../../background/usage.js';
import { maxOutputTokens } from '../../background/limits.js';
import { sanitize } from '../../shared/settings.js';

const M = { id: 'm', label: '', inUsd: 0.10, outUsd: 0.40, gen: 2 };

test('parallel requests reserve before sending, so caps cannot be overshot', () => {
  const s = sanitize({ dailyRequests: 3, dailyBudget: 0 });
  const held = [];
  while (!spendBlock(s, M, 1)) held.push(reserve(M, 1));
  assert.equal(held.length, 3, 'only as many in flight as the cap allows');
  assert.equal(spendBlock(s, M, 1), 'wait', 'the rest wait for those in flight');
  settle(held.pop(), M, { billed: false, inTok: 0, outTok: 0 });
  assert.equal(spendBlock(s, M, 1), null);
  for (const h of held) settle(h, M, { billed: true, inTok: 2000, outTok: 300 });
  assert.equal(usageSnapshot().req, 2);
  settle(held[0], M, { billed: true, inTok: 2000, outTok: 300 });
  assert.equal(usageSnapshot().req, 2);
  assert.equal(spendBlock(sanitize({ dailyRequests: 2, dailyBudget: 0 }), M, 1), 'quota', 'spent: the cap is reached');
});

test('a reservation covers the most a request can cost', () => {
  assert.equal(maxOutputTokens(1), 4500);
  assert.equal(maxOutputTokens(3), 8192);
  assert.ok(Math.abs(estimate(M, 1) - (2800 * 0.10 + 4500 * 0.40) / 1e6) < 1e-12);
});

test('the budget: wait while in-flight reservations fill it, stop once real spending does', () => {
  const base = usageSnapshot().cost;
  const one = estimate(M, 1);
  const s = sanitize({ dailyRequests: 0, dailyBudget: base + one * 1.5 });
  assert.equal(spendBlock(s, M, 1), null);
  const h = reserve(M, 1);
  assert.equal(spendBlock(s, M, 1), 'wait');
  settle(h, M, { billed: true, inTok: 2000, outTok: 100 });
  assert.equal(spendBlock(s, M, 1), null);
  assert.equal(spendBlock(s, M, 3), 'budget', 'a bigger request no longer fits');
});

test('a billed request that failed mid-stream still counts toward the budget', () => {
  const before = usageSnapshot().cost;
  const h = reserve(M, 2);
  settle(h, M, { billed: true, inTok: 3600 + 400, outTok: 120 });
  const added = usageSnapshot().cost - before;
  assert.ok(Math.abs(added - (4000 * 0.10 + 120 * 0.40) / 1e6) < 1e-12);
  const cap = sanitize({ dailyBudget: usageSnapshot().cost, dailyRequests: 0 });
  assert.equal(spendBlock(cap, M, 1), 'budget');
});
