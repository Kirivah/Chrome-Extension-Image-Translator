import test from 'node:test';
import assert from 'node:assert/strict';
import { streamTranslate, looping, testKey } from '../../background/gemini.js';

const MODEL = { id: 'gemini-2.5-flash-lite', label: '', inUsd: 0.1, outUsd: 0.4, gen: 2 };

function sse(chunks, { usage = { promptTokenCount: 1600, candidatesTokenCount: 120 }, split = 7 } = {}) {
  const text = chunks.join('');
  const events = [];
  for (let i = 0; i < text.length; i += split) {
    events.push(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: text.slice(i, i + split) }] } }] })}\r\n\r\n`);
  }
  events.push(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata: usage })}\r\n\r\n`);
  const enc = new TextEncoder();
  const all = enc.encode(events.join(''));
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < all.length; i += 13) c.enqueue(all.slice(i, i + 13));
      c.close();
    },
  });
}

function req(over = {}) {
  const blocks = [];
  return {
    blocks,
    o: {
      apiBase: 'https://gen.test', apiKey: 'AIzaTESTKEY_1234567890abcdef', model: MODEL, images: ['AAAA'],
      langName: 'English', transcribe: false, economy: false, signal: new AbortController().signal,
      onBlock: (b) => blocks.push(b), ...over,
    },
  };
}

test('streams blocks out of SSE as they complete and reports token usage', async () => {
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(sse(['{"blocks":[', '{"box_2d":[10,20,30,40],"translation":"Hello"},', '{"box_2d":[50,60,70,80],"translation":"World"}', ']}']), { status: 200 });
  };
  const { o, blocks } = req();
  const r = await streamTranslate(o);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].translation, 'World');
  assert.equal(r.inTok, 1600);
  assert.equal(r.outTok, 120);
  const sent = bodies[0];
  assert.match(sent.url, /\/v1beta\/models\/gemini-2\.5-flash-lite:streamGenerateContent\?alt=sse$/);
  assert.equal(sent.init.headers['x-goog-api-key'], 'AIzaTESTKEY_1234567890abcdef');
  assert.equal(sent.init.credentials, 'omit');
  assert.equal(sent.body.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(sent.body.generationConfig.responseMimeType, 'application/json');
  assert.ok(sent.body.generationConfig.responseJsonSchema.properties.blocks);
  assert.ok(sent.body.contents[0].parts[0].inlineData, 'image goes before the prompt');
});

test('gemini 3 models get thinkingLevel minimal and no temperature', async () => {
  let body;
  globalThis.fetch = async (_u, init) => { body = JSON.parse(init.body); return new Response(sse(['{"blocks":[]}']), { status: 200 }); };
  const { o } = req({ model: { ...MODEL, id: 'gemini-3.5-flash-lite', gen: 3 }, images: ['AA', 'BB'] });
  await streamTranslate(o);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
  assert.equal(body.generationConfig.temperature, undefined);
  assert.equal(body.contents[0].parts[0].text, 'Image 0:');
  assert.ok(body.generationConfig.responseJsonSchema.properties.blocks.items.properties.image);
});

test('429 carries the server retry delay; bad key maps to auth', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 429, message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }] } }), { status: 429 });
  await assert.rejects(streamTranslate(req().o), (e) => e.code === 'quota' && e.retryMs === 12000);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }), { status: 400 });
  await assert.rejects(streamTranslate(req().o), (e) => e.code === 'auth');
});

test('a 400 that persists without the optional fields is reported, and the fields stay on', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: 400, message: 'Request contains an invalid argument.' } }), { status: 400 });
  };
  await assert.rejects(streamTranslate(req().o), (e) => e.code === 'model' && /invalid argument/.test(e.message));
  assert.equal(calls, 3, 'one retry per optional field sent (schema, then thinking), then give up');
  let body;
  globalThis.fetch = async (_u, init) => { body = JSON.parse(init.body); return new Response(sse(['{"blocks":[]}']), { status: 200 }); };
  await streamTranslate(req().o);
  assert.ok(body.generationConfig.responseJsonSchema, 'schema still sent');
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0, 'thinking still off');
});

test('an error inside the answer is never re-sent (it may already be billed)', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    const ev = (o) => `data: ${JSON.stringify(o)}\n\n`;
    return new Response(new Blob([
      ev({ candidates: [{ content: { parts: [{ text: '{"blocks":[{"box_2d":[1,2,3,4],"translation":"ok"},' }] } }] }),
      ev({ error: { code: 400, message: 'Request contains an invalid argument.' } }),
    ]).stream(), { status: 200 });
  };
  await assert.rejects(streamTranslate(req().o), (e) => e.code === 'model' && /invalid argument/.test(e.message));
  assert.equal(calls, 1);
});

test('a whole answer counts as finished even without Google saying so', async () => {
  const whole = '{"blocks":[{"box_2d":[1,2,3,4],"translation":"ok"}]}';
  globalThis.fetch = async () => new Response(new Blob([`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: whole }] } }] })}\n\n`]).stream(), { status: 200 });
  assert.equal((await streamTranslate(req().o)).finish, 'STOP');
  globalThis.fetch = async () => {
    const enc = new TextEncoder();
    let sent = false;
    return new Response(new ReadableStream({
      pull(c) {
        if (!sent) { sent = true; c.enqueue(enc.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: whole }] } }] })}\n\n`)); return; }
        c.error(new TypeError('network error'));
      },
    }), { status: 200 });
  };
  assert.equal((await streamTranslate(req().o)).finish, 'STOP');
  globalThis.fetch = async () => {
    const enc = new TextEncoder();
    let sent = false;
    return new Response(new ReadableStream({
      pull(c) {
        if (!sent) { sent = true; c.enqueue(enc.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"blocks":[' }] } }] })}\n\n`)); return; }
        c.error(new TypeError('network error'));
      },
    }), { status: 200 });
  };
  await assert.rejects(streamTranslate(req().o), (e) => e.code === 'net');
});

test('an API that rejects responseJsonSchema is retried once without it', async () => {
  let calls = 0;
  let last;
  globalThis.fetch = async (_u, init) => {
    calls++;
    last = JSON.parse(init.body);
    if (last.generationConfig.responseJsonSchema) {
      return new Response(JSON.stringify({ error: { code: 400, message: 'Invalid JSON payload received. Unknown name "responseJsonSchema"' } }), { status: 400 });
    }
    return new Response(sse(['[{"box_2d":[1,2,3,4],"translation":"ok"}]']), { status: 200 });
  };
  const { o, blocks } = req();
  await streamTranslate(o);
  assert.equal(calls, 2);
  assert.equal(last.generationConfig.responseJsonSchema, undefined);
  assert.equal(blocks.length, 1);
});

test('a field Google names is left off afterwards — for that model only', async () => {
  const bodies = [];
  globalThis.fetch = async (_u, init) => { bodies.push(JSON.parse(init.body)); return new Response(sse(['{"blocks":[]}']), { status: 200 }); };
  await streamTranslate(req().o);
  await streamTranslate(req({ model: { ...MODEL, id: 'gemini-3.5-flash-lite', gen: 3 } }).o);
  assert.equal(bodies[0].generationConfig.responseJsonSchema, undefined, 'learned for 2.5 Flash-Lite');
  assert.ok(bodies[1].generationConfig.responseJsonSchema, 'another model still gets the schema');
  assert.equal(bodies[1].generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
});

test('a generic 400 ("invalid argument") is retried without the newer request fields', async () => {
  const bodies = [];
  globalThis.fetch = async (_u, init) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    if (b.generationConfig.thinkingConfig || b.generationConfig.responseJsonSchema) {
      return new Response(JSON.stringify({ error: { code: 400, message: 'Request contains an invalid argument.' } }), { status: 400 });
    }
    return new Response(sse(['{"blocks":[{"box_2d":[1,2,3,4],"translation":"ok"}]}']), { status: 200 });
  };
  const { o, blocks } = req();
  const r = await streamTranslate(o);
  assert.equal(r.finish, 'STOP');
  assert.ok(bodies.length >= 2 && bodies.length <= 4, `calls=${bodies.length}`);
  assert.equal(blocks.length, 1);
  const before = bodies.length;
  await streamTranslate(req().o);
  assert.equal(bodies[before].generationConfig.thinkingConfig?.thinkingBudget, 0, 'thinking setting not dropped for good');
});

test('400s that are clearly not about request fields fail at once, with the reason', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { code: 400, message: 'Unable to process input image.' } }), { status: 400 }); };
  await assert.rejects(streamTranslate(req().o), (e) => e.code === 'model' && /input image/.test(e.message));
  assert.equal(calls, 1);
});

test('a runaway (repeating) answer is cut off early and reported as truncated', async () => {
  globalThis.fetch = async () => {
    const enc = new TextEncoder();
    let i = 0;
    return new Response(new ReadableStream({
      pull(c) {
        const text = i++ === 0 ? '{"blocks":[{"box_2d":[1,2,3,4],"translation":"AAAA' : 'A'.repeat(500);
        c.enqueue(enc.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\r\n\r\n`));
        if (i > 200) c.close();
      },
    }), { status: 200 });
  };
  const meter = { started: false, inTok: 0, outTok: 0, chars: 0 };
  const r = await streamTranslate(req({ meter }).o);
  assert.equal(r.finish, 'LOOP');
  assert.ok(meter.chars < 2_000, `kept reading: ${meter.chars}`);
});

test('padding after a complete answer is not waited for, and a whole answer counts as finished', async () => {
  const blocks = [];
  globalThis.fetch = async () => {
    const enc = new TextEncoder();
    let i = 0;
    return new Response(new ReadableStream({
      pull(c) {
        const text = i++ === 0 ? '{"blocks":[{"box_2d":[1,2,3,4],"translation":"ok"}]}' : '\n'.repeat(100);
        c.enqueue(enc.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\r\n\r\n`));
        if (i > 500) c.close();
      },
    }), { status: 200 });
  };
  const meter = { started: false, inTok: 0, outTok: 0, chars: 0 };
  const r = await streamTranslate(req({ meter, onBlock: (b) => blocks.push(b) }).o);
  assert.equal(r.finish, 'STOP');
  assert.equal(blocks.length, 1);
  assert.ok(meter.chars < 1_000, `kept reading: ${meter.chars}`);

  globalThis.fetch = async () => {
    const ev = (o) => `data: ${JSON.stringify(o)}\n\n`;
    return new Response(new Blob([
      ev({ candidates: [{ content: { parts: [{ text: '{"blocks":[]}' }] } }] }),
      ev({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'MAX_TOKENS' }] }),
    ]).stream(), { status: 200 });
  };
  assert.equal((await streamTranslate(req().o)).finish, 'STOP');
});

test('loop detection: long repeats of a short unit, not ordinary text', () => {
  const entry = '{"box_2d":[100,200,150,300],"translation":"Wait for me!"},';
  assert.equal(looping('{"blocks":[' + 'ド'.repeat(450)), true);
  assert.equal(looping('{"blocks":[' + entry.repeat(9)), true);
  assert.equal(looping('ok' + ' \n'.repeat(260)), true);
  assert.equal(looping('ド'.repeat(300)), false, 'too short to call');
  let varied = '{"blocks":[';
  for (let k = 0; k < 20; k++) varied += `{"box_2d":[${100 + k * 37},200,${150 + k * 37},300],"translation":"Line number ${k} of the page."},`;
  assert.equal(looping(varied), false);
  let seed = 7;
  const prose = Array.from({ length: 1000 }, () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return 'abcdefghij '[Math.floor(seed / 65536) % 11];
  }).join('');
  assert.equal(looping('Ha'.repeat(20) + prose), false);
});

test('safety blocks surface as "blocked"', async () => {
  globalThis.fetch = async () => {
    const ev = `data: ${JSON.stringify({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } })}\n\n`;
    return new Response(new Blob([ev]).stream(), { status: 200 });
  };
  await assert.rejects(streamTranslate(req().o), (e) => e.code === 'blocked');
});

const RETIRED = 'This model models/gemini-2.5-flash-lite is no longer available to new users. Please update your code to use models/gemini-3.5-flash-lite for the latest features and improvements.';

test('a model Google no longer offers to the key is its own error, with Google\'s words', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { code: 404, message: RETIRED, status: 'NOT_FOUND' } }), { status: 404 }); };
  await assert.rejects(streamTranslate(req().o), (e) => e.code === 'nomodel' && e.message === RETIRED);
  assert.equal(calls, 1);
});

test('a complete answer counts as finished whatever finish reason follows it', async () => {
  for (const finishReason of ['CONTINUATION', 'OTHER', 'MAX_TOKENS']) {
    globalThis.fetch = async () => {
      const ev = (o) => `data: ${JSON.stringify(o)}\n\n`;
      return new Response(new Blob([
        ev({ candidates: [{ content: { parts: [{ text: '{"blocks":[{"box_2d":[1,2,3,4],"translation":"ok"}]}' }] } }] }),
        ev({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason }] }),
      ]).stream(), { status: 200 });
    };
    assert.equal((await streamTranslate(req().o)).finish, 'STOP', finishReason);
  }
});

test('the key test makes one tiny real request and says what is wrong', async () => {
  const model = { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', inUsd: 0.3, outUsd: 2.5, gen: 3 };
  let seen;
  const answer = (status, message) => {
    globalThis.fetch = async (url, init) => {
      seen = { url: String(url), body: JSON.parse(init.body), key: init.headers['x-goog-api-key'] };
      return status === 200
        ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }), { status })
        : new Response(JSON.stringify({ error: { code: status, message } }), { status });
    };
  };
  answer(200);
  const ok = await testKey('https://gen.test', 'AIzaKEY', model);
  assert.deepEqual([ok.ok, ok.kind], [true, 'ok']);
  assert.match(seen.url, /\/v1beta\/models\/gemini-3\.5-flash-lite:generateContent$/, 'generation, not just a lookup');
  assert.equal(seen.key, 'AIzaKEY');
  assert.equal(seen.body.generationConfig.maxOutputTokens, 32);
  assert.equal(seen.body.generationConfig.thinkingConfig, undefined, 'no optional fields that could fail the check');
  answer(404, RETIRED);
  assert.deepEqual(await testKey('https://gen.test', 'AIzaKEY', model), { ok: false, kind: 'model', message: RETIRED });
  answer(400, 'API key not valid. Please pass a valid API key.');
  assert.equal((await testKey('https://gen.test', 'AIzaKEY', model)).kind, 'key');
  answer(403, 'Generative Language API has not been used in project 123 before or it is disabled.');
  assert.equal((await testKey('https://gen.test', 'AIzaKEY', model)).kind, 'key');
  answer(429, 'You exceeded your current quota.');
  assert.equal((await testKey('https://gen.test', 'AIzaKEY', model)).kind, 'quota');
  answer(400, 'User location is not supported for the API use.');
  assert.deepEqual(await testKey('https://gen.test', 'AIzaKEY', model), { ok: false, kind: 'other', message: 'User location is not supported for the API use.' });
});
