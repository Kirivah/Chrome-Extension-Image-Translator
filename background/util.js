// @ts-check

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {number} v @param {number} lo @param {number} hi */
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** @param {Uint8Array} bytes */
export async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', /** @type {BufferSource} */ (bytes)));
  let s = '';
  for (let i = 0; i < d.length; i++) s += d[i].toString(16).padStart(2, '0');
  return s;
}

/** @param {Uint8Array} u8 */
export function bytesToB64(u8) {
  const native = /** @type {any} */ (u8).toBase64;
  if (typeof native === 'function') return native.call(u8);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    bin += String.fromCharCode.apply(null, /** @type {any} */ (u8.subarray(i, i + CH)));
  }
  return btoa(bin);
}

/**
 * @param {string} s
 * @returns {Uint8Array | null}
 */
export function b64ToBytes(s) {
  try {
    const native = /** @type {any} */ (Uint8Array).fromBase64;
    if (typeof native === 'function') return native(s);
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** @param {number} r @param {number} g @param {number} b */
export function rgbHex(r, g, b) {
  const h = (/** @type {number} */ v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export class TaskError extends Error {
  /** @param {ErrCode} code @param {string} [detail] @param {number} [retryMs] */
  constructor(code, detail = '', retryMs = 0) {
    super(detail || code);
    this.code = code;
    this.retryMs = retryMs;
    /** @type {{perMinute: number, perDay: number, zero: boolean}} */
    this.quota = { perMinute: 0, perDay: 0, zero: false };
  }
}

/**
 * @param {unknown} e
 * @returns {TaskError}
 */
export function asTaskError(e) {
  if (e instanceof TaskError) return e;
  console.error('[imgtr] internal error', e);
  return new TaskError('internal', String(e).slice(0, 300));
}
