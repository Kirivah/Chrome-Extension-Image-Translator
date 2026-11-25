// @ts-check
var Capture = (() => {
  const MAX_PIXELS = 6e6;

  /** @param {HTMLImageElement} img @param {number} ms */
  function loaded(img, ms) {
    if (img.complete && img.naturalWidth) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); img.removeEventListener('load', done); img.removeEventListener('error', done); resolve(undefined); };
      const t = setTimeout(done, ms);
      img.addEventListener('load', done);
      img.addEventListener('error', done);
    });
  }

  /** @param {Blob} blob @returns {Promise<string>} */
  function blobToB64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => { const s = String(fr.result); resolve(s.slice(s.indexOf(',') + 1)); };
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  const MAX_FILE = 12 * 1024 * 1024;
  const DECODABLE = /^image\/(png|jpe?g|webp|gif|avif|bmp|x-icon|vnd\.microsoft\.icon)$/i;
  const LOSSLESS_PIXELS = 4e6;

  /**
   * @param {HTMLImageElement} img
   * @returns {Promise<string | null>}
   */
  async function readFile(img) {
    const src = img.currentSrc || img.src;
    if (!src || !/^(https?:|blob:|data:)/i.test(src)) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    try {
      const cors = img.crossOrigin !== null && /^https?:/i.test(src) && new URL(src, location.href).origin !== location.origin;
      const res = await fetch(src, {
        cache: 'force-cache',
        signal: ac.signal,
        mode: cors ? 'cors' : 'same-origin',
        credentials: img.crossOrigin === 'use-credentials' ? 'include' : 'same-origin',
        referrerPolicy: 'strict-origin-when-cross-origin',
      });
      if (!res.ok) return null;
      const len = Number(res.headers.get('content-length') || 0);
      if (len > MAX_FILE) return null;
      const blob = await res.blob();
      if (blob.size > MAX_FILE || !DECODABLE.test(blob.type)) return null;
      return await blobToB64(blob);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {HTMLImageElement} img
   * @returns {Promise<string | null>}
   */
  async function readImage(img) {
    try {
      await loaded(img, 10_000);
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      if (!nw || !nh) return null;
      const file = await readFile(img);
      if (file) return file;
      const s = Math.min(1, Math.sqrt(MAX_PIXELS / (nw * nh)), 16384 / Math.max(nw, nh));
      const w = Math.max(1, Math.round(nw * s));
      const h = Math.max(1, Math.round(nh * s));
      const bmp = await createImageBitmap(img, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
      const c = new OffscreenCanvas(w, h);
      const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d', { alpha: false }));
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      const blob = await c.convertToBlob(w * h <= LOSSLESS_PIXELS ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.95 });
      c.width = c.height = 0;
      return await blobToB64(blob);
    } catch {
      return null;
    }
  }

  /**
   * @param {HTMLImageElement} img
   * @param {string} url
   * @returns {CaptureCap}
   */
  function capOf(img, url) {
    if (url.startsWith('blob:') || url.startsWith('data:')) return 1;
    try {
      if (new URL(url, location.href).origin === location.origin) return 2;
    } catch {}
    return img.crossOrigin !== null ? 2 : 0;
  }

  /** @param {string} s */
  function hash(s) {
    let h = 0x811c9dc5;
    const step = Math.max(1, Math.floor(s.length / 4096));
    for (let i = 0; i < s.length; i += step) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  /**
   * @param {string} url
   * @returns {string | null}
   */
  function jobUrl(url) {
    if (url.startsWith('data:')) return `data:${url.length}:${hash(url)}`;
    return url.length <= 4096 ? url : null;
  }

  return { readImage, capOf, jobUrl };
})();
