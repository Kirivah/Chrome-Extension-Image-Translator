// @ts-check
var Geometry = (() => {
  /** @param {string} v @param {number} free */
  function axis(v, free) {
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return free / 2;
    if (v.endsWith('%')) return (free * n) / 100 + 0;
    if (v.endsWith('px')) return n;
    return free / 2;
  }

  /**
   * @param {number} nw
   * @param {number} nh
   * @param {number} cw
   * @param {number} ch
   * @param {string} fit
   * @param {string} position
   */
  function objectFitRect(nw, nh, cw, ch, fit, position) {
    if (!(nw > 0 && nh > 0 && cw > 0 && ch > 0)) return { x: 0, y: 0, w: cw, h: ch };
    let s;
    switch (fit) {
      case 'contain': s = Math.min(cw / nw, ch / nh); break;
      case 'cover': s = Math.max(cw / nw, ch / nh); break;
      case 'none': s = 1; break;
      case 'scale-down': s = Math.min(1, cw / nw, ch / nh); break;
      default: return { x: 0, y: 0, w: cw, h: ch };
    }
    const w = nw * s;
    const h = nh * s;
    const parts = (position || '50% 50%').trim().split(/\s+/);
    return { x: axis(parts[0] || '50%', cw - w), y: axis(parts[1] || '50%', ch - h), w, h };
  }

  /**
   * @param {HTMLElement} el
   * @param {CSSStyleDeclaration} cs
   */
  function contentBox(el, cs) {
    const r = el.getBoundingClientRect();
    const ow = el.offsetWidth;
    const oh = el.offsetHeight;
    const sx = ow ? r.width / ow : 1;
    const sy = oh ? r.height / oh : 1;
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0;
    const bb = parseFloat(cs.borderBottomWidth) || 0;
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pt = parseFloat(cs.paddingTop) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    const pb = parseFloat(cs.paddingBottom) || 0;
    return {
      left: r.left + (bl + pl) * sx,
      top: r.top + (bt + pt) * sy,
      w: Math.max(0, ow - bl - br - pl - pr),
      h: Math.max(0, oh - bt - bb - pt - pb),
      sx: sx || 1,
      sy: sy || 1,
      il: bl + pl,
      it: bt + pt,
      ir: br + pr,
      ib: bb + pb,
    };
  }

  return { objectFitRect, contentBox };
})();
