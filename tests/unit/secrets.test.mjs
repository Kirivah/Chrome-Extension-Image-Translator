import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKey, isPlausibleKey } from '../../shared/secrets.js';

const CLASSIC = 'AIzaSyD3x-AMPLE_key1234567890abcdefghi';

test('keys of any current or future format are accepted as-is', () => {
  for (const k of [CLASSIC, 'AQ.Ab8RN6Lq0Wv3zZ-example_Key.with.dots-0123456789abcdef', 'x'.repeat(66), 'gsk_live:ab12/cd34+ef56=']) {
    assert.equal(normalizeKey(k), k);
    assert.ok(isPlausibleKey(k), k);
  }
});

test('paste artifacts are removed', () => {
  const cases = [
    `  ${CLASSIC}  `,
    `${CLASSIC.slice(0, 20)}\n${CLASSIC.slice(20)}`,
    `${CLASSIC.slice(0, 10)} ${CLASSIC.slice(10)}`,
    `"${CLASSIC}"`,
    `'${CLASSIC}';`,
    `GEMINI_API_KEY=${CLASSIC}`,
    `export GEMINI_API_KEY="${CLASSIC}"`,
    `GOOGLE_API_KEY: ${CLASSIC}`,
    `Bearer ${CLASSIC}`,
    `https://generativelanguage.googleapis.com/v1beta/models?key=${CLASSIC}&alt=sse`,
  ];
  for (const c of cases) assert.equal(normalizeKey(c), CLASSIC, JSON.stringify(c));
});

test('things that cannot be a key are refused', () => {
  for (const k of ['', 'short', 'ключ-ключ-ключ-ключ', 'abc<script>alert(1)</script>', 'has"quote"inside-1234', 'back\\slash-1234567']) {
    assert.equal(isPlausibleKey(normalizeKey(k)), false, k);
  }
});
