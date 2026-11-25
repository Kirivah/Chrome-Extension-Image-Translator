// @ts-check
import { idbGet, idbPut, idbDel, idbClear, idbCount, idbTrim, idbTrimBytes } from '../shared/idb.js';

const MEM_MAX = 300;
const MEM_BYTES = 12e6;
const LIMIT = { raw: 8000, final: 4000 };
const FINAL_BYTES = 150e6;
const MAX_ENTRY_BYTES = 3e6;
const FINAL_TTL = 21 * 24 * 3600 * 1000;

/** @typedef {{value: unknown, partial: boolean, rev: number}} Hit */

/** @type {Map<string, Hit & {bytes: number}>} */
const mem = new Map();
let memBytes = 0;
let writes = 0;

/** @param {unknown} v */
function weigh(v) {
  if (!Array.isArray(v)) return 200;
  let n = 200;
  for (const e of v) n += 150 + (e && typeof e === 'object' && typeof e.im === 'string' ? e.im.length : 0);
  return n;
}

/** @param {string} k */
function memGet(k) {
  const v = mem.get(k);
  if (v !== undefined) { mem.delete(k); mem.set(k, v); }
  return v;
}

/** @param {string} k @param {Hit} v @param {number} [bytes] */
function memSet(k, v, bytes = weigh(v.value)) {
  const old = mem.get(k);
  if (old) { memBytes -= old.bytes; mem.delete(k); }
  if (bytes > MAX_ENTRY_BYTES) return;
  mem.set(k, { ...v, bytes });
  memBytes += bytes;
  while (mem.size > MEM_MAX || (memBytes > MEM_BYTES && mem.size > 1)) {
    const first = /** @type {string} */ (mem.keys().next().value);
    memBytes -= /** @type {{bytes: number}} */ (mem.get(first)).bytes;
    mem.delete(first);
  }
}

/**
 * @param {'raw'|'final'} store
 * @param {string} key
 * @param {{fresh?: boolean, rev?: number}} [opt]
 * @returns {Promise<Hit | undefined>}
 */
export async function cacheGet(store, key, opt = {}) {
  const mk = store + ':' + key;
  /** @type {Hit | undefined} */
  let hit = memGet(mk);
  if (hit === undefined) {
    let v;
    try { v = await idbGet(store, key); } catch { return undefined; }
    const rec = /** @type {{t?: number, r?: unknown, p?: unknown, v?: unknown} | undefined} */ (v);
    if (!rec || typeof rec !== 'object') return undefined;
    if (store === 'final' && (typeof rec.t !== 'number' || Date.now() - rec.t > FINAL_TTL)) return undefined;
    hit = { value: rec.r, partial: rec.p === true, rev: typeof rec.v === 'number' ? rec.v : 0 };
    memSet(mk, hit);
  }
  if (opt.fresh && (hit.partial || (opt.rev !== undefined && hit.rev < opt.rev))) return undefined;
  return { value: hit.value, partial: hit.partial, rev: hit.rev };
}

/**
 * @param {'raw'|'final'} store
 * @param {string} key
 * @param {unknown} value
 * @param {boolean} [partial]
 * @param {number} [rev]
 */
export async function cachePut(store, key, value, partial = false, rev = 0) {
  const w = weigh(value);
  memSet(store + ':' + key, { value, partial, rev }, w);
  /** @type {{t: number, r: unknown, p?: true, w?: number, v?: number}} */
  const rec = { t: Date.now(), r: value };
  if (partial) rec.p = true;
  if (rev) rec.v = rev;
  if (store === 'final') rec.w = w;
  try {
    if (w > MAX_ENTRY_BYTES) { await idbDel(store, key); return; }
    await idbPut(store, key, rec);
    if (++writes % 50 === 0) {
      await idbTrim('raw', LIMIT.raw);
      await idbTrim('final', LIMIT.final);
      await idbTrimBytes(FINAL_BYTES);
    }
  } catch {}
}

export async function cacheClear() {
  mem.clear();
  memBytes = 0;
  await idbClear('raw');
  await idbClear('final');
}

export async function cacheStats() {
  const [raw, final] = await Promise.all([idbCount('raw'), idbCount('final')]);
  return { raw, final };
}
