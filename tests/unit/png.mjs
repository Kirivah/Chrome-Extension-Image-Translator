import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/** @param {string} path @returns {{data: Uint8ClampedArray, W: number, H: number}} */
export function readPng(path) {
  const buf = readFileSync(path);
  let pos = 8;
  let W = 0; let H = 0; let type = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const name = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (name === 'IHDR') {
      W = body.readUInt32BE(0); H = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0) throw new Error('only 8-bit, non-interlaced PNGs');
      type = body[9];
    } else if (name === 'IDAT') idat.push(body);
    else if (name === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = { 0: 1, 2: 3, 6: 4 }[type];
  if (!bpp) throw new Error(`unsupported PNG colour type ${type}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = W * bpp;
  const px = new Uint8Array(H * stride);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[dst + i - bpp] : 0;
      const b = y ? px[dst - stride + i] : 0;
      const c = y && i >= bpp ? px[dst - stride + i - bpp] : 0;
      let v = raw[src + i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[dst + i] = v & 255;
    }
  }
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0, j = 0; i < W * H; i++, j += bpp) {
    data[i * 4] = px[j];
    data[i * 4 + 1] = bpp === 1 ? px[j] : px[j + 1];
    data[i * 4 + 2] = bpp === 1 ? px[j] : px[j + 2];
    data[i * 4 + 3] = bpp === 4 ? px[j + 3] : 255;
  }
  return { data, W, H };
}
