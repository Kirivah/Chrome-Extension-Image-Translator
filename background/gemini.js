// @ts-check
import { JsonObjectStream } from './jsonstream.js';
import { TaskError } from './util.js';
import { maxOutputTokens } from './limits.js';

export const PROMPT_VERSION = 1;
export const PROMPT_REVISION = 2;

const SYSTEM = 'You are a fast OCR and translation engine for comics, manga, webtoons, memes, signs and screenshots. Reply with JSON only.';
const TOTAL_TIMEOUT_MS = 90_000;
const IDLE_TIMEOUT_MS = 30_000;
const TAIL = 1200;
const MAX_TRAILING = 256;

/** @typedef {{noSchema: boolean, noThinking: boolean, noMediaRes: boolean}} Compat */
/** @typedef {keyof Compat} CompatKey */

const DROP_ORDER = /** @type {const} */ (['noMediaRes', 'noSchema', 'noThinking']);
/** @type {Record<CompatKey, RegExp>} */
const FIELD_NAME = { noSchema: /schema/i, noThinking: /thinking/i, noMediaRes: /media_?resolution/i };
/** @type {Readonly<Compat>} */
const ALL_FIELDS = Object.freeze({ noSchema: false, noThinking: false, noMediaRes: false });

/** @type {Map<string, Compat>} */
const learned = new Map();

class FieldError extends Error {}

/**
 * @param {Compat} flags
 * @param {string} msg
 * @param {boolean} economy
 * @returns {{flags: Compat, keys: CompatKey[], named: boolean} | null}
 */
function relax(flags, msg, economy) {
  /** @param {CompatKey} k */
  const sent = (k) => !flags[k] && (k !== 'noMediaRes' || economy);
  /** @param {CompatKey[]} keys */
  const drop = (keys) => {
    const next = { ...flags };
    for (const k of keys) next[k] = true;
    return next;
  };
  const named = DROP_ORDER.filter((k) => sent(k) && FIELD_NAME[k].test(msg));
  if (named.length) return { flags: drop(named), keys: named, named: true };
  const next = DROP_ORDER.find(sent);
  return next ? { flags: drop([next]), keys: [next], named: false } : null;
}

/** @param {string} s */
export function looping(s) {
  const n = s.length;
  for (let p = 1; p <= 200; p++) {
    const span = Math.max(400, 4 * p);
    if (span + p > n) return false;
    const stop = n - span;
    let k = n - 1;
    while (k >= stop && s.charCodeAt(k) === s.charCodeAt(k - p)) k--;
    if (k < stop) return true;
  }
  return false;
}

/**
 * @param {number} n
 * @param {boolean} transcribe
 */
function schema(n, transcribe) {
  /** @type {Record<string, object>} */
  const props = {};
  const required = [];
  if (n > 1) { props.image = { type: 'integer', minimum: 0, maximum: n - 1 }; required.push('image'); }
  props.box_2d = { type: 'array', items: { type: 'integer', minimum: 0, maximum: 1000 }, minItems: 4, maxItems: 4 };
  required.push('box_2d');
  if (transcribe) { props.original = { type: 'string' }; required.push('original'); }
  props.translation = { type: 'string' };
  required.push('translation');
  return {
    type: 'object',
    properties: { blocks: { type: 'array', items: { type: 'object', properties: props, required } } },
    required: ['blocks'],
  };
}

/**
 * @param {string} lang
 * @param {number} n
 * @param {boolean} transcribe
 */
export function buildPrompt(lang, n, transcribe) {
  const where = n > 1 ? `the ${n} images (numbered 0 to ${n - 1})` : 'the image';
  const fields = [
    n > 1 ? '"image" = the image number' : '',
    '"box_2d" = [ymin, xmin, ymax, xmax] tightly around the block\'s glyphs, integers 0-1000 relative to that image\'s height (y) and width (x)',
    transcribe ? '"original" = the text exactly as written' : '',
    `"translation" = a natural, concise ${lang} translation that fits the same space`,
  ].filter(Boolean).join('; ');
  return [
    `Find every separate block of text in ${where}: speech and thought bubbles, narration boxes, captions, signs, labels and sound effects.`,
    `For each block give ${fields}.`,
    'A block is text set together: never split one into lines or columns, and never merge separate blocks. Text set apart by clear space is separate blocks, even inside one bubble or box: two remarks in one bubble, the separate paragraphs of a caption, each field of a status screen or table, each item of a list or menu, each label on a map. Give each text once. The box must take in every character of its block, all columns of vertical text included.',
    'Furigana (the tiny reading hints printed beside kanji) belong to the text they annotate: never give them an entry of their own.',
    `Keep tone, names and emphasis; no notes, quotes or romanization. Skip text already in ${lang}, numbers standing alone, page numbers, watermarks, credits, URLs and unreadable scribbles.`,
    'Return {"blocks":[]} if there is no such text.',
  ].join('\n');
}

/**
 * @typedef {Object} TranslateRequest
 * @property {string} apiBase
 * @property {string} apiKey
 * @property {ModelInfo} model
 * @property {string[]} images
 * @property {string} langName
 * @property {boolean} transcribe
 * @property {boolean} economy
 * @property {AbortSignal} signal
 * @property {(obj: unknown) => void} onBlock
 * @property {() => void} [onText]
 * @property {Meter} [meter]
 * @property {boolean} [hot]
 */

/** @typedef {{inTok: number, outTok: number, finish: string}} TranslateResult */

/**
 * @typedef {Object} Meter
 * @property {boolean} started
 * @property {number} inTok
 * @property {number} outTok
 * @property {number} chars
 */

/**
 * @param {string} apiBase
 * @param {string} apiKey
 * @param {string} model
 */
export function preconnect(apiBase, apiKey, model) {
  fetch(`${apiBase}/v1beta/models/${encodeURIComponent(model)}`, {
    headers: { 'x-goog-api-key': apiKey },
    credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
  }).then((r) => r.body?.cancel(), () => {});
}

/** @returns {Meter} */
export function newMeter() {
  return { started: false, inTok: 0, outTok: 0, chars: 0 };
}

/** @param {TranslateRequest} o @param {Compat} flags */
function requestBody(o, flags) {
  const n = o.images.length;
  /** @type {object[]} */
  const parts = [];
  if (n === 1) {
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: o.images[0] } });
  } else {
    o.images.forEach((data, i) => {
      parts.push({ text: `Image ${i}:` });
      parts.push({ inlineData: { mimeType: 'image/jpeg', data } });
    });
  }
  parts.push({ text: buildPrompt(o.langName, n, o.transcribe) });

  /** @type {Record<string, unknown>} */
  const gc = { responseMimeType: 'application/json', maxOutputTokens: maxOutputTokens(n) };
  if (!flags.noSchema) gc.responseJsonSchema = schema(n, o.transcribe);
  if (o.model.gen === 2) {
    gc.temperature = o.hot ? 0.8 : 0.2;
    if (!flags.noThinking) gc.thinkingConfig = { thinkingBudget: 0 };
  } else if (!flags.noThinking) {
    gc.thinkingConfig = { thinkingLevel: 'MINIMAL' };
  }
  if (o.economy && !flags.noMediaRes) gc.mediaResolution = 'MEDIA_RESOLUTION_MEDIUM';

  return {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts }],
    generationConfig: gc,
  };
}

/**
 * @param {TranslateRequest} o
 * @returns {Promise<TranslateResult>}
 */
export async function streamTranslate(o) {
  /** @type {Compat} */
  let flags = { ...(learned.get(o.model.id) ?? ALL_FIELDS) };
  /** @type {CompatKey[]} */
  const namedDrops = [];
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await once(o, flags);
      if (namedDrops.length) {
        const m = { ...(learned.get(o.model.id) ?? ALL_FIELDS) };
        for (const k of namedDrops) m[k] = true;
        learned.set(o.model.id, m);
      }
      return r;
    } catch (e) {
      if (!(e instanceof FieldError)) throw e;
      const step = attempt < 3 ? relax(flags, e.message, o.economy) : null;
      if (!step) throw new TaskError('model', `HTTP 400 ${e.message}`);
      flags = step.flags;
      if (step.named) namedDrops.push(...step.keys);
    }
  }
}

/** @param {TranslateRequest} o @param {Compat} flags @returns {Promise<TranslateResult>} */
async function once(o, flags) {
  if (o.signal.aborted) throw new TaskError('cancelled');
  const meter = o.meter ?? newMeter();
  const url = `${o.apiBase}/v1beta/models/${encodeURIComponent(o.model.id)}:streamGenerateContent?alt=sse`;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  o.signal.addEventListener('abort', onAbort, { once: true });
  const total = setTimeout(() => ac.abort(), TOTAL_TIMEOUT_MS);
  let idle = setTimeout(() => ac.abort(), IDLE_TIMEOUT_MS);
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(), IDLE_TIMEOUT_MS); };

  /** @type {ReadableStreamDefaultReader<string> | null} */
  let reader = null;
  try {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': o.apiKey },
        body: JSON.stringify(requestBody(o, flags)),
        signal: ac.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
    } catch (e) {
      throw new TaskError(o.signal.aborted ? 'cancelled' : 'net', String(e), 2000);
    }
    if (!res.ok) await throwHttp(res);
    if (!res.body) throw new TaskError('model', 'empty body');
    meter.started = true;

    const stream = new JsonObjectStream(o.onBlock);
    let finish = ''; let blocked = '';
    let tail = '';
    let cut = '';
    let texted = false;

    /** @param {string} evt */
    const handleEvent = (evt) => {
      let data = '';
      for (const line of evt.split('\n')) if (line.startsWith('data:')) data += line.slice(5).trimStart();
      if (!data) return;
      let j;
      try { j = JSON.parse(data); } catch { return; }
      if (j && j.error) {
        const status = Number(j.error.code) || 500;
        const err = httpLikeError(status, String(j.error.message || ''), 0);
        throw err instanceof FieldError ? new TaskError('model', `HTTP ${status} ${err.message}`) : err;
      }
      const c = j?.candidates?.[0];
      const parts = c?.content?.parts;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          if (p && typeof p.text === 'string' && !p.thought) {
            if (!texted && p.text.length) { texted = true; o.onText?.(); }
            meter.chars += p.text.length;
            stream.push(p.text);
            tail = (tail + p.text).slice(-TAIL);
          }
        }
      }
      if (stream.complete) { if (stream.extra > MAX_TRAILING) cut = 'STOP'; }
      else if (looping(tail)) cut = 'LOOP';
      if (typeof c?.finishReason === 'string') finish = c.finishReason;
      if (typeof j?.promptFeedback?.blockReason === 'string') blocked = j.promptFeedback.blockReason;
      const um = j?.usageMetadata;
      if (um) {
        meter.inTok = Number(um.promptTokenCount) || 0;
        meter.outTok = (Number(um.candidatesTokenCount) || 0) + (Number(um.thoughtsTokenCount) || 0);
      }
    };

    reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      let r;
      try { r = await reader.read(); } catch (e) {
        if (stream.complete) break;
        throw new TaskError(o.signal.aborted ? 'cancelled' : 'net', String(e), 2000);
      }
      if (r.done) break;
      bump();
      buf += r.value.replace(/\r/g, '');
      let sep;
      while (!cut && (sep = buf.indexOf('\n\n')) >= 0) {
        handleEvent(buf.slice(0, sep));
        buf = buf.slice(sep + 2);
      }
      if (cut) break;
    }
    if (!cut && buf.trim()) handleEvent(buf);
    if (cut) return { inTok: meter.inTok, outTok: meter.outTok, finish: cut };
    if (stream.complete) finish = 'STOP';

    if (blocked) throw new TaskError('blocked', blocked);
    if (stream.emitted === 0) {
      try {
        const all = JSON.parse(stream.value);
        const arr = Array.isArray(all) ? all : Array.isArray(all?.blocks) ? all.blocks : [];
        for (const b of arr) o.onBlock(b);
      } catch {}
      if (/SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(finish)) throw new TaskError('blocked', finish);
    }
    return { inTok: meter.inTok, outTok: meter.outTok, finish };
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
    o.signal.removeEventListener('abort', onAbort);
    if (reader) reader.cancel().catch(() => {});
  }
}

/**
 * @param {number} status
 * @param {string} msg
 * @param {number} retryMs
 * @param {{perMinute: number, perDay: number, zero: boolean}} [quota]
 * @returns {Error}
 */
function httpLikeError(status, msg, retryMs, quota) {
  if (status === 400 && /api[ _]?key/i.test(msg)) return new TaskError('auth', msg);
  if (status === 400) {
    const aboutFields = /unknown name|cannot find field|schema|thinking|media_?resolution/i.test(msg);
    const elsewhere = /location|region|country|input image|too large|exceed/i.test(msg);
    if (aboutFields || !elsewhere) return new FieldError(msg);
  }
  if (status === 401 || status === 403) return new TaskError('auth', msg);
  if (status === 429) {
    const e = new TaskError('quota', msg, retryMs || 15_000);
    if (quota) e.quota = quota;
    return e;
  }
  if (status === 404) return new TaskError('nomodel', msg);
  if (status >= 500) return new TaskError('net', msg, 3000);
  return new TaskError('model', `HTTP ${status} ${msg}`);
}

/** @param {Response} res @returns {Promise<never>} */
async function throwHttp(res) {
  let msg = '';
  let retryMs = 0;
  const quota = { perMinute: 0, perDay: 0, zero: false };
  try {
    const j = await res.json();
    msg = String(j?.error?.message ?? '');
    for (const d of j?.error?.details ?? []) {
      const type = typeof d?.['@type'] === 'string' ? d['@type'] : '';
      if (type.endsWith('RetryInfo') && typeof d.retryDelay === 'string') {
        retryMs = Math.ceil(parseFloat(d.retryDelay) * 1000) || 0;
      }
      if (type.endsWith('QuotaFailure') && Array.isArray(d.violations)) {
        for (const v of d.violations.slice(0, 20)) {
          const id = typeof v?.quotaId === 'string' ? v.quotaId : '';
          const n = typeof v?.quotaValue === 'string' || typeof v?.quotaValue === 'number' ? Number(v.quotaValue) : NaN;
          if (!Number.isFinite(n) || n < 0 || n > 1e9) continue;
          if (n === 0) { quota.zero = true; continue; }
          if (!/Requests/i.test(id)) continue;
          if (/PerMinute/i.test(id)) quota.perMinute = n;
          else if (/PerDay/i.test(id)) quota.perDay = n;
        }
      }
    }
  } catch {}
  throw httpLikeError(res.status, msg.slice(0, 500), retryMs, quota);
}

/** @typedef {{ok: boolean, kind: 'ok'|'key'|'model'|'quota'|'other'|'net', message: string}} KeyCheck */

/**
 * @param {string} apiBase
 * @param {string} apiKey
 * @param {ModelInfo} model
 * @returns {Promise<KeyCheck>}
 */
export async function testKey(apiBase, apiKey, model) {
  try {
    const res = await fetch(`${apiBase}/v1beta/models/${encodeURIComponent(model.id)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }], generationConfig: { maxOutputTokens: 32 } }),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    if (res.ok) return { ok: true, kind: 'ok', message: `Key works with ${model.id}.` };
    let msg = `HTTP ${res.status}`;
    try { msg = String((await res.json())?.error?.message || msg); } catch {}
    msg = msg.slice(0, 300);
    const s = res.status;
    if (s === 401 || s === 403 || (s === 400 && /api[ _]?key/i.test(msg))) return { ok: false, kind: 'key', message: msg };
    if (s === 404) return { ok: false, kind: 'model', message: msg };
    if (s === 429) return { ok: false, kind: 'quota', message: msg };
    return { ok: false, kind: 'other', message: msg };
  } catch (e) {
    return { ok: false, kind: 'net', message: `Network error: ${String(e).slice(0, 200)}` };
  }
}
