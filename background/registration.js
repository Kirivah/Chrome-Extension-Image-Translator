// @ts-check

const SCRIPT_ID = 'imgtr';
export const ALL_URLS = ['<all_urls>'];

export const CS_FILES = [
  'content/geometry.js',
  'content/fit.js',
  'content/font.js',
  'content/pin.js',
  'content/anchor.js',
  'content/overlay.js',
  'content/capture.js',
  'content/client.js',
  'content/scanner.js',
  'content/preload.js',
  'content/nextpage.js',
  'content/main.js',
];

let chain = Promise.resolve();

export function hasHostAccess() {
  return chrome.permissions.contains({ origins: ALL_URLS });
}

/** @param {string} origin */
function patternFor(origin) {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
}

/** @param {Settings} s */
function matchesFor(s) {
  return s.allSites ? ['http://*/*', 'https://*/*'] : [...new Set(s.sites.map(patternFor))];
}

/** @param {Settings} s */
export function syncRegistration(s) {
  chain = chain.then(() => doSync(s)).catch((e) => console.warn('[imgtr] registration', e));
  return chain;
}

/** @param {Settings} s */
async function doSync(s) {
  const perm = await hasHostAccess();
  const matches = matchesFor(s);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (!perm || matches.length === 0) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    return;
  }
  /** @type {chrome.scripting.RegisteredContentScript} */
  const def = {
    id: SCRIPT_ID,
    js: CS_FILES,
    matches,
    runAt: 'document_start',
    allFrames: true,
    persistAcrossSessions: true,
  };
  if (existing.length) await chrome.scripting.updateContentScripts([def]);
  else await chrome.scripting.registerContentScripts([def]);
}

/** @param {number} tabId */
export async function injectNow(tabId) {
  const [probe] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const p = /** @type {any} */ (globalThis).__imgtr;
      if (p && typeof p.alive === 'function' && p.alive()) { p.restart(); return true; }
      return false;
    },
  });
  if (probe?.result === true) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: CS_FILES });
}

/** @param {Settings} s */
export async function injectOpenTabs(s) {
  const matches = matchesFor(s);
  if (!matches.length || !(await hasHostAccess())) return;
  const tabs = await chrome.tabs.query({ url: matches });
  await Promise.allSettled(tabs.map((t) => (typeof t.id === 'number' && !t.discarded ? injectNow(t.id) : null)));
}

/**
 * @param {Settings} s
 * @returns {Promise<number[]>}
 */
export async function tabsFor(s) {
  const matches = matchesFor(s);
  if (!matches.length || !(await hasHostAccess())) return [];
  const tabs = await chrome.tabs.query({ url: matches });
  return tabs.map((t) => t.id).filter((id) => typeof id === 'number');
}
