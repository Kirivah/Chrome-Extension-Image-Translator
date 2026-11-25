export const PINK = [218, 55, 150];
export const WHITE = [252, 252, 252];

/** @param {{wire?: number}} [o] */
export function scene(o = {}) {
  const W = 360; const H = 640;
  const data = new Uint8ClampedArray(W * H * 4);
  let seed = 9;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let c;
      if (y < 200) c = [120 + y * 0.3, 190 + y * 0.1, 240];
      else if (x > 130 && y > 420 && y < 470) c = [248, 248, 247];
      else { const n = rnd() * 50; c = [30 + n * 0.4, 80 + n, 50 + n * 0.5]; }
      if (o.wire !== undefined && Math.abs(y - o.wire) <= 1) c = [24, 26, 30];
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
    }
  }
  /** @type {{x0: number, y0: number, x1: number, y1: number}[]} */
  const glyphs = [];
  /** @param {number} cx @param {number} cy @param {boolean} edged */
  const char = (cx, cy, edged = true, colour = PINK) => {
    const s = 30; const sw = 5; const ol = 6;
    const ink = (x, y) => {
      const dx = x - cx; const dy = y - cy;
      if (Math.abs(dx) > s / 2 || Math.abs(dy) > s / 2) return false;
      return Math.abs(dy) < sw / 2 || Math.abs(dx) < sw / 2 || Math.abs(dx - s / 2 + sw / 2) < sw / 2 || Math.abs(dy + s / 2 - sw / 2) < sw / 2;
    };
    for (let y = cy - s; y <= cy + s; y++) {
      for (let x = cx - s; x <= cx + s; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = (y * W + x) * 4;
        let near = Infinity;
        if (!ink(x, y)) {
          for (let yy = -ol; yy <= ol && near > 0; yy++) for (let xx = -ol; xx <= ol; xx++) if (xx * xx + yy * yy <= ol * ol && ink(x + xx, y + yy)) { near = 0; break; }
        }
        const c = ink(x, y) ? colour : edged && near === 0 ? WHITE : null;
        if (c) { data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; }
      }
    }
    glyphs.push({ x0: cx - s / 2, y0: cy - s / 2, x1: cx + s / 2 + 1, y1: cy + s / 2 + 1 });
  };
  for (let k = 0; k < 14; k++) char(110, 40 + k * 40);
  const kind = (i) => (data[i] === PINK[0] && data[i + 1] === PINK[1] ? 1 : data[i] === WHITE[0] && data[i + 1] === WHITE[1] ? 2 : 0);
  const was = new Uint8ClampedArray(data);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      if (kind(i) !== 2) continue;
      for (const d of [-4, 4, -W * 4, W * 4]) {
        const q = i + d;
        const k = kind(q);
        if (k === 2) continue;
        for (let c = 0; c < 3; c++) data[i + c] = (was[i + c] + was[q + c]) / 2;
        break;
      }
    }
  }
  const column = glyphs.splice(0);
  char(110, 625, false);
  const flower = glyphs.splice(0);
  for (let k = 0; k < 4; k++) char(300, 60 + k * 40);
  const other = glyphs.splice(0);
  return { px: { data, W, H }, column, flower, other };
}

export function blockOf(px, chars) {
  const x0 = Math.min(...chars.map((c) => c.x0)); const y0 = Math.min(...chars.map((c) => c.y0));
  const x1 = Math.max(...chars.map((c) => c.x1)); const y1 = Math.max(...chars.map((c) => c.y1));
  const w = x1 - x0; const h = y1 - y0;
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * px.W + x0 + x) * 4;
      if (Math.abs(px.data[i] - PINK[0]) < 20 && Math.abs(px.data[i + 1] - PINK[1]) < 20) bits[y * w + x] = 1;
    }
  }
  return { box: { x0, y0, x1, y1 }, glyph: 30, dark: true, vertical: true, cells: chars.length, ink: 113, paper: 250, mask: { x0, y0, w, h, s: 1, bits } };
}
