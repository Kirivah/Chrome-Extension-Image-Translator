// @ts-check
import { idbGet, idbPut, idbDel } from './idb.js';

const KEY = 'apiKey';

/** @param {string} raw */
export function normalizeKey(raw) {
  let k = String(raw ?? '').trim();
  const fromUrl = /[?&]key=([^&#\s]+)/.exec(k);
  if (fromUrl) {
    try { k = decodeURIComponent(fromUrl[1]); } catch { k = fromUrl[1]; }
  }
  k = k.replace(/^export\s+/i, '')
    .replace(/^[A-Z][A-Z0-9_]*\s*[=:]\s*/, '')
    .replace(/^bearer\s+/i, '')
    .replace(/\s+/g, '')
    .replace(/^["'`]+/, '')
    .replace(/["'`;,]+$/, '');
  return k;
}

/** @param {string} k */
export function isPlausibleKey(k) {
  return /^[\x21-\x7E]{10,512}$/.test(k) && !/["'`\\<>]/.test(k);
}

/** @returns {Promise<string>} */
export async function getApiKey() {
  const v = await idbGet('kv', KEY);
  return typeof v === 'string' && isPlausibleKey(v) ? v : '';
}

/**
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function setApiKey(key) {
  const k = normalizeKey(key);
  if (!k) { await idbDel('kv', KEY); return true; }
  if (!isPlausibleKey(k)) return false;
  await idbPut('kv', KEY, k);
  return true;
}
