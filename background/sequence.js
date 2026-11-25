// @ts-check

export const AHEAD = 2;
const KEEP = 6;
const TTL_MS = 20 * 60_000;
const SITES = 50;

/**
 * @param {string} url
 * @returns {{origin: string, parts: string[]} | null}
 */
function split(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return { origin: u.origin, parts: (u.pathname + u.search).split(/(\d+)/) };
}

/**
 * @param {string} d
 * @param {number} n
 */
function plus(d, n) {
  const s = (BigInt(d) + BigInt(n)).toString();
  return d.length > 1 && d[0] === '0' ? s.padStart(d.length, '0') : s;
}

/**
 * @param {string} a
 * @param {string} b
 */
export function step(a, b) {
  const A = split(a); const B = split(b);
  if (!A || !B || A.origin !== B.origin || A.parts.length !== B.parts.length) return -1;
  let k = -1;
  for (let i = 0; i < A.parts.length; i++) {
    if (A.parts[i] === B.parts[i]) continue;
    if (i % 2 === 0 || k >= 0 || B.parts[i] !== plus(A.parts[i], 1)) return -1;
    k = i;
  }
  return k;
}

/**
 * @param {string} url
 * @param {number} k
 * @param {number} n
 * @returns {string | null}
 */
export function onward(url, k, n) {
  const A = split(url);
  if (!A || k % 2 !== 1 || k >= A.parts.length) return null;
  const parts = A.parts.slice();
  parts[k] = plus(parts[k], n);
  try { return new URL(parts.join(''), A.origin).href; } catch { return null; }
}

/**
 * @param {string} url
 * @param {string} shown
 */
export function sameFolder(url, shown) {
  let a; let b;
  try { a = new URL(url); b = new URL(shown); } catch { return false; }
  if (a.protocol !== b.protocol || (a.protocol !== 'https:' && a.protocol !== 'http:') || a.origin !== b.origin || a.href === b.href) return false;
  const dir = (/** @type {string} */ p) => p.slice(0, p.lastIndexOf('/') + 1);
  const ext = (/** @type {string} */ p) => { const f = p.slice(p.lastIndexOf('/') + 1); const i = f.lastIndexOf('.'); return i > 0 ? f.slice(i).toLowerCase() : ''; };
  return dir(a.pathname) === dir(b.pathname) && dir(a.pathname).length > 1 && ext(a.pathname) === ext(b.pathname);
}

export class Sequence {
  constructor() {
    /** @type {Map<string, {url: string, at: number}[]>} */
    this.seen = new Map();
  }

  /**
   * @param {string} site
   * @param {number} [now]
   * @returns {string[]}
   */
  recent(site, now = Date.now()) {
    return (this.seen.get(site) ?? []).filter((e) => now - e.at < TTL_MS).map((e) => e.url);
  }

  /**
   * @param {string} site
   * @param {string} url
   * @param {number} [now]
   * @returns {string[]}
   */
  shown(site, url, now = Date.now()) {
    const list = (this.seen.get(site) ?? []).filter((e) => now - e.at < TTL_MS && e.url !== url);
    let k = -1;
    for (let i = list.length - 1; i >= 0 && k < 0; i--) k = step(list[i].url, url);
    list.push({ url, at: now });
    if (list.length > KEEP) list.splice(0, list.length - KEEP);
    this.seen.delete(site);
    this.seen.set(site, list);
    if (this.seen.size > SITES) this.seen.delete(/** @type {string} */ (this.seen.keys().next().value));
    if (k < 0) return [];
    /** @type {string[]} */
    const out = [];
    for (let n = 1; n <= AHEAD; n++) {
      const u = onward(url, k, n);
      if (u) out.push(u);
    }
    return out;
  }
}
