// @ts-check
import { MODELS, DEFAULT_MODEL, MODEL_ID_RE } from './models.js';
import { isLangCode } from './languages.js';
import { idbGet, idbUpdate } from './idb.js';

const KEY = 'settings';
export const SETTINGS_CHANNEL = 'imgtr-settings';
export const DEFAULT_FONT = '"Imgtr Comic","Comic Neue","Comic Sans MS",system-ui,sans-serif';

/** @type {Readonly<Settings>} */
export const DEFAULTS = Object.freeze({
  v: 2,
  model: DEFAULT_MODEL,
  customModel: '',
  tier: 'free',
  lang: 'en',
  sites: [],
  allSites: false,
  rpm: 15,
  concurrency: 4,
  batch: 3,
  dailyBudget: 1,
  dailyRequests: 500,
  maxSide: 1536,
  economy: false,
  transcribe: false,
  minSide: 120,
  prefetch: 3,
  sensitivity: 0.5,
  font: '',
  bold: true,
  textScale: 1,
  caps: true,
});

/**
 * @param {'free'|'paid'} tier
 * @returns {Pick<Settings, 'rpm'|'concurrency'|'batch'|'dailyRequests'>}
 */
export function tierPreset(tier) {
  return tier === 'paid'
    ? { rpm: 1000, concurrency: 6, batch: 1, dailyRequests: 0 }
    : { rpm: 15, concurrency: 4, batch: 3, dailyRequests: 500 };
}

/** @param {unknown} v @param {number} lo @param {number} hi @param {number} d */
function num(v, lo, hi, d) {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}

/** @param {unknown} v @param {number} lo @param {number} hi @param {number} d */
function int(v, lo, hi, d) {
  return Math.round(num(v, lo, hi, d));
}

/** @param {unknown} v @param {boolean} d */
function bool(v, d) {
  return typeof v === 'boolean' ? v : d;
}

/** @param {unknown} v */
export function cleanOrigin(v) {
  if (typeof v !== 'string' || v.length > 300) return '';
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

/** @param {unknown} v */
function cleanFont(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[^A-Za-z0-9 ,'"_-]/g, '').slice(0, 120).trim();
}

/**
 * @param {unknown} raw
 * @returns {Settings}
 */
export function sanitize(raw) {
  const r = /** @type {Record<string, unknown>} */ (raw && typeof raw === 'object' ? raw : {});
  const d = DEFAULTS;

  const model = typeof r.model === 'string' && (r.model === 'custom' || Object.hasOwn(MODELS, r.model))
    ? r.model : d.model;
  const customModel = typeof r.customModel === 'string' && MODEL_ID_RE.test(r.customModel) ? r.customModel : '';

  /** @type {string[]} */
  const sites = [];
  if (Array.isArray(r.sites)) {
    const seen = new Set();
    for (const s of r.sites.slice(0, 500)) {
      const o = cleanOrigin(s);
      if (o && !seen.has(o)) { seen.add(o); sites.push(o); }
    }
  }

  const v1 = typeof r.v === 'number' && r.v < 2;
  const concurrency = v1 && r.concurrency === 2 && r.tier !== 'paid' ? d.concurrency : r.concurrency;
  const prefetch = v1 && r.prefetch === 1.5 ? d.prefetch : r.prefetch;

  return {
    v: 2,
    model,
    customModel,
    tier: r.tier === 'paid' ? 'paid' : 'free',
    lang: typeof r.lang === 'string' && isLangCode(r.lang) ? r.lang : d.lang,
    sites,
    allSites: bool(r.allSites, d.allSites),
    rpm: int(r.rpm, 1, 10000, d.rpm),
    concurrency: int(concurrency, 1, 16, d.concurrency),
    batch: int(r.batch, 1, 6, d.batch),
    dailyBudget: num(r.dailyBudget, 0, 1000, d.dailyBudget),
    dailyRequests: int(r.dailyRequests, 0, 1_000_000, d.dailyRequests),
    maxSide: int(r.maxSide, 512, 3072, d.maxSide),
    economy: bool(r.economy, d.economy),
    transcribe: bool(r.transcribe, d.transcribe),
    minSide: int(r.minSide, 40, 1000, d.minSide),
    prefetch: num(prefetch, 0, 5, d.prefetch),
    sensitivity: num(r.sensitivity, 0, 1, d.sensitivity),
    font: cleanFont(r.font),
    bold: bool(r.bold, d.bold),
    textScale: Math.round(num(r.textScale, 0.5, 2.5, d.textScale) * 20) / 20,
    caps: bool(r.caps, d.caps),
  };
}

/** @returns {Promise<Settings>} */
export async function loadSettings() {
  try {
    return sanitize(await idbGet('kv', KEY));
  } catch {
    return sanitize(undefined);
  }
}

/**
 * @param {Partial<Settings>} patch
 * @returns {Promise<Settings>}
 */
export async function saveSettings(patch) {
  const next = await idbUpdate('kv', KEY, (cur) => sanitize({ ...sanitize(cur), ...patch }));
  announce();
  return next;
}

function announce() {
  try {
    const bc = new BroadcastChannel(SETTINGS_CHANNEL);
    bc.postMessage('changed');
    bc.close();
  } catch {}
  try {
    chrome.runtime.sendMessage({ t: 'ui:settings' }).catch(() => {});
  } catch {}
}

/**
 * @param {() => void} cb
 * @returns {() => void}
 */
export function onSettingsChanged(cb) {
  const bc = new BroadcastChannel(SETTINGS_CHANNEL);
  bc.onmessage = () => cb();
  return () => bc.close();
}

/** @param {Settings} s */
export function resultSignature(s) {
  const model = s.model === 'custom' ? s.customModel || DEFAULT_MODEL : s.model;
  return [s.lang, model, s.transcribe ? 't' : '', s.economy ? 'e' : ''].join('|');
}
