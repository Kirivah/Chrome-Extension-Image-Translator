// @ts-check
var Preload = (() => {
  /** @type {PerformanceObserver | null} */
  let po = null;

  /** @param {(url: string) => void} onImage */
  function start(onImage) {
    stop();
    if (typeof PerformanceObserver !== 'function') return;
    try {
      po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const r = /** @type {PerformanceResourceTiming} */ (e);
          if ((r.initiatorType === 'img' || r.initiatorType === 'link') && /^https?:/i.test(r.name)) onImage(r.name);
        }
      });
      po.observe({ type: 'resource', buffered: true });
    } catch {
      po = null;
    }
  }

  function stop() {
    if (po) { po.disconnect(); po = null; }
  }

  return { start, stop };
})();
