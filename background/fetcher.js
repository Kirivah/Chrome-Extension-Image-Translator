// @ts-check
import { ensureReferer, allowPrivateHost } from './netrules.js';
import { looksLikeImage } from './imagesize.js';
import { TaskError } from './util.js';

const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/** @param {string} host */
export function isPrivateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (h === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (h.includes(':')) {
    return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  }
  return false;
}

/**
 * @param {string} raw
 * @param {string} pageOrigin
 * @returns {URL}
 */
export function checkImageUrl(raw, pageOrigin) {
  let u;
  try { u = new URL(raw); } catch { throw new TaskError('bad', 'url'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new TaskError('bad', 'scheme');
  if (u.username || u.password) throw new TaskError('bad', 'credentials');
  if (isPrivateHost(u.hostname) && u.hostname !== new URL(pageOrigin).hostname) throw new TaskError('bad', 'private host');
  return u;
}

/**
 * @param {string} rawUrl
 * @param {string} pageOrigin
 * @param {AbortSignal} outer
 * @returns {Promise<Uint8Array>}
 */
export async function fetchImageBytes(rawUrl, pageOrigin, outer) {
  if (outer.aborted) throw new TaskError('cancelled');
  const url = checkImageUrl(rawUrl, pageOrigin);
  if (isPrivateHost(url.hostname)) await allowPrivateHost(url.hostname);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const onAbort = () => ac.abort();
  outer.addEventListener('abort', onAbort, { once: true });
  try {
    let res = await doFetch(url, ac.signal, 'default');
    if ((res.status === 401 || res.status === 403) && await ensureReferer(url.hostname, pageOrigin).catch(() => false)) {
      res = await doFetch(url, ac.signal, 'reload');
    }
    if (!res.ok) throw new TaskError('fetch', `HTTP ${res.status}`);
    if (res.url) checkImageUrl(res.url, pageOrigin);

    const type = (res.headers.get('content-type') || '').toLowerCase();
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) throw new TaskError('fetch', 'too large');
    if (type.startsWith('image/svg')) throw new TaskError('fetch', 'svg');

    const bytes = await readCapped(res, MAX_BYTES);
    if (!type.startsWith('image/') && !looksLikeImage(bytes)) throw new TaskError('fetch', 'not an image');
    return bytes;
  } catch (e) {
    if (e instanceof TaskError) throw e;
    throw new TaskError(outer.aborted ? 'cancelled' : 'fetch', String(e));
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', onAbort);
  }
}

/** @param {URL} url @param {AbortSignal} signal @param {RequestCache} cache */
function doFetch(url, signal, cache) {
  return fetch(url, {
    credentials: 'omit',
    cache,
    redirect: 'follow',
    referrerPolicy: 'no-referrer',
    signal,
  });
}

/** @param {Response} res @param {number} max */
async function readCapped(res, max) {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  /** @type {Uint8Array[]} */
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); throw new TaskError('fetch', 'too large'); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}
