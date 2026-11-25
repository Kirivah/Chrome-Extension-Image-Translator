// @ts-check
var Anchor = (() => {
  const SUPPORTED = (() => {
    const css = globalThis.CSS;
    return !!css && typeof css.supports === 'function' && css.supports('position-anchor', '--a')
      && css.supports('top', 'calc(anchor(top, 0px) + 1px)') && css.supports('width', 'calc(anchor-size(width, 0px) - 1px)');
  })();
  const OURS = '--imgtr-';
  const PREFIX = `${OURS}${Math.random().toString(36).slice(2, 8)}-`;
  let named = 0;
  /** @type {WeakMap<HTMLImageElement, string>} */
  const owners = new WeakMap();
  const MAX_RENAMES = 3;
  const RENAME_WINDOW_MS = 10_000;
  const IDENTITY = new Set(['none', 'matrix(1, 0, 0, 1, 0, 0)', 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)']);
  const rt = chrome.runtime;
  const alive = () => { try { return !!rt?.id; } catch { return false; } };

  /** @param {string} v @returns {string[]} */
  const nameList = (v) => (v && v.trim() !== 'none' ? v.split(',').map((n) => n.trim()).filter(Boolean) : []);
  /** @param {number} v */
  const px = (v) => `${Math.round(v * 1000) / 1000}px`;

  /** @param {HTMLImageElement} img */
  function scrub(img) {
    if (!img.getAttribute('style')?.includes(OURS)) return;
    const s = img.style;
    const v = s.getPropertyValue('anchor-name');
    if (!v.includes(OURS)) return;
    const mine = owners.get(img);
    const list = nameList(v);
    const keep = list.filter((n) => !n.startsWith(OURS) || n === mine);
    if (keep.length === list.length) return;
    if (keep.length) s.setProperty('anchor-name', keep.join(', '), s.getPropertyPriority('anchor-name'));
    else s.removeProperty('anchor-name');
    if (!img.getAttribute('style')) img.removeAttribute('style');
  }

  /**
   * @param {CSSStyleDeclaration} cs
   * @param {{il: number, it: number}} cb
   * @returns {string}
   */
  function ownTransform(cs, cb) {
    const t = cs.transform || 'none';
    const tr = cs.translate || 'none';
    const ro = cs.rotate || 'none';
    const sc = cs.scale || 'none';
    if (IDENTITY.has(t) && tr === 'none' && ro === 'none' && sc === 'none') return '';
    const [ox = 0, oy = 0, oz = 0] = cs.transformOrigin.split(' ').map((v) => parseFloat(v) || 0);
    const content = cs.transformBox === 'content-box' || cs.transformBox === 'fill-box';
    const origin = `${px(content ? ox : ox - cb.il)} ${px(content ? oy : oy - cb.it)} ${px(oz)}`;
    return [t, origin, tr, ro, sc].join('|');
  }

  class Name {
    /**
     * @param {HTMLImageElement} img
     * @param {() => boolean} wanted
     */
    constructor(img, wanted) {
      this.img = img;
      this.wanted = wanted;
      this.name = PREFIX + (++named);
      /** @type {{value: string, priority: string} | null} */
      this.saved = null;
      this.wrote = '';
      this.renames = 0;
      this.renameSince = 0;
      /** @type {MutationObserver | null} */
      this.watch = null;
    }

    on() {
      return nameList(this.img.style.getPropertyValue('anchor-name')).includes(this.name);
    }

    claim() {
      const img = this.img;
      const s = img.style;
      const inline = s.getPropertyValue('anchor-name');
      if (nameList(inline).includes(this.name)) return;
      const own = inline.includes(OURS) ? nameList(inline).filter((n) => !n.startsWith(OURS)).join(', ') : inline;
      this.saved = { value: own, priority: s.getPropertyPriority('anchor-name') };
      const page = nameList(getComputedStyle(img).getPropertyValue('anchor-name')).filter((n) => !n.startsWith(OURS));
      s.setProperty('anchor-name', [...page, this.name].join(', '), 'important');
      this.wrote = s.getPropertyValue('anchor-name');
      owners.set(img, this.name);
      if (!this.watch) {
        this.watch = new MutationObserver(() => {
          if (!alive()) { this.watch?.disconnect(); this.watch = null; return; }
          if (this.wanted() && this.saved && !this.on()) this.rename();
        });
        this.watch.observe(img, { attributes: true, attributeFilter: ['style'] });
      }
    }

    /** @returns {boolean} */
    rename() {
      if (!alive()) return false;
      const now = Date.now();
      if (now - this.renameSince > RENAME_WINDOW_MS) { this.renames = 0; this.renameSince = now; }
      if (++this.renames > MAX_RENAMES) return false;
      this.claim();
      return true;
    }

    release() {
      if (this.watch) { this.watch.disconnect(); this.watch = null; }
      if (!this.saved) return;
      const img = this.img;
      const s = img.style;
      const inline = s.getPropertyValue('anchor-name');
      const list = nameList(inline);
      if (list.includes(this.name)) {
        if (inline === this.wrote) {
          if (this.saved.value) s.setProperty('anchor-name', this.saved.value, this.saved.priority);
          else s.removeProperty('anchor-name');
        } else {
          const rest = list.filter((n) => n !== this.name);
          if (rest.length) s.setProperty('anchor-name', rest.join(', '), s.getPropertyPriority('anchor-name'));
          else s.removeProperty('anchor-name');
        }
        if (!img.getAttribute('style')) img.removeAttribute('style');
      }
      if (owners.get(img) === this.name) owners.delete(img);
      this.saved = null;
      this.wrote = '';
    }
  }

  return { SUPPORTED, scrub, ownTransform, Name };
})();
