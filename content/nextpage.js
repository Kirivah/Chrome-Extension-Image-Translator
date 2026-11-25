// @ts-check
var NextPage = (() => {
  const AHEAD = 2;
  const MAX_HTML = 2_000_000;
  const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-url'];

  const done = new Set();
  let before = document.referrer;
  let here = location.href;

  /** @param {URL} u */
  function lastNumber(u) {
    const s = u.pathname + u.search;
    const m = /(\d+)(?!.*\d)/.exec(s);
    return m ? { at: m.index, text: m[1], s } : null;
  }

  /**
   * @param {string} a
   * @param {string} b
   */
  function after(a, b) {
    let x; let y;
    try { x = new URL(a); y = new URL(b); } catch { return 0; }
    if (x.origin !== y.origin || x.pathname.split('/').length !== y.pathname.split('/').length) return 0;
    const p = lastNumber(x); const q = lastNumber(y);
    if (!p || !q || p.text.length > 9 || q.text.length > 9) return 0;
    const d = Number(q.text) - Number(p.text);
    return d === 1 || d === 2 ? d : 0;
  }

  /**
   * @param {string} url
   * @param {number} d
   * @returns {string}
   */
  function counted(url, d) {
    let u;
    try { u = new URL(url); } catch { return ''; }
    const n = lastNumber(u);
    if (!n || n.text.length > 9) return '';
    let t = String(Number(n.text) + d);
    if (n.text.length > 1 && n.text[0] === '0') t = t.padStart(n.text.length, '0');
    const s = n.s.slice(0, n.at) + t + n.s.slice(n.at + n.text.length);
    try { return new URL(s, u.origin).href; } catch { return ''; }
  }

  /**
   * @param {Document} doc
   * @param {string} url
   * @param {number} d
   */
  function linkAfter(doc, url, d) {
    for (const el of Array.from(doc.querySelectorAll('link[rel~="next"][href], a[href]'))) {
      let h;
      try { h = new URL(el.getAttribute('href') ?? '', url).href; } catch { continue; }
      if (after(url, h) === d) return h;
    }
    return '';
  }

  /**
   * @param {Document} doc
   * @param {Element} img
   * @returns {Element | null}
   */
  function locate(doc, img) {
    const isImg = (/** @type {Element | null} */ e) => !!e && e.localName === 'img';
    if (img.id) { const e = doc.getElementById(img.id); return isImg(e) ? e : null; }
    const cls = img.getAttribute('class');
    if (cls) {
      const same = Array.from(doc.getElementsByTagName('img')).filter((e) => e.getAttribute('class') === cls);
      if (same.length === 1) return same[0];
    }
    /** @type {[string, number][]} */
    const steps = [];
    let e = img;
    while (e.parentElement && !e.parentElement.id && e.parentElement.localName !== 'body') {
      const p = e.parentElement;
      steps.unshift([e.localName, Array.from(p.children).filter((c) => c.localName === e.localName).indexOf(e)]);
      e = p;
    }
    const top = e.parentElement;
    if (!top) return null;
    steps.unshift([e.localName, Array.from(top.children).filter((c) => c.localName === e.localName).indexOf(e)]);
    /** @type {Element | null} */
    let at = top.id ? doc.getElementById(top.id) : doc.body;
    for (const [tag, i] of steps) {
      if (!at) return null;
      at = Array.from(at.children).filter((c) => c.localName === tag)[i] ?? null;
    }
    return isImg(at) ? at : null;
  }

  /** @param {Element} el @param {string} base */
  function addressOf(el, base) {
    for (const a of ['src', ...LAZY_ATTRS]) {
      const v = el.getAttribute(a)?.trim();
      if (!v || v.startsWith('data:')) continue;
      try {
        const u = new URL(v, base);
        if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
      } catch {}
    }
    return '';
  }

  /** @param {string} url @returns {Promise<Document | null>} */
  async function fetchPage(url) {
    try {
      const r = await fetch(url, { credentials: 'include', cache: 'default' });
      const type = r.headers.get('content-type') ?? '';
      if (!r.ok || !/html/i.test(type) || Number(r.headers.get('content-length') ?? 0) > MAX_HTML) return null;
      const text = await r.text();
      return text.length > MAX_HTML ? null : new DOMParser().parseFromString(text, 'text/html');
    } catch {
      return null;
    }
  }

  /**
   * @param {HTMLImageElement} img
   * @param {(url: string) => void} found
   */
  async function look(img, found) {
    if (location.href !== here) { before = here; here = location.href; }
    if (done.has(here)) return;
    const d = after(before, here);
    if (!d) return;
    done.add(here);
    if (done.size > 200) done.clear();
    const pure = counted(before, d) === here;
    let url = here;
    /** @type {Document} */
    let doc = document;
    /** @type {Element} */
    let el = img;
    for (let n = 0; n < AHEAD; n++) {
      const next = pure ? counted(url, d) : linkAfter(doc, url, d);
      if (!next || new URL(next).origin !== location.origin || next === url) return;
      const page = await fetchPage(next);
      const pic = page && locate(page, el);
      if (!page || !pic) return;
      const addr = addressOf(pic, next);
      if (addr) found(addr);
      url = next;
      doc = page;
      el = pic;
    }
  }

  return { look, after, counted };
})();
