import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonObjectStream } from '../../background/jsonstream.js';
import { parseModelBlock, toFullImage, BlockCollector, overlapRatio, validCachedBlocks } from '../../background/regions.js';
import { RateLimiter } from '../../background/limiter.js';
import { planSegments } from '../../background/imaging.js';
import { sniffImageSize } from '../../background/imagesize.js';
import { isPrivateHost, checkImageUrl } from '../../background/fetcher.js';
import { parseCsMessage, parseUiMessage } from '../../background/validate.js';
import { sanitize, DEFAULTS, cleanOrigin, resultSignature, tierPreset } from '../../shared/settings.js';
import { resolveModel, MODELS } from '../../shared/models.js';
import { buildPrompt } from '../../background/gemini.js';
import { TaskError, asTaskError } from '../../background/util.js';
import * as badge from '../../background/badge.js';
import { requestAccess } from '../../shared/access.js';
import { Sequence, step, onward, sameFolder } from '../../background/sequence.js';
import { readFileSync as readSource } from 'node:fs';
import vm from 'node:vm';

test('json stream emits objects as they close, across arbitrary chunk splits', () => {
  const doc = JSON.stringify({ blocks: [
    { box_2d: [1, 2, 3, 4], translation: 'He said "hi" \\ {not a brace} [x]' },
    { box_2d: [5, 6, 7, 8], translation: 'Second' },
    { box_2d: [9, 10, 11, 12], translation: 'Ünïcødé 漢字 😀' },
  ] });
  for (let trial = 0; trial < 200; trial++) {
    const got = [];
    const s = new JsonObjectStream((o) => got.push(o));
    let i = 0;
    while (i < doc.length) {
      const n = 1 + Math.floor(Math.random() * 9);
      s.push(doc.slice(i, i + n));
      i += n;
    }
    assert.equal(got.length, 3);
    assert.equal(got[0].translation, 'He said "hi" \\ {not a brace} [x]');
    assert.equal(got[2].translation, 'Ünïcødé 漢字 😀');
  }
});

test('json stream also accepts a bare top-level array and skips malformed objects', () => {
  const got = [];
  const s = new JsonObjectStream((o) => got.push(o));
  s.push('[{"a":1},{"b":');
  s.push('2},{"c":3}]');
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test('json stream knows when the answer is whole and counts what trails it', () => {
  const got = [];
  const s = new JsonObjectStream((o) => got.push(o));
  s.push('\n {"blocks":[{"a":"}{]["}');
  assert.equal(s.complete, false);
  s.push(']}\n\n\n');
  assert.equal(s.complete, true);
  assert.equal(s.extra, 3);
  s.push('\n'.repeat(50));
  assert.equal(s.extra, 53);
  assert.deepEqual(got, [{ a: '}{][' }]);
  assert.equal(s.value.endsWith(']}'), true, 'padding is not kept');
});

test('json stream never calls an answer whole when text surrounds the JSON or brackets mismatch', () => {
  for (const doc of [
    'Result [JSON]: {"blocks":[{"a":1}]}',
    ']} stray closers {"blocks":[{"a":1}]}',
    '{"blocks":[{"a":1}}] more',
  ]) {
    const got = [];
    const s = new JsonObjectStream((o) => got.push(o));
    for (const ch of doc) s.push(ch);
    assert.equal(s.complete, false, doc);
    assert.equal(s.extra, 0, doc);
    assert.deepEqual(got, [{ a: 1 }], `blocks still stream out: ${doc}`);
  }
});

test('model blocks are validated and clamped', () => {
  assert.equal(parseModelBlock(null, 1), null);
  assert.equal(parseModelBlock({ box_2d: [1, 2, 3], translation: 'x' }, 1), null);
  assert.equal(parseModelBlock({ box_2d: [1, 2, 3, 4], translation: '   ' }, 1), null);
  assert.equal(parseModelBlock({ box_2d: ['a', 2, 3, 4], translation: 'x' }, 1), null);
  const b = parseModelBlock({ box_2d: [900, -50, 100, 2000], translation: '  hi\n there ' }, 1);
  assert.deepEqual(b, { img: 0, y0: 100, x0: 0, y1: 900, x1: 1000, t: 'hi there' });
  assert.equal(parseModelBlock({ image: 3, box_2d: [1, 2, 30, 40], translation: 'x' }, 2), null);
  assert.equal(parseModelBlock({ image: 1, box_2d: [1, 2, 30, 40], translation: 'x' }, 2)?.img, 1);
  assert.equal(parseModelBlock({ box_2d: [0, 0, 10, 10], translation: 'a'.repeat(5000) }, 1)?.t.length, 1200);
});

test('segment coordinates map back to the full image and flag cut edges', () => {
  const seg = { x: 0, y: 1000, w: 800, h: 1280, cutT: true, cutB: true, cutL: false, cutR: false };
  const b = toFullImage({ y0: 0, x0: 250, y1: 500, x1: 750, t: 't' }, seg, 800, 4000);
  assert.ok(Math.abs(b.y0 - 1000 / 4000) < 1e-9);
  assert.ok(Math.abs(b.y1 - 1640 / 4000) < 1e-9);
  assert.ok(Math.abs(b.x0 - 0.25) < 1e-9);
  assert.equal(b.edge, true);
  const inner = toFullImage({ y0: 100, x0: 250, y1: 500, x1: 750, t: 't' }, seg, 800, 4000);
  assert.equal(inner.edge, false);
});

test('collector drops duplicates and resolves clipped copies at the end', () => {
  const c = new BlockCollector(2);
  const full = { x0: 0.1, y0: 0.40, x1: 0.5, y1: 0.50, t: 'complete', edge: false };
  const clipped = { x0: 0.1, y0: 0.40, x1: 0.5, y1: 0.43, t: 'clip', edge: true };
  assert.deepEqual(c.add(clipped), []);
  assert.deepEqual(c.add(full), [full]);
  assert.deepEqual(c.add({ ...full, t: 'dup' }), []);
  assert.deepEqual(c.finish(), []);
  assert.equal(c.all().length, 1);
  assert.ok(overlapRatio(full, clipped) > 0.99);
});

test('collector keeps repeated sound effects at different spots, merges a looping bubble', () => {
  const c = new BlockCollector(1);
  for (let k = 0; k < 8; k++) c.add({ x0: 0.1, y0: 0.1 * k, x1: 0.3, y1: 0.1 * k + 0.05, t: 'Murmur', edge: false });
  assert.equal(c.all().length, 8);
  for (let k = 0; k < 20; k++) c.add({ x0: 0.5, y0: 0.5 + 0.002 * k, x1: 0.8, y1: 0.6 + 0.002 * k, t: 'Wait for me!', edge: false });
  assert.equal(c.all().length, 9);
});

test('badge: account/connection errors clear on the next model answer, image errors stay until a rescan', () => {
  globalThis.chrome ??= /** @type {any} */ ({ action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} } });
  badge.setError(1, 'model', 'Gemini stopped   without an answer (OTHER)');
  badge.imageDone(1, 3, true);
  assert.equal(badge.tabStatus(1).lastError, 'model');
  badge.setError(1, 'budget');
  assert.equal(badge.tabStatus(1).lastError, 'budget', 'the account problem shows first');
  badge.imageDone(1, 2, false);
  assert.equal(badge.tabStatus(1).lastError, 'budget', 'a cache hit proves nothing about the cap');
  badge.imageDone(1, 0, true);
  assert.deepEqual(badge.tabStatus(1), { count: 2, lastError: 'model', detail: 'Gemini stopped without an answer (OTHER)' });
  badge.clearImageErrors(1);
  assert.equal(badge.tabStatus(1).lastError, '');
  badge.setError(1, 'decode');
  badge.setError(2, 'fetch');
  badge.clearAllImageErrors();
  assert.equal(badge.tabStatus(1).lastError + badge.tabStatus(2).lastError, '');
  badge.setError(1, 'nomodel', 'no longer available to new users');
  badge.imageDone(1, 2, false);
  assert.equal(badge.tabStatus(1).lastError, 'nomodel');
  badge.clearPassing('nomodel');
  assert.equal(badge.tabStatus(1).lastError, '');
  badge.resetTab(1);
  badge.resetTab(2);
  assert.deepEqual(badge.tabStatus(1), { count: 0, lastError: '', detail: '' });
});

test('unexpected exceptions are labelled internal, typed ones pass through', () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(asTaskError(new TypeError('x is undefined')).code, 'internal');
  } finally {
    console.error = quiet;
  }
  const e = new TaskError('quota', 'slow down', 5000);
  assert.equal(asTaskError(e), e);
});

test('cached blocks are validated', () => {
  assert.equal(validCachedBlocks('x'), null);
  assert.equal(validCachedBlocks([{ x0: 0, y0: 0, x1: 2, y1: 1, t: 'x' }]), null);
  assert.equal(validCachedBlocks([{ x0: 0, y0: 0, x1: 1, y1: 1, t: 'x' }])?.length, 1);
});

test('rate limiter enforces a sliding window and backs off on 429', () => {
  let rpm = 3;
  const l = new RateLimiter(() => rpm);
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) { assert.equal(l.waitTime(t0 + i), 0); l.take(t0 + i); }
  assert.ok(l.waitTime(t0 + 10) > 59_000);
  assert.equal(l.waitTime(t0 + 60_001), 0);
  l.onRateLimited(t0 + 61_000, 5000);
  assert.ok(l.waitTime(t0 + 61_000) >= 5000);
  assert.ok(l.rpm() < 3 || rpm * 0.7 < 3);
  rpm = 100;
  for (let i = 0; i < 20; i++) l.onSuccess();
  assert.equal(l.rpm(), 100);
});

test('tall images split into overlapping pieces that cover everything', () => {
  assert.equal(planSegments(800, 1200).length, 1);
  for (const [W, H] of [[800, 12000], [690, 30000], [1000, 2300], [700, 400000]]) {
    const segs = planSegments(W, H);
    assert.ok(segs.length > 1 && segs.length <= 24, `count for ${W}x${H}`);
    assert.equal(segs[0].y, 0);
    assert.equal(segs.at(-1).y + segs.at(-1).h, H);
    for (let i = 1; i < segs.length; i++) {
      const overlap = segs[i - 1].y + segs[i - 1].h - segs[i].y;
      assert.ok(overlap >= segs[i].h * 0.15, `overlap ${overlap}`);
      assert.equal(segs[i].cutT, true);
    }
    assert.equal(segs[0].cutT, false);
    assert.equal(segs.at(-1).cutB, false);
  }
  const wide = planSegments(5000, 800);
  assert.ok(wide.length > 1 && wide[0].cutR && !wide[0].cutT);
});

test('image headers give dimensions without decoding', () => {
  const png = new Uint8Array(32);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 44, 0, 0, 0, 200]);
  assert.deepEqual(sniffImageSize(png), { w: 300, h: 200, type: 'image/png' });
  const gif = new Uint8Array(32);
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x80, 0x02, 0xe0, 0x01]);
  assert.deepEqual(sniffImageSize(gif), { w: 640, h: 480, type: 'image/gif' });
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(14).fill(0), 0xff, 0xc0, 0, 17, 8, 0x03, 0x00, 0x04, 0x00, 3, ...new Array(20).fill(0)]);
  assert.deepEqual(sniffImageSize(jpg), { w: 1024, h: 768, type: 'image/jpeg' });
  assert.equal(sniffImageSize(new Uint8Array(40)), null);
});

test('fetch guard refuses private hosts unless the page is on that host', () => {
  for (const h of ['localhost', 'localhost.', 'LOCALHOST', '127.0.0.1', '10.1.2.3', '192.168.0.4', '172.20.1.1', '169.254.1.1',
    '[::1]', 'fd00::1', 'fe80::1', 'fe90::1', 'febf::1', '::ffff:7f00:1', 'printer.local', 'printer.local.', 'nas.home.arpa']) {
    assert.equal(isPrivateHost(h), true, h);
  }
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', 'cdn.site.io']) assert.equal(isPrivateHost(h), false, h);
  assert.throws(() => checkImageUrl('http://192.168.1.1/x.png', 'https://evil.com'));
  assert.throws(() => checkImageUrl('file:///etc/passwd', 'https://evil.com'));
  assert.throws(() => checkImageUrl('https://user:pw@cdn.com/x.png', 'https://evil.com'));
  assert.ok(checkImageUrl('http://127.0.0.1:8080/a.png', 'http://127.0.0.1:8080'));
  assert.ok(checkImageUrl('https://cdn.example.com/a.png', 'https://example.com'));
});

test('content-script messages are schema-checked', () => {
  assert.deepEqual(parseCsMessage({ t: 'job', id: 1, u: 'https://a.com/x.png', p: 0, l: 0 }), { t: 'job', id: 1, u: 'https://a.com/x.png', p: 0, l: 0 });
  assert.equal(parseCsMessage({ t: 'job', id: 1, u: 'javascript:alert(1)', p: 0, l: 0 }), null);
  assert.equal(parseCsMessage({ t: 'job', id: 1, u: 'blob:https://a.com/uuid', p: 0, l: 0 }), null);
  assert.ok(parseCsMessage({ t: 'job', id: 1, u: 'blob:https://a.com/uuid', p: 0, l: 1 }));
  assert.equal(parseCsMessage({ t: 'job', id: 0, u: 'https://a.com', p: 0, l: 0 }), null);
  assert.equal(parseCsMessage({ t: 'job', id: 1.5, u: 'https://a.com', p: 0, l: 0 }), null);
  assert.equal(parseCsMessage({ t: 'job', id: 1, u: 'https://a.com', p: 7, l: 0 }), null);
  assert.equal(parseCsMessage({ t: 'job', id: 1, u: 'https://a.com/' + 'x'.repeat(5000), p: 0, l: 0 }), null);
  assert.equal(parseCsMessage({ t: 'bytes', id: 2, b: 123 }), null);
  assert.deepEqual(parseCsMessage({ t: 'bytes', id: 2, b: null }), { t: 'bytes', id: 2, b: null });
  assert.equal(parseCsMessage({ t: 'setBudget', v: 1e9 }), null);
  assert.equal(parseCsMessage('job'), null);
  assert.deepEqual(parseUiMessage({ t: 'ui:cmd', tabId: 3, c: 'rescan' }), { t: 'ui:cmd', tabId: 3, c: 'rescan', v: false });
  assert.equal(parseUiMessage({ t: 'ui:cmd', tabId: 3, c: 'eval' }), null);
});

test('settings are sanitized: ranges, model ids, origins, api base, font', () => {
  const s = sanitize({
    rpm: 1e9, concurrency: -4, batch: '3', dailyBudget: 'abc', model: '../../evil', customModel: 'gemini/../x',
    lang: 'xx', sites: ['https://Example.com/path?q', 'javascript:alert(1)', 'https://example.com', 'ftp://x.y'],
    apiBase: 'https://evil.example.com/?steal=1', font: 'Arial;}body{display:none', sensitivity: 7,
  });
  assert.equal('apiBase' in s, false, 'the API endpoint is a constant, never a setting');
  assert.equal(s.rpm, 10000);
  assert.equal(s.concurrency, 1);
  assert.equal(s.batch, 3);
  assert.equal(s.dailyBudget, DEFAULTS.dailyBudget);
  assert.equal(s.model, DEFAULTS.model);
  assert.equal(s.customModel, '');
  assert.equal(s.lang, 'en');
  assert.deepEqual(s.sites, ['https://example.com']);
  assert.equal(s.font, 'Arialbodydisplaynone');
  assert.equal(s.sensitivity, 1);
  assert.equal(cleanOrigin('https://a.com:8443/x'), 'https://a.com:8443');
  assert.notEqual(resultSignature(sanitize({ lang: 'es' })), resultSignature(sanitize({ lang: 'fr' })));
  assert.equal(resolveModel(sanitize({ model: 'custom', customModel: 'gemini-2.5-flash' })).gen, 2);
  assert.equal(resolveModel(sanitize({ model: 'custom', customModel: 'gemini-3.8-flash' })).gen, 3);
});

test('settings: the text size is kept to 50–250%, in steps of 5%, and never changes cached results', () => {
  assert.equal(sanitize({}).textScale, 1);
  assert.equal(sanitize({ textScale: 1.5 }).textScale, 1.5);
  assert.equal(sanitize({ textScale: 1.53 }).textScale, 1.55);
  assert.equal(sanitize({ textScale: 9 }).textScale, 2.5);
  assert.equal(sanitize({ textScale: 0.1 }).textScale, 0.5);
  assert.equal(sanitize({ textScale: '2' }).textScale, 2);
  assert.equal(sanitize({ textScale: 'big' }).textScale, 1);
  assert.equal(sanitize({ textScale: NaN }).textScale, 1);
  assert.equal(resultSignature(sanitize({ textScale: 2 })), resultSignature(sanitize({ textScale: 0.7 })));
});

test('models: a default Google serves to new keys; unknown ones are budgeted at Flash prices', () => {
  assert.equal(DEFAULTS.model, 'gemini-3.5-flash-lite', '2.5 models are closed to new projects since Sep 2026');
  assert.equal(resolveModel(DEFAULTS).gen, 3);
  assert.equal(resolveModel(sanitize({ model: 'gemini-2.5-flash-lite' })).id, 'gemini-2.5-flash-lite', 'still selectable for keys that have it');
  const unknown = resolveModel(sanitize({ model: 'custom', customModel: 'gemini-3.8-flash' }));
  for (const m of Object.values(MODELS)) assert.ok(unknown.outUsd >= m.outUsd && unknown.inUsd >= m.inUsd);
  assert.equal(tierPreset('free').dailyRequests, 500);
  assert.equal(tierPreset('free').rpm, 15);
});

test('prompt names the target language and the batch layout', () => {
  const p1 = buildPrompt('Spanish', 1, false);
  assert.match(p1, /Spanish/);
  assert.doesNotMatch(p1, /"image"/);
  const p3 = buildPrompt('German', 3, true);
  assert.match(p3, /numbered 0 to 2/);
  assert.match(p3, /"original"/);
});

test('access to websites: a browser that shows no prompt, refuses or declines is told apart from one that grants', async () => {
  const saved = globalThis.chrome;
  /** @param {() => unknown} request */
  const ask = (request) => { globalThis.chrome = { permissions: { request } }; return requestAccess(50); };
  try {
    assert.equal(await ask(async () => true), '');
    assert.match(await ask(async () => false), /wasn’t granted/);
    assert.match(await ask(() => new Promise(() => {})), /no permission prompt/);
    assert.match(await ask(async () => { throw new Error('This function must be called during a user gesture'); }), /user gesture/);
    assert.match(await ask(() => { throw new Error('Not supported on this platform'); }), /Not supported/);
    assert.match(await ask(() => undefined), /wasn’t granted/);
  } finally {
    globalThis.chrome = saved;
  }
});

test('pages read one at a time: once two shown in a row count on by one, the next ones are known', () => {
  assert.ok(step('https://c.ex/m/12/007.jpg', 'https://c.ex/m/12/008.jpg') > 0);
  assert.ok(step('https://c.ex/m/12/9.webp', 'https://c.ex/m/12/10.webp') > 0);
  assert.ok(step('https://c.ex/img?ch=4&p=09', 'https://c.ex/img?ch=4&p=10') > 0);
  assert.equal(step('https://c.ex/m/12/007.jpg', 'https://c.ex/m/12/009.jpg'), -1, 'two pages on');
  assert.equal(step('https://c.ex/m/12/007.jpg', 'https://c.ex/m/13/008.jpg'), -1, 'two numbers changed');
  assert.equal(step('https://c.ex/a/7.jpg', 'https://c.ex/b/8.jpg'), -1, 'other text');
  assert.equal(step('https://c.ex/7.jpg', 'https://d.ex/8.jpg'), -1, 'another server');
  assert.equal(step('https://c.ex/9.jpg', 'https://c.ex/010.jpg'), -1, 'padding changed');
  assert.equal(step('https://c.ex/1x.jpg', 'blob:https://c.ex/2x'), -1);
  const k = step('https://c.ex/m/12/098.jpg', 'https://c.ex/m/12/099.jpg');
  assert.equal(onward('https://c.ex/m/12/099.jpg', k, 1), 'https://c.ex/m/12/100.jpg');
  const big = step('https://c.ex/9007199254740993.png', 'https://c.ex/9007199254740994.png');
  assert.equal(onward('https://c.ex/9007199254740994.png', big, 2), 'https://c.ex/9007199254740996.png');

  const seq = new Sequence();
  let t = 0;
  assert.deepEqual(seq.shown('https://site.ex', 'https://c.ex/ch/5/001.jpg', t += 1000), [], 'one page says nothing yet');
  assert.deepEqual(seq.shown('https://site.ex', 'https://c.ex/ch/5/002.jpg', t += 9000), ['https://c.ex/ch/5/003.jpg', 'https://c.ex/ch/5/004.jpg']);
  assert.deepEqual(seq.shown('https://site.ex', 'https://c.ex/ch/5/003.jpg', t += 9000), ['https://c.ex/ch/5/004.jpg', 'https://c.ex/ch/5/005.jpg']);
  assert.deepEqual(seq.shown('https://site.ex', 'https://c.ex/ch/5/003.jpg', t += 1000), ['https://c.ex/ch/5/004.jpg', 'https://c.ex/ch/5/005.jpg']);
  assert.deepEqual(seq.shown('https://other.ex', 'https://c.ex/ch/5/004.jpg', t += 1000), []);
  assert.deepEqual(seq.shown('https://gal.ex', 'https://i.gal.ex/ab12cd.jpg', t += 1000), []);
  assert.deepEqual(seq.shown('https://gal.ex', 'https://i.gal.ex/9f3e1a.jpg', t += 1000), []);
  assert.deepEqual(seq.shown('https://site.ex', 'https://c.ex/ch/5/005.jpg', t += 60 * 60_000), []);
});

test('pages a reader loads ahead: files beside the page shown, in its folder, of its kind', () => {
  assert.ok(sameFolder('https://up.ex/data/9f2c/2-a81f.png', 'https://up.ex/data/9f2c/1-77c2.png'));
  assert.ok(sameFolder('https://up.ex/data/9f2c/x.JPG?v=2', 'https://up.ex/data/9f2c/y.jpg'));
  assert.ok(!sameFolder('https://up.ex/data/9f2c/1-77c2.png', 'https://up.ex/data/9f2c/1-77c2.png'), 'the page itself');
  assert.ok(!sameFolder('https://up.ex/data/aaaa/2.png', 'https://up.ex/data/9f2c/1.png'), 'another chapter');
  assert.ok(!sameFolder('https://up.ex/data/9f2c/2.webp', 'https://up.ex/data/9f2c/1.png'), 'another kind of file');
  assert.ok(!sameFolder('https://ads.ex/data/9f2c/2.png', 'https://up.ex/data/9f2c/1.png'), 'another server');
  assert.ok(!sameFolder('https://up.ex/banner.png', 'https://up.ex/page.png'), 'the site\'s top folder: anything');
  assert.ok(!sameFolder('data:image/png;base64,AAAA', 'https://up.ex/data/9f2c/1.png'));
  const seq = new Sequence();
  seq.shown('https://site.ex', 'https://up.ex/data/9f2c/1-77c2.png', 1000);
  assert.deepEqual(seq.recent('https://site.ex', 2000), ['https://up.ex/data/9f2c/1-77c2.png']);
  assert.deepEqual(seq.recent('https://site.ex', 1000 + 60 * 60_000), [], 'forgotten after a while');
});

test('readers with an address per page: the page after this one, one on — or two, a two-page spread', () => {
  const ctx = vm.createContext({ URL, document: { referrer: '' }, location: { href: 'https://r.ex/read/12?page=2' } });
  vm.runInContext(readSource(new URL('../../content/nextpage.js', import.meta.url), 'utf8') + '\nglobalThis.NP = NextPage;', ctx);
  const { after, counted } = ctx.NP;
  assert.equal(after('https://r.ex/read/12?page=1', 'https://r.ex/read/12?page=2'), 1);
  assert.equal(after('https://r.ex/read/12?page=1', 'https://r.ex/read/12?page=3'), 2, 'two pages a view');
  assert.equal(after('https://r.ex/read/12?page=1', 'https://r.ex/read/12?page=5'), 0, 'a jump');
  assert.equal(after('https://r.ex/read/12/3', 'https://r.ex/read/12/4'), 1);
  assert.equal(after('https://g.ex/s/8f3a2c/1234-3', 'https://g.ex/s/c71e09/1234-4'), 1, 'a code that changes too');
  assert.equal(after('https://r.ex/read/12?page=2', 'https://r.ex/read/12?page=1'), 0, 'backwards');
  assert.equal(after('https://r.ex/read/12?page=1', 'https://x.ex/read/12?page=2'), 0, 'another site');
  assert.equal(after('https://r.ex/read/12?page=1', 'https://r.ex/read/12/x?page=2'), 0, 'deeper');
  assert.equal(after('', 'https://r.ex/read/12?page=2'), 0, 'opened on its own');
  assert.equal(counted('https://r.ex/read/12?page=2', 1), 'https://r.ex/read/12?page=3');
  assert.equal(counted('https://r.ex/read/12?page=3', 2), 'https://r.ex/read/12?page=5');
  assert.equal(counted('https://r.ex/read/12/p09', 1), 'https://r.ex/read/12/p10');
  assert.equal(counted('https://r.ex/read/12/p9', 1), 'https://r.ex/read/12/p10');
});
