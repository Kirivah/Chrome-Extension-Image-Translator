// @ts-check
import { bytesToB64 } from './util.js';

/** @typedef {import('./regions.js').Seg} Seg */
/** @typedef {import('./analysis.js').Pixels} Pixels */

const DECODE_MAX_PIXELS = 16e6;
const ANALYSIS_MAX_PIXELS = 3e6;
const MAX_SEGMENTS = 24;

/**
 * @param {Uint8Array} bytes
 * @param {{w: number, h: number} | null} dims
 * @returns {Promise<ImageBitmap>}
 */
export async function decodeImage(bytes, dims) {
  const blob = new Blob([/** @type {BlobPart} */ (bytes)]);
  /** @type {ImageBitmapOptions} */
  const opts = { imageOrientation: 'from-image', colorSpaceConversion: 'default', premultiplyAlpha: 'none' };
  if (dims && dims.w * dims.h > DECODE_MAX_PIXELS) {
    const s = Math.sqrt(DECODE_MAX_PIXELS / (dims.w * dims.h));
    opts.resizeWidth = Math.max(1, Math.round(dims.w * s));
    opts.resizeQuality = 'medium';
  }
  return createImageBitmap(blob, opts);
}

/**
 * @param {number} W
 * @param {number} H
 * @returns {Seg[]}
 */
export function planSegments(W, H) {
  /** @type {Seg[]} */
  const out = [];
  const tall = H > W * 2.2;
  const wide = W > H * 3;
  if (!tall && !wide) return [{ x: 0, y: 0, w: W, h: H, cutT: false, cutB: false, cutL: false, cutR: false }];

  const long = tall ? H : W;
  const short = tall ? W : H;
  let seg = Math.round(short * (tall ? 1.6 : 2));
  let overlap = Math.round(seg * 0.2);
  let count = Math.ceil((long - overlap) / (seg - overlap));
  if (count > MAX_SEGMENTS) {
    seg = Math.ceil(long / MAX_SEGMENTS * 1.25);
    overlap = Math.round(seg * 0.2);
    count = Math.ceil((long - overlap) / (seg - overlap));
  }
  const stride = count > 1 ? (long - seg) / (count - 1) : 0;
  for (let i = 0; i < count; i++) {
    const a = Math.round(i * stride);
    const len = Math.min(seg, long - a);
    const first = i === 0;
    const last = i === count - 1;
    out.push(tall
      ? { x: 0, y: a, w: W, h: len, cutT: !first, cutB: !last, cutL: false, cutR: false }
      : { x: a, y: 0, w: len, h: H, cutT: false, cutB: false, cutL: !first, cutR: !last });
  }
  return out;
}

/**
 * @param {ImageBitmap} bmp
 * @param {Seg} s
 * @param {number} maxSide
 * @returns {Promise<string>}
 */
export async function encodeSegment(bmp, s, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(s.w, s.h));
  const w = Math.max(1, Math.round(s.w * scale));
  const h = Math.max(1, Math.round(s.h * scale));
  const c = new OffscreenCanvas(w, h);
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d', { alpha: false }));
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, s.x, s.y, s.w, s.h, 0, 0, w, h);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
  c.width = c.height = 0;
  return bytesToB64(new Uint8Array(await blob.arrayBuffer()));
}

/**
 * @param {ImageBitmap} bmp
 * @returns {Pixels}
 */
export function analysisPixels(bmp) {
  const s = Math.min(1, Math.sqrt(ANALYSIS_MAX_PIXELS / (bmp.width * bmp.height)));
  const W = Math.max(1, Math.round(bmp.width * s));
  const H = Math.max(1, Math.round(bmp.height * s));
  const c = new OffscreenCanvas(W, H);
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d', { alpha: false, willReadFrequently: true }));
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(bmp, 0, 0, W, H);
  const data = ctx.getImageData(0, 0, W, H).data;
  c.width = c.height = 0;
  return { data, W, H };
}

/**
 * @param {Uint8ClampedArray} rgba
 * @param {number} w
 * @param {number} h
 * @returns {Promise<string | null>}
 */
export async function encodePatch(rgba, w, h) {
  try {
    const c = new OffscreenCanvas(w, h);
    const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d'));
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
    let blob = await c.convertToBlob({ type: 'image/webp', quality: 0.9 });
    if (blob.type !== 'image/webp') blob = await c.convertToBlob({ type: 'image/png' });
    c.width = c.height = 0;
    return bytesToB64(new Uint8Array(await blob.arrayBuffer()));
  } catch {
    return null;
  }
}
