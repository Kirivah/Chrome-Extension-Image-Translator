// @ts-check
import { loadSettings, sanitize, saveSettings, resultSignature, DEFAULT_FONT, cleanOrigin } from '../shared/settings.js';
import { resolveModel } from '../shared/models.js';
import { langName } from '../shared/languages.js';
import { getApiKey } from '../shared/secrets.js';
import { Dispatcher } from './dispatcher.js';
import { TaskHub } from './tasks.js';
import { ClientRegistry } from './clients.js';
import { parseUiMessage, isExtensionPage } from './validate.js';
import { syncRegistration, injectNow, injectOpenTabs, hasHostAccess, tabsFor } from './registration.js';
import { loadUsage, usageSnapshot } from './usage.js';
import { cacheClear, cacheStats } from './cache.js';
import { testKey } from './gemini.js';
import { initNetRules } from './netrules.js';
import { API_BASE } from '../shared/models.js';
import * as badge from './badge.js';

/** @type {Settings} */
let settings = sanitize(undefined);
let sig = resultSignature(settings);
let hostAccess = false;
/** @type {Promise<string> | null} */
let apiKeyP = null;
/** @type {{tabId: number, origin: string} | null} */
let pendingInject = null;

const ready = (async () => {
  const [s, perm] = await Promise.all([loadSettings(), hasHostAccess(), loadUsage(), initNetRules()]);
  settings = s;
  sig = resultSignature(s);
  hostAccess = perm;
})().catch((e) => console.warn('[imgtr] startup: using defaults', e));

const apiKey = () => (apiKeyP ??= getApiKey().catch(() => ''));

const dispatcher = new Dispatcher({
  settings: () => settings,
  apiKey,
  onBlocked: (code) => { for (const c of registry.clients) badge.setError(c.tabId, code); },
});

/** @type {Map<number, number>} */
const rescans = new Map();
const RESCAN_FRESH_MS = 15_000;

const hub = new TaskHub({
  snapshot: () => ({
    sig,
    cfg: {
      model: resolveModel(settings),
      langName: langName(settings.lang),
      transcribe: settings.transcribe,
      economy: settings.economy,
    },
    lang: settings.lang,
    sensitivity: settings.sensitivity,
    maxSide: settings.maxSide,
  }),
  ahead: () => settings.prefetch > 0,
  apiKey,
  dispatcher,
  wantsFresh: (tabId) => Date.now() - (rescans.get(tabId) ?? 0) < RESCAN_FRESH_MS,
  onImageDone: (client, regions, viaModel) => badge.imageDone(client.tabId, regions, viaModel),
  onImageError: (client, code, detail) => { badge.setError(client.tabId, code, detail); logError(code, detail); },
});

/** @type {Map<string, number>} */
const logged = new Map();
/**
 * @param {ErrCode} code
 * @param {string} detail
 */
function logError(code, detail) {
  const key = code + detail;
  const now = Date.now();
  if ((logged.get(key) ?? 0) > now - 60_000) return;
  if (logged.size > 200) logged.clear();
  logged.set(key, now);
  console.warn(`[imgtr] ${code}: ${detail}`);
}

/** @param {string} origin */
const allowed = (origin) => hostAccess && (settings.allSites || settings.sites.includes(origin));

/** @returns {ContentConfig} */
const contentConfig = () => ({
  on: true,
  gen: sig,
  lang: settings.lang,
  minSide: settings.minSide,
  prefetch: settings.prefetch,
  font: settings.font || DEFAULT_FONT,
  bold: settings.bold,
  textScale: settings.textScale,
  caps: settings.caps,
});
const rescanKey = () => JSON.stringify({ ...contentConfig(), textScale: 0, caps: false });

const registry = new ClientRegistry({ ready, hub, allowed, config: contentConfig });

chrome.runtime.onConnect.addListener((port) => registry.connect(port));

chrome.permissions.onAdded.addListener(() => { void refreshAccess(); });
chrome.permissions.onRemoved.addListener(() => { void refreshAccess(); });

chrome.tabs.onRemoved.addListener((tabId) => { badge.resetTab(tabId); rescans.delete(tabId); });
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading') badge.resetTab(tabId); });

chrome.runtime.onInstalled.addListener((details) => {
  ready.then(() => syncRegistration(settings)).then(() => {
    if (details.reason === 'install') chrome.runtime.openOptionsPage().catch(() => {});
    if (details.reason === 'update') void injectOpenTabs(settings);
  });
});
chrome.runtime.onStartup.addListener(() => { ready.then(() => syncRegistration(settings)); });

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  if (!isExtensionPage(sender)) return false;
  const m = parseUiMessage(raw);
  if (!m) return false;
  handleUi(m).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

/** @param {Settings} next */
function applySettings(next) {
  if (JSON.stringify(next) === JSON.stringify(settings)) return;
  const prev = settings;
  const cfgBefore = rescanKey();
  settings = next;
  const nextSig = resultSignature(next);
  if (nextSig !== sig) {
    sig = nextSig;
    hub.cancelStale(sig);
  }
  if (rescanKey() !== cfgBefore) badge.clearAllImageErrors();
  registry.broadcastConfig();
  if (resolveModel(prev).id !== resolveModel(next).id) {
    dispatcher.reviveModels();
    badge.clearPassing('nomodel');
  }
  if (resolveModel(prev).id !== resolveModel(next).id || prev.tier !== next.tier || prev.rpm !== next.rpm) dispatcher.limitsChanged();
  dispatcher.pump();
  void syncRegistration(next);
  void wakeIdleTabs(prev, next);
}

/**
 * @param {Settings} prev
 * @param {Settings} next
 */
async function wakeIdleTabs(prev, next) {
  const ids = new Set([...(await tabsFor(prev)), ...(await tabsFor(next))]);
  for (const id of ids) {
    if (registry.hasTab(id)) continue;
    /** @type {SwToTab} */
    const msg = { t: 'wake' };
    chrome.tabs.sendMessage(id, msg).catch(() => {});
  }
}

async function refreshAccess() {
  await ready;
  hostAccess = await hasHostAccess();
  await syncRegistration(settings);
  registry.broadcastConfig();
  if (hostAccess && pendingInject) {
    const p = pendingInject;
    pendingInject = null;
    await injectIfStillOn(p);
  }
}

/** @param {number} tabId */
async function tabOrigin(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return cleanOrigin(tab.url ?? '');
  } catch {
    return '';
  }
}

/** @param {{tabId: number, origin: string}} p */
async function injectIfStillOn(p) {
  if (!allowed(p.origin) || (await tabOrigin(p.tabId)) !== p.origin) return;
  await syncRegistration(settings);
  await injectNow(p.tabId).catch((e) => console.warn('[imgtr] inject', e));
}

/** @param {ReturnType<Dispatcher['status']>} st @returns {Omit<WorkStatus, 'pending'>} */
const pick = (st) => ({ waitMs: st.waitMs, limited: st.limited, slow: st.slow });

/** @param {number} tabId @returns {Promise<UiState>} */
async function uiState(tabId) {
  const origin = await tabOrigin(tabId);
  return {
    ok: true,
    origin,
    supported: !!origin,
    enabled: !!origin && (settings.allSites || settings.sites.includes(origin)),
    allSites: settings.allSites,
    perm: hostAccess,
    hasKey: !!(await apiKey()),
    lang: settings.lang,
    model: resolveModel(settings).label,
    usage: usageSnapshot(),
    settings,
    tab: badge.tabStatus(tabId),
    work: { pending: hub.pending(tabId), ...pick(dispatcher.status()) },
  };
}

/** @param {number} tabId @param {boolean} on */
async function setSite(tabId, on) {
  const origin = await tabOrigin(tabId);
  if (!origin) return { ok: false, error: 'This page can’t be translated.' };
  const sites = settings.sites.filter((o) => o !== origin);
  if (on) sites.push(origin);
  applySettings(await saveSettings({ sites }));
  if (on) {
    if (hostAccess) await injectIfStillOn({ tabId, origin });
    else pendingInject = { tabId, origin };
  }
  return uiState(tabId);
}

/** @param {UiToSw} m */
async function handleUi(m) {
  await ready;
  switch (m.t) {
    case 'ui:settings':
      applySettings(await loadSettings());
      return { ok: true };
    case 'ui:state':
      return uiState(m.tabId);
    case 'ui:site':
      return setSite(m.tabId, m.on);
    case 'ui:cmd': {
      if (m.c === 'rescan') {
        badge.clearImageErrors(m.tabId);
        rescans.set(m.tabId, Date.now());
      }
      /** @type {SwToTab} */
      const msg = { t: 'cmd', c: m.c, v: m.v };
      await chrome.tabs.sendMessage(m.tabId, msg).catch(() => {});
      return { ok: true };
    }
    case 'ui:testKey': {
      const k = await apiKey();
      if (!k) return { ok: false, kind: 'key', message: 'No API key saved yet.' };
      return testKey(API_BASE, k, resolveModel(settings));
    }
    case 'ui:keyChanged': {
      apiKeyP = null;
      dispatcher.reviveModels();
      dispatcher.limitsChanged();
      /** @type {SwToTab} */
      const msg = { t: 'cmd', c: 'rescan' };
      for (const id of await tabsFor(settings)) chrome.tabs.sendMessage(id, msg).catch(() => {});
      return { ok: true };
    }
    case 'ui:clearCache':
      await cacheClear();
      return { ok: true };
    case 'ui:cacheStats':
      return { ok: true, ...(await cacheStats()) };
  }
  return { ok: false };
}
