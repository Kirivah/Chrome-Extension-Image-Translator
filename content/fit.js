// @ts-check
var Fit = (() => {
  const MIN_PX = 7;
  const MAX_PX = 72;

  /**
   * @param {HTMLElement} box
   * @param {HTMLElement} span
   * @param {number} w
   * @param {number} h
   * @param {boolean} vertical
   * @param {number} [maxPx]
   * @param {number} [scale]
   * @returns {number}
   */
  function fitFont(box, span, w, h, vertical, maxPx = MAX_PX, scale = 1) {
    const fits = (/** @type {number} */ px) => {
      box.style.fontSize = px + 'px';
      return vertical
        ? span.offsetWidth <= w + 0.5 && span.scrollHeight <= span.clientHeight + 1
        : span.offsetHeight <= h + 0.5 && span.scrollWidth <= span.clientWidth + 1;
    };
    span.style.overflowWrap = 'normal';
    span.style.hyphens = 'manual';
    const min = Math.max(5, MIN_PX * Math.min(1, scale));
    let lo = min;
    let hi = Math.max(min, Math.min(vertical ? w : h, maxPx, MAX_PX * Math.max(1, scale)));
    if (!fits(lo)) {
      span.style.overflowWrap = 'anywhere';
      span.style.hyphens = 'auto';
      return lo;
    }
    if (fits(hi)) return hi;
    for (let i = 0; i < 8 && hi - lo > 0.4; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid; else hi = mid;
    }
    return lo;
  }

  return { fitFont };
})();
