// @ts-check
var Pin = (() => {
  /** @type {Map<HTMLElement, {n: number, value: string, priority: string}>} */
  const pinned = new Map();
  const CB_CONTAIN = /layout|paint|strict|content/;
  const CB_WILL = /transform|filter|perspective/;

  /**
   * @param {Element} el
   * @returns {HTMLElement | null}
   */
  function pinScroller(el) {
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.display === 'contents') continue;
      if (cs.position !== 'static' || cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none'
        || CB_CONTAIN.test(cs.contain) || CB_WILL.test(cs.willChange)) return null;
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const p = pinned.get(a);
        if (p) p.n++;
        else {
          pinned.set(a, { n: 1, value: a.style.getPropertyValue('position'), priority: a.style.getPropertyPriority('position') });
          a.style.setProperty('position', 'relative');
        }
        return a;
      }
    }
    return null;
  }

  /** @param {HTMLElement} el */
  function unpin(el) {
    const p = pinned.get(el);
    if (!p || --p.n > 0) return;
    pinned.delete(el);
    if (p.value) el.style.setProperty('position', p.value, p.priority);
    else el.style.removeProperty('position');
  }

  return { pinScroller, unpin };
})();
