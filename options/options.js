// @ts-check
import { loadSettings, saveSettings, tierPreset, DEFAULT_FONT, sanitize, onSettingsChanged } from '../shared/settings.js';
import { MODELS } from '../shared/models.js';
import { LANGUAGES } from '../shared/languages.js';
import { getApiKey, setApiKey, normalizeKey } from '../shared/secrets.js';
import { ALL, requestAccess, ACCESS_HELP } from '../shared/access.js';

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
/** @type {(HTMLInputElement | HTMLSelectElement)[]} */
const bound = Array.from(document.querySelectorAll('[data-key]'));

/** @type {Settings} */
let current = sanitize(undefined);
/** @type {ReturnType<typeof setTimeout> | 0} */
let flashTimer = 0;

/** @param {string} text */
function flash(text) {
  const el = $('saved');
  el.textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.textContent = ''; }, 1800);
}

/** @param {UiToSw} msg @returns {Promise<any>} */
function send(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => null);
}

function fillSelects() {
  const model = /** @type {HTMLSelectElement} */ ($('model'));
  for (const m of Object.values(MODELS)) model.append(new Option(m.label, m.id));
  model.append(new Option('Custom model ID', 'custom'));
  const lang = /** @type {HTMLSelectElement} */ ($('lang'));
  for (const l of LANGUAGES) lang.append(new Option(l.name, l.code));
  /** @type {HTMLInputElement} */ ($('font')).placeholder = DEFAULT_FONT;
}

/** @param {HTMLInputElement | HTMLSelectElement} el */
function readField(el) {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number' || el.type === 'range') return Number(el.value);
    return el.value;
  }
  return el.dataset.key === 'maxSide' ? Number(el.value) : el.value;
}

/** @param {Settings} s */
function writeFields(s) {
  current = s;
  const rec = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (s));
  for (const el of bound) {
    const key = /** @type {string} */ (el.dataset.key);
    const v = rec[key];
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!v;
    else if (el instanceof HTMLInputElement && el.type === 'radio') el.checked = el.value === v;
    else if (document.activeElement !== el) el.value = String(v ?? '');
  }
  $('customRow').hidden = s.model !== 'custom';
  renderSites(s);
  void renderPermission(s);
}

/** @param {Settings} s */
function renderSites(s) {
  const list = $('sites');
  list.replaceChildren();
  if (!s.sites.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No sites yet. Open a page with images and switch it on from the toolbar button.';
    list.append(li);
    return;
  }
  for (const origin of s.sites) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = origin.replace(/^https?:\/\//, '');
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = 'Remove';
    rm.setAttribute('aria-label', `Stop translating ${name.textContent}`);
    rm.addEventListener('click', async () => {
      writeFields(await saveSettings({ sites: current.sites.filter((o) => o !== origin) }));
      flash('Removed');
    });
    li.append(name, rm);
    list.append(li);
  }
}

let accessFailed = '';

/** @param {Settings} s */
async function renderPermission(s) {
  const has = await chrome.permissions.contains({ origins: ALL });
  if (has) accessFailed = '';
  $('permHint').hidden = has || (!s.sites.length && !s.allSites);
  $('permHelp').hidden = !accessFailed;
  $('permHelp').textContent = accessFailed ? `${accessFailed} ${ACCESS_HELP}` : '';
}

function askAccess() {
  void requestAccess().then((why) => { accessFailed = why; return renderPermission(current); });
}
chrome.permissions.onAdded.addListener(() => { void renderPermission(current); });

/** @param {Event} e */
async function onChange(e) {
  const el = /** @type {HTMLInputElement | HTMLSelectElement} */ (e.target);
  const key = el.dataset?.key;
  if (!key) return;
  /** @type {Record<string, unknown>} */
  const patch = {};
  if (el instanceof HTMLInputElement && el.type === 'radio') {
    if (!el.checked) return;
    patch[key] = el.value;
    if (key === 'tier') Object.assign(patch, tierPreset(el.value === 'paid' ? 'paid' : 'free'));
  } else {
    patch[key] = readField(el);
  }
  if (key === 'allSites' && patch[key] === true) askAccess();
  writeFields(await saveSettings(/** @type {Partial<Settings>} */ (patch)));
  flash('Saved');
  if ((key === 'model' || key === 'customModel') && (await getApiKey())) {
    await send({ t: 'ui:settings' });
    await checkKey();
  }
}

/** @param {string} text @param {boolean} [bad] */
function keyStatus(text, bad = false) {
  const status = $('keyStatus');
  status.textContent = text;
  status.classList.toggle('alert', bad);
}

async function initKey() {
  const key = await getApiKey();
  const input = /** @type {HTMLInputElement} */ ($('apiKey'));
  input.placeholder = key ? `Saved key ending in ${key.slice(-4)}` : 'Paste your API key';
  $('removeKey').hidden = !key;
  if (!key) keyStatus('No key saved yet.');
  return key;
}

async function checkKey() {
  keyStatus('Checking with Google…');
  /** @type {import('../background/gemini.js').KeyCheck | null} */
  const r = await send({ t: 'ui:testKey' });
  if (!r) keyStatus('The background worker didn’t answer. Reload the extension and try again.', true);
  else if (r.ok) keyStatus(`Key saved and working: ${r.message}`);
  else if (r.kind === 'model') keyStatus(`Your key works, but Google doesn’t offer the selected model to it. Pick another model below. (${r.message})`, true);
  else if (r.kind === 'quota') keyStatus(`Your key works, but its limit for the selected model is used up for now. (${r.message})`, true);
  else if (r.kind === 'key') keyStatus(`Google rejected this key: ${r.message}`, true);
  else keyStatus(`Couldn’t confirm the key: ${r.message}`, true);
}

$('saveKey').addEventListener('click', async () => {
  const input = /** @type {HTMLInputElement} */ ($('apiKey'));
  const value = normalizeKey(input.value);
  if (!value) {
    keyStatus((await getApiKey()) ? 'Paste a new key to replace the saved one.' : 'Paste a key first.');
    return;
  }
  if (!(await setApiKey(value))) {
    keyStatus('That can’t be an API key: it contains characters keys never have. Copy it again from Google AI Studio.', true);
    return;
  }
  input.value = '';
  await send({ t: 'ui:keyChanged' });
  await initKey();
  await checkKey();
});

$('testKey').addEventListener('click', async () => {
  if (!(await getApiKey())) { keyStatus('Save a key first.'); return; }
  await checkKey();
});

$('removeKey').addEventListener('click', async () => {
  await setApiKey('');
  await send({ t: 'ui:keyChanged' });
  await initKey();
  keyStatus('Key removed.');
});

$('grant').addEventListener('click', askAccess);

async function renderCache() {
  const r = await send({ t: 'ui:cacheStats' });
  $('cacheStats').textContent = r && r.ok
    ? `Results are saved for ${r.final} image addresses (${r.raw} distinct images), so revisits and reloads cost nothing.`
    : 'Couldn’t read the saved results.';
}

$('clearCache').addEventListener('click', async () => {
  await send({ t: 'ui:clearCache' });
  flash('Cleared');
  renderCache();
});

document.addEventListener('change', onChange);
onSettingsChanged(() => { loadSettings().then(writeFields); });

fillSelects();
loadSettings().then(writeFields);
initKey();
renderCache();
