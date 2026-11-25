// @ts-check
(() => {
  const G = /** @type {any} */ (globalThis);
  const prev = G.__imgtr;
  if (prev && typeof prev.alive === 'function' && prev.alive()) { prev.restart(); return; }
  if (prev && typeof prev.dispose === 'function') { try { prev.dispose(); } catch {} }
  const { Overlay, Capture, Client, Scanner, Preload, NextPage } = globalThis;

  const IDLE = 0;
  const PENDING = 1;
  const DONE = 2;
  const FAILED = 3;

  /**
   * @typedef {Object} St
   * @property {HTMLImageElement} img
   * @property {string} url
   * @property {number} id
   * @property {number} status
   * @property {InstanceType<typeof Overlay.Layer> | null} layer
   * @property {boolean} near
   * @property {boolean} visible
   * @property {number} w
   * @property {number} h
   * @property {Region[]} buffered
   * @property {boolean} lazy
   * @property {boolean} early
   * @property {string} failed
   */

  /** @type {WeakMap<HTMLImageElement, St>} */
  let states = new WeakMap();
  /** @type {Map<number, St>} */
  const jobs = new Map();
  /** @type {Set<St>} */
  const live = new Set();
  /** @type {Set<St>} */
  const onScreen = new Set();
  /** @type {Set<St>} */
  const dirty = new Set();
  /** @type {Set<St>} */
  const waitingGate = new Set();
  /** @type {Set<St>} */
  const waitingSwap = new Set();
  let lazyHits = 0;
  let lazyMisses = 0;
  /** @type {Set<St>} */
  let lazyOpen = new Set();
  let shownHosts = new Set([location.hostname]);

  /** @type {ContentConfig | null} */
  let cfg = null;
  let running = false;
  let gateOpen = false;
  let showOriginal = false;
  let peek = false;
  let leaving = false;
  let nextId = 1;
  let raf = 0;
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let sweepTimer = 0;
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let reconnectTimer = 0;
  /** @type {ReturnType<typeof setInterval> | 0} */
  let tick = 0;
  let shownPage = '';
  /** @type {St | null} */
  let mainPic = null;
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let lookTimer = 0;
  const preloads = new Map();
  let passed = new Set();

  /** @param {HTMLImageElement} img */
  const urlOf = (img) => img.currentSrc || img.src || '';

  const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-url'];

  /** @param {HTMLImageElement} img */
  function placeholder(img) {
    const u = urlOf(img);
    if (!u || u.startsWith('about:') || (u.startsWith('data:') && u.length < 3000)) return true;
    if (!img.complete || !img.naturalWidth) return false;
    const natural = img.naturalWidth * img.naturalHeight;
    const st = states.get(img);
    return natural < 20_000 && !!st && st.w * st.h >= 4 * natural;
  }

  /** @param {HTMLImageElement} img */
  function lazyUrlOf(img) {
    if (lazyMisses >= 2 || img.srcset || img.parentElement?.localName === 'picture') return '';
    for (const a of img.getAttributeNames()) if (/^data-.*srcset$/i.test(a)) return '';
    for (const a of LAZY_ATTRS) {
      const v = img.getAttribute(a);
      if (!v) continue;
      try {
        const u = new URL(v.trim(), document.baseURI);
        return (u.protocol === 'https:' || u.protocol === 'http:') && shownHosts.has(u.hostname) ? u.href : '';
      } catch { return ''; }
    }
    return '';
  }

  /** @param {HTMLImageElement} img */
  function targetOf(img) {
    if (!placeholder(img)) return urlOf(img);
    const src = img.getAttribute('src') ? img.src : '';
    if (src && src !== urlOf(img) && /^https?:/i.test(src)) return src;
    return lazyUrlOf(img) || urlOf(img);
  }

  /** @param {HTMLImageElement} img */
  function noteShown(img) {
    const u = urlOf(img);
    if (!/^https?:/i.test(u) || !img.complete || !img.naturalWidth || placeholder(img)) return;
    try { shownHosts.add(new URL(u).hostname); } catch {}
  }

  /** @param {St} st */
  function settleLazy(st) {
    st.lazy = false;
    lazyOpen.delete(st);
  }

  /** @param {St} st */
  function retryFromPage(st) {
    clearState(st);
    st.url = '';
    Scanner.refresh(st.img);
  }

  /** @param {HTMLImageElement} img @returns {St} */
  function stateOf(img) {
    let st = states.get(img);
    if (!st) {
      st = { img, url: '', id: 0, status: IDLE, layer: null, near: false, visible: false, w: 0, h: 0, buffered: [], lazy: false, early: false, failed: '' };
      states.set(img, st);
    }
    return st;
  }

  /** @param {St} st */
  function consider(st) {
    if (!running || !cfg) return;
    if (st.img.isContentEditable) { clearState(st); return; }
    noteShown(st.img);
    let url = targetOf(st.img);
    if (url !== st.url && url !== urlOf(st.img) && lazyOpen.size >= (lazyHits ? 8 : 2)) url = urlOf(st.img);
    if (url !== st.url) { clearState(st); st.url = url; }
    if (st.status !== IDLE || !st.near || !url || !eligible(st)) return;
    submit(st);
  }

  /** @param {St} st */
  function eligible(st) {
    const min = /** @type {ContentConfig} */ (cfg).minSide;
    if (st.w < min || st.h < min * 0.6) return false;
    const img = st.img;
    if (urlOf(img) === st.url && img.complete && img.naturalWidth && img.naturalWidth * img.naturalHeight < 20_000) return false;
    const u = st.url;
    if (/\.svg(?:[?#]|$)/i.test(u) || u.startsWith('data:image/svg')) return false;
    if (u.startsWith('data:') && u.length < 3000) return false;
    return /^(https?:|blob:|data:)/i.test(u);
  }

  /** @param {string} url */
  function besideShown(url) {
    let a; let b;
    try { a = new URL(url); b = new URL(shownPage); } catch { return false; }
    const dir = (/** @type {string} */ p) => p.slice(0, p.lastIndexOf('/') + 1);
    const ext = (/** @type {string} */ p) => p.slice(p.lastIndexOf('.')).toLowerCase();
    return a.origin === b.origin && a.href !== b.href && dir(a.pathname) === dir(b.pathname) && ext(a.pathname) === ext(b.pathname);
  }

  /** @param {string} url */
  function onPreload(url) {
    if (!running || passed.has(url)) return;
    preloads.delete(url);
    preloads.set(url, Date.now());
    if (preloads.size > 40) preloads.delete(/** @type {string} */ (preloads.keys().next().value));
    passPreloads();
  }

  function passPreloads() {
    if (!shownPage) return;
    const now = Date.now();
    /** @type {Set<string> | null} */
    let onPage = null;
    for (const [u, at] of preloads) {
      if (now - at > 60_000) { preloads.delete(u); continue; }
      if (!besideShown(u)) continue;
      onPage ??= new Set(Array.from(document.images, (im) => im.currentSrc || im.src));
      if (onPage.has(u)) { preloads.delete(u); continue; }
      preloads.delete(u);
      if (passed.size > 400) passed = new Set();
      passed.add(u);
      Client.sendIfOpen({ t: 'ahead', u, n: false });
    }
  }

  /** @param {St} st */
  function noteOnScreen(st) {
    if (!st.visible || !/^https?:/i.test(st.url)) return;
    const m = mainPic;
    if (m && m !== st && m.visible && m.img.isConnected && m.w * m.h >= st.w * st.h) return;
    mainPic = st;
    if (st.url === shownPage) return;
    shownPage = st.url;
    passPreloads();
    if (lookTimer) clearTimeout(lookTimer);
    lookTimer = setTimeout(() => {
      lookTimer = 0;
      const p = mainPic;
      if (running && p && p.visible && p.img.isConnected) void NextPage.look(p.img, (u) => Client.sendIfOpen({ t: 'ahead', u, n: true }));
    }, 300);
  }

  /** @param {St} st */
  function submit(st) {
    const u = Capture.jobUrl(st.url);
    if (!u) { st.status = FAILED; return; }
    const id = nextId++;
    const early = urlOf(st.img) !== st.url;
    st.early = early;
    st.failed = '';
    if (early) { st.lazy = true; lazyOpen.add(st); }
    const cap = early ? 0 : Capture.capOf(st.img, st.url);
    if (!Client.send({ t: 'job', id, u, p: st.visible ? 0 : 1, l: cap })) {
      if (!Client.alive()) stop();
      else scheduleReconnect();
      return;
    }
    st.id = id;
    st.status = PENDING;
    jobs.set(id, st);
    noteOnScreen(st);
  }

  /** @param {St} st */
  function cancelJob(st) {
    if (st.id) {
      jobs.delete(st.id);
      Client.sendIfOpen({ t: 'cancel', id: st.id });
      st.id = 0;
    }
    if (st.status === PENDING) st.status = IDLE;
  }

  /** @param {St} st */
  function clearState(st) {
    cancelJob(st);
    if (st.layer) { st.layer.destroy(); st.layer = null; }
    live.delete(st);
    onScreen.delete(st);
    dirty.delete(st);
    waitingGate.delete(st);
    waitingSwap.delete(st);
    settleLazy(st);
    st.buffered = [];
    st.status = IDLE;
  }

  /** @param {St} st @param {Region[]} regions */
  function render(st, regions) {
    if (!regions.length || !cfg) return;
    if (st.img.isContentEditable) { clearState(st); return; }
    if (!gateOpen) {
      st.buffered.push(...regions);
      waitingGate.add(st);
      return;
    }
    if (urlOf(st.img) !== st.url) {
      st.buffered.push(...regions);
      waitingSwap.add(st);
      return;
    }
    if (!st.layer) {
      st.layer = new Overlay.Layer(st.img, { font: cfg.font, bold: cfg.bold, lang: cfg.lang, scale: cfg.textScale, caps: cfg.caps });
      st.layer.mount();
      st.layer.setHidden(showOriginal || peek);
      live.add(st);
      if (st.visible) onScreen.add(st);
      Scanner.trackSize(st.img);
    }
    st.layer.add(regions);
    markDirty(st);
  }

  /** @param {St} st */
  function markDirty(st) {
    dirty.add(st);
    if (!raf) raf = requestAnimationFrame(frame);
  }

  /** @type {Map<HTMLImageElement, number>} */
  const moving = new Map();
  /** @param {Event} e */
  function onMotion(e) {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const st = states.get(img);
    if (!st?.layer) return;
    const ends = e.type === 'transitionend' || e.type === 'transitioncancel' || e.type === 'animationend' || e.type === 'animationcancel';
    if (ends) moving.set(img, performance.now() + 50);
    else moving.set(img, performance.now() + 5000);
    markDirty(st);
  }

  function frame() {
    raf = 0;
    if (!running) return;
    if (moving.size) {
      const now = performance.now();
      for (const [img, until] of moving) {
        const st = states.get(img);
        if (now > until || !st?.layer) moving.delete(img);
        else dirty.add(st);
      }
    }
    const items = [...dirty];
    dirty.clear();
    const measures = items.map((st) => (st.layer ? st.layer.measure() : null));
    let again = false;
    items.forEach((st, i) => {
      const m = measures[i];
      if (st.layer && m && !st.layer.apply(m)) { dirty.add(st); again = true; }
    });
    for (const st of items) st.layer?.fit();
    if ((again || moving.size) && !raf) raf = requestAnimationFrame(frame);
  }

  function applyVisibility() {
    const hide = showOriginal || peek;
    for (const st of live) st.layer?.setHidden(hide);
    if (!hide) for (const st of live) markDirty(st);
  }

  function openGateWhenReady() {
    const open = () => {
      if (gateOpen || !running) return;
      gateOpen = true;
      for (const st of waitingGate) {
        const r = st.buffered;
        st.buffered = [];
        if (st.img.isConnected && targetOf(st.img) === st.url) render(st, r);
      }
      waitingGate.clear();
    };
    const idle = () => (typeof requestIdleCallback === 'function' ? requestIdleCallback(open, { timeout: 400 }) : setTimeout(open, 60));
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', idle, { once: true });
    else idle();
  }

  /** @type {ScanHooks} */
  const hooks = {
    /** @param {HTMLImageElement} img @param {boolean} near @param {number} w @param {number} h */
    near(img, near, w, h) {
      const st = stateOf(img);
      st.near = near;
      if (w || h) { st.w = w; st.h = h; }
      if (near) consider(st);
      else if (st.status === PENDING) cancelJob(st);
    },
    /** @param {HTMLImageElement} img @param {boolean} visible */
    visible(img, visible) {
      const st = stateOf(img);
      st.visible = visible;
      if (st.layer) {
        if (visible) { onScreen.add(st); markDirty(st); } else onScreen.delete(st);
      }
      if (st.status === PENDING && st.id) Client.sendIfOpen({ t: 'prio', id: st.id, p: visible ? 0 : 1 });
      if (visible && st.status !== IDLE && st.status !== FAILED) noteOnScreen(st);
    },
    /** @param {HTMLImageElement} img */
    changed(img) {
      const st = states.get(img);
      noteShown(img);
      const target = targetOf(img);
      if (st && st.url && target !== st.url) {
        if (st.lazy && /^https?:/i.test(target) && !placeholder(img)) lazyMisses++;
        else if (st.lazy && /^https?:/i.test(target) && target === img.src) lazyMisses++;
        clearState(st);
        st.url = '';
      } else if (st && st.lazy && urlOf(img) === st.url) {
        const first = lazyHits === 0;
        lazyHits++;
        settleLazy(st);
        if (st.status === FAILED && st.failed === 'fetch') {
          retryFromPage(st);
        } else if (waitingSwap.has(st)) {
          waitingSwap.delete(st);
          const r = st.buffered;
          st.buffered = [];
          render(st, r);
        }
        if (first) Scanner.rescanAll();
      }
      Scanner.refresh(img);
      if (st?.layer) markDirty(st);
    },
    removed() {
      if (!sweepTimer) sweepTimer = setTimeout(sweep, 400);
    },
    /** @param {HTMLImageElement[]} imgs */
    resized(imgs) {
      for (const img of imgs) {
        const st = states.get(img);
        if (st?.layer) markDirty(st);
      }
    },
  };

  function sweep() {
    sweepTimer = 0;
    for (const st of [...live, ...jobs.values(), ...waitingGate, ...waitingSwap, ...lazyOpen]) {
      if (!st.img.isConnected) clearState(st);
    }
  }

  /** @param {SwToCs} m */
  function onMessage(m) {
    switch (m.t) {
      case 'cfg':
        applyConfig(m.c);
        return;
      case 'part': {
        const st = jobs.get(m.id);
        if (st && st.img.isConnected && targetOf(st.img) === st.url && Array.isArray(m.r)) render(st, m.r);
        return;
      }
      case 'drop': {
        const st = jobs.get(m.id);
        if (!st || !Array.isArray(m.k) || m.k.length > 500) return;
        const gone = new Set(m.k.filter((v) => typeof v === 'number'));
        if (st.buffered.length) st.buffered = st.buffered.filter((r) => r.i === undefined || !gone.has(r.i));
        st.layer?.remove([...gone]);
        return;
      }
      case 'done': {
        const st = jobs.get(m.id);
        if (st) { jobs.delete(m.id); st.id = 0; st.status = DONE; }
        return;
      }
      case 'err': {
        const st = jobs.get(m.id);
        if (!st) return;
        jobs.delete(m.id);
        st.id = 0;
        const later = m.e === 'busy' || m.e === 'cancelled';
        st.status = later ? IDLE : FAILED;
        st.failed = later ? '' : m.e;
        if (m.e === 'fetch' && st.early && st.img.isConnected && urlOf(st.img) === st.url) { retryFromPage(st); return; }
        if (later) setTimeout(() => { if (running && st.img.isConnected) Scanner.refresh(st.img); }, 3000);
        return;
      }
      case 'need': {
        const st = jobs.get(m.id);
        if (!st) { Client.send({ t: 'bytes', id: m.id, b: null }); return; }
        Capture.readImage(st.img).then((b) => {
          if (jobs.get(m.id) !== st) return;
          if (!b && leaving) return;
          Client.sendIfOpen({ t: 'bytes', id: m.id, b });
        });
      }
    }
  }

  /**
   * @param {unknown} raw
   * @param {chrome.runtime.MessageSender} sender
   */
  function onTabMessage(raw, sender) {
    if (sender.id !== chrome.runtime.id || sender.tab) return;
    const m = /** @type {SwToTab} */ (raw);
    if (!m || typeof m !== 'object') return;
    if (m.t === 'wake') { if (running) Client.connect(); else boot(); return; }
    if (m.t !== 'cmd' || !running) return;
    if (m.c === 'rescan') rescan(false);
    else if (m.c === 'original') { showOriginal = typeof m.v === 'boolean' ? m.v : !showOriginal; applyVisibility(); }
  }

  /** @param {ContentConfig} c */
  function applyConfig(c) {
    if (!c || !c.on) { stop(); return; }
    const prev = cfg;
    cfg = c;
    if (!running) { start(); return; }
    if (prev && (prev.gen !== c.gen || prev.minSide !== c.minSide || prev.font !== c.font || prev.bold !== c.bold || prev.lang !== c.lang)) {
      rescan(false);
    } else if (prev && prev.prefetch !== c.prefetch) {
      rescan(true);
    }
    if (prev && prev.textScale !== c.textScale) {
      for (const st of live) { st.layer?.setScale(c.textScale); markDirty(st); }
    }
    if (prev && prev.caps !== c.caps) {
      for (const st of live) { st.layer?.setCaps(c.caps); markDirty(st); }
    }
  }

  function onDrop() {
    if (!Client.alive()) { stop(); return; }
    if (!running || jobs.size === 0) return;
    for (const st of [...jobs.values()]) clearState(st);
    jobs.clear();
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (reconnectTimer || !running) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = 0;
      if (!running) return;
      if (!Client.alive()) { stop(); return; }
      Client.connect();
      Scanner.rescanAll();
    }, 400);
  }

  /** @param {KeyboardEvent} e */
  function onKey(e) {
    if (e.key !== 'Alt') return;
    const down = e.type === 'keydown';
    if (down === peek) return;
    peek = down;
    applyVisibility();
  }

  function onBlur() {
    if (peek) { peek = false; applyVisibility(); }
  }

  function onResize() {
    for (const st of live) markDirty(st);
  }

  function onScroll() {
    for (const st of live) if (st.near && st.layer && st.layer.mode !== 'anchor') markDirty(st);
  }

  function onPageHide() {
    leaving = true;
  }

  /** @param {PageTransitionEvent} e */
  function onPageShow(e) {
    leaving = false;
    if (e.persisted && running) { Client.connect(); Scanner.rescanAll(); }
  }

  const MOTION = ['transitionrun', 'transitionend', 'transitioncancel', 'animationstart', 'animationend', 'animationcancel'];
  let ticks = 0;
  function onTick() {
    if (!Client.alive()) { stop(); return; }
    if (document.visibilityState !== 'visible') return;
    for (const st of onScreen) markDirty(st);
    if (++ticks % 4 === 0 && live.size > 0) {
      for (const st of [...live]) if (st.img.isContentEditable) clearState(st);
      for (const el of Array.from(document.querySelectorAll('[style*="--imgtr-"]'))) {
        if (el instanceof HTMLImageElement) Overlay.scrub(el);
      }
    }
  }

  function start() {
    if (!cfg) return;
    running = true;
    for (const h of Array.from(document.querySelectorAll(Overlay.TAG))) h.remove();
    Scanner.start(hooks, cfg.prefetch);
    Preload.start(onPreload);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    for (const t of MOTION) document.addEventListener(t, onMotion, { capture: true, passive: true });
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('pagehide', onPageHide);
    tick = setInterval(onTick, 800);
    openGateWhenReady();
  }

  function stop() {
    const wasRunning = running;
    running = false;
    cfg = null;
    if (wasRunning) {
      Scanner.stop();
      Preload.stop();
      preloads.clear();
      shownPage = '';
      mainPic = null;
      if (lookTimer) { clearTimeout(lookTimer); lookTimer = 0; }
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('scroll', onScroll, { capture: true });
      for (const t of MOTION) document.removeEventListener(t, onMotion, { capture: true });
      moving.clear();
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('pagehide', onPageHide);
    }
    if (tick) { clearInterval(tick); tick = 0; }
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = 0; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = 0; }
    for (const st of live) st.layer?.destroy();
    live.clear();
    onScreen.clear();
    dirty.clear();
    waitingGate.clear();
    waitingSwap.clear();
    jobs.clear();
    states = new WeakMap();
    lazyHits = 0; lazyMisses = 0; lazyOpen = new Set();
    shownHosts = new Set([location.hostname]);
    peek = false;
    showOriginal = false;
    Client.close();
  }

  /** @param {boolean} restartObservers */
  function rescan(restartObservers) {
    if (!running || !cfg) return;
    for (const st of [...jobs.values()]) clearState(st);
    for (const st of [...live]) clearState(st);
    for (const st of [...waitingGate, ...waitingSwap, ...lazyOpen]) clearState(st);
    lazyOpen.clear();
    states = new WeakMap();
    if (restartObservers) Scanner.start(hooks, cfg.prefetch);
    else Scanner.rescanAll();
  }

  function boot() {
    Client.setHandlers(onMessage, onDrop);
    Client.connect();
  }

  function dispose() {
    stop();
    try { chrome.runtime.onMessage.removeListener(onTabMessage); } catch {}
  }

  G.__imgtr = {
    alive: () => Client.alive(),
    restart: () => { if (!running) boot(); },
    dispose,
  };
  try { chrome.runtime.onMessage.addListener(onTabMessage); } catch {}
  boot();
})();
