// @ts-check
import { LANGUAGES } from '../shared/languages.js';
import { saveSettings } from '../shared/settings.js';
import { MODELS, DEFAULT_MODEL } from '../shared/models.js';
import { requestAccess, ACCESS_HELP } from '../shared/access.js';

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const bubble = $('bubble');
const site = $('site');
const line = $('bubbleLine');
const toggle = /** @type {HTMLInputElement} */ ($('siteToggle'));
const notice = $('notice');
const lang = /** @type {HTMLSelectElement} */ ($('lang'));
const rescan = /** @type {HTMLButtonElement} */ ($('rescan'));
const original = /** @type {HTMLButtonElement} */ ($('original'));
const usage = $('usage');
const work = $('work');
const size = /** @type {HTMLInputElement} */ ($('size'));
const sizeOut = /** @type {HTMLOutputElement} */ ($('sizeOut'));
let sizing = false;

/** @param {string} label */
const shortName = (label) => label.replace(/\s*\(.*\)\s*$/, '');

/** @type {Record<string, string>} */
const ERRORS = {
  nokey: 'No API key yet. Add one in Settings.',
  auth: 'Google rejected the API key. Check it in Settings.',
  nomodel: 'Google doesn’t offer the selected model to your API key.',
  quota: 'The request limit is reached for now. Translation resumes when it resets.',
  budget: 'Today’s spending cap is reached. Raise it in Settings to keep going.',
  blocked: 'Gemini’s safety filter refused some images.',
  model: 'Gemini couldn’t translate some images. Rescan to try again.',
  internal: 'Something went wrong while preparing some images. Rescan to try again.',
  net: 'Couldn’t reach Gemini. Check your connection, then rescan.',
  fetch: 'This site blocked downloading some images.',
  decode: 'Some images are in a format that can’t be read.',
  bad: 'Some image addresses weren’t valid.',
};

let tabId = -1;
/** @type {UiState | null} */
let state = null;
let showingOriginal = false;
let accessFailed = '';

/** @param {UiToSw} msg @returns {Promise<any>} */
function send(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => null);
}

/** @param {string} origin */
function host(origin) {
  try { return new URL(origin).hostname.replace(/^www\./, ''); } catch { return origin; }
}

/** @param {number} usd */
function money(usd) {
  return '$' + (usd > 0 && usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2));
}

/**
 * @param {string} text
 * @param {{label: string, run: () => void} | null} [action]
 * @param {string} [detail]
 */
function showNotice(text, action = null, detail = '') {
  notice.replaceChildren(document.createTextNode(text));
  if (detail) {
    const d = document.createElement('small');
    d.className = 'detail';
    d.textContent = `Details: ${detail}`;
    notice.append(document.createElement('br'), d);
  }
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', action.run);
    notice.append(document.createElement('br'), b);
  }
  notice.hidden = false;
}

/** @param {string} model */
async function switchModel(model) {
  await saveSettings({ model });
  await send({ t: 'ui:settings' });
  await refresh();
}

function grantAccess() {
  void requestAccess().then((why) => { accessFailed = why; return refresh(); });
}

function render() {
  const s = state;
  notice.hidden = true;
  work.hidden = true;
  if (!s || !s.ok) {
    showNotice('The extension’s background worker didn’t answer. Reload the extension from chrome://extensions.');
    toggle.disabled = true;
    return;
  }
  site.textContent = s.supported ? host(s.origin) : 'this page';
  line.textContent = s.supported ? 'Translate images on' : 'Chrome doesn’t allow translating';
  toggle.checked = s.enabled;
  toggle.disabled = !s.supported || s.allSites;
  bubble.dataset.on = String(s.enabled && s.perm);
  lang.value = s.lang;
  if (!sizing) showSize(Math.round((s.settings.textScale ?? 1) * 100));
  const active = s.enabled && s.perm;
  rescan.disabled = !active;
  original.disabled = !active;

  if (!s.supported) showNotice('Open a regular web page to translate its images.');
  else if (!s.hasKey) showNotice('Add your Gemini API key to start translating.', { label: 'Open settings', run: () => chrome.runtime.openOptionsPage() });
  else if (s.enabled && !s.perm) {
    showNotice(accessFailed ? ACCESS_HELP : 'The browser needs your permission for the extension to read images on websites.',
      { label: accessFailed ? 'Try again' : 'Grant access', run: grantAccess }, accessFailed);
  }
  else if (s.tab.lastError === 'nomodel') {
    const fallback = MODELS[DEFAULT_MODEL];
    const canSwitch = s.settings.model !== DEFAULT_MODEL;
    showNotice(
      `Google doesn’t offer ${shortName(s.model)} to your API key.`,
      canSwitch
        ? { label: `Switch to ${shortName(fallback.label)}`, run: () => { void switchModel(DEFAULT_MODEL); } }
        : { label: 'Pick another model', run: () => chrome.runtime.openOptionsPage() },
      s.tab.detail,
    );
  } else if (s.tab.lastError && ERRORS[s.tab.lastError]) {
    const settings = s.tab.lastError === 'auth' || s.tab.lastError === 'budget'
      ? { label: 'Open settings', run: () => chrome.runtime.openOptionsPage() } : null;
    showNotice(ERRORS[s.tab.lastError], settings, s.tab.detail);
  }

  renderWork(s.work, active);

  const u = s.usage;
  const cap = s.settings.dailyBudget > 0 ? ` of your ${money(s.settings.dailyBudget)} daily cap` : '';
  usage.replaceChildren(
    document.createTextNode('Today: '),
    Object.assign(document.createElement('strong'), { textContent: `${u.img} images` }),
    document.createTextNode(` (${u.hits} reused from saved results), ${u.req} requests, about ${money(u.cost)}${cap}.`),
  );
  if (s.allSites) usage.append(document.createTextNode(' Running on every site.'));
}

/**
 * @param {WorkStatus | undefined} w
 * @param {boolean} active
 */
function renderWork(w, active) {
  if (!active || !w || w.pending <= 0) { work.hidden = true; return; }
  const n = w.pending === 1 ? '1 image' : `${w.pending} images`;
  const secs = Math.max(1, Math.round(w.waitMs / 1000));
  const why = w.waitMs > 1000
    ? (w.limited
      ? `Google asked to slow down; continuing in ${secs} s.`
      : `Next request in ${secs} s (your plan’s per-minute limit).`)
    : w.slow ? 'Gemini is slow right now; stalled requests were sent again.' : '';
  work.replaceChildren(document.createTextNode(`Translating ${n}…`));
  if (why) work.append(' ', Object.assign(document.createElement('span'), { className: 'why', textContent: why }));
  work.hidden = false;
}

/** @type {ReturnType<typeof setTimeout> | 0} */
let poll = 0;

async function refresh() {
  state = await send({ t: 'ui:state', tabId });
  render();
  if (poll) clearTimeout(poll);
  poll = state?.ok && state.work?.pending > 0 ? setTimeout(() => { poll = 0; void refresh(); }, 1000) : 0;
}

toggle.addEventListener('change', () => {
  const on = toggle.checked;
  const pending = send({ t: 'ui:site', tabId, on });
  if (on && !state?.perm) grantAccess();
  pending.then((st) => { if (st && st.ok) { state = st; render(); } });
});

lang.addEventListener('change', async () => {
  await saveSettings({ lang: lang.value });
  refresh();
});

/** @param {number} pct */
function showSize(pct) {
  size.value = String(pct);
  sizeOut.textContent = `${pct}%`;
}

/** @type {ReturnType<typeof setTimeout> | 0} */
let sizeTimer = 0;
size.addEventListener('input', () => {
  sizing = true;
  const pct = Number(size.value);
  sizeOut.textContent = `${pct}%`;
  if (sizeTimer) clearTimeout(sizeTimer);
  sizeTimer = setTimeout(() => {
    sizeTimer = 0;
    void saveSettings({ textScale: pct / 100 }).finally(() => { sizing = false; });
  }, 120);
});

rescan.addEventListener('click', () => { send({ t: 'ui:cmd', tabId, c: 'rescan' }); });

original.addEventListener('click', () => {
  showingOriginal = !showingOriginal;
  original.setAttribute('aria-pressed', String(showingOriginal));
  original.textContent = showingOriginal ? 'Show translation' : 'Show original';
  send({ t: 'ui:cmd', tabId, c: 'original', v: showingOriginal });
});

$('openSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.permissions.onAdded.addListener(() => { accessFailed = ''; void refresh(); });

/** @returns {Promise<chrome.tabs.Tab | undefined>} */
async function pageTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const self = await chrome.tabs.getCurrent().catch(() => undefined);
  if (!self || active?.id !== self.id) return active;
  const others = (await chrome.tabs.query({})).filter((t) => t.id !== self.id);
  others.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return others.find((t) => /^https?:/.test(t.url ?? '')) ?? others[0] ?? active;
}

(async () => {
  for (const l of LANGUAGES) lang.append(new Option(l.name, l.code));
  const tab = await pageTab().catch(() => undefined);
  tabId = tab?.id ?? -1;
  await refresh();
})();
