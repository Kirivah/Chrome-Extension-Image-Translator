// @ts-check
var Overlay = (() => {
  const { Geometry, Fit, Fonts, Anchor, Pin } = globalThis;
  const ANCHORS = Anchor.SUPPORTED;
  /** @param {number} v */
  const px = (v) => `${Math.round(v * 1000) / 1000}px`;
  /** @param {number} v */
  const pct = (v) => `${Math.round(v * 1e6) / 1e4}%`;
  const TAG = 'imgtr-layer';
  const SHADOW_MODE = /** @type {ShadowRootMode} */ ('closed');
  const HEX = /^#[0-9a-f]{6}$/i;

  const STYLES = `
:host { all: initial; }
.f { all: initial; position: absolute; display: block; container-type: size; }
.l { position: absolute; left: 0; top: 0; width: 100%; height: 100%; display: block; }
.p { position: absolute; display: block; z-index: 0; }
.p.fill { background: var(--imgtr-bg); border-radius: .6cqw; box-shadow: 0 0 .25cqw .2cqw var(--imgtr-bg); }
.p.img { background: none; }
.p.blur { background: var(--imgtr-bg); border-radius: 1.2cqw;
  -webkit-backdrop-filter: blur(var(--imgtr-blur, max(3px, .9cqw))); backdrop-filter: blur(var(--imgtr-blur, max(3px, .9cqw)));
  --h: linear-gradient(to right, transparent, #000 var(--fl, 0px), #000 calc(100% - var(--fr, 0px)), transparent);
  --w: linear-gradient(to bottom, transparent, #000 var(--ft, 0px), #000 calc(100% - var(--fb, 0px)), transparent);
  -webkit-mask-image: var(--h), var(--w); -webkit-mask-composite: source-in;
  mask-image: var(--h), var(--w); mask-composite: intersect; }
.t { position: absolute; z-index: 1; display: flex; align-items: center; justify-content: center; text-align: center;
  color: var(--imgtr-fg); font-family: var(--imgtr-font); font-weight: var(--imgtr-fw); font-style: normal;
  font-size: 12px; line-height: 1.12; letter-spacing: 0; word-spacing: 0; text-transform: var(--imgtr-tt, none);
  white-space: normal; contain: layout style; direction: ltr; }
.t > span { display: block; min-width: 0; max-width: 100%; overflow-wrap: normal; word-break: normal;
  hyphens: manual; -webkit-hyphens: manual; text-wrap: balance; }
.t.v > span { writing-mode: vertical-rl; max-height: 100%; text-wrap: wrap; }
.t.o > span { text-shadow: ${ring(0.11)}, 0 0 .04em var(--imgtr-ol); }
`;

  /** @param {number} r */
  function ring(r) {
    const out = [];
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8;
      const x = Math.round(r * Math.cos(a) * 1000) / 1000; const y = Math.round(r * Math.sin(a) * 1000) / 1000;
      out.push(`${x}em ${y}em 0 var(--imgtr-ol)`);
    }
    return out.join(', ');
  }

  const HOST_STYLE = /** @type {const} */ ([
    ['position', 'absolute'], ['display', 'block'], ['top', 'auto'], ['left', 'auto'], ['right', 'auto'],
    ['bottom', 'auto'], ['margin', '0'], ['padding', '0'], ['border', '0'], ['width', '0'], ['height', '0'],
    ['min-width', '0'], ['min-height', '0'], ['max-width', 'none'], ['max-height', 'none'],
    ['pointer-events', 'none'], ['overflow', 'hidden'], ['box-sizing', 'content-box'], ['float', 'none'],
    ['transform', 'none'], ['opacity', '1'], ['visibility', 'visible'], ['contain', 'layout style'],
    ['background', 'transparent'], ['filter', 'none'], ['clip-path', 'none'], ['animation', 'none'],
    ['transition', 'none'], ['z-index', 'auto'], ['user-select', 'none'],
    ['align-self', 'normal'], ['justify-self', 'normal'], ['position-area', 'none'],
    ['position-try-fallbacks', 'none'], ['position-visibility', 'anchors-visible'],
    ['translate', 'none'], ['rotate', 'none'], ['scale', 'none'],
  ]);

  /** @type {CSSStyleSheet | null} */
  let sheet = null;
  function getSheet() {
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLES);
    }
    return sheet;
  }

  /** @param {string} hex @param {number} a */
  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${a})`;
  }

  /** @param {unknown} v */
  const isNum01 = (v) => typeof v === 'number' && v >= 0 && v <= 1;
  /** @param {any} r */
  const validRect = (r) => r && isNum01(r.x) && isNum01(r.y) && isNum01(r.w) && isNum01(r.h);
  const IMAGE = /^[A-Za-z0-9+/]+={0,2}$/;
  const MAX_IMAGE = 1_400_000;
  /** @param {any} r @returns {r is Region} */
  function validRegion(r) {
    return !!r && validRect(r.p) && validRect(r.a) && (r.m === 0 || r.m === 1 || r.m === 2)
      && (r.m !== 2 || (typeof r.im === 'string' && r.im.length <= MAX_IMAGE && IMAGE.test(r.im)))
      && (r.i === undefined || (Number.isInteger(r.i) && r.i > 0))
      && HEX.test(r.bg) && HEX.test(r.fg) && HEX.test(r.ol) && typeof r.t === 'string' && r.t.length <= 2000
      && (r.g === undefined || (typeof r.g === 'number' && r.g > 0 && r.g <= 1))
      && (r.e === undefined || (Array.isArray(r.e) && r.e.length === 4 && r.e.every((/** @type {unknown} */ v) => typeof v === 'number' && v >= 0 && v <= 0.25)));
  }

  /** @param {unknown} v */
  const textScale = (v) => (typeof v === 'number' && v >= 0.5 && v <= 2.5 ? v : 1);

  const FEATHER = /** @type {const} */ (['--fl', '--ft', '--fr', '--fb']);

  const LETTER_SCALE = 1.1;

  /** @param {number | undefined} g */
  function wash(g) {
    const k = g ? Math.min(1, Math.max(0, (g - 0.045) / 0.045)) : 0;
    const blur = g ? Math.min(1.5, Math.max(0.9, 14.5 * g)) : 0.9;
    return { blur: `max(3px, ${blur.toFixed(2)}cqw)`, alpha: 0.24 + 0.12 * k };
  }

  /** @param {HTMLElement} el @param {NRect} r */
  function place(el, r) {
    el.style.left = (r.x * 100).toFixed(3) + '%';
    el.style.top = (r.y * 100).toFixed(3) + '%';
    el.style.width = (r.w * 100).toFixed(3) + '%';
    el.style.height = (r.h * 100).toFixed(3) + '%';
  }

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {string} b64
   * @param {() => void} [then]
   */
  function drawPatch(canvas, b64, then = () => {}) {
    let bytes;
    try {
      const bin = atob(b64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch { then(); return; }
    const png = bytes[0] === 0x89 && bytes[1] === 0x50;
    createImageBitmap(new Blob([bytes], { type: png ? 'image/png' : 'image/webp' })).then((bmp) => {
      if (!canvas.isConnected && !canvas.parentNode) { bmp.close(); then(); return; }
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d')?.drawImage(bmp, 0, 0);
      bmp.close();
      then();
    }, () => { then(); });
  }

  /**
   * @typedef {Object} Measure
   * @property {ReturnType<typeof Geometry.contentBox>} cb
   * @property {DOMRect} hr
   * @property {{x: number, y: number, w: number, h: number}} fit
   * @property {string} z
   * @property {boolean} mounted
   * @property {boolean} named
   * @property {string} tf
   * @property {string} pos
   */

  const SLACK = 0.3;
  class Layer {
    /**
     * @param {HTMLImageElement} img
     * @param {{font: string, bold: boolean, lang: string, scale?: number, caps?: boolean}} look
     */
    constructor(img, look) {
      Fonts.ensure();
      this.img = img;
      this.host = document.createElement(TAG);
      for (const [k, v] of HOST_STYLE) this.host.style.setProperty(k, v, 'important');
      this.host.style.setProperty('--imgtr-font', look.font);
      this.host.style.setProperty('--imgtr-fw', look.bold ? '700' : '500');
      this.caps = !!look.caps;
      this.host.style.setProperty('--imgtr-tt', this.caps ? 'uppercase' : 'none');
      const root = this.host.attachShadow({ mode: SHADOW_MODE });
      root.adoptedStyleSheets = [getSheet()];
      this.frame = document.createElement('div');
      this.frame.className = 'f';
      this.patches = document.createElement('div');
      this.patches.className = 'l';
      this.texts = document.createElement('div');
      this.texts.className = 'l';
      this.frame.append(this.patches, this.texts);
      root.append(this.frame);
      this.lang = look.lang;
      /** @type {'anchor' | 'margin'} */
      this.mode = ANCHORS ? 'anchor' : 'margin';
      this.tie = ANCHORS ? new Anchor.Name(img, () => this.mode === 'anchor') : null;
      this.geo = '';
      this.tf = '';
      this.mx = 0;
      this.my = 0;
      this.w = -1;
      this.h = -1;
      this.z = 'auto';
      this.fixed = false;
      this.fx = NaN; this.fy = NaN; this.fw = 0; this.fh = 0;
      this.rtl = false;
      this.zItem = false;
      this.hidden = false;
      this.count = 0;
      /** @type {HTMLElement | null} */
      this.pin = null;
      /** @type {Set<string>} */
      this.seen = new Set();
      /** @type {Map<number, {key: string, patch: HTMLElement, box: HTMLElement, im?: string}>} */
      this.byId = new Map();
      /** @type {{box: HTMLElement, span: HTMLElement, r: Region}[]} */
      this.unfitted = [];
      /** @type {{box: HTMLElement, span: HTMLElement, r: Region}[]} */
      this.texts$ = [];
      this.scale = textScale(look.scale);
    }

    /**
     * @param {Region} r
     * @returns {NRect}
     */
    room(r) {
      const a = r.a;
      const k = this.scale;
      if (k <= 1 || r.m === 0) return a;
      const ax1 = a.x + a.w; const ay1 = a.y + a.h;
      let x0 = a.x - (a.w * (k - 1)) / 2; let x1 = ax1 + (a.w * (k - 1)) / 2;
      let y0 = a.y - (a.h * (k - 1)) / 2; let y1 = ay1 + (a.h * (k - 1)) / 2;
      for (const u of this.texts$) {
        if (u.r === r) continue;
        const b = u.r.a;
        const bx1 = b.x + b.w; const by1 = b.y + b.h;
        const gx = Math.max(b.x - ax1, a.x - bx1); const gy = Math.max(b.y - ay1, a.y - by1);
        if (gx < 0 && gy < 0) continue;
        if (gx >= gy) {
          if (b.x >= ax1) x1 = Math.min(x1, (ax1 + b.x) / 2); else x0 = Math.max(x0, (bx1 + a.x) / 2);
        } else if (b.y >= ay1) y1 = Math.min(y1, (ay1 + b.y) / 2); else y0 = Math.max(y0, (by1 + a.y) / 2);
      }
      x0 = Math.max(0, Math.min(a.x, x0)); y0 = Math.max(0, Math.min(a.y, y0));
      x1 = Math.min(1, Math.max(ax1, x1)); y1 = Math.min(1, Math.max(ay1, y1));
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }

    /** @param {number} scale */
    setScale(scale) {
      const k = textScale(scale);
      if (k === this.scale) return;
      this.scale = k;
      this.reroom();
    }

    /** @param {boolean} caps */
    setCaps(caps) {
      if (!!caps === this.caps) return;
      this.caps = !!caps;
      this.host.style.setProperty('--imgtr-tt', this.caps ? 'uppercase' : 'none');
      this.reroom();
    }

    target() {
      const p = this.img.parentElement;
      return p && p.tagName === 'PICTURE' ? p : this.img;
    }

    mount() {
      const a = this.target();
      if (a.nextSibling === this.host) return;
      a.after(this.host);
      if (this.pin) Pin.unpin(this.pin);
      this.pin = Pin.pinScroller(a);
      const parent = this.host.parentElement;
      const pcs = parent ? getComputedStyle(parent) : null;
      this.rtl = !!pcs && pcs.direction === 'rtl';
      this.zItem = !!pcs && /flex|grid/.test(pcs.display);
      this.mx = 0;
      this.my = 0;
      this.host.style.setProperty('margin', '0', 'important');
      if (this.mode === 'anchor') {
        this.tie?.claim();
        if (!this.geo) this.anchorTo(0, 0, 0, 0);
      }
    }

    /**
     * @param {number} il
     * @param {number} it
     * @param {number} ir
     * @param {number} ib
     */
    anchorTo(il, it, ir, ib) {
      const x = px(il);
      const y = px(it);
      const w = px(il + ir);
      const h = px(it + ib);
      const geo = `${x} ${y} ${w} ${h}`;
      if (geo === this.geo) return;
      this.geo = geo;
      const s = this.host.style;
      s.setProperty('position-anchor', this.tie ? this.tie.name : 'none', 'important');
      s.setProperty('left', `calc(anchor(left, 0px) + ${x})`, 'important');
      s.setProperty('top', `calc(anchor(top, 0px) + ${y})`, 'important');
      s.setProperty('width', `calc(anchor-size(width, 0px) - ${w})`, 'important');
      s.setProperty('height', `calc(anchor-size(height, 0px) - ${h})`, 'important');
    }

    unanchor() {
      this.mode = 'margin';
      this.tie?.release();
      const s = this.host.style;
      s.removeProperty('position-anchor');
      s.setProperty('left', 'auto', 'important');
      s.setProperty('top', 'auto', 'important');
      s.setProperty('margin', '0', 'important');
      this.copyTransform('');
      this.mx = 0; this.my = 0; this.w = -1; this.h = -1; this.geo = '';
    }

    /** @param {string} tf */
    copyTransform(tf) {
      if (tf === this.tf) return;
      this.tf = tf;
      const s = this.host.style;
      const [t = 'none', origin = '', tr = 'none', ro = 'none', sc = 'none'] = tf ? tf.split('|') : [];
      s.setProperty('transform', t, 'important');
      if (origin) s.setProperty('transform-origin', origin, 'important');
      else s.removeProperty('transform-origin');
      s.setProperty('translate', tr, 'important');
      s.setProperty('rotate', ro, 'important');
      s.setProperty('scale', sc, 'important');
    }

    /** @param {Region[]} regions */
    add(regions) {
      for (const r of regions) {
        if (!validRegion(r)) continue;
        const key = `${r.t}|${r.p.x.toFixed(4)}|${r.p.y.toFixed(4)}|${r.p.w.toFixed(4)}|${r.p.h.toFixed(4)}`;
        const was = r.i !== undefined ? this.byId.get(r.i) : undefined;
        if (this.seen.has(key)) {
          if (was && was.key === key && r.m === 2 && r.im !== undefined && was.im !== r.im && was.patch instanceof HTMLCanvasElement) {
            was.im = r.im;
            drawPatch(was.patch, r.im);
          }
          continue;
        }
        const erased = r.m === 2 && r.im !== undefined;
        const old = r.i !== undefined ? this.drop(r.i, erased) : null;
        this.seen.add(key);
        const patch = document.createElement(erased ? 'canvas' : 'div');
        patch.className = erased ? 'p img' : r.m ? 'p blur' : 'p fill';
        place(patch, r.p);
        if (erased) {
          drawPatch(/** @type {HTMLCanvasElement} */ (patch), /** @type {string} */ (r.im), old ? () => old.remove() : undefined);
        } else if (r.m) {
          const w = wash(r.g);
          patch.style.setProperty('--imgtr-bg', rgba(r.bg, w.alpha));
          patch.style.setProperty('--imgtr-blur', w.blur);
          if (r.e) r.e.forEach((v, i) => patch.style.setProperty(FEATHER[i], (v * 80).toFixed(3) + 'cqw'));
        } else patch.style.setProperty('--imgtr-bg', r.bg);

        const box = document.createElement('div');
        box.className = 't' + (r.m ? ' o' : '') + (r.v ? ' v' : '');
        place(box, this.room(r));
        box.lang = this.lang;
        box.style.setProperty('--imgtr-fg', r.fg);
        box.style.setProperty('--imgtr-ol', r.ol);
        const span = document.createElement('span');
        span.textContent = r.t;
        box.append(span);

        this.patches.append(patch);
        this.texts.append(box);
        const u = { box, span, r };
        this.unfitted.push(u);
        this.texts$.push(u);
        if (r.i !== undefined) this.byId.set(r.i, { key, patch, box, im: r.im });
        this.count++;
      }
      if (this.scale > 1) this.reroom();
    }

    reroom() {
      for (const u of this.texts$) {
        place(u.box, this.room(u.r));
        if (!this.unfitted.includes(u)) this.unfitted.push(u);
      }
    }

    /** @param {unknown[]} ids */
    remove(ids) {
      for (const id of ids) if (typeof id === 'number') this.drop(id);
      if (this.scale > 1 && ids.length) this.reroom();
    }

    /**
     * @param {number} id
     * @param {boolean} [keepPatch]
     * @returns {HTMLElement | null}
     */
    drop(id, keepPatch = false) {
      const e = this.byId.get(id);
      if (!e) return null;
      this.byId.delete(id);
      this.seen.delete(e.key);
      if (!keepPatch) e.patch.remove();
      e.box.remove();
      this.unfitted = this.unfitted.filter((u) => u.box !== e.box);
      this.texts$ = this.texts$.filter((u) => u.box !== e.box);
      this.count--;
      return keepPatch ? e.patch : null;
    }

    /** @returns {Measure | null} */
    measure() {
      const img = this.img;
      if (!img.isConnected) return null;
      const cs = getComputedStyle(img);
      const cb = Geometry.contentBox(img, cs);
      const fit = Geometry.objectFitRect(img.naturalWidth, img.naturalHeight, cb.w, cb.h, cs.objectFit, cs.objectPosition);
      const z = (cs.position !== 'static' || this.zItem) && cs.zIndex !== 'auto' ? cs.zIndex : 'auto';
      const anchored = this.mode === 'anchor';
      return {
        cb, hr: this.host.getBoundingClientRect(), fit, z,
        mounted: this.target().nextSibling === this.host,
        named: !anchored || !!this.tie?.on(),
        tf: anchored ? Anchor.ownTransform(cs, cb) : '',
        pos: cs.position,
      };
    }

    /**
     * @param {Measure} m
     * @returns {boolean}
     */
    apply(m) {
      if (!m.mounted) { this.mount(); return false; }
      const fixed = m.pos === 'fixed';
      if (fixed !== this.fixed) {
        this.fixed = fixed;
        this.host.style.setProperty('position', fixed ? 'fixed' : 'absolute', 'important');
        if (this.mode === 'margin') {
          this.mx = 0;
          this.my = 0;
          this.host.style.setProperty('margin', '0', 'important');
          return false;
        }
      }
      if (!(this.mode === 'anchor' ? this.follow(m) : this.nudge(m))) return false;
      if (m.z !== this.z) {
        this.z = m.z;
        this.host.style.setProperty('z-index', m.z, 'important');
      }
      const f = m.fit;
      const cw = m.cb.w;
      const ch = m.cb.h;
      if (cw > 0 && ch > 0 && (f.x !== this.fx || f.y !== this.fy || f.w !== this.fw || f.h !== this.fh)) {
        this.fx = f.x; this.fy = f.y; this.fw = f.w; this.fh = f.h;
        const fs = this.frame.style;
        fs.left = pct(f.x / cw);
        fs.top = pct(f.y / ch);
        fs.width = pct(f.w / cw);
        fs.height = pct(f.h / ch);
      }
      return true;
    }

    /** @param {Measure} m */
    follow(m) {
      if (!m.named) {
        if (!this.tie?.rename()) this.unanchor();
        return false;
      }
      if (m.pos === 'sticky') { this.unanchor(); return false; }
      const cb = m.cb;
      this.anchorTo(cb.il, cb.it, cb.ir, cb.ib);
      this.copyTransform(m.tf);
      if (!this.hidden && cb.w >= 1 && cb.h >= 1 && m.hr.width === 0 && m.hr.height === 0) { this.unanchor(); return false; }
      return true;
    }

    /** @param {Measure} m */
    nudge(m) {
      const s = this.host.style;
      if (m.cb.w !== this.w || m.cb.h !== this.h) {
        this.w = m.cb.w;
        this.h = m.cb.h;
        s.setProperty('width', px(this.w), 'important');
        s.setProperty('height', px(this.h), 'important');
      }
      if (this.hidden) return true;
      const dx = (m.cb.left - m.hr.left) / m.cb.sx;
      const dy = (m.cb.top - m.hr.top) / m.cb.sy;
      if (Math.abs(dx) > SLACK) {
        this.mx += dx;
        s.setProperty(this.rtl ? 'margin-right' : 'margin-left', px(this.rtl ? -this.mx : this.mx), 'important');
      }
      if (Math.abs(dy) > SLACK) {
        this.my += dy;
        s.setProperty('margin-top', px(this.my), 'important');
      }
      return true;
    }

    fit() {
      if (!this.unfitted.length || this.hidden || this.fw < 8 || this.fh < 8) return;
      for (const u of this.unfitted.splice(0)) {
        const cap = u.r.g ? u.r.g * this.fw * LETTER_SCALE * this.scale : undefined;
        const a = this.room(u.r);
        const fpx = Fit.fitFont(u.box, u.span, a.w * this.fw, a.h * this.fh, u.r.v, cap, this.scale);
        u.box.style.fontSize = ((fpx / this.fw) * 100).toFixed(4) + 'cqw';
      }
    }

    /** @param {boolean} hidden */
    setHidden(hidden) {
      if (hidden === this.hidden) return;
      this.hidden = hidden;
      this.host.style.setProperty('display', hidden ? 'none' : 'block', 'important');
    }

    destroy() {
      this.host.remove();
      this.tie?.release();
      if (this.pin) { Pin.unpin(this.pin); this.pin = null; }
      this.unfitted = [];
      this.texts$ = [];
      this.seen.clear();
      this.byId.clear();
    }
  }

  return { Layer, TAG, scrub: Anchor.scrub, ANCHORS };
})();
