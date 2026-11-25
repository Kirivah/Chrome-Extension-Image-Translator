// @ts-check
import { analyzeBox, resolveCollisions, overlap, luminance, contrast, fontFor } from './analysis.js';
import { refineBox } from './refine.js';
import { buildTextMap } from './textmap.js';
import { Matcher } from './match.js';
import { findBubbles } from './bubbles.js';
import { textsOf } from './texts.js';
import { eraseLettering } from './inpaint.js';
import { completeLettering } from './complete.js';
import { colourLettering, adoptColourBlocks } from './colortext.js';
import { rgbHex, clamp } from './util.js';
import { VERTICAL_LANGS } from '../shared/languages.js';

/** @typedef {import('./analysis.js').Pixels} Pixels */
/** @typedef {import('./analysis.js').Box} Box */
/** @typedef {import('./analysis.js').Style} Style */
/** @typedef {import('./analysis.js').RGB} RGB */
/** @typedef {import('./regions.js').Block} Block */
/** @typedef {import('./textmap.js').TextBlock} TextBlock */
/** @typedef {import('./textmap.js').TextMap} TextMap */
/** @typedef {import('./match.js').Action} Action */
/** @typedef {import('./inpaint.js').Erased} Erased */

export const LETTER_SCALE = 1.1;
const LOUD_SCALE = 1.5;

const REFINE_BUDGET_MS = 1500;
const REFINE_BURST_MS = 4000;
const REFINE_REFILL = 1 / 3;
const refineBank = { ms: REFINE_BURST_MS, at: -Infinity };
function mayRefine() {
  const now = performance.now();
  refineBank.ms = Math.min(REFINE_BURST_MS, refineBank.ms + (now - refineBank.at) * REFINE_REFILL);
  refineBank.at = now;
  return refineBank.ms > 0;
}

const NO_WORDS = /^[^\p{L}\p{N}]*$/u;
const ANY_BREAK = /[぀-ヿ㐀-鿿豈-﫿가-힯฀-๿]/u;

/**
 * @param {string} text
 * @param {number} cap
 * @returns {import('./analysis.js').TextNeed}
 */
export function textNeed(text, cap) {
  const chars = [...text].length;
  let word = 0;
  if (ANY_BREAK.test(text)) word = 2;
  else for (const w of text.split(/\s+/)) word = Math.max(word, [...w].length);
  return { chars, word, cap };
}

const WHITE = /** @type {RGB} */ ([255, 255, 255]);
const INK = /** @type {RGB} */ ([17, 17, 17]);

/**
 * @typedef {Object} PlaceOpts
 * @property {number} sensitivity
 * @property {string} lang
 * @property {(rgba: Uint8ClampedArray, w: number, h: number) => Promise<string | null>} encode
 */
/** @typedef {{show: Region[], retract: number[]}} Update */

/**
 * @typedef {Object} Item
 * @property {number} id
 * @property {Box} box
 * @property {number} glyph
 * @property {boolean} measured
 * @property {TextBlock[] | null} found
 */

const ERASE_BUDGET_MS = 4000;
const ERASE_BURST_MS = 8000;
const PLAIN_BUDGET_MS = 3000;
const eraseBank = { ms: ERASE_BURST_MS, at: -Infinity };
function mayErase() {
  const now = performance.now();
  eraseBank.ms = Math.min(ERASE_BURST_MS, eraseBank.ms + (now - eraseBank.at) * REFINE_REFILL);
  eraseBank.at = now;
  return eraseBank.ms > 0;
}
const MAP_BUDGET_MS = 1500;
const SLICE_MS = 40;
const MAX_PATCH_B64 = 1_400_000;

const yieldTurn = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * @param {string} a
 * @param {string} b
 */
function sameText(a, b) {
  const norm = (/** @type {string} */ t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const x = norm(a); const y = norm(b);
  if (!x || !y || x === y) return true;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  if (l.includes(s) && s.length >= 0.6 * l.length) return true;
  /** @param {string} t */
  const pairs = (t) => { const m = new Map(); for (let i = 0; i < t.length - 1; i++) { const k = t.slice(i, i + 2); m.set(k, (m.get(k) || 0) + 1); } return m; };
  const px = pairs(x); const py = pairs(y);
  let common = 0;
  for (const [k, n] of px) common += Math.min(n, py.get(k) || 0);
  return (2 * common) / Math.max(1, x.length - 1 + y.length - 1) >= 0.8;
}

/**
 * @param {string} whole
 * @param {string} part
 */
export function covers(whole, part) {
  /** @param {string} t */
  const words = (t) => t.toLowerCase().normalize('NFKC').replace(/[’']/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  let a = words(whole); let b = words(part);
  if (ANY_BREAK.test(part) && !/\s/.test(part.trim())) {
    /** @param {string} t */
    const chars = (t) => [...t.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '')];
    a = chars(whole); b = chars(part);
  }
  const m = a.length; const n = b.length;
  if (!n || n > m || m * n > 250_000) return false;
  let prev = new Uint16Array(n + 1); let cur = new Uint16Array(n + 1);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  return prev[n] >= Math.max(2, 0.7 * n);
}

/**
 * @param {Box} a
 * @param {Box} b
 * @param {number} glyph
 */
function sideBySide(a, b, glyph) {
  const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  const reach = 1.6 * glyph;
  if (-ox <= reach && oy >= 0.3 * Math.min(a.y1 - a.y0, b.y1 - b.y0)) return true;
  return -oy <= reach && ox >= 0.3 * Math.min(a.x1 - a.x0, b.x1 - b.x0);
}

export class Placer {
  /** @param {Pixels} px @param {PlaceOpts} opts */
  constructor(px, opts) {
    this.px = px;
    this.opts = opts;
    /** @type {TextMap | null} */
    this.map = null;
    /** @type {Matcher | null} */
    this.matcher = null;
    /** @type {Map<number, Block>} */
    this.blocks = new Map();
    this.nextId = 0;
    /** @type {Map<number, Style>} */
    this.styles = new Map();
    /** @type {Map<number, Region>} */
    this.shown = new Map();
    /** @type {Map<number, Item>} */
    this.placed = new Map();
    /** @type {Map<number, number[]>} */
    this.parts = new Map();
    /** @type {Map<number, number>} */
    this.partOf = new Map();
    /** @type {Set<number>} */
    this.covered = new Set();
    /** @type {(import('./refine.js').Claim & {id: number})[]} */
    this.claims = [];
    this.refineMs = 0;
    this.eraseMs = 0;
    this.plainMs = 0;
    /** @type {Set<number>} */
    this.unpolished = new Set();
    this.rough = false;
    this.dialogue = 0;
    this.colourArt = inColour(px);
  }

  /** @param {number} glyph */
  sizeFor(glyph) {
    return this.dialogue ? Math.min(glyph, LOUD_SCALE * this.dialogue) : glyph;
  }

  get matcherReady() {
    if (!this.matcher) {
      const found = buildTextMap(this.px, { deadline: performance.now() + MAP_BUDGET_MS });
      if (found.partial) this.rough = true;
      const map = adoptColourBlocks(found, colourLettering(this.px, dialogueSize(found.blocks) || 0.03 * this.px.W));
      const t = textsOf(map, findBubbles(this.px, map));
      this.map = t.map;
      this.dialogue = dialogueSize(this.map.blocks);
      this.matcher = new Matcher(this.map, t.texts, t.cells, t.apart, t.count);
    }
    return this.matcher;
  }

  /**
   * @param {Block[]} blocks
   * @returns {Promise<Update>}
   */
  async add(blocks) {
    const m = this.matcherReady;
    /** @type {Action[]} */
    const actions = [];
    for (const b of blocks) {
      if (NO_WORDS.test(b.t)) continue;
      const id = ++this.nextId;
      this.blocks.set(id, b);
      actions.push(...m.place(id, this.modelBox(b), [...b.t].length));
    }
    return this.act(actions);
  }

  /** @returns {Promise<Update>} */
  async finish() {
    return this.act(this.matcherReady.finish());
  }

  /** @param {Block} b @returns {Box} */
  modelBox(b) {
    const { W, H } = this.px;
    return { x0: b.x0 * W, y0: b.y0 * H, x1: b.x1 * W, y1: b.y1 * H };
  }

  /** @param {number} id */
  textOf(id) {
    const ids = new Set([id]);
    for (const i of ids) for (const p of this.parts.get(i) ?? []) ids.add(p);
    return [...ids].filter((i) => i === id || !this.covered.has(i)).sort((a, b) => a - b).map((i) => /** @type {Block} */ (this.blocks.get(i)).t).join(' ');
  }

  /** @param {number} id */
  rootOf(id) {
    for (let n = 0; this.partOf.has(id) && n < 50; n++) id = /** @type {number} */ (this.partOf.get(id));
    return id;
  }

  /**
   * @param {Map<number, Item>} pending
   * @returns {{changed: Set<number>, gone: Set<number>}}
   */
  mergeParts(pending) {
    /** @type {Set<number>} */
    const changed = new Set();
    /** @type {Set<number>} */
    const gone = new Set();
    const ids = [...new Set([...this.placed.keys(), ...pending.keys()])].filter((id) => !this.partOf.has(id));
    if (ids.length < 2) return { changed, gone };
    /** @param {number} id */
    const item = (id) => pending.get(id) ?? this.placed.get(id);
    for (const a of ids) {
      for (const b of ids) {
        if (a === b || gone.has(a) || gone.has(b)) continue;
        const qa = item(a); const qb = item(b);
        if (!qa?.found || !qb?.found) continue;
        const ta = this.textOf(a); const tb = this.textOf(b);
        if (!(tb.length < ta.length || (tb.length === ta.length && b > a)) || !covers(ta, tb)) continue;
        if (!sideBySide(qa.box, qb.box, Math.max(qa.glyph, qb.glyph))) continue;
        this.partOf.set(b, a);
        this.parts.set(a, [...(this.parts.get(a) ?? []), b]);
        this.covered.add(b);
        const into = /** @type {Item} */ (qa);
        into.found = [...(into.found ?? []), ...qb.found.filter((x) => !into.found?.includes(x))];
        into.box = union([into.box, qb.box]);
        into.glyph = Math.max(into.glyph, qb.glyph);
        gone.add(b);
        changed.add(a);
      }
    }
    return { changed, gone };
  }

  /**
   * @param {Map<number, Item>} pending
   * @returns {{changed: Set<number>, gone: Set<number>}}
   */
  dropCopies(pending) {
    /** @type {Set<number>} */
    const changed = new Set();
    /** @type {Set<number>} */
    const gone = new Set();
    const alone = [...new Set([...this.placed.keys(), ...pending.keys()])].filter((id) => !this.partOf.has(id));
    if (alone.length < 2) return { changed, gone };
    /** @param {number} id */
    const textOf = (id) => /** @type {Block} */ (this.blocks.get(id)).t;
    /** @param {number} id */
    const cellsOf = (id) => (pending.get(id) ?? this.placed.get(id))?.found?.reduce((n, b) => n + b.cells, 0) ?? 0;
    /** @param {number} id @param {string} t */
    const holds = (id, t) => { const c = cellsOf(id); return !c || [...t].length <= 9 * c; };
    /** @param {string} t */
    const letters = (t) => t.replace(/[^\p{L}\p{N}]+/gu, '').length;
    for (const [p, into] of [...this.partOf]) {
      const root = this.rootOf(p);
      const t = textOf(p);
      if (!alone.some((s) => s !== root && (sameText(t, textOf(s)) || sameText(t, this.textOf(s))))) continue;
      if (letters(t) < 12 && holds(root, this.textOf(root))) continue;
      this.partOf.delete(p);
      this.parts.set(into, (this.parts.get(into) ?? []).filter((x) => x !== p));
      changed.add(root);
    }
    for (const id of alone) {
      if (this.parts.get(id)?.length || holds(id, textOf(id)) || letters(textOf(id)) < 12) continue;
      if (alone.some((s) => s !== id && !gone.has(s) && sameText(textOf(id), textOf(s)) && holds(s, textOf(s)) && cellsOf(s) > 0)) gone.add(id);
    }
    return { changed, gone };
  }

  /**
   * @param {Action[]} actions
   * @returns {Promise<Update>}
   */
  async act(actions) {
    /** @type {number[]} */
    const retract = [];
    /** @type {Map<number, Item>} */
    const pending = new Map();
    /** @param {number} id */
    const unplace = (id) => {
      if (!pending.delete(id) && this.styles.delete(id)) retract.push(id);
      this.shown.delete(id);
      this.placed.delete(id);
      this.claims = this.claims.filter((c) => c.id !== id);
    };
    for (const a of actions) {
      if (a.type === 'retract') { unplace(a.id); continue; }
      if (a.type === 'join') {
        let into = a.into;
        for (let n = 0; this.partOf.has(into) && n < 50; n++) into = /** @type {number} */ (this.partOf.get(into));
        const mine = /** @type {Block} */ (this.blocks.get(a.id)).t;
        if (into === a.id || sameText(mine, this.textOf(into))) continue;
        this.partOf.set(a.id, into);
        this.parts.set(into, [...(this.parts.get(into) ?? []), a.id]);
        const was = pending.get(into) ?? this.placed.get(into);
        if (was && !pending.has(into)) {
          unplace(into);
          pending.set(into, was);
          if (was.measured) this.claims.push({ box: was.box, model: was.box, id: into });
        }
        continue;
      }
      if (a.type === 'show') {
        const box = union(a.blocks.map((x) => x.box));
        const model = this.modelBox(/** @type {Block} */ (this.blocks.get(a.id)));
        this.claims.push({ box, model, id: a.id });
        pending.set(a.id, { id: a.id, box, glyph: Math.max(...a.blocks.map((x) => x.glyph)), measured: true, found: a.blocks });
        continue;
      }
      const model = a.box;
      let r = null;
      if (this.refineMs < REFINE_BUDGET_MS && mayRefine()) {
        const t0 = performance.now();
        r = refineBox(this.px, model, this.claims);
        const ms = performance.now() - t0;
        this.refineMs += ms;
        refineBank.ms -= ms;
      } else {
        this.rough = true;
      }
      if (r === 'duplicate') continue;
      const box = r ? r.box : model;
      if (r) this.claims.push({ box, model, id: a.id });
      pending.set(a.id, { id: a.id, box, glyph: r ? r.glyph : Math.min(model.x1 - model.x0, model.y1 - model.y0), measured: !!r, found: null });
    }
    const merged = this.mergeParts(pending);
    for (const id of merged.gone) unplace(id);
    for (const id of merged.changed) {
      const was = this.placed.get(id);
      if (!was || pending.has(id) || merged.gone.has(id)) continue;
      unplace(id);
      pending.set(id, was);
      if (was.measured) this.claims.push({ box: was.box, model: was.box, id });
    }
    const copies = this.dropCopies(pending);
    for (const id of copies.gone) unplace(id);
    for (const id of copies.changed) {
      const was = this.placed.get(id);
      if (!was || pending.has(id) || copies.gone.has(id)) continue;
      unplace(id);
      pending.set(id, was);
      if (was.measured) this.claims.push({ box: was.box, model: was.box, id });
    }
    const items = [...pending.values()];
    if (!items.length) return { show: [], retract };

    const px = this.px;
    /** @type {Style[]} */
    const styles = [];
    /** @type {(Erased | null)[]} */
    const erased = [];
    let slice = performance.now();
    for (const q of items) {
      if (performance.now() - slice > SLICE_MS) { await yieldTurn(); slice = performance.now(); }
      const inBubble = !!q.found?.some((b) => (this.matcher?.texts.get(b)?.bubble.blocks.length ?? 0) > 1);
      let st = analyzeBox(px, q.box, this.opts.sensitivity, q.measured ? q.glyph : 0,
        textNeed(this.textOf(q.id), q.measured ? LETTER_SCALE * this.sizeFor(q.glyph) : 0), inBubble, toneOf(q.found));
      if (st.m !== 0 && q.found && !inBubble && !q.found.every((b) => b.colour)) {
        const more = completeLettering(px, q.found, this.lettersBut(q.id, pending));
        if (more) {
          q.found = [...q.found, more];
          q.box = union([q.box, more.box]);
          q.glyph = Math.max(q.glyph, more.glyph);
          st = analyzeBox(px, q.box, this.opts.sensitivity, q.glyph,
            textNeed(this.textOf(q.id), LETTER_SCALE * this.sizeFor(q.glyph)), inBubble, toneOf(q.found));
        }
      }
      styles.push(st);
      const found = q.found;
      let e = null;
      this.unpolished.delete(q.id);
      if (found && !(st.m === 0 && plainPaper(px, st.patch, st.bg, found))) {
        if (this.plainMs < PLAIN_BUDGET_MS) {
          const t0 = performance.now();
          e = eraseLettering(px, found, this.others(found), undefined, true, 0, this.colourArt);
          this.plainMs += performance.now() - t0;
          if (e) this.unpolished.add(q.id);
        } else {
          this.rough = true;
        }
      }
      erased.push(e);
      if (!e) continue;
      st.patch = e.box;
      st.core = e.box;
      if (st.m === 0) continue;
      st.area = artRoom(q.box, q.glyph, px.W, px.H, textNeed(this.textOf(q.id), LETTER_SCALE * this.sizeFor(q.glyph)));
      const ink = /** @type {RGB} */ (e.ink);
      const ol = e.outline;
      if (ol && contrast(ink, ol) >= 2.5) { st.fg = ink; st.ol = ol; }
      else { st.fg = ink; st.ol = contrast(ink, WHITE) > contrast(ink, INK) ? WHITE : INK; }
      st.bg = ol ?? st.bg;
    }
    for (const [i, st] of styles.entries()) st.text = items[i].box;
    /** @type {[number, Style][]} */
    const meet = [];
    /** @type {Style[]} */
    const fixed = [];
    for (const [id, o] of this.styles) {
      if (styles.some((st) => overlap(st.area, o.area))) meet.push([id, { ...o }]);
      else fixed.push(o);
    }
    resolveCollisions(styles, fixed, meet.map(([, o]) => o));
    items.forEach((q, i) => { this.styles.set(q.id, styles[i]); this.placed.set(q.id, q); });

    /** @type {Region[]} */
    const show = [];
    for (let i = 0; i < items.length; i++) show.push(await this.region(items[i], styles[i], erased[i]));
    for (const [id, o] of meet) {
      const was = this.shown.get(id);
      const old = this.styles.get(id);
      this.styles.set(id, o);
      if (!was || !old || (o.area.x0 === old.area.x0 && o.area.y0 === old.area.y0 && o.area.x1 === old.area.x1 && o.area.y1 === old.area.y1)) continue;
      if (was.v) continue;
      retract.push(id);
      show.push({ ...was, a: this.rect(o.area) });
    }
    for (const r of show) if (r.i !== undefined) this.shown.set(r.i, r);
    return { show, retract };
  }

  /**
   * @param {TextBlock[]} found
   * @returns {Box[]}
   */
  others(found) {
    const lettering = [...(this.map ? this.map.blocks : []), ...(this.matcher ? this.matcher.built.keys() : [])];
    for (const q of this.placed.values()) for (const b of q.found ?? []) if (!lettering.includes(b)) lettering.push(b);
    return lettering.filter((b) => !found.includes(b)).map((b) => b.box);
  }

  /**
   * @param {number} id
   * @param {Map<number, Item>} pending
   * @returns {Box[]}
   */
  lettersBut(id, pending) {
    /** @type {Box[]} */
    const out = [];
    for (const [k, q] of [...this.placed, ...pending]) {
      if (k === id || !q.found) continue;
      for (const b of q.found) out.push(b.box);
    }
    return out;
  }

  /** @returns {Promise<Update | null>} */
  async polishNext() {
    for (const id of this.unpolished) {
      this.unpolished.delete(id);
      const q = this.placed.get(id);
      const was = this.shown.get(id);
      if (!q?.found || !was || was.m !== 2 || !was.im) continue;
      if (this.eraseMs >= ERASE_BUDGET_MS || !mayErase()) {
        this.rough = true;
        this.unpolished.clear();
        return null;
      }
      const t0 = performance.now();
      const e = eraseLettering(this.px, q.found, this.others(q.found), undefined, false, 0, this.colourArt);
      const ms = performance.now() - t0;
      this.eraseMs += ms;
      eraseBank.ms -= ms;
      if (!e) continue;
      const im = await this.opts.encode(e.rgba, e.box.x1 - e.box.x0, e.box.y1 - e.box.y0);
      if (!im || im.length > MAX_PATCH_B64) continue;
      if (this.shown.get(id) !== was) { this.unpolished.add(id); continue; }
      /** @type {Region} */
      const r = { ...was, p: this.rect(e.box), im };
      this.shown.set(id, r);
      return { show: [r], retract: [] };
    }
    return null;
  }

  /** @param {Box} b */
  rect(b) {
    const { W, H } = this.px;
    const x = clamp(b.x0 / W, 0, 1);
    const y = clamp(b.y0 / H, 0, 1);
    return { x, y, w: clamp(b.x1 / W, 0, 1) - x, h: clamp(b.y1 / H, 0, 1) - y };
  }

  /**
   * @param {Item} q
   * @param {Style} st
   * @param {Erased | null} er
   * @returns {Promise<Region>}
   */
  async region(q, st, er) {
    const { W, H } = this.px;
    /** @param {Box} b */
    const rect = (b) => {
      const x = clamp(b.x0 / W, 0, 1);
      const y = clamp(b.y0 / H, 0, 1);
      return { x, y, w: clamp(b.x1 / W, 0, 1) - x, h: clamp(b.y1 / H, 0, 1) - y };
    };
    const vertical = VERTICAL_LANGS.has(this.opts.lang) && q.box.y1 - q.box.y0 > 1.6 * (q.box.x1 - q.box.x0);
    let im = er ? await this.opts.encode(er.rgba, er.box.x1 - er.box.x0, er.box.y1 - er.box.y0) : null;
    if (im && im.length > MAX_PATCH_B64) im = null;
    if (er && !im && st.m === 0) {
      st.patch = st.core;
    }
    /** @type {Region} */
    const r = {
      i: q.id,
      p: rect(st.patch),
      a: vertical ? rect(st.patch) : rect(st.area),
      m: im ? 2 : st.m,
      bg: rgbHex(...st.bg),
      fg: rgbHex(...st.fg),
      ol: rgbHex(...st.ol),
      v: vertical,
      t: this.textOf(q.id),
      g: clamp(this.sizeFor(q.glyph) / W, 0.001, 1),
    };
    if (im) {
      r.im = im;
    } else if (st.m) {
      const box = q.box;
      const m = Math.max(2, Math.round(0.2 * q.glyph));
      const patch = er || q.found ? { x0: Math.max(0, box.x0 - m), y0: Math.max(0, box.y0 - m), x1: Math.min(W, box.x1 + m), y1: Math.min(H, box.y1 + m) } : st.patch;
      r.p = rect(patch);
      const edge = (/** @type {number} */ d) => clamp(d / W, 0, 0.25);
      r.e = [edge(box.x0 - patch.x0), edge(box.y0 - patch.y0), edge(patch.x1 - box.x1), edge(patch.y1 - box.y1)];
    }
    return r;
  }
}

/**
 * @param {Pixels} px
 * @param {Box} patch
 * @param {RGB} bg
 * @param {TextBlock[]} found
 */
function plainPaper(px, patch, bg, found) {
  const x0 = Math.max(0, Math.floor(patch.x0)); const y0 = Math.max(0, Math.floor(patch.y0));
  const x1 = Math.min(px.W, Math.ceil(patch.x1)); const y1 = Math.min(px.H, Math.ceil(patch.y1));
  const w = x1 - x0; const h = y1 - y0;
  if (w <= 0 || h <= 0) return true;
  if (w * h > 4_000_000) return false;
  const glyph = new Uint8Array(w * h);
  let r = 1;
  for (const b of found) {
    const m = b.mask;
    r = Math.max(r, Math.ceil(0.2 * b.glyph));
    const cs = Math.ceil(m.s);
    for (let my = 0; my < m.h; my++) {
      for (let mx = 0; mx < m.w; mx++) {
        if (!m.bits[my * m.w + mx]) continue;
        const gx = Math.floor((m.x0 + mx) * m.s) - x0; const gy = Math.floor((m.y0 + my) * m.s) - y0;
        for (let y = Math.max(0, gy); y < Math.min(h, gy + cs); y++) {
          for (let x = Math.max(0, gx); x < Math.min(w, gx + cs); x++) glyph[y * w + x] = 1;
        }
      }
    }
  }
  const rows = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = -r; x < w; x++) {
      if (x + r < w && glyph[y * w + x + r]) n++;
      if (x - r - 1 >= 0 && glyph[y * w + x - r - 1]) n--;
      if (x >= 0 && n > 0) rows[y * w + x] = 1;
    }
  }
  const near = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = -r; y < h; y++) {
      if (y + r < h && rows[(y + r) * w + x]) n++;
      if (y - r - 1 >= 0 && rows[(y - r - 1) * w + x]) n--;
      if (y >= 0 && n > 0) near[y * w + x] = 1;
    }
  }
  let rest = 0; let off = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (near[y * w + x]) continue;
      rest++;
      const i = ((y0 + y) * px.W + x0 + x) * 4;
      if (Math.abs(px.data[i] - bg[0]) + Math.abs(px.data[i + 1] - bg[1]) + Math.abs(px.data[i + 2] - bg[2]) > 40) off++;
    }
  }
  return off <= 0.02 * rest;
}

/** @param {Pixels} px */
export function inColour(px) {
  const n = px.W * px.H;
  const step = Math.max(1, Math.floor(n / 20_000));
  let all = 0; let coloured = 0;
  for (let k = 0; k < n; k += step) {
    const i = k * 4;
    const r = px.data[i]; const g = px.data[i + 1]; const b = px.data[i + 2];
    all++;
    if (Math.max(r, g, b) - Math.min(r, g, b) >= 40) coloured++;
  }
  return coloured >= 0.1 * all;
}

/**
 * @param {TextBlock[]} blocks
 * @returns {number}
 */
export function dialogueSize(blocks) {
  const by = blocks.filter((b) => b.cells > 0).map((b) => [b.glyph, b.cells]).sort((a, b) => a[0] - b[0]);
  const total = by.reduce((n, [, c]) => n + c, 0);
  let n = 0;
  for (const [g, c] of by) { n += c; if (n >= total / 2) return g; }
  return 0;
}

/**
 * @param {TextBlock[] | null} found
 * @returns {{ink: number, paper: number} | null}
 */
function toneOf(found) {
  let n = 0; let ink = 0; let paper = 0;
  for (const b of found ?? []) {
    const k = Math.max(1, b.cells);
    if (!(b.ink >= 0 && b.paper >= 0) || Math.abs(b.paper - b.ink) < 30) continue;
    n += k; ink += k * b.ink; paper += k * b.paper;
  }
  return n ? { ink: ink / n, paper: paper / n } : null;
}

/** @param {Box[]} boxes @returns {Box} */
function union(boxes) {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

/**
 * @param {Box} box
 * @param {number} glyph
 * @param {number} W
 * @param {number} H
 * @param {import('./analysis.js').TextNeed} need
 * @returns {Box}
 */
export function artRoom(box, glyph, W, H, need) {
  const pad = 0.15 * glyph;
  const base = { x0: Math.max(0, box.x0 - pad), y0: Math.max(0, box.y0 - pad), x1: Math.min(W, box.x1 + pad), y1: Math.min(H, box.y1 + pad) };
  const want = 0.9 * Math.min(need.cap > 0 ? need.cap : glyph, 0.66 * glyph);
  /** @param {Box} b */
  const size = (b) => fontFor(b.x1 - b.x0, b.y1 - b.y0, need);
  if (size(base) >= want) return base;
  const across = base.y1 - base.y0 >= base.x1 - base.x0;
  const step = Math.max(1, 0.125 * glyph);
  let best = base; let bestSize = size(base);
  for (let extra = step; extra <= 3 * glyph + 0.01; extra += step) {
    const b = across
      ? { x0: Math.max(0, base.x0 - extra / 2), y0: base.y0, x1: Math.min(W, base.x1 + extra / 2), y1: base.y1 }
      : { x0: base.x0, y0: Math.max(0, base.y0 - extra / 2), x1: base.x1, y1: Math.min(H, base.y1 + extra / 2) };
    const s = size(b);
    if (s > 1.03 * bestSize) { best = b; bestSize = s; }
    if (s >= want) break;
  }
  return best;
}
