// @ts-check
import { MAX_B64 } from './limits.js';

/** @param {unknown} v */
const isId = (v) => typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 2 ** 31;
/** @param {unknown} v */
const isPrio = (v) => v === 0 || v === 1 || v === 2;
/** @param {unknown} v */
const isTab = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * @param {unknown} raw
 * @returns {CsToSw | null}
 */
export function parseCsMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const m = /** @type {Record<string, unknown>} */ (raw);
  switch (m.t) {
    case 'job': {
      const { id, u, p, l } = m;
      if (!isId(id) || !isPrio(p) || (l !== 0 && l !== 1 && l !== 2)) return null;
      if (typeof u !== 'string' || u.length < 1 || u.length > 4096) return null;
      if (l !== 1 && !/^https?:\/\//i.test(u)) return null;
      return { t: 'job', id: /** @type {number} */ (id), u, p: /** @type {number} */ (p), l };
    }
    case 'prio':
      return isId(m.id) && isPrio(m.p) ? { t: 'prio', id: /** @type {number} */ (m.id), p: /** @type {number} */ (m.p) } : null;
    case 'cancel':
      return isId(m.id) ? { t: 'cancel', id: /** @type {number} */ (m.id) } : null;
    case 'ahead':
      if (typeof m.u !== 'string' || m.u.length > 4096 || !/^https?:\/\//i.test(m.u) || typeof m.n !== 'boolean') return null;
      return { t: 'ahead', u: m.u, n: m.n };
    case 'bytes': {
      const { id, b } = m;
      if (!isId(id)) return null;
      if (b !== null && (typeof b !== 'string' || b.length > MAX_B64)) return null;
      return { t: 'bytes', id: /** @type {number} */ (id), b: /** @type {string | null} */ (b) };
    }
    default:
      return null;
  }
}

/**
 * @param {unknown} raw
 * @returns {UiToSw | null}
 */
export function parseUiMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const m = /** @type {Record<string, unknown>} */ (raw);
  switch (m.t) {
    case 'ui:settings':
      return { t: 'ui:settings' };
    case 'ui:state':
      return isTab(m.tabId) ? { t: 'ui:state', tabId: /** @type {number} */ (m.tabId) } : null;
    case 'ui:site':
      return isTab(m.tabId) && typeof m.on === 'boolean' ? { t: 'ui:site', tabId: /** @type {number} */ (m.tabId), on: m.on } : null;
    case 'ui:cmd':
      if (!isTab(m.tabId) || (m.c !== 'rescan' && m.c !== 'original')) return null;
      return { t: 'ui:cmd', tabId: /** @type {number} */ (m.tabId), c: m.c, v: m.v === true };
    case 'ui:testKey':
    case 'ui:keyChanged':
    case 'ui:clearCache':
    case 'ui:cacheStats':
      return { t: m.t };
    default:
      return null;
  }
}

/** @param {chrome.runtime.MessageSender} sender */
export function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id
    && typeof sender.url === 'string'
    && sender.url.startsWith(chrome.runtime.getURL(''))
    && !sender.tab?.url?.startsWith('http');
}
