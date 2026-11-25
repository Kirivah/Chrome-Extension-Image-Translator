import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.env.E2E_OUT || join(ROOT, 'tests', 'e2e', 'out');
mkdirSync(OUT, { recursive: true });
const SITE = 'http://127.0.0.1:8701';

let pw;
try { pw = await import('playwright'); } catch { pw = await import(process.env.PLAYWRIGHT_MODULE || '/opt/npm-tools/node_modules/playwright/index.mjs'); }
const { chromium } = pw;

const results = [];
let lastCheck = '(start)';
function check(name, ok, detail = '') {
  lastCheck = name;
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inWorker = (w, fn, arg) => Promise.race([w.evaluate(fn, arg), sleep(1500).then(() => { throw new Error('worker gone'); })]);
async function until(fn, ms = 20000, step = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

const server = spawn('python3', [join(ROOT, 'tests/e2e/server.py')], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve) => server.stdout.on('data', (d) => { if (String(d).includes('site :')) resolve(); }));
const log = async () => (await fetch(SITE + '/__log')).json();

const ext = mkdtempSync(join(tmpdir(), 'imgtr-ext-'));
for (const d of ['background', 'content', 'shared', 'popup', 'options', 'icons', 'fonts', 'manifest.json']) cpSync(join(ROOT, d), join(ext, d), { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
if (!manifest.host_permissions?.includes('<all_urls>') || manifest.optional_host_permissions) throw new Error('manifest: access to websites must be granted at install');
const patch = (file, from, to) => {
  const p = join(ext, file);
  const src = readFileSync(p, 'utf8');
  if (!src.includes(from)) throw new Error(`patch target missing in ${file}`);
  writeFileSync(p, src.replace(from, to));
};
patch('content/overlay.js', "('closed')", "('open')");
const NO_ANCHORS = !!process.env.E2E_NO_ANCHORS;
if (NO_ANCHORS) patch('content/anchor.js', 'const SUPPORTED = (() => {', 'const SUPPORTED = false && (() => {');
patch('shared/models.js', "export const API_BASE = 'https://generativelanguage.googleapis.com';", `export const API_BASE = '${SITE}';`);
patch('background/index.js', 'const registry = new ClientRegistry({ ready, hub, allowed, config: contentConfig });',
  'const registry = new ClientRegistry({ ready, hub, allowed, config: contentConfig });\nglobalThis.__testDropPorts = () => { for (const c of [...registry.clients]) { registry.drop(c); c.port.disconnect(); } };');

const userData = mkdtempSync(join(tmpdir(), 'imgtr-profile-'));
const context = await chromium.launchPersistentContext(userData, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1100, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let exitCode = 0;
try {
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  await until(() => sw.evaluate(() => !!(globalThis.chrome && chrome.scripting)), 10000);
  const opts = await context.newPage();
  for (let tries = 0; ; tries++) {
    try { await opts.goto(`chrome-extension://${extId}/options/options.html`); break; } catch (e) {
      if (tries >= 2 || !/interrupted/i.test(String(e))) throw e;
      await sleep(300);
    }
  }

  const swErrors = [];
  /** @type {Map<string, string>} */
  const swAfter = new Map();
  const swCdp = await context.newCDPSession(opts);
  const attached = new Set();
  swCdp.on('Target.receivedMessageFromTarget', ({ message }) => {
    let m;
    try { m = JSON.parse(message); } catch { return; }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      swErrors.push(text);
      if (!swAfter.has(text)) swAfter.set(text, lastCheck);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const text = 'exception: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      swErrors.push(text);
      if (!swAfter.has(text)) swAfter.set(text, lastCheck);
    }
  });
  swCdp.on('Target.targetCreated', async ({ targetInfo: t }) => {
    if (t.type !== 'service_worker' || !t.url.startsWith(`chrome-extension://${extId}/`) || attached.has(t.targetId)) return;
    attached.add(t.targetId);
    try {
      const { sessionId } = await swCdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: false });
      await swCdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 1, method: 'Runtime.enable' }) });
    } catch {}
  });
  await swCdp.send('Target.setDiscoverTargets', { discover: true });
  const probed = await until(async () => {
    await inWorker(sw, () => console.warn('[imgtr] e2e probe'));
    return swErrors.includes('[imgtr] e2e probe') || null;
  }, 5000, 300);
  check('worker console is observed', !!probed);
  swErrors.length = 0;
  await opts.evaluate(async (site) => {
    const m = await import('/shared/settings.js');
    await m.saveSettings({
      sites: [site], tier: 'paid', rpm: 1000, concurrency: 2, batch: 2,
      dailyBudget: 1, dailyRequests: 0, lang: 'en', prefetch: 2, minSide: 100,
    });
  }, SITE);
  const KEY = 'AIzaE2E.new-format.key_' + '0'.repeat(44);
  await opts.fill('#apiKey', `  "${KEY}"  `);
  await opts.click('#saveKey');
  const saveMsg = await until(async () => { const t = await opts.textContent('#keyStatus'); return /working|rejected/i.test(t || '') && t; });
  check('options: long new-format key (pasted with quotes/spaces) saves and is checked with Google', /working/i.test(saveMsg || ''), saveMsg || 'no answer');
  await opts.click('#testKey');
  const keyMsg = await until(async () => { const t = await opts.textContent('#keyStatus'); return /working|rejected/i.test(t || '') && t; });
  check('options: the key is checked with one tiny real request to the selected model', /working/i.test(keyMsg || '') && (await log()).keyTests >= 2, keyMsg || 'no answer');
  const stored = await opts.evaluate(async () => ({
    key: (await (await import('/shared/secrets.js')).getApiKey()).slice(-4),
    storageApi: typeof chrome.storage,
  }));
  const full = await opts.evaluate(async () => (await import('/shared/secrets.js')).getApiKey());
  check('options: key stored cleaned up, in extension IndexedDB; no chrome.storage permission at all', full === KEY && stored.storageApi === 'undefined', JSON.stringify(stored));
  const hiddenOk = await opts.evaluate(() => getComputedStyle(document.getElementById('customRow')).display === 'none');
  check('options: hidden rows stay hidden', hiddenOk);
  const guard = await opts.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules())
    .filter((r) => r.id >= 6000 && r.id <= 6006 && r.action.type === 'block').map((r) => r.id));
  check('network guard: all private-address block rules are installed', guard.length === 7, JSON.stringify(guard));
  await opts.screenshot({ path: join(OUT, 'options.png'), fullPage: true });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

  const layers = (p = page) => p.evaluate(() => [...document.querySelectorAll('imgtr-layer')].map((h) => {
    const sib = h.previousElementSibling;
    const img = sib?.tagName === 'IMG' ? sib : sib?.querySelector?.('img');
    const sr = h.shadowRoot;
    const f = sr.querySelector('.f').getBoundingClientRect();
    const r = img.getBoundingClientRect();
    return {
      id: img?.id,
      n: sr.querySelectorAll('.t').length,
      fills: sr.querySelectorAll('.p.fill').length,
      blurs: sr.querySelectorAll('.p.blur').length,
      erased: sr.querySelectorAll('.p.img').length,
      texts: [...sr.querySelectorAll('.t span')].map((s) => s.textContent),
      fonts: [...sr.querySelectorAll('.t')].map((t) => t.style.fontSize),
      spans: [...sr.querySelectorAll('.t > span')].map((t) => t.getBoundingClientRect().toJSON()),
      host: h.getBoundingClientRect().toJSON(),
      frame: { x: f.x, y: f.y, w: f.width, h: f.height },
      img: { x: r.x, y: r.y, w: r.width, h: r.height },
      display: getComputedStyle(h).display,
    };
  }));
  const byId = async (p = page) => Object.fromEntries((await layers(p)).map((l) => [l.id, l]));
  const drawn1 = (l, n) => l?.n === n && l.frame.w > 0;
  const firstScreen = (L) => drawn1(L.manga, 5) && drawn1(L.pos, 1) && drawn1(L.sign, 1) && drawn1(L.meme, 1) && drawn1(L.hot, 1);

  const t0 = Date.now();
  await page.goto(SITE + '/');
  const first = await until(async () => { const L = await byId(); return firstScreen(L) ? L : null; }, 25000);
  const firstMs = Date.now() - t0;
  const L = first || await byId();
  check('manga page: 5 blocks translated', L.manga?.n === 5, JSON.stringify(L.manga?.texts));
  check('manga page: 4 bubbles/caption filled, SFX over art erased exactly (not blurred)', L.manga?.fills === 4 && L.manga?.erased === 1 && L.manga?.blurs === 0,
    `fills=${L.manga?.fills} erased=${L.manga?.erased} blurs=${L.manga?.blurs}`);
  check('same-origin image read from the page (no re-download)', L.sign?.n === 1, JSON.stringify(L.sign?.texts));
  check('blob: image read from the page', L.meme?.n === 1, JSON.stringify(L.meme?.texts));
  check('hotlink-protected CDN image fetched with page Referer', L.hot?.n === 1);
  check('tiny icon skipped', !L.icon);
  check(`first screen translated in ${firstMs} ms (mock model ~0.3–0.6 s/request)`, !!first);
  const m = L.manga;
  if (m) {
    const d = Math.max(Math.abs(m.host.x - m.img.x), Math.abs(m.host.y - m.img.y), Math.abs(m.host.width - m.img.w), Math.abs(m.host.height - m.img.h));
    check('overlay aligned to the image (px error)', d <= 1.5, d.toFixed(2));
    check('font sizes stored in container units (scale with the image)', m.fonts.every((f) => f.endsWith('cqw')), m.fonts.join(' '));
  }
  const s = L.sign;
  if (s) {
    const want = { x: s.img.x, y: s.img.y + 70, w: 420, h: 280 };
    const d = Math.max(Math.abs(s.frame.x - want.x), Math.abs(s.frame.y - want.y), Math.abs(s.frame.w - want.w), Math.abs(s.frame.h - want.h));
    check('object-fit: contain handled', d <= 1.5, JSON.stringify(s.frame));
  }
  const posEl = await page.$('#pos');
  await posEl.scrollIntoViewIfNeeded();
  await sleep(200);
  const withOverlay = await posEl.screenshot();
  await page.keyboard.down('Alt');
  await sleep(120);
  const without = await posEl.screenshot();
  await page.keyboard.up('Alt');
  check('overlay paints above a positioned, z-indexed, composited image', !withOverlay.equals(without));
  const farAsked = (await log()).segments.filter((x) => ['lazy.png', 'dynamic.png', 'strip.png'].includes(x[0])).map((x) => x[0]);
  check('images far below the prefetch zone are not requested yet (no wasted calls)', farAsked.length === 0, farAsked.join(', '));
  check('an image inside an editable area gets no layer (it would be written into what is edited)', !(await byId()).edit);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(OUT, 'page-top.png') });
  await (await page.$('#manga')).screenshot({ path: join(OUT, 'manga-translated.png') });

  await page.evaluate(() => {
    const r = document.getElementById('lazy').getBoundingClientRect();
    window.scrollBy(0, r.top - 2 * window.innerHeight);
  });
  const early = await until(async () => ((await log()).segments.some((x) => x[0] === 'lazy.png') ? true : null), 15000);
  const stillPlaceholder = await page.evaluate(() => document.getElementById('lazy').src.startsWith('data:'));
  check('lazy-loading site: a page is translated ahead, from the address the site keeps for it', !!early && stillPlaceholder,
    `asked=${!!early} placeholder still shown=${stillPlaceholder}`);
  await sleep(1500);
  const tLazy = Date.now();
  await page.evaluate(() => document.getElementById('lazy').scrollIntoView({ block: 'center' }));
  const lazyDone = await until(async () => (await byId()).lazy?.n === 1, 15000, 25);
  const lazyMs = Date.now() - tLazy;
  check('lazy-loaded image (src swapped by the page) translated', !!lazyDone);
  check(`…and drawn as soon as the site shows it (${lazyMs} ms), with one request`,
    !!lazyDone && lazyMs < 800 && (await log()).segments.filter((x) => x[0] === 'lazy.png').length === 1, `${lazyMs} ms`);
  await page.evaluate(() => document.getElementById('reader').scrollIntoView({ block: 'center' }));
  const later = await until(async () => {
    const X = await byId();
    return X.dynamic?.n === 1 && X.strip?.n === 4 ? X : null;
  }, 25000);
  const X = later || await byId();
  check('image inserted after load (SPA / infinite scroll) translated', X.dynamic?.n === 1);
  check('tall strip split into segments, cut bubble deduplicated', X.strip?.n === 4, JSON.stringify(X.strip?.texts));

  const truth = JSON.parse(readFileSync(join(ROOT, 'tests/e2e/www/truth.json'), 'utf8'));
  const files = { manga: 'manga.png', pos: 'positioned.png', sign: 'sign.jpg', meme: 'meme.png', hot: 'hotlink.png', lazy: 'lazy.png', dynamic: 'dynamic.png', strip: 'strip.png' };
  const drawn = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('imgtr-layer')].map((h) => {
    const sib = h.previousElementSibling;
    const img = sib?.tagName === 'IMG' ? sib : sib?.querySelector?.('img');
    const pct = (/** @type {string} */ v) => parseFloat(v) / 100;
    const sr = h.shadowRoot;
    const frame = sr.querySelector('.f').getBoundingClientRect();
    return [img.id, {
      patches: [...sr.querySelectorAll('.p')].map((p) => ({ x: pct(p.style.left), y: pct(p.style.top), w: pct(p.style.width), h: pct(p.style.height) })),
      fonts: [...sr.querySelectorAll('.t')].map((t) => t.getBoundingClientRect().width ? parseFloat(getComputedStyle(t).fontSize) : 0),
      texts: [...sr.querySelectorAll('.t')].map((t) => t.textContent),
      hyphens: [...sr.querySelectorAll('.t > span')].map((s) => getComputedStyle(s).hyphens),
      frameW: frame.width,
    }];
  })));
  const uncovered = [];
  for (const [id, file] of Object.entries(files)) {
    const L = drawn[id];
    const T = truth[file];
    if (!L) { uncovered.push(`${id}: no overlay`); continue; }
    for (const b of T.blocks) {
      const [x0, y0, x1, y1] = b.ink.map((v, i) => v / (i % 2 ? T.h : T.w));
      let hit = 0; let all = 0;
      for (let i = 0; i < 24; i++) {
        for (let j = 0; j < 24; j++) {
          const x = x0 + ((i + 0.5) / 24) * (x1 - x0);
          const y = y0 + ((j + 0.5) / 24) * (y1 - y0);
          all++;
          if (L.patches.some((p) => x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h)) hit++;
        }
      }
      if (hit / all < 0.97) uncovered.push(`${id} "${b.t}": ${((100 * hit) / all).toFixed(0)}%`);
    }
  }
  check('rough boxes from the model: the patches still hide all of the original lettering', uncovered.length === 0, uncovered.join('; '));
  const hyphenated = Object.entries(drawn).flatMap(([id, L]) => L.hyphens.filter((h) => h !== 'manual').map(() => id));
  check('no automatic hyphenation (words stay whole)', hyphenated.length === 0, hyphenated.join(', '));
  const mg = drawn.manga;
  const sizes = mg ? mg.fonts.map((v, i) => ({ t: mg.texts[i], v: (v * truth['manga.png'].w) / mg.frameW })).filter((x) => x.v > 0 && x.t !== 'BOOM') : [];
  check('translations are set no larger than the original lettering', sizes.length === 4 && sizes.every((x) => x.v <= 1.1 * 40 * 1.02),
    sizes.map((x) => `${x.t}: ${x.v.toFixed(1)}`).join(', '));
  const nested = await page.evaluate(() => {
    document.getElementById('reader').scrollTop = 600;
    const img = document.getElementById('strip');
    const h = img.nextElementSibling;
    return h?.localName === 'imgtr-layer' ? { host: h.getBoundingClientRect().y, img: img.getBoundingClientRect().y } : null;
  });
  check('overlay scrolls with a nested scroll container, in the same frame', !!nested && Math.abs(nested.host - nested.img) <= 1, JSON.stringify(nested));
  await (await page.$('#reader')).screenshot({ path: join(OUT, 'strip-in-reader.png') });

  const before = await log();
  check('requests were batched (same-site images share a request)', before.batches.some((b) => b > 1), JSON.stringify(before.batches));

  await page.evaluate(() => { /** @type {HTMLElement} */ (document.getElementById('meme').closest('figure')).contentEditable = 'true'; });
  const unlayered = await until(async () => ((await byId()).meme ? null : true), 6000);
  check('…and a translated image made editable later loses its layer', !!unlayered);

  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(200);
  const t1 = Date.now();
  await page.reload();
  const again = await until(async () => (firstScreen(await byId()) ? true : null), 15000, 25);
  const reloadMs = Date.now() - t1;
  const after = await log();
  check(`reload rescans automatically and paints from cache in ${reloadMs} ms`, !!again);
  check('reload made zero new model requests', after.requests === before.requests, `${before.requests} → ${after.requests}`);

  const reqBeforeScroll = (await log()).requests;
  const sp = await context.newPage();
  sp.on('pageerror', (e) => pageErrors.push(String(e)));
  await sp.goto(SITE + '/scroll.html');
  const SCROLL_IDS = ['b-manga', 'b-moved', 'b-shift', 'b-scoped', 'b-fixed', 'b-sticky'];
  const ANCHORED_IDS = NO_ANCHORS ? [] : ['b-manga', 'b-moved', 'b-shift', 'b-fixed'];
  const CHECK_IDS = NO_ANCHORS ? SCROLL_IDS.filter((id) => id !== 'b-shift') : SCROLL_IDS;
  await sp.evaluate(() => {
    window.__gap = (id) => {
      const img = document.getElementById(id);
      const h = img?.nextElementSibling;
      if (!img || !h || h.localName !== 'imgtr-layer' || !h.shadowRoot.querySelector('.t')) return null;
      const cs = getComputedStyle(img);
      const n = (v) => parseFloat(v) || 0;
      const r = img.getBoundingClientRect();
      const sx = r.width / img.offsetWidth;
      const sy = r.height / img.offsetHeight;
      const x = r.left + (n(cs.borderLeftWidth) + n(cs.paddingLeft)) * sx;
      const y = r.top + (n(cs.borderTopWidth) + n(cs.paddingTop)) * sy;
      const w = r.width - (n(cs.borderLeftWidth) + n(cs.paddingLeft) + n(cs.borderRightWidth) + n(cs.paddingRight)) * sx;
      const hh = r.height - (n(cs.borderTopWidth) + n(cs.paddingTop) + n(cs.borderBottomWidth) + n(cs.paddingBottom)) * sy;
      const b = h.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) return -1;
      return Math.round(100 * Math.max(Math.abs(b.left - x), Math.abs(b.top - y), Math.abs(b.width - w), Math.abs(b.height - hh))) / 100;
    };
    window.__gaps = (ids) => Object.fromEntries(ids.map((id) => [id, window.__gap(id)]));
    window.__frames = (n) => new Promise((res) => { const f = () => (--n <= 0 ? res(undefined) : requestAnimationFrame(f)); requestAnimationFrame(f); });
  });
  const gaps = (ids = SCROLL_IDS) => sp.evaluate((x) => window.__gaps(x), ids);
  const aligned = (g, ids = CHECK_IDS) => !!g && ids.every((id) => typeof g[id] === 'number' && g[id] >= 0 && g[id] <= 1);
  const TOP_IDS = SCROLL_IDS.filter((id) => id !== 'b-sticky');
  const drawnAll = await until(async () => { const g = await gaps(TOP_IDS); return TOP_IDS.every((id) => g[id] !== null) ? g : null; }, 15000);
  if (drawnAll) await sp.evaluate(() => window.__frames(2));
  const rest = drawnAll && await gaps(TOP_IDS);
  check('scroll layouts drawn from the cache (no new requests)', !!rest && (await log()).requests === reqBeforeScroll, JSON.stringify(rest));
  check('…each overlay exactly on its image: bordered + padded + flex-centred, script-positioned, scaled + shifted, fixed, not anchorable',
    aligned(rest, CHECK_IDS.filter((id) => id !== 'b-sticky')), JSON.stringify(rest));
  const jump = await sp.evaluate(async (ids) => {
    document.body.scrollTop = 1700;
    await window.__frames(1);
    const first = window.__gaps(ids);
    await new Promise((r) => setTimeout(r, 300));
    return { first, settled: window.__gaps(ids), windowY: window.scrollY, bodyY: document.body.scrollTop };
  }, SCROLL_IDS);
  check('<body> as the scroller: overlays move with their images in the very next frame, no script involved',
    jump.windowY === 0 && jump.bodyY === 1700 && aligned(jump.first, ANCHORED_IDS) && aligned(jump.settled), JSON.stringify(jump));
  await sp.screenshot({ path: join(OUT, 'body-scroller.png') });
  const glide = await sp.evaluate(async (ids) => {
    document.body.scrollTop = 1900;
    await window.__frames(1);
    const first = window.__gaps(ids);
    await window.__frames(1);
    return { first, second: window.__gaps(ids) };
  }, SCROLL_IDS);
  check('…and one placed by margins (the browser won’t anchor to it) is realigned in the scroll’s own frame',
    aligned(glide.first, ANCHORED_IDS) && aligned(glide.second), JSON.stringify(glide));
  const stuck = await sp.evaluate(async (ids) => {
    const box = document.getElementById('sticky-box');
    const out = [];
    for (const dy of [300, 650]) {
      document.body.scrollTop = box.offsetTop + dy;
      await window.__frames(2);
      out.push({ top: Math.round(document.getElementById('b-sticky').getBoundingClientRect().top), gaps: window.__gaps(ids) });
    }
    return out;
  }, SCROLL_IDS);
  check('a sticky image (stuck while the page scrolls) and a fixed one: overlays stay on them',
    stuck.every((x) => x.top === 20 && aligned(x.gaps, ['b-sticky', 'b-fixed'])), JSON.stringify(stuck));
  const cloned = await sp.evaluate(async () => {
    const img = document.getElementById('b-manga');
    img.scrollIntoView({ block: 'start' });
    await window.__frames(2);
    const copy = /** @type {HTMLImageElement} */ (img.cloneNode());
    copy.id = 'b-copy';
    copy.style.cssText += ';position:fixed;left:0;top:0;width:60px;height:90px';
    const carried = copy.getAttribute('style').includes('--imgtr-');
    document.body.append(copy);
    await window.__frames(2);
    const out = { carried, gap: window.__gap('b-manga'), copyStyle: copy.getAttribute('style') };
    copy.remove();
    return out;
  });
  check('an image the page clones: the copy loses the anchor name, the overlay stays on the original',
    cloned.carried !== NO_ANCHORS && cloned.gap >= 0 && cloned.gap <= 1 && !cloned.copyStyle.includes('--imgtr-'), JSON.stringify(cloned));
  await sp.evaluate(async () => {
    document.getElementById('b-moved').scrollIntoView({ block: 'center' });
    await window.__frames(2);
  });
  const moved = await sp.evaluate(() => {
    const img = document.getElementById('b-moved');
    img.style.top = '95px';
    img.style.left = '72px';
    return window.__gap('b-moved');
  });
  if (NO_ANCHORS) {
    const later = await until(async () => { const g = (await gaps(['b-moved']))['b-moved']; return g >= 0 && g <= 1 ? String(g) : null; }, 1500, 50);
    check('an image the page moves by script: its overlay follows within the periodic check', later !== null, `${moved} → ${later}`);
  } else {
    check('an image the page moves by script: its overlay moves with it, in the same frame', typeof moved === 'number' && moved >= 0 && moved <= 1, String(moved));
  }
  const wiped = await sp.evaluate(async () => {
    const img = document.getElementById('b-moved');
    await window.__frames(2);
    img.setAttribute('style', 'top: 95px; left: 72px');
    const meanwhile = window.__gap('b-moved');
    await Promise.resolve();
    return { meanwhile, next: window.__gap('b-moved'), style: img.getAttribute('style') };
  });
  check('a page that rewrites the image’s style: the anchor name is back before anything is drawn',
    (wiped.meanwhile === -1 || (wiped.meanwhile >= 0 && wiped.meanwhile <= 1)) && wiped.next >= 0 && wiped.next <= 1 && wiped.style.includes('--imgtr-') !== NO_ANCHORS,
    JSON.stringify(wiped));
  await sp.close();

  const rp = await context.newPage();
  rp.on('pageerror', (e) => pageErrors.push(String(e)));
  await rp.goto(SITE + '/reader.html');
  const shownText = () => rp.evaluate(() => {
    const host = document.getElementById('page')?.nextElementSibling;
    return host?.localName === 'imgtr-layer' && host.shadowRoot ? [...host.shadowRoot.querySelectorAll('.t span')].map((t) => t.textContent).join('|') : '';
  });
  const p1 = await until(async () => ((await shownText()) === 'Page one' ? true : null), 15000);
  await rp.click('#next');
  const p2 = await until(async () => ((await shownText()) === 'Page two' ? true : null), 15000);
  const asked = await until(async () => {
    const l = await log();
    return ['pages/3.png', 'pages/4.png'].every((n) => l.segments.some((sg) => sg[0] === n)) ? l : null;
  }, 15000);
  await sleep(1500);
  const reqBeforeTurn = (await log()).requests;
  const turned = Date.now();
  await rp.click('#next');
  const p3 = await until(async () => ((await shownText()) === 'Page three' ? true : null), 5000, 20);
  const turnMs = Date.now() - turned;
  const reqAfterTurn = (await log()).requests;
  check(`a reader showing one page at a time: the next pages translated ahead, and page 3 shown translated ${turnMs} ms after turning to it, nothing asked then`,
    !!p1 && !!p2 && !!asked && !!p3 && reqAfterTurn === reqBeforeTurn && turnMs < 1500,
    `pages fetched: ${(await log()).pages.join(' ')}; requests ${reqBeforeTurn} → ${reqAfterTurn}`);
  await rp.close();

  const rq = await context.newPage();
  rq.on('pageerror', (e) => pageErrors.push(String(e)));
  await rq.goto(SITE + '/reader2.html');
  const leafText = () => rq.evaluate(() => {
    const host = document.getElementById('page')?.nextElementSibling;
    return host?.localName === 'imgtr-layer' && host.shadowRoot ? [...host.shadowRoot.querySelectorAll('.t span')].map((t) => t.textContent).join('|') : '';
  });
  const leaf1 = await until(async () => ((await leafText()) === 'First leaf' ? true : null), 15000);
  const leafAsked = await until(async () => ((await log()).segments.some((sg) => sg[0] === 'pages/m3x9.png') ? true : null), 15000);
  await sleep(1500);
  const leafAskedFor = (/** @type {{segments: [string][]}} */ l) => l.segments.filter((sg) => sg[0] === 'pages/m3x9.png').length;
  const beforeLeaf = await log();
  const reqBeforeLeaf = beforeLeaf.requests;
  const leafTurned = Date.now();
  await rq.click('#next');
  const leaf2 = await until(async () => ((await leafText()) === 'Next leaf' ? true : null), 5000, 20);
  const leafMs = Date.now() - leafTurned;
  const leafLog = await log();
  check(`…and one that loads the next page ahead itself: that page translated too, shown translated ${leafMs} ms after turning to it, nothing asked for it then`,
    !!leaf1 && !!leafAsked && !!leaf2 && leafAskedFor(leafLog) === leafAskedFor(beforeLeaf) && leafMs < 1500,
    `pages fetched: ${leafLog.pages.filter((x) => !/\/\d\.png$/.test(x)).join(' ')}; requests ${reqBeforeLeaf} → ${leafLog.requests}; asked: ${leafLog.segments.map((sg) => sg[0]).filter((x) => x.startsWith('pages/') && !/\/\d\.png$/.test(x)).join(' ')}`);
  await rq.close();

  const bk = await context.newPage();
  bk.on('pageerror', (e) => pageErrors.push(String(e)));
  await bk.goto(SITE + '/book.html?page=1');
  const bookText = () => bk.evaluate(() => {
    const host = document.querySelector('img.page-img')?.nextElementSibling;
    return host?.localName === 'imgtr-layer' && host.shadowRoot ? [...host.shadowRoot.querySelectorAll('.t span')].map((t) => t.textContent).join('|') : '';
  });
  const book1 = await until(async () => ((await bookText()) === 'Book one' ? true : null), 15000);
  await bk.click('img.page-img');
  await bk.waitForURL(/page=2/);
  const book2 = await until(async () => ((await bookText()) === 'Book two' ? true : null), 15000);
  const bookAsked = await until(async () => ((await log()).segments.some((sg) => sg[0] === 'pages/h3n.png') ? true : null), 15000);
  await sleep(1500);
  const reqBeforeBook = (await log()).requests;
  const bookTurned = Date.now();
  await bk.click('img.page-img');
  await bk.waitForURL(/page=3/);
  const book3 = await until(async () => ((await bookText()) === 'Book three' ? true : null), 5000, 20);
  const bookMs = Date.now() - bookTurned;
  const served = (await log()).book;
  check(`…and one with an address per page (…?page=2, ?page=3): the next pages fetched ahead, page 3 shown translated ${bookMs} ms after turning to it, nothing asked then`,
    !!book1 && !!book2 && !!bookAsked && !!book3 && (await log()).requests === reqBeforeBook && bookMs < 2500 && served.filter((n) => n === 3).length >= 2,
    `pages served: ${served.join(' ')}`);
  await bk.close();

  await page.bringToFront();
  await page.keyboard.down('Alt');
  await sleep(100);
  const peekHidden = (await layers()).every((l) => l.display === 'none');
  await page.keyboard.up('Alt');
  await sleep(100);
  const peekBack = (await layers()).every((l) => l.display === 'block');
  check('holding Alt hides overlays, releasing shows them', peekHidden && peekBack);

  const cdp = await context.newCDPSession(page);
  const worlds = [];
  cdp.on('Runtime.executionContextCreated', (e) => worlds.push(e.context));
  await cdp.send('Runtime.enable');
  await sleep(300);
  const csWorld = () => worlds.filter((c) => c.auxData?.type === 'isolated' && (c.origin || '').includes(extId)).at(-1);
  const inCs = async (expression) => {
    const w = csWorld();
    if (!w) return { error: 'no content-script world' };
    const r = await cdp.send('Runtime.evaluate', { contextId: w.id, awaitPromise: true, returnByValue: true, expression });
    return r.result.value ?? { error: r.exceptionDetails?.text };
  };
  const iso = await inCs(`(async () => ({
    running: typeof globalThis.__imgtr,
    storageApi: typeof chrome.storage,
    extensionDb: (await indexedDB.databases()).some((d) => d.name === 'imgtr'),
  }))()`);
  check('content script world: no chrome.storage, cannot open the extension database', iso.running === 'object' && iso.storageApi === 'undefined' && iso.extensionDb === false, JSON.stringify(iso));
  const leakedGlobals = await page.evaluate(() => [typeof window.__imgtr, typeof window.Overlay, typeof window.Client].join('/'));
  check('no extension globals leak into the page', leakedGlobals === 'undefined/undefined/undefined', leakedGlobals);

  const portBefore = await inCs('Client.isOpen()');
  await inWorker(sw, () => globalThis.__testDropPorts());
  await sleep(1500);
  const portAfterStop = await inCs('Client.isOpen()');
  check('idle tab does not reconnect when the worker drops it (worker can sleep)', portBefore === true && portAfterStop === false, `${portBefore} → ${portAfterStop}`);

  const tabId = await opts.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:8701/*' }))[0]?.id);
  const popup = await context.newPage();
  await popup.addInitScript((id) => {
    const q = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info) => (info && info.active ? [{ id, url: 'http://127.0.0.1:8701/' }] : q(info));
  }, tabId);
  await popup.setViewportSize({ width: 320, height: 420 });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await until(() => popup.textContent('#site').then((t) => t === '127.0.0.1'));
  await sleep(200);
  await popup.screenshot({ path: join(OUT, 'popup.png') });
  check('popup shows the site as on', await popup.isChecked('#siteToggle'));
  const reqBeforeRescan = (await log()).requests;
  await popup.click('#rescan');
  const rescanned = await until(async () => (firstScreen(await byId()) && (await inCs('Client.isOpen()')) === true) || null, 8000);
  check('popup "Rescan" reaches the idle tab and repaints from cache', !!rescanned && (await log()).requests === reqBeforeRescan);
  await popup.click('#original');
  const orig = await until(async () => (await layers()).every((l) => l.display === 'none'), 3000);
  await popup.click('#original');
  const back = await until(async () => (await layers()).every((l) => l.display === 'block'), 3000);
  check('popup "Show original" toggles overlays', !!orig && !!back);

  await page.bringToFront();
  const asTab = await context.newPage();
  await asTab.goto(`chrome-extension://${extId}/popup/popup.html`);
  const tabSite = await until(() => asTab.textContent('#site').then((t) => (t === '127.0.0.1' ? t : null)), 5000);
  check('popup opened as a page of its own (as on phones) acts on the web page it came from', !!tabSite, String(await asTab.textContent('#site')));
  await asTab.close();

  const fontsOf = async () => ((await byId()).manga?.fonts ?? []).map((f) => parseFloat(f));
  const sizeBefore = await fontsOf();
  const reqBeforeSize = (await log()).requests;
  /** @param {number} pct */
  const setSize = (pct) => popup.evaluate((v) => {
    const s = /** @type {HTMLInputElement} */ (document.getElementById('size'));
    s.value = String(v);
    s.dispatchEvent(new Event('input', { bubbles: true }));
  }, pct);
  await setSize(150);
  const grown = await until(async () => {
    const f = await fontsOf();
    if (f.length !== sizeBefore.length || !f.length) return null;
    const k = f.map((v, i) => v / sizeBefore[i]);
    return k.every((v) => v >= 0.98) && Math.max(...k) >= 1.3 ? f : null;
  }, 6000);
  const spans = (await byId()).manga?.spans ?? [];
  /** @param {DOMRect} a @param {DOMRect} b */
  const meet = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const crossing = spans.flatMap((a, i) => spans.slice(i + 1).map((b) => meet(a, b))).filter((v) => v > 1).length;
  await setSize(100);
  const resized = await until(async () => { const f = await fontsOf(); return f.length === sizeBefore.length && f.every((v, i) => Math.abs(v - sizeBefore[i]) <= 0.02 * sizeBefore[i]) ? f : null; }, 6000);
  check('popup "Text size": the open page\'s translations set larger where there is room (none smaller, none over another), then back, with no new requests',
    !!grown && !crossing && !!resized && (await log()).requests === reqBeforeSize,
    `${sizeBefore.map((v) => v.toFixed(2)).join(' ')} → ${(grown ?? []).map((v) => v.toFixed(2)).join(' ')}; overlapping ${crossing}`);

  await page.evaluate(() => document.getElementById('reader').scrollIntoView({ block: 'center' }));
  await until(async () => (await byId()).strip?.n === 4, 8000);
  const pinnedPos = await page.evaluate(() => getComputedStyle(document.getElementById('reader')).position);
  await popup.click('#siteToggle');
  const gone = await until(async () => (await layers()).length === 0, 5000);
  check('turning the site off removes overlays', !!gone);
  const restoredPos = await page.evaluate(() => getComputedStyle(document.getElementById('reader')).position);
  check('scroll container made relative while needed, restored afterwards', pinnedPos === 'relative' && restoredPos === 'static', `${pinnedPos} → ${restoredPos}`);
  const leftover = await page.evaluate(() => [...document.images].filter((i) => (i.getAttribute('style') || '').includes('--imgtr-') || (i.id === 'manga' && i.hasAttribute('style'))).map((i) => i.id));
  check('…and the images are left as they were (no anchor names, no style attribute added)', leftover.length === 0, leftover.join(', '));
  const reg = String(await opts.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length));
  check('content script unregistered when no sites are on', reg === '0', `registered=${reg}`);

  const reqBeforeOn = (await log()).requests;
  await page.evaluate(() => window.scrollTo(0, 0));
  await popup.click('#siteToggle');
  const resumed = await until(async () => firstScreen(await byId()) || null, 8000);
  check('switching the site back on resumes the open tab without reloading', !!resumed);
  check('…and uses the cache (no new requests)', (await log()).requests === reqBeforeOn);

  await popup.click('#siteToggle');
  await until(async () => (await layers()).length === 0, 5000);
  const fresh = await context.newPage();
  await fresh.goto(SITE + '/');
  await sleep(500);
  const freshBefore = await fresh.evaluate(() => document.querySelectorAll('imgtr-layer').length);
  const popup2 = await context.newPage();
  const freshId = await opts.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:8701/*' })).map((t) => t.id).at(-1));
  await popup2.addInitScript((id) => {
    const q = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info) => (info && info.active ? [{ id, url: 'http://127.0.0.1:8701/' }] : q(info));
  }, freshId);
  await popup2.goto(`chrome-extension://${extId}/popup/popup.html`);
  await until(() => popup2.textContent('#site').then((t) => t === '127.0.0.1'));
  await popup2.click('#siteToggle');
  const injected = await until(() => fresh.evaluate(() => {
    const h = [...document.querySelectorAll('imgtr-layer')];
    return h.length >= 3 && h.every((x) => x.shadowRoot.querySelectorAll('.t').length > 0);
  }), 10000);
  check('enabling from the popup injects into a tab that never had the scripts', freshBefore === 0 && !!injected);

  const failTab = await context.newPage();
  failTab.on('pageerror', (e) => pageErrors.push(String(e)));
  await failTab.goto(SITE + '/fail.html');
  const failScreen = async () => {
    const F = await byId(failTab);
    return F.loop?.n === 2 && F.stubborn?.n === 1 ? F : null;
  };
  const F1 = await until(failScreen, 15000);
  await until(async () => ((await log()).special['refuse.png'].length >= 2) || null, 15000);
  await sleep(300);
  const special = (await log()).special;
  check('an answer stuck in a loop is cut off and retried once', special['loop.png'].length === 2, JSON.stringify(special['loop.png']));
  check('…and the image ends up fully translated', F1?.loop.texts.join('|') === 'First line|Second line', JSON.stringify(F1?.loop?.texts));
  check('an answer that stays stuck keeps the bubble that came through (two requests, no more)',
    special['stubborn.png'].length === 2 && F1?.stubborn.texts.join('|') === 'First words',
    `${JSON.stringify(special['stubborn.png'])} ${JSON.stringify(F1?.stubborn?.texts)}`);
  check('an image Gemini never answers is retried once, then given up on', special['refuse.png'].length === 2, JSON.stringify(special['refuse.png']));
  const gc = (await log()).gc ?? {};
  check('requests to Gemini 3.5 Flash-Lite: minimal thinking, schema, no temperature (Google advises against it)',
    gc.thinkingConfig?.thinkingLevel === 'MINIMAL' && !!gc.responseJsonSchema && !('temperature' in gc) && !('thinkingBudget' in (gc.thinkingConfig ?? {})),
    JSON.stringify({ ...gc, responseJsonSchema: gc.responseJsonSchema ? '…' : undefined }));
  const failTabId = await opts.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:8701/fail.html' }))[0]?.id);
  const popup3 = await context.newPage();
  await popup3.addInitScript((id) => {
    const q = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info) => (info && info.active ? [{ id, url: 'http://127.0.0.1:8701/fail.html' }] : q(info));
  }, failTabId);
  await popup3.goto(`chrome-extension://${extId}/popup/popup.html`);
  const notice = await until(async () => { const t = await popup3.textContent('#notice'); return /Details/.test(t || '') && t; }, 5000);
  check('the popup says what went wrong, in Google’s or our own words',
    /couldn’t translate some images/.test(notice || '') && /Details: Gemini stopped without an answer \(OTHER\)/.test(notice || ''), notice || 'no notice');
  await popup3.screenshot({ path: join(OUT, 'popup-error.png') });
  const expected = '[imgtr] model: Gemini stopped without an answer (OTHER)';
  check('…and the worker console logs it once', swErrors.filter((m) => m === expected).length === 1, JSON.stringify(swErrors));
  await failTab.reload();
  const F2 = await until(failScreen, 15000);
  const afterReload = await until(async () => { const sp = (await log()).special; return sp['refuse.png'].length >= 4 ? sp : null; }, 15000);
  await sleep(300);
  const sp2 = (await log()).special;
  check('reload: the incomplete image comes from the cache (no new requests for it)',
    !!F2 && !!afterReload && sp2['stubborn.png'].length === 2 && sp2['loop.png'].length === 2, JSON.stringify(sp2));
  await popup3.click('#rescan');
  const retried = await until(async () => {
    const sp = (await log()).special;
    return sp['refuse.png'].length >= 6 && sp['stubborn.png'].length >= 4 ? sp : null;
  }, 15000);
  await sleep(300);
  const sp3 = (await log()).special;
  check('popup "Rescan" asks again for failed and incomplete images, not finished ones',
    !!retried && sp3['loop.png'].length === 2 && sp3['stubborn.png'].length === 4, JSON.stringify(sp3));

  const RETIRED_ID = 'gemini-2.5-flash-lite';
  const sentBefore = (await log()).byModel[RETIRED_ID] ?? 0;
  await opts.evaluate(async (id) => { await (await import('/shared/settings.js')).saveSettings({ model: id }); }, RETIRED_ID);
  await opts.click('#testKey');
  const modelMsg = await until(async () => { const t = await opts.textContent('#keyStatus'); return /doesn’t offer the selected model/.test(t || '') && t; }, 8000);
  check('options: the key test tells "this model isn’t offered to your key" apart from a bad key', !!modelMsg, modelMsg || 'no answer');
  const nm = await until(async () => {
    await popup3.reload();
    const t = await popup3.textContent('#notice').catch(() => '');
    return /doesn’t offer Gemini 2\.5 Flash-Lite to your API key/.test(t || '') && t;
  }, 15000, 400);
  await sleep(500);
  const sentToRetired = ((await log()).byModel[RETIRED_ID] ?? 0) - sentBefore;
  check('a model Google won’t serve: the popup names it and quotes Google', !!nm && /no longer available to new users/.test(nm || ''), nm || 'no notice');
  check('…and after the first refusals, the other images don’t each cost a request', sentToRetired >= 1 && sentToRetired <= 2, `requests=${sentToRetired}`);
  await popup3.screenshot({ path: join(OUT, 'popup-nomodel.png') });
  const segsBefore = (await log()).segments.length;
  await popup3.click('#notice button');
  const restored = await until(async () => ((await failScreen()) && firstScreen(await byId())) || null, 15000);
  const modelNow = await opts.evaluate(async () => (await (await import('/shared/settings.js')).loadSettings()).model);
  await until(async () => (((await log()).special['refuse.png'].length >= 8) || null), 15000);
  await sleep(300);
  const resent = (await log()).segments.slice(segsBefore).map((x) => x[0]);
  const paidAgain = resent.filter((n) => n !== 'refuse.png' && n !== 'stubborn.png');
  check('…one click switches to Gemini 3.5 Flash-Lite, and pages translate again from the cache',
    !!restored && modelNow === 'gemini-3.5-flash-lite' && paidAgain.length === 0, `model=${modelNow} re-sent: ${JSON.stringify(resent)}`);
  const notice2 = await (async () => { await popup3.reload(); await sleep(300); return popup3.textContent('#notice'); })();
  check('…and the popup no longer says the model isn’t offered', !/doesn’t offer/.test(notice2 || ''), notice2 || '');

  check('page world has no chrome.storage', (await page.evaluate(() => typeof globalThis.chrome?.storage)) === 'undefined');
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  const known = [expected, `[imgtr] nomodel: ${'This model models/gemini-2.5-flash-lite is no longer available to new users.'}`];
  const unexpected = swErrors.filter((m) => !known.some((k) => m === k || (k.endsWith('users.') && m.startsWith(k))));
  check('no other service worker errors or [imgtr] warnings', unexpected.length === 0,
    unexpected.slice(0, 3).map((m) => `${m} (logged after: ${swAfter.get(m)})`).join(' | '));
  await cdp.detach().catch(() => {});
  await swCdp.detach().catch(() => {});
  const final = await log();
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ firstMs, reloadMs, mock: final, results }, null, 2));
  console.log(`\nmodel requests: ${final.requests}, images: ${final.images}, batches: ${JSON.stringify(final.batches)}`);
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  await context.close();
  server.kill();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed || exitCode ? 1 : 0);
