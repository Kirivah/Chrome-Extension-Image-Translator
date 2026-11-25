// @ts-check

import { guide, blockOfChars } from './guided.js';
import { trimCell, share } from './texts.js';

/** @typedef {import('./analysis.js').Box} Box */
/** @typedef {import('./textmap.js').TextBlock} TextBlock */
/** @typedef {import('./textmap.js').TextMap} TextMap */
/** @typedef {import('./textmap.js').TextChar} TextChar */
/** @typedef {import('./texts.js').Text} Text */

/**
 * @typedef {{type: 'show', id: number, blocks: TextBlock[]}
 *   | {type: 'none', id: number, box: Box}
 *   | {type: 'join', id: number, into: number}
 *   | {type: 'retract', id: number}} Action
 */

const REACH = 3;
const MOVE = 2;
const NO_MATCH = 3.6;
const FORBIDDEN = 1e9;
const MAX_EXACT_WORK = 2e7;

/** @param {Box} b */
const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
/** @param {Box} a @param {Box} b */
const inter = (a, b) => area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
/** @param {Box} a @param {Box} b */
const iou = (a, b) => { const i = inter(a, b); return i ? i / (area(a) + area(b) - i) : 0; };
/** @param {Box} b */
const side = (b) => Math.max(b.x1 - b.x0, b.y1 - b.y0);

/**
 * @param {number} chars
 * @param {number} cells
 */
function plausible(chars, cells) {
  if (!chars || !cells) return true;
  const r = chars / cells;
  return r >= 0.35 && r <= 9;
}

/**
 * @typedef {Object} Entry
 * @property {number} id
 * @property {Box} model
 * @property {number} chars
 * @property {TextBlock[]} blocks
 * @property {TextChar[]} letters
 */

export class Matcher {
  /**
   * @param {TextMap} map
   * @param {Map<TextBlock, Text>} [texts]
   * @param {Map<TextBlock, TextChar[]>} [cells]
   * @param {Set<TextChar>} [apart]
   * @param {Map<TextBlock, number>} [count]
   */
  constructor(map, texts = new Map(), cells = new Map(), apart = new Set(), count = new Map()) {
    this.map = map;
    this.texts = texts;
    this.cells = cells;
    this.apart = apart;
    this.count = count;
    /** @type {Set<TextChar>} */
    this.textChars = new Set([...new Set(texts.values())].flatMap((t) => t.chars));
    /** @type {Map<TextBlock, Entry>} */
    this.owner = new Map();
    /** @type {Map<TextBlock, Entry>} */
    this.built = new Map();
    /** @type {Set<TextChar>} */
    this.taken = new Set();
    /** @type {Entry[]} */
    this.held = [];
    /** @type {{q: number, sum: (b: Box) => number} | null | undefined} */
    this.ink = undefined;
  }

  /**
   * @param {number} id
   * @param {Box} model
   * @param {number} chars
   * @returns {Action[]}
   */
  place(id, model, chars) {
    /** @type {Entry} */
    const e = { id, model, chars, blocks: [], letters: [] };
    this.trimCells(model);
    const cands = [];
    for (const b of this.map.blocks) {
      const i = inter(model, b.box);
      if (!i) continue;
      const inBlock = i / area(b.box);
      const onBlock = i / Math.max(1, area(model));
      if (inBlock < 0.5 && onBlock < 0.4) continue;
      cands.push({ b, inBlock, onBlock, fit: i / (area(model) + area(b.box) - i), score: inBlock + onBlock });
    }
    cands.sort((p, q) => q.score - p.score);
    const best = cands[0];
    if (!best) { this.held.push(e); return []; }
    const taken = this.owner.get(best.b);
    if (taken) {
      const bub = this.texts.get(best.b);
      if (bub && centreIn(taken.model, bub.box) && inter(model, bub.box) >= 0.5 * area(model) && !this.otherFree(model, bub)) {
        const mine = iou(model, bub.text);
        if (!(mine >= 0.3 && mine >= 1.3 * iou(taken.model, bub.text))) return [{ type: 'join', id, into: taken.id }];
      }
      if (sideBySide(model, taken.model, best.b.box) && !this.inside(model).length) return [{ type: 'join', id, into: taken.id }];
      const theirs = iou(taken.model, best.b.box);
      if (best.fit >= 0.3 && best.fit >= 1.3 * theirs && plausible(chars, best.b.cells)) {
        /** @type {Action[]} */
        const out = [{ type: 'retract', id: taken.id }];
        this.release(taken);
        this.held.push(taken);
        this.claim(e, this.withTexts([best.b, ...this.inside(model).filter((b) => b !== best.b && similar(b, best.b))]));
        this.extend(e);
        out.push({ type: 'show', id, blocks: e.blocks });
        return out;
      }
      if (best.fit >= 0.3 && best.fit * 1.3 > theirs) {
        this.release(taken);
        this.held.push(taken, e);
        return [{ type: 'retract', id: taken.id }];
      }
      const free = this.inside(model);
      if (!free.length && best.onBlock >= 0.5) return [{ type: 'join', id, into: taken.id }];
      this.held.push(e);
      return [];
    }
    const bub = this.texts.get(best.b);
    const parts = [best.b, ...this.inside(model).filter((b) => b !== best.b && similar(b, best.b))];
    const second = cands.find((c) => c !== best && !parts.includes(c.b) && !this.owner.has(c.b) && !similar(c.b, best.b) && !(bub && this.texts.get(c.b) === bub));
    const fit = parts.length > 1 ? Math.max(best.fit, iou(model, union(parts.map((b) => b.box)))) : best.fit;
    const clear = fit >= 0.25 && (!second || best.score >= 1.6 * second.score);
    const cells = parts.reduce((a, b) => a + b.cells, 0);
    if (!clear || !plausible(chars, cells)) { this.held.push(e); return []; }
    this.claim(e, this.withTexts(parts));
    this.extend(e);
    return [{ type: 'show', id, blocks: e.blocks }];
  }

  /**
   * @param {Entry} e
   * @param {{block: TextBlock, chars: TextChar[]}} g
   */
  build(e, g) {
    e.blocks = [...e.blocks, g.block];
    e.letters = [...e.letters, ...g.chars];
    this.built.set(g.block, e);
    for (const c of g.chars) this.taken.add(c.of ?? c);
  }

  /**
   * @param {Entry} e
   * @param {boolean} [guided]
   */
  extend(e, guided = true) {
    if (!e.blocks.length) return;
    const g = guided && !e.blocks.every((b) => b.colour) ? guide(this.map, e.model, this.taken, { like: e.blocks, spoken: (c) => this.spokenFor(c) }) : null;
    if (g) this.build(e, g);
    /** @type {TextChar[]} */
    const chars = [];
    for (const b of e.blocks) {
      const bub = this.texts.get(b);
      if (bub) for (const c of bub.chars) if (!this.taken.has(c) && !chars.includes(c)) chars.push(c);
    }
    const sizes = e.blocks.map((b) => b.glyph).sort((a, b) => a - b);
    const size = sizes[sizes.length >> 1];
    const dark = e.blocks[0].dark;
    /** @type {import('./bubbles.js').Bubble[]} */
    const bubbles = [];
    for (const b of e.blocks) { const bub = this.texts.get(b)?.bubble; if (bub && !bubbles.includes(bub)) bubbles.push(bub); }
    for (const c of bubbles.length ? this.map.chars ?? [] : []) {
      if (c.inBlock || c.mark || c.dark !== dark || c.clear < 0.55 || this.taken.has(c) || this.textChars.has(c) || chars.includes(c)) continue;
      if (c.size < 0.5 * size || c.size > 2 * size || inter(c.box, e.model) < 0.8 * area(c.box)) continue;
      if (bubbles.some((bub) => (bub.within ? bub.within(c.box) : inter(c.box, bub.box) / Math.max(1, area(c.box))) >= 0.6)) chars.push(c);
    }
    if (chars.length) this.build(e, { block: blockOfChars(chars), chars });
  }

  /** @param {TextChar} c */
  spoken(c) {
    for (const b of [...this.owner.keys(), ...this.built.keys()]) if (inter(c.box, b.box) >= 0.6 * area(c.box)) return true;
    return false;
  }

  /** @param {TextChar} c */
  spokenFor(c) {
    return this.apart.has(c) || (c.inBlock && this.spoken(c));
  }

  /**
   * @param {TextBlock[]} blocks
   * @returns {TextBlock[]}
   */
  withTexts(blocks) {
    const out = [...blocks];
    for (const b of blocks) {
      const bub = this.texts.get(b);
      if (bub) for (const o of bub.blocks) if (!out.includes(o) && !this.owner.has(o)) out.push(o);
    }
    return out;
  }

  /**
   * @param {Box} model
   * @returns {{owner: Entry, text: Text} | null}
   */
  textOwner(model) {
    let best = null; let most = 0.5 * area(model); let nearest = Infinity;
    const c = center(model);
    for (const bub of new Set(this.texts.values())) {
      const m = Math.max(...bub.blocks.map((b) => b.glyph));
      const near = { x0: bub.text.x0 - m, y0: bub.text.y0 - m, x1: bub.text.x1 + m, y1: bub.text.y1 + m };
      if (!centreIn(model, near)) continue;
      const i = inter(model, bub.box);
      const d = Math.hypot(Math.max(bub.text.x0 - c.x, 0, c.x - bub.text.x1), Math.max(bub.text.y0 - c.y, 0, c.y - bub.text.y1));
      if (i > most || (i >= most && d < nearest)) { most = i; nearest = d; best = bub; }
    }
    if (!best) return null;
    for (const b of best.blocks) { const e = this.owner.get(b); if (e) return { owner: e, text: best }; }
    return null;
  }

  /**
   * @param {Box} model
   * @param {Text} text
   */
  otherFree(model, text) {
    return this.map.blocks.some((b) => {
      if (this.owner.has(b) || text.blocks.includes(b)) return false;
      const i = inter(model, b.box);
      return i >= 0.5 * area(b.box) || i >= 0.25 * area(model);
    });
  }

  /** @param {Box} model */
  trimCells(model) {
    if (!this.cells.size) return;
    for (const [cell, chars] of [...this.cells]) {
      if (this.owner.has(cell) || this.built.has(cell) || !inter(model, cell.box)) continue;
      const t = trimCell(cell, chars, model);
      if (!t) continue;
      const pieces = [t.inside, ...t.outside];
      const made = share(cell, pieces);
      const k = this.map.blocks.indexOf(cell);
      if (k < 0) continue;
      this.map.blocks.splice(k, 1, ...made);
      this.cells.delete(cell);
      made.forEach((b, i) => this.cells.set(b, pieces[i]));
      const text = this.texts.get(cell);
      if (text) {
        this.texts.delete(cell);
        made.forEach((b, i) => this.texts.set(b, { box: text.box, text: b.box, blocks: [b], chars: i ? [] : text.chars, bubble: text.bubble }));
      }
    }
  }

  placed() {
    return new Set([...this.owner.values(), ...this.built.values()]);
  }

  /** @returns {Action[]} */
  finish() {
    /** @type {Action[]} */
    const out = [];
    const fix = this.commonError() ?? this.inkError();
    if (fix) {
      for (const e of this.placed()) {
        if (e.blocks.some((b) => lands(fix(e.model), b.box))) {
          e.model = fix(e.model);
          const had = e.letters.length; const n = e.blocks.length;
          this.claimMore(e, this.withTexts(this.inside(e.model).filter((b) => e.blocks.some((o) => similar(o, b)))));
          this.extend(e);
          if (e.letters.length > had || e.blocks.length > n) out.push({ type: 'retract', id: e.id }, { type: 'show', id: e.id, blocks: e.blocks });
          continue;
        }
        this.release(e);
        this.held.push(e);
        out.push({ type: 'retract', id: e.id });
      }
      for (const e of this.held) e.model = fix(e.model);
    }
    const held = this.held;
    this.held = [];
    if (!held.length) { out.push(...this.overflow()); return out; }
    for (const e of held) this.trimCells(e.model);
    /** @type {Entry[]} */
    const rest = [];
    /** @type {[Entry, Entry][]} */
    const twins = [];
    /** @type {Map<Entry, TextBlock | null>} */
    const home = new Map();
    for (const e of held) {
      const over = this.textOwner(e.model);
      if (over && !this.otherFree(e.model, over.text)) { out.push({ type: 'join', id: e.id, into: over.owner.id }); continue; }
      if (this.partly(e)) { out.push({ type: 'show', id: e.id, blocks: e.blocks }); continue; }
      if (!this.freeUnder(e.model)) {
        const g = guide(this.map, e.model, this.taken);
        if (g && (!e.chars || e.chars <= 15 * g.block.cells)) {
          this.build(e, g);
          out.push({ type: 'show', id: e.id, blocks: e.blocks });
          continue;
        }
      }
      const on = this.takenUnder(e.model);
      if (on && !this.inside(e.model).length) { out.push({ type: 'join', id: e.id, into: on.id }); continue; }
      home.set(e, this.under(e.model));
      const h = home.get(e);
      const k = rest.findIndex((o) => iou(o.model, e.model) >= 0.6 || (!!h && home.get(o) === h && sideBySide(o.model, e.model, h.box)));
      if (k < 0) { rest.push(e); continue; }
      const o = rest[k];
      if (iou(o.model, e.model) < 0.6) {
        o.model = union([o.model, e.model]);
        twins.push([e, o]);
        continue;
      }
      const fit = (/** @type {Entry} */ x) => Math.max(0, ...this.map.blocks.map((b) => iou(x.model, b.box)));
      const [keep, lose] = fit(e) > fit(o) ? [e, o] : [o, e];
      rest[k] = keep;
      twins.push([lose, keep]);
    }
    const free = this.map.blocks.filter((b) => !this.owner.has(b));
    const costs = rest.map((e) => free.map((b) => this.cost(e, b)));
    const used = free.map((_, j) => costs.some((row) => row[j] < FORBIDDEN));
    const cols = free.filter((_, j) => used[j]);
    const cost = costs.map((row) => row.filter((_, j) => used[j]));
    const work = rest.length * rest.length * (cols.length + rest.length);
    const pick = work <= MAX_EXACT_WORK ? assign(cost, NO_MATCH) : greedy(cost, NO_MATCH);
    rest.forEach((e, i) => { if (pick[i] >= 0) this.claim(e, [cols[pick[i]]]); });
    rest.forEach((e, i) => {
      if (pick[i] < 0) {
        const on = this.takenUnder(e.model);
        out.push(on ? { type: 'join', id: e.id, into: on.id } : { type: 'none', id: e.id, box: e.model });
        return;
      }
      const b = cols[pick[i]];
      const extra = this.inside(e.model).filter((o) => similar(o, b));
      this.claim(e, this.withTexts([b, ...extra]));
      this.extend(e);
      out.push({ type: 'show', id: e.id, blocks: e.blocks });
    });
    for (const [lose, keep] of twins) out.push({ type: 'join', id: lose.id, into: keep.id });
    out.push(...this.oneEach(), ...this.overflow());
    return out;
  }

  /** @returns {Action[]} */
  overflow() {
    /** @type {Action[]} */
    const out = [];
    for (const e of this.placed()) {
      const mine = new Set(/** @type {Text[]} */ (e.blocks.map((b) => this.texts.get(b)).filter(Boolean)));
      if (!mine.size || e.blocks.some((b) => this.cells.has(b))) continue;
      /** @param {TextBlock} b */
      const chars = (b) => this.count.get(b) ?? b.cells;
      let cells = e.blocks.reduce((n, b) => n + chars(b), 0);
      const bubble = [...mine][0].bubble;
      const lettering = union(e.blocks.map((b) => b.box));
      const c = center(lettering);
      /** @param {Box} b */
      const dist = (b) => Math.hypot(Math.max(b.x0 - c.x, 0, c.x - b.x1), Math.max(b.y0 - c.y, 0, c.y - b.y1));
      const free = [...new Set(this.texts.values())]
        .filter((t) => t.bubble === bubble && !mine.has(t) && t.blocks.every((b) => !this.owner.has(b) && !this.cells.has(b)))
        .sort((p, q) => dist(p.text) - dist(q.text));
      const long = () => e.chars > 0 && cells >= 3 && e.chars > 4 * cells;
      const wordy = long();
      let more = false;
      for (const t of free) {
        const n = t.blocks.reduce((k, b) => k + chars(b), 0) + t.chars.filter((q) => !q.mark).length;
        const under = t.blocks.reduce((k, b) => k + inter(e.model, b.box), 0) / Math.max(1, t.blocks.reduce((k, b) => k + area(b.box), 0));
        const fits = !e.chars || e.chars >= 1.2 * (cells + n);
        if (!(under >= 0.3 || (wordy && long())) || !fits) continue;
        this.claimMore(e, t.blocks);
        cells += n;
        more = true;
      }
      if (!more) continue;
      this.extend(e);
      out.push({ type: 'retract', id: e.id }, { type: 'show', id: e.id, blocks: e.blocks });
    }
    return out;
  }

  /** @param {Entry} e */
  partly(e) {
    const inside = this.inside(e.model);
    if (!inside.length || iou(e.model, union(inside.map((b) => b.box))) >= 0.25) return false;
    this.claim(e, this.withTexts(inside));
    const g = guide(this.map, e.model, this.taken, { like: e.blocks, spoken: (c) => this.spokenFor(c), fill: true });
    if (g && iou(e.model, union([...e.blocks.map((b) => b.box), g.block.box])) >= 0.3) {
      this.build(e, g);
      this.extend(e, false);
      return true;
    }
    this.release(e);
    return false;
  }

  /** @returns {Action[]} */
  oneEach() {
    /** @type {Action[]} */
    const out = [];
    /** @type {Map<Text, Entry[]>} */
    const by = new Map();
    for (const [b, e] of this.owner) {
      const bub = this.texts.get(b);
      if (!bub) continue;
      const list = by.get(bub) ?? [];
      if (!list.includes(e)) list.push(e);
      by.set(bub, list);
    }
    for (const [bub, list] of by) {
      list.sort((a, b) => a.id - b.id);
      const keep = list[0];
      let changed = false;
      for (const o of list.slice(1)) {
        if (!o.blocks.every((b) => this.texts.get(b) === bub || this.built.get(b) === o)) continue;
        const blocks = o.blocks.filter((b) => this.owner.get(b) === o);
        this.release(o);
        this.claimMore(keep, blocks);
        out.push({ type: 'retract', id: o.id }, { type: 'join', id: o.id, into: keep.id });
        changed = true;
      }
      const free = bub.blocks.filter((b) => !this.owner.has(b));
      if (free.length) { this.claimMore(keep, free); changed = true; }
      const had = keep.letters.length;
      this.extend(keep);
      if (changed || keep.letters.length > had) out.push({ type: 'retract', id: keep.id }, { type: 'show', id: keep.id, blocks: keep.blocks });
    }
    return out;
  }

  /** @param {Entry} e @param {TextBlock[]} blocks */
  claimMore(e, blocks) {
    const add = blocks.filter((b) => !e.blocks.includes(b));
    e.blocks = [...e.blocks, ...add];
    for (const b of add) this.owner.set(b, e);
  }

  /**
   * @param {Box} model
   * @returns {Entry | null}
   */
  takenUnder(model) {
    let best = null; let most = 0;
    for (const [b, o] of [...this.owner, ...this.built]) {
      const i = inter(model, b.box);
      if (i >= 0.5 * area(model) && i > most) { most = i; best = o; }
    }
    return best;
  }

  /** @param {Box} model */
  freeUnder(model) {
    return this.map.blocks.some((b) => {
      if (this.owner.has(b)) return false;
      const i = inter(model, b.box);
      return i >= 0.5 * area(b.box) || i >= 0.4 * area(model);
    });
  }

  /**
   * @param {Entry} e
   * @param {TextBlock} b
   */
  cost(e, b) {
    const m = e.model;
    const i = inter(m, b.box);
    let c;
    if (i) c = 1 - 0.5 * (i / area(b.box) + i / Math.max(1, area(m)));
    else {
      const d = Math.hypot((m.x0 + m.x1) / 2 - (b.box.x0 + b.box.x1) / 2, (m.y0 + m.y1) / 2 - (b.box.y0 + b.box.y1) / 2) / Math.max(1, side(m), side(b.box));
      if (d > MOVE) return FORBIDDEN;
      c = 1 + d;
    }
    const ratio = Math.abs(Math.log(Math.max(1, area(b.box)) / Math.max(1, area(m))));
    if (ratio > Math.log(14)) return FORBIDDEN;
    const tallM = m.y1 - m.y0 > 1.3 * (m.x1 - m.x0);
    const tallB = b.box.y1 - b.box.y0 > 1.3 * (b.box.x1 - b.box.x0);
    return c + 0.35 * ratio + (tallM === tallB ? 0 : 0.25) + (plausible(e.chars, b.cells) ? 0 : 0.8);
  }

  /** @returns {((b: Box) => Box) | null} */
  commonError() {
    const entries = [...this.held, ...this.placed()];
    if (entries.length < 3) return null;
    /** @type {((b: Box) => Box)[]} */
    const tries = [];
    for (const e of entries) {
      const c = center(e.model);
      for (const b of this.map.blocks) {
        const d = center(b.box);
        if (Math.hypot(d.x - c.x, d.y - c.y) > REACH * Math.max(side(e.model), side(b.box))) continue;
        const dx = d.x - c.x; const dy = d.y - c.y;
        if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) tries.push((m) => moved(m, dx, dy));
        const k = (d.x * c.x + d.y * c.y) / Math.max(1, c.x * c.x + c.y * c.y);
        if (k > 0.5 && k < 2 && Math.abs(k - 1) > 0.02) tries.push((m) => scaled(m, k));
      }
    }
    if (tries.length > 6000) return null;
    const stride = Math.max(1, Math.ceil((tries.length * entries.length * this.map.blocks.length) / 5e6));
    /** @param {(b: Box) => Box} f */
    const support = (f) => {
      let n = 0;
      for (const e of entries) { const m = f(e.model); if (this.map.blocks.some((b) => lands(m, b.box))) n++; }
      return n;
    };
    const settled = [...this.placed()].filter((e) => e.blocks.some((b) => lands(e.model, b.box)));
    /** @param {(b: Box) => Box} f */
    const breaks = (f) => settled.filter((e) => !e.blocks.some((b) => lands(f(e.model), b.box))).length;
    const none = support((m) => m);
    let best = null; let most = none;
    for (let i = 0; i < tries.length; i += stride) {
      const f = tries[i];
      const n = support(f);
      if (n > most && breaks(f) <= settled.length / 3) { most = n; best = f; }
    }
    if (!best || most < none + Math.max(2, 0.25 * entries.length) || most < 0.6 * entries.length) return null;
    return best;
  }

  /** @returns {((b: Box) => Box) | null} */
  inkError() {
    const entries = [...this.held, ...this.placed()];
    if (entries.length < 3) return null;
    const ink = this.inkGrid();
    if (!ink) return null;
    /** @param {Box} m */
    const cov = (m) => ink.sum(m) / Math.max(1, area(m));
    /** @param {(b: Box) => Box} f */
    const total = (f) => { let t = 0; for (const e of entries) t += cov(f(e.model)); return t; };
    const none = total((m) => m);
    let best = null; let most = none;
    const R = 0.15 * Math.max(this.map.W, this.map.H);
    const q = ink.q;
    let bx = 0; let by = 0;
    for (let dy = -R; dy <= R; dy += q) {
      for (let dx = -R; dx <= R; dx += q) {
        const t = total((m) => moved(m, dx, dy));
        if (t > most) { most = t; bx = dx; by = dy; best = (/** @type {Box} */ m) => moved(m, dx, dy); }
      }
    }
    if (best) {
      const [x0, y0] = [bx, by];
      for (let dy = y0 - q + 1; dy < y0 + q; dy++) {
        for (let dx = x0 - q + 1; dx < x0 + q; dx++) {
          const t = total((m) => moved(m, dx, dy));
          if (t > most) { most = t; best = (/** @type {Box} */ m) => moved(m, dx, dy); }
        }
      }
    }
    for (let k = 0.8; k <= 1.25; k += 0.005) {
      if (Math.abs(k - 1) < 0.01) continue;
      const t = total((m) => scaled(m, k));
      if (t > most) { most = t; const kk = k; best = (/** @type {Box} */ m) => scaled(m, kk); }
    }
    if (!best) return null;
    const f = best;
    const better = entries.filter((e) => cov(f(e.model)) > cov(e.model)).length;
    if (most < 1.15 * none || most - none < 0.02 * entries.length || better < 0.6 * entries.length) return null;
    let agree = 0;
    for (const e of entries) {
      const m = e.model;
      let top = cov(m); let ox = 0; let oy = 0;
      for (let dy = -R; dy <= R; dy += q) {
        for (let dx = -R; dx <= R; dx += q) {
          const c = cov(moved(m, dx, dy));
          if (c > top) { top = c; ox = dx; oy = dy; }
        }
      }
      const a = center(m); const b = center(f(m));
      if (Math.hypot(b.x - a.x - ox, b.y - a.y - oy) <= Math.max(2 * q, 0.3 * side(m))) agree++;
    }
    if (agree < 0.6 * entries.length) return null;
    const settled = [...this.placed()].filter((e) => e.blocks.some((b) => lands(e.model, b.box)));
    if (settled.filter((e) => !e.blocks.some((b) => lands(f(e.model), b.box))).length > settled.length / 3) return null;
    return f;
  }

  /** @returns {{q: number, sum: (b: Box) => number} | null} */
  inkGrid() {
    if (this.ink !== undefined) return this.ink;
    const { W, H, chars } = this.map;
    if (!chars?.length) return (this.ink = null);
    const q = Math.max(2, Math.round(Math.max(W, H) / 400));
    const gw = Math.ceil(W / q); const gh = Math.ceil(H / q);
    const cnt = new Float32Array(gw * gh);
    for (const c of chars) {
      if (c.mark || c.clear < 0.55) continue;
      const m = c.mask; const s = m.s;
      for (let y = 0; y < m.h; y++) {
        for (let x = 0; x < m.w; x++) {
          if (!m.bits[y * m.w + x]) continue;
          const gx = Math.min(gw - 1, Math.floor(((m.x0 + x + 0.5) * s) / q));
          const gy = Math.min(gh - 1, Math.floor(((m.y0 + y + 0.5) * s) / q));
          cnt[gy * gw + gx] += s * s;
        }
      }
    }
    const W1 = gw + 1;
    const sat = new Float64Array(W1 * (gh + 1));
    for (let y = 0; y < gh; y++) {
      let row = 0;
      for (let x = 0; x < gw; x++) { row += cnt[y * gw + x]; sat[(y + 1) * W1 + x + 1] = sat[y * W1 + x + 1] + row; }
    }
    /** @param {Box} b */
    const sum = (b) => {
      const x0 = Math.max(0, Math.min(gw, Math.round(b.x0 / q))); const x1 = Math.max(0, Math.min(gw, Math.round(b.x1 / q)));
      const y0 = Math.max(0, Math.min(gh, Math.round(b.y0 / q))); const y1 = Math.max(0, Math.min(gh, Math.round(b.y1 / q)));
      if (x1 <= x0 || y1 <= y0) return 0;
      return sat[y1 * W1 + x1] - sat[y0 * W1 + x1] - sat[y1 * W1 + x0] + sat[y0 * W1 + x0];
    };
    return (this.ink = { q, sum });
  }

  /**
   * @param {Box} model
   * @returns {TextBlock | null}
   */
  under(model) {
    let best = null; let most = 0.6 * area(model);
    for (const b of this.map.blocks) {
      if (this.owner.has(b)) continue;
      const i = inter(model, b.box);
      if (i >= most) { most = i; best = b; }
    }
    return best;
  }

  /** @param {Box} model */
  inside(model) {
    return this.map.blocks.filter((b) => !this.owner.has(b) && inter(model, b.box) >= 0.6 * area(b.box));
  }

  /** @param {Entry} e @param {TextBlock[]} blocks */
  claim(e, blocks) {
    e.blocks = blocks;
    for (const b of blocks) this.owner.set(b, e);
  }

  /** @param {Entry} e */
  release(e) {
    for (const b of e.blocks) {
      if (this.owner.get(b) === e) this.owner.delete(b);
      if (this.built.get(b) === e) this.built.delete(b);
    }
    for (const c of e.letters) this.taken.delete(c.of ?? c);
    e.blocks = [];
    e.letters = [];
  }
}

/** @param {Box} b */
const center = (b) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
/** @param {Box} a @param {Box} b */
const centreIn = (a, b) => { const c = center(a); return c.x >= b.x0 && c.x < b.x1 && c.y >= b.y0 && c.y < b.y1; };
/** @param {Box} b @param {number} dx @param {number} dy @returns {Box} */
const moved = (b, dx, dy) => ({ x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy });
/** @param {Box} b @param {number} k @returns {Box} */
const scaled = (b, k) => ({ x0: b.x0 * k, y0: b.y0 * k, x1: b.x1 * k, y1: b.y1 * k });
/** @param {Box[]} boxes @returns {Box} */
function union(boxes) {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

/**
 * @param {Box} a
 * @param {Box} b
 * @param {Box} block
 */
function sideBySide(a, b, block) {
  return inter(a, block) >= 0.6 * area(a) && inter(b, block) >= 0.6 * area(b)
    && inter(a, b) <= 0.3 * Math.min(area(a), area(b));
}

/**
 * @param {Box} m
 * @param {Box} b
 */
function lands(m, b) {
  const i = inter(m, b);
  return i >= 0.6 * area(b) && i >= 0.3 * area(m);
}

/**
 * @param {TextBlock} a
 * @param {TextBlock} b
 */
function similar(a, b) {
  const r = a.glyph / b.glyph;
  return r >= 0.4 && r <= 2.5;
}

/**
 * @param {number[][]} cost
 * @param {number} none
 * @returns {number[]}
 */
export function greedy(cost, none) {
  /** @type {[number, number, number][]} */
  const pairs = [];
  cost.forEach((row, i) => row.forEach((c, j) => { if (c < none) pairs.push([c, i, j]); }));
  pairs.sort((a, b) => a[0] - b[0]);
  const out = new Array(cost.length).fill(-1);
  const taken = new Set();
  for (const [, i, j] of pairs) {
    if (out[i] >= 0 || taken.has(j)) continue;
    out[i] = j;
    taken.add(j);
  }
  return out;
}

/**
 * @param {number[][]} cost
 * @param {number} none
 * @returns {number[]}
 */
export function assign(cost, none) {
  const rows = cost.length;
  if (!rows) return [];
  const cols = cost[0].length;
  const m = cols + rows;
  /** @param {number} i @param {number} j */
  const at = (i, j) => (j < cols ? Math.min(cost[i][j], FORBIDDEN) : j - cols === i ? none : FORBIDDEN);
  const u = new Float64Array(rows + 1);
  const v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1);
  const way = new Int32Array(m + 1);
  const minv = new Float64Array(m + 1);
  const used = new Uint8Array(m + 1);
  for (let i = 1; i <= rows; i++) {
    p[0] = i;
    let j0 = 0;
    minv.fill(Infinity);
    used.fill(0);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = at(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const out = new Array(rows).fill(-1);
  for (let j = 1; j <= cols; j++) {
    const i = p[j] - 1;
    if (i >= 0 && cost[i][j - 1] < FORBIDDEN) out[i] = j - 1;
  }
  return out;
}
