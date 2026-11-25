// @ts-check
/**
 * @typedef {Object} ScanHooks
 * @property {(img: HTMLImageElement, near: boolean, w: number, h: number) => void} near
 * @property {(img: HTMLImageElement, visible: boolean) => void} visible
 * @property {(img: HTMLImageElement) => void} changed
 * @property {() => void} removed
 * @property {(imgs: HTMLImageElement[]) => void} resized
 */

var Scanner = (() => {
  const { Overlay } = globalThis;
  /** @typedef {ScanHooks} Hooks */

  /** @type {Hooks | null} */
  let hooks = null;
  /** @type {MutationObserver | null} */
  let mo = null;
  /** @type {IntersectionObserver | null} */
  let nearIO = null;
  /** @type {IntersectionObserver | null} */
  let visIO = null;
  /** @type {ResizeObserver | null} */
  let ro = null;
  /** @type {WeakSet<HTMLImageElement>} */
  let watched = new WeakSet();
  /** @type {Set<HTMLImageElement>} */
  let maybeGone = new Set();
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let goneTimer = 0;

  /** @param {HTMLImageElement} img */
  function watch(img) {
    if (!nearIO || !visIO || watched.has(img)) return;
    watched.add(img);
    Overlay.scrub(img);
    if (img.isContentEditable) return;
    nearIO.observe(img);
    visIO.observe(img);
  }

  /** @param {HTMLImageElement} img */
  function refresh(img) {
    if (!nearIO || !visIO) return;
    if (watched.has(img)) { nearIO.unobserve(img); visIO.unobserve(img); }
    watched.add(img);
    if (img.isContentEditable) return;
    nearIO.observe(img);
    visIO.observe(img);
  }

  /** @param {HTMLImageElement} img */
  function unwatch(img) {
    watched.delete(img);
    nearIO?.unobserve(img);
    visIO?.unobserve(img);
    ro?.unobserve(img);
  }

  /** @param {HTMLImageElement} img */
  function trackSize(img) {
    ro?.observe(img);
  }

  /** @param {Node} n @param {(img: HTMLImageElement) => void} fn */
  function eachImg(n, fn) {
    if (n.nodeType !== 1) return;
    const el = /** @type {Element} */ (n);
    if (el.localName === Overlay.TAG) return;
    if (el instanceof HTMLImageElement) { fn(el); return; }
    if (el.firstElementChild) for (const img of Array.from(el.getElementsByTagName('img'))) fn(img);
  }

  /** @param {MutationRecord[]} records */
  function onMutations(records) {
    let removed = false;
    for (const r of records) {
      if (r.type === 'childList') {
        for (const n of Array.from(r.removedNodes)) {
          eachImg(n, (img) => maybeGone.add(img));
          removed = true;
        }
        for (const n of Array.from(r.addedNodes)) eachImg(n, watch);
      } else {
        const t = /** @type {Element} */ (r.target);
        if (t instanceof HTMLImageElement) hooks?.changed(t);
        else if (t.localName === 'source' && t.parentElement?.localName === 'picture') {
          const img = t.parentElement.querySelector('img');
          if (img) hooks?.changed(img);
        }
      }
    }
    if (removed) {
      hooks?.removed();
      if (!goneTimer) goneTimer = setTimeout(collectGone, 500);
    }
  }

  function collectGone() {
    goneTimer = 0;
    for (const img of maybeGone) if (!img.isConnected) unwatch(img);
    maybeGone.clear();
  }

  /** @param {Event} e */
  function onLoad(e) {
    if (e.target instanceof HTMLImageElement) hooks?.changed(e.target);
  }

  /**
   * @param {Hooks} h
   * @param {number} prefetchScreens
   */
  function start(h, prefetchScreens) {
    if (mo) stop();
    hooks = h;
    const vh = Math.max(400, window.innerHeight || 900);
    const vw = Math.max(320, window.innerWidth || 1000);
    const side = Math.round(Math.min(2, prefetchScreens) * vw);
    const margin = `${Math.round(prefetchScreens * vh * 0.5)}px ${side}px ${Math.round(prefetchScreens * vh)}px ${side}px`;
    const zone = 'scrollMargin' in IntersectionObserver.prototype ? { scrollMargin: margin } : { rootMargin: margin };
    nearIO = new IntersectionObserver((entries) => {
      for (const e of entries) {
        hooks?.near(/** @type {HTMLImageElement} */ (e.target), e.isIntersecting, e.boundingClientRect.width, e.boundingClientRect.height);
      }
    }, /** @type {IntersectionObserverInit} */ (zone));
    visIO = new IntersectionObserver((entries) => {
      for (const e of entries) hooks?.visible(/** @type {HTMLImageElement} */ (e.target), e.isIntersecting);
    });
    ro = new ResizeObserver((entries) => hooks?.resized(entries.map((e) => /** @type {HTMLImageElement} */ (e.target))));
    mo = new MutationObserver(onMutations);
    mo.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });
    document.addEventListener('load', onLoad, true);
    for (const img of Array.from(document.getElementsByTagName('img'))) watch(img);
  }

  function stop() {
    mo?.disconnect();
    nearIO?.disconnect();
    visIO?.disconnect();
    ro?.disconnect();
    document.removeEventListener('load', onLoad, true);
    if (goneTimer) clearTimeout(goneTimer);
    mo = null; nearIO = null; visIO = null; ro = null; hooks = null; goneTimer = 0;
    watched = new WeakSet();
    maybeGone = new Set();
  }

  function rescanAll() {
    for (const img of Array.from(document.getElementsByTagName('img'))) refresh(img);
  }

  return { start, stop, watch, refresh, unwatch, trackSize, rescanAll };
})();
