// @ts-check

/** @typedef {import('./analysis.js').Pixels} Pixels */
/** @typedef {import('./analysis.js').Box} Box */

const R = 3;
const MAX_LEVELS = 5;
const RIM = 2;
const DEPTH = 2;
const GUESS = 0.3;
const SIGMA_Q = 0.75;
const EM = [4, 2, 1];
const MODE_STEPS = 1;
const MODE_BAND = 24;

/**
 * @typedef {Object} Level
 * @property {number} w
 * @property {number} h
 * @property {Float32Array} img
 * @property {Uint8Array} hole
 * @property {Uint8Array} bad
 */

/**
 * @param {Pixels} px
 * @param {Uint8Array} mask
 * @param {number} bx0
 * @param {number} by0
 * @param {number} w
 * @param {number} h
 * @param {Float32Array} start
 * @param {Box[]} avoid
 * @param {number} pad
 * @param {number} margin
 * @param {number} deadline
 * @param {(stage: string, data: unknown) => void} [debug]
 * @returns {Float32Array}
 */
export function patchFill(px, mask, bx0, by0, w, h, start, avoid, pad, margin, deadline, debug) {
  const { data, W, H } = px;
  const out = new Float32Array(start);
  const X0 = Math.max(0, bx0 - margin); const Y0 = Math.max(0, by0 - margin);
  const X1 = Math.min(W, bx0 + w + margin); const Y1 = Math.min(H, by0 + h + margin);
  const ww = X1 - X0; const wh = Y1 - Y0;
  const ox = bx0 - X0; const oy = by0 - Y0;
  if (ww < 4 * R || wh < 4 * R) return out;

  const n0 = ww * wh;
  const img0 = new Float32Array(n0 * 3);
  const hole0 = new Uint8Array(n0);
  let holes = 0;
  for (let y = 0; y < wh; y++) {
    let i = ((Y0 + y) * W + X0) * 4;
    for (let x = 0; x < ww; x++, i += 4) {
      const k = y * ww + x;
      const bx = x - ox; const by = y - oy;
      if (bx >= 0 && by >= 0 && bx < w && by < h && mask[by * w + bx]) {
        const b = (by * w + bx) * 3;
        img0[k * 3] = start[b]; img0[k * 3 + 1] = start[b + 1]; img0[k * 3 + 2] = start[b + 2];
        hole0[k] = 1;
        holes++;
      } else {
        img0[k * 3] = data[i]; img0[k * 3 + 1] = data[i + 1]; img0[k * 3 + 2] = data[i + 2];
      }
    }
  }
  if (!holes) return out;
  const bad0 = new Uint8Array(n0);
  for (let k = 0; k < n0; k++) if (hole0[k]) bad0[k] = 1;
  chebyshevDilate(bad0, ww, wh, RIM);
  for (const b of avoid) {
    const x0 = Math.max(0, b.x0 - pad - X0); const x1 = Math.min(ww, b.x1 + pad - X0);
    const y0 = Math.max(0, b.y0 - pad - Y0); const y1 = Math.min(wh, b.y1 + pad - Y0);
    for (let y = y0; y < y1; y++) bad0.fill(1, y * ww + x0, y * ww + Math.max(x0, x1));
  }

  const deep = depthOf(hole0, ww, wh);
  let dmax = 0;
  for (let k = 0; k < n0; k++) if (deep[k] > dmax) dmax = deep[k];
  const count = Math.max(1, Math.min(MAX_LEVELS, 1 + Math.floor(Math.log2(Math.max(1, dmax) / 2))));
  /** @type {Level[]} */
  const levels = [{ w: ww, h: wh, img: img0, hole: hole0, bad: bad0 }];
  while (levels.length < count) {
    const f = levels[levels.length - 1];
    if (f.w < 8 * R || f.h < 8 * R) break;
    levels.push(halve(f));
  }

  const rnd = xorshift((bx0 * 73856093) ^ (by0 * 19349663) ^ (w * 83492791) ^ h);
  /** @type {{nnf: Int32Array, tIdx: Int32Array, tList: Int32Array} | null} */
  let prev = null;
  for (let li = levels.length - 1; li >= 0; li--) {
    const L = levels[li];
    const coarsest = li === levels.length - 1;
    const res = matchLevel(L, li === levels.length - 1 ? null : levels[li + 1], prev, rnd, {
      em: coarsest ? EM[0] : li === 0 ? EM[2] : EM[1],
      passes: coarsest ? 2 : 1,
      deadline,
    });
    if (!res) return out;
    debug?.('level', { li, L, X0, Y0, ...res });
    prev = res;
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const b = y * w + x;
      if (!mask[b]) continue;
      const k = (y + oy) * ww + x + ox;
      out[b * 3] = img0[k * 3]; out[b * 3 + 1] = img0[k * 3 + 1]; out[b * 3 + 2] = img0[k * 3 + 2];
    }
  }
  return out;
}

/**
 * @param {Level} L
 * @param {Level | null} C
 * @param {{nnf: Int32Array, tIdx: Int32Array, tList: Int32Array} | null} prev
 * @param {() => number} rnd
 * @param {{em: number, passes: number, deadline: number}} o
 * @returns {{nnf: Int32Array, tIdx: Int32Array, tList: Int32Array} | null}
 */
function matchLevel(L, C, prev, rnd, o) {
  const { w, h, img, hole, bad } = L;
  const n = w * h;
  const ok = new Uint8Array(n);
  {
    const ii = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += bad[y * w + x];
        ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + row;
      }
    }
    for (let y = R; y < h - R; y++) {
      for (let x = R; x < w - R; x++) {
        const a = ii[(y - R) * (w + 1) + x - R]; const b = ii[(y - R) * (w + 1) + x + R + 1];
        const c = ii[(y + R + 1) * (w + 1) + x - R]; const d = ii[(y + R + 1) * (w + 1) + x + R + 1];
        if (d - b - c + a === 0) ok[y * w + x] = 1;
      }
    }
  }
  let nOk = 0;
  for (let k = 0; k < n; k++) nOk += ok[k];
  if (nOk < 16) return null;
  const okList = new Int32Array(nOk);
  for (let k = 0, j = 0; k < n; k++) if (ok[k]) okList[j++] = k;

  const isT = new Uint8Array(hole);
  chebyshevDilate(isT, w, h, R);
  let nT = 0;
  for (let k = 0; k < n; k++) nT += isT[k];
  const tList = new Int32Array(nT);
  const tIdx = new Int32Array(n).fill(-1);
  for (let k = 0, j = 0; k < n; k++) if (isT[k]) { tIdx[k] = j; tList[j++] = k; }
  const deep = depthOf(hole, w, h);
  const conf = new Float32Array(nT);
  for (let j = 0; j < nT; j++) conf[j] = Math.pow(DEPTH, -deep[tList[j]]);

  if (C) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        if (!hole[k]) continue;
        const cx = Math.min(C.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
        const cy = Math.min(C.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
        const x0 = Math.floor(cx); const y0 = Math.floor(cy);
        const x1 = Math.min(C.w - 1, x0 + 1); const y1 = Math.min(C.h - 1, y0 + 1);
        const fx = cx - x0; const fy = cy - y0;
        for (let c = 0; c < 3; c++) {
          img[k * 3 + c] = (1 - fy) * ((1 - fx) * C.img[(y0 * C.w + x0) * 3 + c] + fx * C.img[(y0 * C.w + x1) * 3 + c])
            + fy * ((1 - fx) * C.img[(y1 * C.w + x0) * 3 + c] + fx * C.img[(y1 * C.w + x1) * 3 + c]);
        }
      }
    }
  }

  const nnf = new Int32Array(nT);
  const nd = new Float32Array(nT);
  const randomOk = () => okList[Math.floor(rnd() * nOk)];
  for (let j = 0; j < nT; j++) {
    const t = tList[j];
    let s = -1;
    if (prev && C) {
      const tx = t % w; const ty = (t - tx) / w;
      const ct = (ty >> 1) * C.w + (tx >> 1);
      const cj = ty >> 1 < C.h && tx >> 1 < C.w ? prev.tIdx[ct] : -1;
      if (cj >= 0) {
        const cs = prev.nnf[cj];
        const csx = cs % C.w; const csy = (cs - csx) / C.w;
        const sx = Math.min(w - R - 1, Math.max(R, 2 * csx + (tx & 1)));
        const sy = Math.min(h - R - 1, Math.max(R, 2 * csy + (ty & 1)));
        const q = sy * w + sx;
        if (ok[q]) s = q;
      }
    }
    nnf[j] = s >= 0 ? s : randomOk();
  }

  /**
   * @param {number} tx
   * @param {number} ty
   * @param {number} sx
   * @param {number} sy
   * @param {number} cut
   */
  const dist = (tx, ty, sx, sy, cut) => {
    let d = 0; let cnt = 0;
    const xa = Math.max(0, tx - R); const xb = Math.min(w - 1, tx + R);
    for (let dy = -R; dy <= R; dy++) {
      const y = ty + dy;
      if (y < 0 || y >= h) continue;
      let k = y * w + xa;
      let si = ((sy + dy) * w + sx + xa - tx) * 3;
      for (let x = xa; x <= xb; x++, k++, si += 3) {
        const ti = k * 3;
        const a = img[ti] - img[si]; const b = img[ti + 1] - img[si + 1]; const c = img[ti + 2] - img[si + 2];
        d += (hole[k] ? GUESS : 1) * (a * a + b * b + c * c);
      }
      cnt += xb - xa + 1;
      if (d >= cut) return d;
    }
    return cnt === (2 * R + 1) * (2 * R + 1) ? d : (d * (2 * R + 1) * (2 * R + 1)) / Math.max(1, cnt);
  };

  const acc = new Float32Array(nT * 3);
  const wsum = new Float32Array(nT);
  const tw = new Float32Array(nT);
  const best = new Float32Array(nT);
  const mode = new Float32Array(nT * 3);
  const order = new Float32Array(nT);
  const far = Math.max(w, h);
  for (let e = 0; e < o.em; e++) {
    for (let j = 0; j < nT; j++) {
      const t = tList[j]; const s = nnf[j];
      const tx = t % w; const sx = s % w;
      nd[j] = dist(tx, (t - tx) / w, sx, (s - sx) / w, Infinity);
    }
    for (let p = 0; p < o.passes && performance.now() < o.deadline; p++) {
      const back = (p & 1) === 1;
      const step = back ? -1 : 1;
      for (let jj = 0; jj < nT; jj++) {
        const j = back ? nT - 1 - jj : jj;
        const t = tList[j];
        const tx = t % w; const ty = (t - tx) / w;
        let best = nd[j]; let bs = nnf[j];
        const nx = tx - step;
        if (nx >= 0 && nx < w) {
          const nj = tIdx[t - step];
          if (nj >= 0) {
            const s = nnf[nj] + step;
            if (s !== bs && s >= 0 && s < w * h && ok[s]) {
              const sx = s % w;
              const d = dist(tx, ty, sx, (s - sx) / w, best);
              if (d < best) { best = d; bs = s; }
            }
          }
        }
        const ny = ty - step;
        if (ny >= 0 && ny < h) {
          const nj = tIdx[t - step * w];
          if (nj >= 0) {
            const s = nnf[nj] + step * w;
            if (s !== bs && s >= 0 && s < w * h && ok[s]) {
              const sx = s % w;
              const d = dist(tx, ty, sx, (s - sx) / w, best);
              if (d < best) { best = d; bs = s; }
            }
          }
        }
        const bx = bs % w; const by = (bs - bx) / w;
        for (let rad = far; rad >= 1; rad >>= 1) {
          const sx = Math.min(w - R - 1, Math.max(R, bx + Math.round((2 * rnd() - 1) * rad)));
          const sy = Math.min(h - R - 1, Math.max(R, by + Math.round((2 * rnd() - 1) * rad)));
          const s = sy * w + sx;
          if (s === bs || !ok[s]) continue;
          const d = dist(tx, ty, sx, sy, best);
          if (d < best) { best = d; bs = s; }
        }
        nnf[j] = bs; nd[j] = best;
      }
    }
    for (let j = 0; j < nT; j++) order[j] = nd[j];
    order.sort();
    const s2 = Math.max(1, order[Math.min(nT - 1, Math.floor(SIGMA_Q * nT))]);
    for (let j = 0; j < nT; j++) tw[j] = Math.exp(-nd[j] / (2 * s2)) * conf[j];
    best.fill(0);
    for (let j = 0; j < nT; j++) {
      const wt = tw[j];
      if (wt < 1e-6) continue;
      const t = tList[j]; const s = nnf[j];
      const tx = t % w; const ty = (t - tx) / w;
      for (let dy = -R; dy <= R; dy++) {
        const y = ty + dy;
        if (y < 0 || y >= h) continue;
        for (let dx = -R; dx <= R; dx++) {
          const x = tx + dx;
          if (x < 0 || x >= w) continue;
          const q = y * w + x;
          if (!hole[q]) continue;
          const qj = tIdx[q];
          if (wt <= best[qj]) continue;
          best[qj] = wt;
          const si = (s + dy * w + dx) * 3;
          mode[qj * 3] = img[si]; mode[qj * 3 + 1] = img[si + 1]; mode[qj * 3 + 2] = img[si + 2];
        }
      }
    }
    for (let it = 0; it < MODE_STEPS; it++) {
      acc.fill(0); wsum.fill(0);
      for (let j = 0; j < nT; j++) {
        const wt = tw[j];
        if (wt < 1e-6) continue;
        const t = tList[j]; const s = nnf[j];
        const tx = t % w; const ty = (t - tx) / w;
        for (let dy = -R; dy <= R; dy++) {
          const y = ty + dy;
          if (y < 0 || y >= h) continue;
          for (let dx = -R; dx <= R; dx++) {
            const x = tx + dx;
            if (x < 0 || x >= w) continue;
            const q = y * w + x;
            if (!hole[q]) continue;
            const qj = tIdx[q];
            const si = (s + dy * w + dx) * 3;
            const r = img[si]; const g = img[si + 1]; const b = img[si + 2];
            const dr = r - mode[qj * 3]; const dg = g - mode[qj * 3 + 1]; const db = b - mode[qj * 3 + 2];
            const k = wt * Math.exp(-(dr * dr + dg * dg + db * db) / (2 * MODE_BAND * MODE_BAND));
            acc[qj * 3] += k * r; acc[qj * 3 + 1] += k * g; acc[qj * 3 + 2] += k * b;
            wsum[qj] += k;
          }
        }
      }
      for (let j = 0; j < nT; j++) {
        if (!(wsum[j] > 0)) continue;
        mode[j * 3] = acc[j * 3] / wsum[j]; mode[j * 3 + 1] = acc[j * 3 + 1] / wsum[j]; mode[j * 3 + 2] = acc[j * 3 + 2] / wsum[j];
      }
    }
    for (let j = 0; j < nT; j++) {
      const q = tList[j];
      if (!hole[q] || !(best[j] > 0)) continue;
      img[q * 3] = mode[j * 3]; img[q * 3 + 1] = mode[j * 3 + 1]; img[q * 3 + 2] = mode[j * 3 + 2];
    }
  }
  return { nnf, tIdx, tList };
}

/**
 * @param {Level} f
 * @returns {Level}
 */
function halve(f) {
  const w = Math.ceil(f.w / 2); const h = Math.ceil(f.h / 2);
  const img = new Float32Array(w * h * 3);
  const hole = new Uint8Array(w * h);
  const bad = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0; let g = 0; let b = 0; let m = 0;
      let kr = 0; let kg = 0; let kb = 0; let km = 0;
      const k = y * w + x;
      for (let dy = 0; dy < 2; dy++) {
        const yy = 2 * y + dy;
        if (yy >= f.h) continue;
        for (let dx = 0; dx < 2; dx++) {
          const xx = 2 * x + dx;
          if (xx >= f.w) continue;
          const q = yy * f.w + xx;
          r += f.img[q * 3]; g += f.img[q * 3 + 1]; b += f.img[q * 3 + 2]; m++;
          if (!f.hole[q]) { kr += f.img[q * 3]; kg += f.img[q * 3 + 1]; kb += f.img[q * 3 + 2]; km++; }
          if (f.bad[q]) bad[k] = 1;
        }
      }
      if (2 * km >= m && km > 0) { img[k * 3] = kr / km; img[k * 3 + 1] = kg / km; img[k * 3 + 2] = kb / km; }
      else { hole[k] = 1; img[k * 3] = r / m; img[k * 3 + 1] = g / m; img[k * 3 + 2] = b / m; }
    }
  }
  return { w, h, img, hole, bad };
}

/**
 * @param {Uint8Array} hole
 * @param {number} w
 * @param {number} h
 * @returns {Uint16Array}
 */
function depthOf(hole, w, h) {
  const n = w * h;
  const d = new Uint16Array(n);
  /** @type {number[]} */
  let front = [];
  for (let k = 0; k < n; k++) {
    if (!hole[k]) continue;
    d[k] = 65535;
    const x = k % w; const y = (k - x) / w;
    if ((x > 0 && !hole[k - 1]) || (x < w - 1 && !hole[k + 1]) || (y > 0 && !hole[k - w]) || (y < h - 1 && !hole[k + w])) { d[k] = 1; front.push(k); }
  }
  for (let level = 2; front.length; level++) {
    /** @type {number[]} */
    const next = [];
    for (const k of front) {
      const x = k % w; const y = (k - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (d[q] !== 65535) continue;
          d[q] = level;
          next.push(q);
        }
      }
    }
    front = next;
  }
  for (let k = 0; k < n; k++) if (d[k] === 65535) d[k] = 0;
  return d;
}

/**
 * @param {Uint8Array} a
 * @param {number} w
 * @param {number} h
 * @param {number} r
 */
function chebyshevDilate(a, w, h, r) {
  if (r <= 0) return;
  const tmp = new Uint8Array(a.length);
  for (let y = 0; y < h; y++) {
    let last = -Infinity;
    const row = y * w;
    for (let x = 0; x < w; x++) { if (a[row + x]) last = x; if (x - last <= r) tmp[row + x] = 1; }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) { if (a[row + x]) last = x; if (last - x <= r) tmp[row + x] = 1; }
  }
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; if (y - last <= r) a[y * w + x] = 1; }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (last - y <= r) a[y * w + x] = 1; }
  }
}

/** @param {number} seed */
function xorshift(seed) {
  let s = (seed | 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}
