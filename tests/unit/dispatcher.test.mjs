import test from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher } from '../../background/dispatcher.js';
import { usageSnapshot } from '../../background/usage.js';
import { sanitize } from '../../shared/settings.js';

const MODEL = { id: 'gemini-2.5-flash-lite', label: '', inUsd: 0.1, outUsd: 0.4, gen: 2 };
const cfg = { model: MODEL, langName: 'English', transcribe: false, economy: false };

function sse(text, finish = 'STOP') {
  const ev = (o) => `data: ${JSON.stringify(o)}\r\n\r\n`;
  return new Blob([
    ev({ candidates: [{ content: { parts: [{ text }] } }] }),
    ev({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: finish }], usageMetadata: { promptTokenCount: 1800, candidatesTokenCount: 40 } }),
  ]).stream();
}

const imagesOf = (init) => JSON.parse(init.body).contents[0].parts.filter((p) => p.inlineData).map((p) => p.inlineData.data);

function make(settings) {
  return new Dispatcher({ settings: () => settings, apiKey: async () => 'AIzaTEST_key_1234567890', onBlocked: () => {} });
}

/** @param {Dispatcher} d */
function job(d, label, origin, extra = {}) {
  const blocks = [];
  const onBlock = (/** @type {unknown} */ b) => { blocks.push(b); return true; };
  const p = d.submit({ b64: label, origin, sig: 's', cfg, prio: () => 0, cancelled: () => false, onBlock, ...extra });
  return { p, blocks };
}

test('a daily cap of 1 sends exactly one request, even with 6 free slots', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(sse('{"blocks":[]}'), { status: 200 }); };
  const d = make(sanitize({ concurrency: 6, batch: 1, rpm: 1000, dailyRequests: 1, dailyBudget: 0 }));
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => job(d, `I${i}`, 'https://a.com').p));
  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.err?.code === 'quota').length, 5);
});

test('sites take turns when priorities are equal', async () => {
  const order = [];
  globalThis.fetch = async (_u, init) => { order.push(...imagesOf(init)); return new Response(sse('{"blocks":[]}'), { status: 200 }); };
  const d = make(sanitize({ concurrency: 1, batch: 1, rpm: 1000, dailyRequests: 0, dailyBudget: 0 }));
  const all = [job(d, 'A1', 'https://a.com'), job(d, 'A2', 'https://a.com'), job(d, 'A3', 'https://a.com'), job(d, 'B1', 'https://b.com')];
  await Promise.all(all.map((j) => j.p));
  assert.ok(order.indexOf('B1') <= 1, `B waited behind all of A: ${order.join(',')}`);
});

test('only same-site images share a request', async () => {
  const batches = [];
  globalThis.fetch = async (_u, init) => { batches.push(imagesOf(init)); return new Response(sse('{"blocks":[]}'), { status: 200 }); };
  const d = make(sanitize({ concurrency: 1, batch: 3, rpm: 1000, dailyRequests: 0, dailyBudget: 0 }));
  const all = [job(d, 'A0', 'https://a.com'), job(d, 'A1', 'https://a.com'), job(d, 'B1', 'https://b.com'), job(d, 'A2', 'https://a.com')];
  await Promise.all(all.map((j) => j.p));
  for (const b of batches) assert.equal(new Set(b.map((x) => x[0])).size, 1, `mixed sites in one request: ${b}`);
});

const FREE = { rpm: 1000, dailyRequests: 0, dailyBudget: 0 };
const STUCK = '{"blocks":[{"box_2d":[1,2,3,4],"translation":"ok"},{"box_2d":[5,6,7,8],"translation":"' + 'ド'.repeat(600);

test('an answer stuck in a loop gets one hotter retry, then keeps what arrived', async () => {
  const temps = [];
  globalThis.fetch = async (_u, init) => {
    temps.push(JSON.parse(init.body).generationConfig.temperature);
    return new Response(sse(STUCK, 'MAX_TOKENS'), { status: 200 });
  };
  const d = make(sanitize({ concurrency: 1, batch: 1, ...FREE }));
  const j = job(d, 'A0', 'https://a.com');
  const r = await j.p;
  assert.deepEqual(temps, [0.2, 0.8]);
  assert.equal(r.err, null, 'the block that did arrive is kept');
  assert.equal(r.partial, true, 'and marked incomplete');
});

test('an answer that merely ran out of room is kept, not paid for twice', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(sse('{"blocks":[{"box_2d":[1,2,3,4],"translation":"ok"},{"box_2d":[5,6', 'MAX_TOKENS'), { status: 200 });
  };
  const d = make(sanitize({ concurrency: 1, batch: 1, ...FREE }));
  const r = await job(d, 'A0', 'https://a.com').p;
  assert.equal(calls, 1);
  assert.equal(r.err, null);
  assert.equal(r.partial, true);
});

test('an image with no usable answer fails with the reason, after one retry', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(sse('', 'OTHER'), { status: 200 }); };
  const d = make(sanitize({ concurrency: 1, batch: 1, ...FREE }));
  const r = await job(d, 'A0', 'https://a.com').p;
  assert.equal(calls, 2);
  assert.equal(r.err?.code, 'model');
  assert.match(r.err?.message ?? '', /OTHER/);
});

test('blocks the page rejects don\'t count as usable', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(sse('{"blocks":[{"box_2d":[1,2,3,4],"translation":""},', 'MAX_TOKENS'), { status: 200 }); };
  const d = make(sanitize({ concurrency: 1, batch: 1, ...FREE }));
  const r = await job(d, 'A0', 'https://a.com', { onBlock: () => false }).p;
  assert.equal(calls, 2, 'nothing usable came, so it was worth one more try');
  assert.equal(r.err?.code, 'model', 'and is not cached as "no text"');
});

test('the extra try runs alone and hot, even with same-site images waiting', async () => {
  const sent = [];
  globalThis.fetch = async (_u, init) => {
    const imgs = imagesOf(init);
    const temp = JSON.parse(init.body).generationConfig.temperature;
    sent.push(`${imgs.join('+')}@${temp}`);
    if (imgs.includes('BAD') && temp < 0.5) return new Response(sse(STUCK), { status: 200 });
    const blocks = imgs.map((_, i) => ({ ...(imgs.length > 1 ? { image: i } : {}), box_2d: [1, 2, 3, 4], translation: 'ok' }));
    return new Response(sse(JSON.stringify({ blocks })), { status: 200 });
  };
  const d = make(sanitize({ concurrency: 1, batch: 3, ...FREE }));
  const all = [job(d, 'BAD', 'https://a.com'), job(d, 'B1', 'https://a.com'), job(d, 'B2', 'https://a.com')];
  const rs = await Promise.all(all.map((j) => j.p));
  assert.deepEqual(sent, ['BAD@0.2', 'BAD@0.8', 'B1+B2@0.2']);
  assert.ok(rs.every((r) => r.err === null));
});

test('a shared request one image gets refused is split, so the others still translate', async () => {
  globalThis.fetch = async (_u, init) => {
    const imgs = imagesOf(init);
    if (imgs.includes('NSFW')) {
      return new Response(new Blob([`data: ${JSON.stringify({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } })}\n\n`]).stream(), { status: 200 });
    }
    const blocks = imgs.map((_, i) => ({ ...(imgs.length > 1 ? { image: i } : {}), box_2d: [1, 2, 3, 4], translation: 'ok' }));
    return new Response(sse(JSON.stringify({ blocks })), { status: 200 });
  };
  const d = make(sanitize({ concurrency: 1, batch: 3, ...FREE }));
  const first = job(d, 'A0', 'https://a.com');
  const all = [job(d, 'OK1', 'https://a.com'), job(d, 'NSFW', 'https://a.com'), job(d, 'OK2', 'https://a.com')];
  const [r1, bad, r2] = await Promise.all(all.map((j) => j.p));
  await first.p;
  assert.equal(r1.err, null);
  assert.equal(r2.err, null);
  assert.equal(bad.err?.code, 'blocked');
});

test('a retry whose page went away keeps the blocks already paid for', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(sse(STUCK), { status: 200 }); };
  const d = make(sanitize({ concurrency: 1, batch: 1, ...FREE }));
  let gone = false;
  const r = await job(d, 'A0', 'https://a.com', { cancelled: () => gone, onBlock: () => { gone = true; return true; } }).p;
  assert.equal(calls, 1);
  assert.equal(r.err, null);
  assert.equal(r.partial, true);
});

test('once Google says it won\'t serve the model, queued images fail without more requests', async () => {
  let calls = 0;
  const msg = 'This model models/gemini-2.5-flash-lite is no longer available to new users.';
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { code: 404, message: msg } }), { status: 404 }); };
  const d = make(sanitize({ concurrency: 1, batch: 1, ...FREE }));
  const rs = await Promise.all(['A', 'B', 'C', 'D'].map((x) => job(d, x, 'https://a.com').p));
  assert.equal(calls, 1);
  assert.ok(rs.every((r) => r.err?.code === 'nomodel' && r.err.message === msg));
  d.reviveModels();
  globalThis.fetch = async () => { calls++; return new Response(sse('{"blocks":[]}'), { status: 200 }); };
  assert.equal((await job(d, 'E', 'https://a.com').p).err, null);
  assert.equal(calls, 2);
});

test('near the spending cap, images wait for requests in flight instead of failing', async () => {
  let active = 0;
  let most = 0;
  globalThis.fetch = async () => {
    most = Math.max(most, ++active);
    await new Promise((res) => setTimeout(res, 20));
    active--;
    return new Response(sse('{"blocks":[]}'), { status: 200 });
  };
  const s = sanitize({ concurrency: 3, batch: 1, rpm: 1000, dailyRequests: 0, dailyBudget: usageSnapshot().cost + 0.003 });
  const d = make(s);
  const rs = await Promise.all(['A', 'B', 'C'].map((x) => job(d, x, 'https://a.com').p));
  assert.equal(most, 1, 'the cap held');
  assert.ok(rs.every((r) => r.err === null), JSON.stringify(rs.map((r) => r.err?.code)));
});

test('a cut-off shared answer is retried per image and stays marked as shared', async () => {
  let n = 0;
  globalThis.fetch = async (_u, init) => {
    n++;
    const imgs = imagesOf(init);
    if (imgs.length > 1) return new Response(sse('{"blocks":[{"image":0,"box_2d":[1,2,3,4],"translation":"x"}', 'MAX_TOKENS'), { status: 200 });
    return new Response(sse('{"blocks":[{"box_2d":[1,2,3,4],"translation":"ok"}]}'), { status: 200 });
  };
  const d = make(sanitize({ concurrency: 1, batch: 2, rpm: 1000, dailyRequests: 0, dailyBudget: 0 }));
  const first = job(d, 'A0', 'https://a.com');
  const a = job(d, 'A1', 'https://a.com');
  const b = job(d, 'A2', 'https://a.com');
  const [r0, r1, r2] = await Promise.all([first.p, a.p, b.p]);
  assert.equal(r0.batched, false);
  assert.equal(r1.err, null);
  assert.equal(r1.batched, true, 'blocks from the shared attempt must not reach the cross-site cache');
  assert.equal(r2.batched, true);
  assert.ok(n >= 4);
});

test('on-screen images go out one per request while there is room for each', async () => {
  const batches = [];
  globalThis.fetch = async (_u, init) => { batches.push(imagesOf(init)); return new Response(sse('{"blocks":[]}'), { status: 200 }); };
  const d = make(sanitize({ concurrency: 4, batch: 3, rpm: 15, dailyRequests: 0, dailyBudget: 0 }));
  const all = ['V0', 'V1', 'V2'].map((l) => job(d, l, 'https://a.com'));
  await Promise.all(all.map((j) => j.p));
  assert.deepEqual(batches.map((b) => b.length), [1, 1, 1]);
});

test('a backlog beyond the requests that can go now shares them, as few to each as will do', async () => {
  const batches = [];
  globalThis.fetch = async (_u, init) => { batches.push(imagesOf(init)); return new Response(sse('{"blocks":[]}'), { status: 200 }); };
  const d = make(sanitize({ concurrency: 2, batch: 3, rpm: 1000, dailyRequests: 0, dailyBudget: 0 }));
  const all = Array.from({ length: 7 }, (_, i) => job(d, `A${i}`, 'https://a.com'));
  await Promise.all(all.map((j) => j.p));
  assert.deepEqual(batches.map((b) => b.length), [1, 1, 3, 2]);
});

function stalled(init, onAbort) {
  return new Response(new ReadableStream({
    start(c) { init.signal.addEventListener('abort', () => { onAbort(); c.error(new DOMException('aborted', 'AbortError')); }); },
  }), { status: 200 });
}

test('a request Gemini sits on is sent once more, and the first to answer is kept', async () => {
  let calls = 0;
  const cancelled = [];
  globalThis.fetch = async (_u, init) => {
    const k = calls++;
    if (k === 0) return stalled(init, () => cancelled.push(k));
    return new Response(sse('{"blocks":[{"box_2d":[1,2,3,4],"translation":"quick"}]}'), { status: 200 });
  };
  const d = make(sanitize({ concurrency: 2, batch: 1, rpm: 15, dailyRequests: 0, dailyBudget: 0 }));
  d.hedgeDelay = () => 50;
  const j = job(d, 'A0', 'https://a.com');
  const r = await j.p;
  assert.equal(r.err, null);
  assert.equal(calls, 2);
  assert.deepEqual(cancelled, [0], 'the copy that sat there is cancelled');
  assert.equal(j.blocks.length, 1, 'blocks come from one answer only');
  assert.equal(d.status().slow, true);
});

test('no second copy when the answer starts in time, or the minute\'s allowance is used up', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(sse('{"blocks":[]}'), { status: 200 }); };
  const d = make(sanitize({ concurrency: 1, batch: 1, rpm: 15, dailyRequests: 0, dailyBudget: 0 }));
  d.hedgeDelay = () => 400;
  await job(d, 'A0', 'https://a.com').p;
  assert.equal(calls, 1);
  let n = 0;
  const cancelled = [];
  globalThis.fetch = async (_u, init) => {
    if (n++ === 0) {
      return new Response(new ReadableStream({
        start(c) {
          const t = setTimeout(() => { c.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"{\\"blocks\\":[]}"}]},"finishReason":"STOP"}]}\r\n\r\n')); c.close(); }, 300);
          init.signal.addEventListener('abort', () => { clearTimeout(t); cancelled.push(0); c.error(new DOMException('aborted', 'AbortError')); });
        },
      }), { status: 200 });
    }
    return new Response(sse('{"blocks":[]}'), { status: 200 });
  };
  const e = make(sanitize({ concurrency: 1, batch: 1, rpm: 1, dailyRequests: 0, dailyBudget: 0 }));
  e.hedgeDelay = () => 50;
  const r = await job(e, 'B0', 'https://b.com').p;
  assert.equal(r.err, null);
  assert.equal(n, 1, 'no room this minute: not sent twice');
  assert.deepEqual(cancelled, []);
});

/** @param {Array<{quotaId: string, quotaValue: string}>} violations @param {string} delay */
function tooMany(violations, delay) {
  return new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota.', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay },
  ] } }), { status: 429, headers: { 'content-type': 'application/json' } });
}

test('a 429 naming the per-minute limit: from then on the queue paces at that limit', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    if (calls++ === 0) return tooMany([{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '5' }], '0.05s');
    return new Response(sse('{"blocks":[]}'), { status: 200 });
  };
  const d = make(sanitize({ concurrency: 1, batch: 1, rpm: 15, dailyRequests: 0, dailyBudget: 0 }));
  const r = await job(d, 'A0', 'https://a.com').p;
  assert.equal(r.err, null, 'retried after the pause');
  assert.equal(calls, 2);
  assert.equal(d.limiter.cap, 5);
  assert.ok(d.limiter.rpm() <= 5);
});

test('a 429 for today\'s allowance is reported, not retried every minute', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return tooMany([{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '500' }], '20s'); };
  const d = make(sanitize({ concurrency: 1, batch: 1, rpm: 15, dailyRequests: 0, dailyBudget: 0 }));
  const r = await job(d, 'A0', 'https://a.com').p;
  assert.equal(r.err?.code, 'quota');
  assert.equal(calls, 1);
});

test('pages arriving faster than the allowance can serve one by one share requests, a lone one waits a moment', async () => {
  const batches = [];
  globalThis.fetch = async (_u, init) => { batches.push(imagesOf(init)); return new Response(sse('{"blocks":[]}'), { status: 200 }); };
  const d = make(sanitize({ concurrency: 4, batch: 3, rpm: 15, dailyRequests: 0, dailyBudget: 0 }));
  const all = [];
  for (let i = 0; i < 12; i++) {
    all.push(new Promise((res) => setTimeout(() => res(job(d, `P${i}`, 'https://a.com', { prio: () => 1 }).p), i * 150)));
  }
  await Promise.all((await Promise.all(all)));
  assert.ok(batches.length <= 6, `${batches.length} requests for 12 pages: ${JSON.stringify(batches.map((b) => b.length))}`);
  assert.ok(batches.flat().length === 12);
});

test('with allowance to spare, pages ahead still go one per request', async () => {
  const batches = [];
  globalThis.fetch = async (_u, init) => { batches.push(imagesOf(init)); return new Response(sse('{"blocks":[]}'), { status: 200 }); };
  const d = make(sanitize({ concurrency: 4, batch: 3, rpm: 15, dailyRequests: 0, dailyBudget: 0 }));
  const all = [job(d, 'A0', 'https://a.com', { prio: () => 1 })];
  await new Promise((r) => setTimeout(r, 300));
  all.push(job(d, 'A1', 'https://a.com', { prio: () => 1 }));
  await Promise.all(all.map((j) => j.p));
  assert.deepEqual(batches.map((b) => b.length), [1, 1]);
});

test('second copies count against "requests at the same time"', async () => {
  let calls = 0;
  const cancelled = [];
  globalThis.fetch = async (_u, init) => {
    const k = calls++;
    if (k === 0) {
      return new Response(new ReadableStream({
        start(c) {
          const t = setTimeout(() => { c.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"{\\"blocks\\":[]}"}]},"finishReason":"STOP"}]}\r\n\r\n')); c.close(); }, 250);
          init.signal.addEventListener('abort', () => { clearTimeout(t); cancelled.push(k); c.error(new DOMException('aborted', 'AbortError')); });
        },
      }), { status: 200 });
    }
    return new Response(sse('{"blocks":[]}'), { status: 200 });
  };
  const d = make(sanitize({ concurrency: 1, batch: 1, rpm: 15, dailyRequests: 0, dailyBudget: 0 }));
  d.hedgeDelay = () => 50;
  const r = await job(d, 'A0', 'https://a.com').p;
  assert.equal(r.err, null);
  assert.equal(calls, 1, 'one request at a time: no copy');
});

test('no second copy for images nobody is waiting for any more', async () => {
  let calls = 0;
  let gone = false;
  globalThis.fetch = async (_u, init) => {
    const k = calls++;
    if (k === 0) {
      return new Response(new ReadableStream({
        start(c) {
          const t = setTimeout(() => { c.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"{\\"blocks\\":[]}"}]},"finishReason":"STOP"}]}\r\n\r\n')); c.close(); }, 250);
          init.signal.addEventListener('abort', () => { clearTimeout(t); c.error(new DOMException('aborted', 'AbortError')); });
        },
      }), { status: 200 });
    }
    return new Response(sse('{"blocks":[]}'), { status: 200 });
  };
  const d = make(sanitize({ concurrency: 4, batch: 1, rpm: 15, dailyRequests: 0, dailyBudget: 0 }));
  d.hedgeDelay = () => 60;
  const j = job(d, 'A0', 'https://a.com', { cancelled: () => gone });
  setTimeout(() => { gone = true; }, 20);
  await j.p;
  assert.equal(calls, 1);
});

test('near the daily cap, a cancelled second copy releasing its reservation lets the queue go on', async () => {
  let calls = 0;
  globalThis.fetch = async (_u, init) => {
    const k = calls++;
    if (k === 0) {
      return new Response(new ReadableStream({
        start(c) {
          setTimeout(() => { c.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"{\\"blocks\\":[{\\"box_2d\\":[1,2,3,4],\\"translation\\":\\"ok\\"}]}"}]},"finishReason":"STOP"}]}\r\n\r\n')); c.close(); }, 150);
        },
      }), { status: 200 });
    }
    if (k === 1) {
      return new Promise((_res, rej) => init.signal.addEventListener('abort', () => setTimeout(() => rej(new DOMException('aborted', 'AbortError')), 5)));
    }
    return new Response(sse('{"blocks":[{"box_2d":[1,2,3,4],"translation":"b"}]}'), { status: 200 });
  };
  const used = usageSnapshot().req;
  const d = make(sanitize({ concurrency: 3, batch: 1, rpm: 15, dailyRequests: used + 2, dailyBudget: 0 }));
  d.hedgeDelay = () => 50;
  const a = job(d, 'A', 'https://a.com');
  await new Promise((r) => setTimeout(r, 100));
  const b = job(d, 'B', 'https://a.com');
  const timeout = new Promise((r) => setTimeout(() => r('stuck'), 3000));
  assert.equal((await a.p).err, null);
  const rb = await Promise.race([b.p, timeout]);
  assert.notEqual(rb, 'stuck', 'the queue stalled');
  assert.equal(rb.err, null);
});

test('a model, key or plan change forgets the per-minute limit Google reported', () => {
  const d = make(sanitize({ concurrency: 1, batch: 1, rpm: 15, dailyRequests: 0, dailyBudget: 0 }));
  d.limiter.learn(5);
  d.limiter.onRateLimited(Date.now(), 10);
  assert.ok(d.limiter.rpm() <= 5);
  d.limitsChanged();
  assert.equal(d.limiter.rpm(), 15);
});

test('a 429 with a limit of 0 (the plan has no allowance for this model) is reported, not retried', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return tooMany([{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '0' }], '0.01s'); };
  const d = make(sanitize({ concurrency: 1, batch: 1, rpm: 15, dailyRequests: 0, dailyBudget: 0 }));
  const r = await job(d, 'A0', 'https://a.com').p;
  assert.equal(r.err?.code, 'quota');
  assert.equal(calls, 1);
});

test('a pause after a network error isn\'t reported as Google asking to slow down', () => {
  const d = make(sanitize({ concurrency: 1, batch: 1, rpm: 15, dailyRequests: 0, dailyBudget: 0 }));
  d.queue.push({ prio: () => 0 });
  d.limiter.pause(Date.now() + 5000, 'net');
  assert.equal(d.status().limited, false);
  d.limiter.onRateLimited(Date.now(), 20_000);
  assert.equal(d.status().limited, true);
  d.queue.length = 0;
});

test('a request for a page on screen is asked again sooner than one for a page ahead', () => {
  const d = make(sanitize({ concurrency: 4, batch: 3, rpm: 15, dailyRequests: 0, dailyBudget: 0 }));
  assert.equal(d.hedgeDelay(MODEL.id, 1, true), 3500);
  assert.equal(d.hedgeDelay(MODEL.id, 1, false), 6000);
  for (let i = 0; i < 6; i++) d.noteFirstText(MODEL.id, 800);
  assert.equal(d.hedgeDelay(MODEL.id, 1, true), 2500);
  assert.equal(d.hedgeDelay(MODEL.id, 1, false), 4000);
  for (let i = 0; i < 15; i++) d.noteFirstText(MODEL.id, 3000);
  assert.equal(d.hedgeDelay(MODEL.id, 1, true), 6000);
  assert.equal(d.hedgeDelay(MODEL.id, 1, false), 7500);
  assert.equal(d.hedgeDelay(MODEL.id, 3, false), 11_250);
  assert.equal(d.hedgeDelay(MODEL.id, 5, false), 12_000);
});

test('a job hears when its request goes out: at once with a free slot, later when queued', async () => {
  /** @type {() => void} */
  let release = () => {};
  globalThis.fetch = async () => {
    await new Promise((r) => { release = r; });
    return new Response(sse('{"blocks":[]}'), { status: 200 });
  };
  const d = make(sanitize({ concurrency: 1, batch: 1, ...FREE }));
  const sent = [];
  const a = job(d, 'A0', 'https://a.com', { sent: () => sent.push('A0') });
  assert.deepEqual(sent, ['A0'], 'went out within submit()');
  const b = job(d, 'A1', 'https://a.com', { sent: () => sent.push('A1') });
  assert.deepEqual(sent, ['A0'], 'queued behind the only slot: not yet');
  while (sent.length < 2) { release(); await new Promise((r) => setTimeout(r, 5)); }
  release();
  await Promise.all([a.p, b.p]);
  assert.deepEqual(sent, ['A0', 'A1']);
});

test('pages ahead leave the last free request for a page coming on screen', async () => {
  const sent = [];
  /** @type {(() => void)[]} */
  const finish = [];
  globalThis.fetch = async (_u, init) => {
    sent.push(...imagesOf(init));
    await new Promise((r) => finish.push(r));
    return new Response(sse('{"blocks":[]}'), { status: 200 });
  };
  const d = make(sanitize({ concurrency: 3, batch: 1, rpm: 1000, dailyRequests: 0, dailyBudget: 0 }));
  const ahead = ['A1', 'A2', 'A3', 'A4'].map((l) => job(d, l, 'https://a.com', { prio: () => 1 }));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(sent, ['A1', 'A2'], 'pages ahead take all requests but one');
  const shown = job(d, 'S', 'https://a.com');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(sent, ['A1', 'A2', 'S'], 'the page on screen goes at once');
  while (finish.length || sent.length < 5) { finish.shift()?.(); await new Promise((r) => setTimeout(r, 10)); }
  await Promise.all([...ahead, shown].map((j) => j.p));
  assert.equal(sent.length, 5);
});
