// @ts-check

/** @typedef {{code: ErrCode, detail: string}} TabError */
/** @typedef {{count: number, passing: TabError | null, image: TabError | null}} Entry */

/** @type {ReadonlySet<ErrCode>} */
const PASSING = new Set(['nokey', 'auth', 'nomodel', 'quota', 'budget', 'net']);

/** @type {Map<number, Entry>} */
const tabs = new Map();
/** @type {Map<number, ReturnType<typeof setTimeout>>} */
const pending = new Map();

/** @param {number} tabId @returns {TabStatus} */
export function tabStatus(tabId) {
  const e = tabs.get(tabId);
  const err = e ? e.passing ?? e.image : null;
  return { count: e?.count ?? 0, lastError: err?.code ?? '', detail: err?.detail ?? '' };
}

/** @param {number} tabId */
function entry(tabId) {
  let e = tabs.get(tabId);
  if (!e) { e = { count: 0, passing: null, image: null }; tabs.set(tabId, e); }
  return e;
}

/**
 * @param {number} tabId
 * @param {number} regions
 * @param {boolean} viaModel
 */
export function imageDone(tabId, regions, viaModel) {
  const e = tabs.get(tabId);
  if (regions === 0 && !(viaModel && e?.passing)) return;
  const x = entry(tabId);
  if (regions > 0) x.count++;
  if (viaModel) x.passing = null;
  schedule(tabId);
}

/** @param {number} tabId @param {ErrCode} code @param {string} [detail] */
export function setError(tabId, code, detail = '') {
  if (code === 'cancelled' || code === 'busy') return;
  const e = entry(tabId);
  const err = { code, detail: detail.replace(/\s+/g, ' ').trim().slice(0, 300) };
  if (PASSING.has(code)) e.passing = err;
  else e.image = err;
  schedule(tabId);
}

/** @param {number} tabId */
export function clearImageErrors(tabId) {
  const e = tabs.get(tabId);
  if (!e || !e.image) return;
  e.image = null;
  schedule(tabId);
}

export function clearAllImageErrors() {
  for (const tabId of tabs.keys()) clearImageErrors(tabId);
}

/** @param {ErrCode} code */
export function clearPassing(code) {
  for (const [tabId, e] of tabs) {
    if (e.passing?.code === code) { e.passing = null; schedule(tabId); }
  }
}

/** @param {number} tabId */
export function resetTab(tabId) {
  tabs.delete(tabId);
  const t = pending.get(tabId);
  if (t) { clearTimeout(t); pending.delete(tabId); }
}

/** @param {number} tabId */
function schedule(tabId) {
  if (pending.has(tabId)) return;
  pending.set(tabId, setTimeout(() => {
    pending.delete(tabId);
    const e = tabs.get(tabId);
    if (!e) return;
    const failed = !!(e.passing || e.image);
    const text = failed ? '!' : e.count ? String(Math.min(e.count, 999)) : '';
    chrome.action?.setBadgeText({ tabId, text })?.catch(() => {});
    chrome.action?.setBadgeBackgroundColor({ tabId, color: failed ? '#c5221f' : '#3b3f45' })?.catch(() => {});
  }, 300));
}
