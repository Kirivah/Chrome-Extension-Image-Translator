// @ts-check
import { API_BASE } from '../shared/models.js';

const GUARD_BASE = 6000;
const ALLOW_BASE = 6100;
const ALLOW_SPAN = 90;
const MAX_ALLOW = 20;
const REF_BASE = 7000;
const MAX_REF = 40;

const PRIVATE_REGEXES = [
  '^https?://(127|10|0)\\.',
  '^https?://192\\.168\\.',
  '^https?://172\\.(1[6-9]|2[0-9]|3[01])\\.',
  '^https?://169\\.254\\.',
  '^https?://100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.',
  '^https?://\\[',
];
const LOCAL_DOMAINS = ['localhost', 'local', 'internal', 'lan', 'home.arpa'];

/** @type {Map<string, {id: number, referer: string}>} */
const referers = new Map();
/** @type {Map<string, Promise<void>>} */
const allowed = new Map();
/** @type {Map<string, number>} */
const allowIds = new Map();
let nextRef = REF_BASE;
let nextAllow = ALLOW_BASE;
/** @type {Promise<boolean> | null} */
let setup = null;

const own = () => ({
  initiatorDomains: [chrome.runtime.id],
  tabIds: [chrome.tabs.TAB_ID_NONE],
  resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST, chrome.declarativeNetRequest.ResourceType.OTHER],
});

/** @returns {Promise<boolean>} */
export function initNetRules() {
  setup ??= (async () => {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const ids = existing.map((r) => r.id).filter((id) => id >= GUARD_BASE && id < REF_BASE + 100_000);
    const block = { type: chrome.declarativeNetRequest.RuleActionType.BLOCK };
    /** @type {chrome.declarativeNetRequest.Rule[]} */
    const addRules = PRIVATE_REGEXES.map((regexFilter, i) => ({
      id: GUARD_BASE + i, priority: 1, action: block, condition: { regexFilter, ...own() },
    }));
    addRules.push({ id: GUARD_BASE + PRIVATE_REGEXES.length, priority: 1, action: block, condition: { requestDomains: LOCAL_DOMAINS, ...own() } });
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids, addRules });
    referers.clear();
    allowed.clear();
    allowIds.clear();
    const apiHost = new URL(API_BASE).hostname;
    if (/^(127\.|localhost$)/.test(apiHost)) await allowHostRule(apiHost);
    return true;
  })().catch((e) => {
    setup = null;
    console.error('[imgtr] private-network guard could not be installed:', e);
    return false;
  });
  return setup;
}

/** @param {string} host */
function allowHostRule(host) {
  let p = allowed.get(host);
  if (p) return p;
  p = (async () => {
    /** @type {number[]} */
    const removeRuleIds = [];
    if (allowIds.size >= MAX_ALLOW) {
      const [old, oldId] = allowIds.entries().next().value ?? [];
      if (old && oldId) { allowIds.delete(old); allowed.delete(old); removeRuleIds.push(oldId); }
    }
    const id = nextAllow;
    nextAllow = ALLOW_BASE + ((nextAllow - ALLOW_BASE + 1) % ALLOW_SPAN);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [...removeRuleIds, id],
      addRules: [{ id, priority: 2, action: { type: chrome.declarativeNetRequest.RuleActionType.ALLOW }, condition: { requestDomains: [host], ...own() } }],
    });
    allowIds.set(host, id);
  })();
  allowed.set(host, p);
  p.catch(() => allowed.delete(host));
  return p;
}

/** @param {string} host */
export async function allowPrivateHost(host) {
  await initNetRules();
  await allowHostRule(host);
}

/**
 * @param {string} host
 * @param {string} pageOrigin
 * @returns {Promise<boolean>}
 */
export async function ensureReferer(host, pageOrigin) {
  await initNetRules();
  const referer = pageOrigin + '/';
  const cur = referers.get(host);
  if (cur && cur.referer === referer) return false;
  /** @type {number[]} */
  const removeRuleIds = [];
  if (cur) {
    removeRuleIds.push(cur.id);
    referers.delete(host);
  } else if (referers.size >= MAX_REF) {
    const [oldHost, old] = referers.entries().next().value ?? [];
    if (oldHost && old) { removeRuleIds.push(old.id); referers.delete(oldHost); }
  }
  const id = nextRef++;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds,
    addRules: [{
      id,
      priority: 3,
      action: {
        type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
        requestHeaders: [{ header: 'referer', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: referer }],
      },
      condition: { requestDomains: [host], ...own() },
    }],
  });
  referers.set(host, { id, referer });
  return true;
}
