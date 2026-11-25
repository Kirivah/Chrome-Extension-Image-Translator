// @ts-check

/**
 * @typedef {Object} Seg
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {boolean} cutT
 * @property {boolean} cutB
 * @property {boolean} cutL
 * @property {boolean} cutR
 */

/**
 * @typedef {Object} Block
 * @property {number} x0
 * @property {number} y0
 * @property {number} x1
 * @property {number} y1
 * @property {string} t
 * @property {boolean} [edge]
 */

const MAX_TEXT = 1200;
const EDGE = 8;

/**
 * @param {unknown} obj
 * @param {number} nImages
 * @returns {{img: number, y0: number, x0: number, y1: number, x1: number, t: string} | null}
 */
export function parseModelBlock(obj, nImages) {
  if (!obj || typeof obj !== 'object') return null;
  const o = /** @type {Record<string, unknown>} */ (obj);
  const box = o.box_2d;
  if (!Array.isArray(box) || box.length !== 4) return null;
  const n = box.map((v) => (typeof v === 'number' ? v : Number(v)));
  if (!n.every(Number.isFinite)) return null;
  let [y0, x0, y1, x1] = n.map((v) => Math.min(1000, Math.max(0, v)));
  if (y1 < y0) [y0, y1] = [y1, y0];
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 - y0 < 2 || x1 - x0 < 2) return null;

  const tr = typeof o.translation === 'string' ? o.translation : '';
  const t = tr.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  if (!t) return null;

  let img = 0;
  if (nImages > 1) {
    const i = typeof o.image === 'number' ? o.image : Number(o.image);
    if (!Number.isInteger(i) || i < 0 || i >= nImages) return null;
    img = i;
  }
  return { img, y0, x0, y1, x1, t };
}

/**
 * @param {{y0: number, x0: number, y1: number, x1: number, t: string}} b
 * @param {Seg} seg
 * @param {number} W
 * @param {number} H
 * @returns {Block}
 */
export function toFullImage(b, seg, W, H) {
  const edge = (seg.cutT && b.y0 <= EDGE) || (seg.cutB && b.y1 >= 1000 - EDGE)
    || (seg.cutL && b.x0 <= EDGE) || (seg.cutR && b.x1 >= 1000 - EDGE);
  return {
    x0: (seg.x + (b.x0 / 1000) * seg.w) / W,
    y0: (seg.y + (b.y0 / 1000) * seg.h) / H,
    x1: (seg.x + (b.x1 / 1000) * seg.w) / W,
    y1: (seg.y + (b.y1 / 1000) * seg.h) / H,
    t: b.t,
    edge,
  };
}

/** @param {Block} a */
const area = (a) => Math.max(0, a.x1 - a.x0) * Math.max(0, a.y1 - a.y0);

/**
 * @param {Block} a
 * @param {Block} b
 */
export function overlapRatio(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  const m = Math.min(area(a), area(b));
  return m > 0 ? (w * h) / m : 0;
}

/** @param {Block} b @param {Block[]} list */
function isDuplicate(b, list) {
  for (const a of list) if (overlapRatio(a, b) > 0.55) return true;
  return false;
}

export class BlockCollector {
  /** @param {number} segCount */
  constructor(segCount) {
    this.multi = segCount > 1;
    /** @type {Block[]} */
    this.accepted = [];
    /** @type {Block[]} */
    this.held = [];
  }

  /** @param {Block} b @returns {Block[]} */
  add(b) {
    if (isDuplicate(b, this.accepted)) return [];
    if (this.multi && b.edge) {
      this.held.push(b);
      return [];
    }
    this.accepted.push(b);
    return [b];
  }

  /** @returns {Block[]} */
  finish() {
    /** @type {Block[]} */
    const out = [];
    this.held.sort((a, b) => area(b) - area(a));
    for (const b of this.held) {
      if (isDuplicate(b, this.accepted)) continue;
      this.accepted.push(b);
      out.push(b);
    }
    this.held = [];
    return out;
  }

  /** @returns {Block[]} */
  all() {
    return this.accepted.map(({ x0, y0, x1, y1, t }) => ({ x0, y0, x1, y1, t }));
  }
}

/**
 * @param {unknown} v
 * @returns {Block[] | null}
 */
export function validCachedBlocks(v) {
  if (!Array.isArray(v) || v.length > 500) return null;
  /** @type {Block[]} */
  const out = [];
  for (const b of v) {
    if (!b || typeof b !== 'object') return null;
    const { x0, y0, x1, y1, t } = /** @type {Record<string, unknown>} */ (b);
    if (![x0, y0, x1, y1].every((n) => typeof n === 'number' && n >= 0 && n <= 1)) return null;
    if (typeof t !== 'string' || t.length > MAX_TEXT) return null;
    out.push({ x0: /** @type {number} */ (x0), y0: /** @type {number} */ (y0), x1: /** @type {number} */ (x1), y1: /** @type {number} */ (y1), t });
  }
  return out;
}
