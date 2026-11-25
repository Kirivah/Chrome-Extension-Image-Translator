// @ts-check
import { cacheGet, cachePut } from './cache.js';
import { fetchImageBytes } from './fetcher.js';
import { sniffImageSize } from './imagesize.js';
import { decodeImage, planSegments, encodeSegment, analysisPixels, encodePatch } from './imaging.js';
import { Placer } from './placement.js';
import { releaseScratch } from './textmap.js';
import { parseModelBlock, toFullImage, BlockCollector, validCachedBlocks } from './regions.js';
import { PROMPT_VERSION, PROMPT_REVISION } from './gemini.js';
import { recordImage } from './usage.js';
import { sha256Hex, b64ToBytes, TaskError, asTaskError } from './util.js';
import { Sequence, sameFolder, AHEAD } from './sequence.js';
import { MAX_B64 } from './limits.js';
import * as keepalive from './keepalive.js';

export const ANALYSIS_VERSION = 10;

const DROP_MAX = 500;
const A_SLOTS = 4;
const A_SLOTS_PER_ORIGIN = 2;
const BYTES_TIMEOUT_MS = 8_000;

/** @typedef {import('./dispatcher.js').Dispatcher} Dispatcher */
/** @typedef {import('./dispatcher.js').JobCfg} JobCfg */
/** @typedef {import('./analysis.js').Pixels} Pixels */
/** @typedef {import('./regions.js').Block} Block */
/** @typedef {import('./placement.js').Update} Update */

/**
 * @typedef {Object} Client
 * @property {number} tabId
 * @property {string} origin
 * @property {Map<number, Listener>} jobs
 * @property {(m: SwToCs) => void} post
 */

/**
 * @typedef {Object} Listener
 * @property {Client} client
 * @property {number} id
 * @property {number} prio
 * @property {CaptureCap} cap
 * @property {Task} task
 */

/**
 * @typedef {Object} Snapshot
 * @property {string} sig
 * @property {JobCfg} cfg
 * @property {string} lang
 * @property {number} sensitivity
 * @property {number} maxSide
 */

/**
 * @typedef {Object} Task
 * @property {string} key
 * @property {Snapshot} snap
 * @property {string} origin
 * @property {string} url
 * @property {string} finalKey
 * @property {Set<Listener>} ls
 * @property {Region[]} out
 * @property {boolean} rough
 * @property {number} seq
 * @property {AbortController} ac
 * @property {boolean} dispatched
 * @property {boolean} closed
 * @property {((b: Uint8Array | null) => void) | null} bytesWaiter
 * @property {Listener | null} bytesFrom
 * @property {boolean} fresh
 * @property {boolean} viaModel
 */

/**
 * @typedef {Object} HubEnv
 * @property {() => Snapshot} snapshot
 * @property {() => boolean} ahead
 * @property {() => Promise<string>} apiKey
 * @property {Dispatcher} dispatcher
 * @property {(tabId: number) => boolean} wantsFresh
 * @property {(client: Client, regions: number, viaModel: boolean) => void} onImageDone
 * @property {(client: Client, code: ErrCode, detail: string) => void} onImageError
 */

let preparing = Promise.resolve();
/** @param {() => void} fn */
function inTurn(fn) {
  preparing = preparing.then(() => new Promise((resolve) => setTimeout(resolve, 0))).then(fn).catch(() => {});
}

let placing = 0;
/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function first(fn) {
  placing++;
  try { return await fn(); } finally { placing--; }
}
let polishing = Promise.resolve();
/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function polishStep(fn) {
  const run = polishing.then(async () => {
    for (let n = 0; placing > 0 && n < 150; n++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 0));
    return fn();
  });
  polishing = run.then(() => {}, () => {});
  return run;
}

/** @param {string} url */
const isEphemeral = (url) => !/^https?:/i.test(url);

/** @param {number} w @param {number} h */
const tooSmall = (w, h) => w < 48 || h < 48 || w * h < 20_000;

/** @param {unknown} v @returns {Region[] | null} */
function validRegions(v) {
  if (!Array.isArray(v) || v.length > 500) return null;
  for (const r of v) {
    if (!r || typeof r !== 'object' || typeof (/** @type {Region} */ (r)).t !== 'string') return null;
  }
  return /** @type {Region[]} */ (v);
}

export class TaskHub {
  /** @param {HubEnv} env */
  constructor(env) {
    this.env = env;
    /** @type {Map<string, Task>} */
    this.tasks = new Map();
    /** @type {Task[]} */
    this.aQueue = [];
    /** @type {Map<string, number>} */
    this.aRunning = new Map();
    this.aTotal = 0;
    this.seq = 0;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.idleTimer = undefined;
    this.sequence = new Sequence();
    this.aheadId = 0;
    /** @type {Map<string, number>} */
    this.preloadsLeft = new Map();
  }

  /**
   * @param {Client} client
   * @param {number} id
   * @param {string} url
   * @param {number} prio
   * @param {CaptureCap} cap
   */
  add(client, id, url, prio, cap) {
    const snap = this.env.snapshot();
    const key = `${snap.sig}\n${client.origin}\n${url}`;
    let task = this.tasks.get(key);
    const fresh = !task || task.closed || task.ac.signal.aborted;
    if (!task || fresh) {
      task = {
        key, snap, origin: client.origin, url,
        finalKey: `${snap.sig}|a${ANALYSIS_VERSION}|s${snap.sensitivity.toFixed(2)}|p${PROMPT_VERSION}\n${client.origin}\n${url}`,
        ls: new Set(), out: [], rough: false, seq: ++this.seq,
        ac: new AbortController(), dispatched: false, closed: false,
        bytesWaiter: null, bytesFrom: null,
        fresh: this.env.wantsFresh(client.tabId), viaModel: false,
      };
      this.tasks.set(key, task);
      keepalive.hold();
    }
    const before = fresh ? 9 : this.prio(task);
    /** @type {Listener} */
    const l = { client, id, prio, cap, task };
    task.ls.add(l);
    client.jobs.set(id, l);
    if (task.out.length && id > 0) client.post({ t: 'part', id, r: task.out });
    if (fresh) void this.start(task);
    else if (prio < before) this.env.dispatcher.pump();
    if (prio === 0) this.ahead(client, url);
  }

  /**
   * @param {Client} client
   * @param {string} url
   */
  ahead(client, url) {
    if (isEphemeral(url)) return;
    this.preloadsLeft.delete(client.origin);
    this.preloadsLeft.set(client.origin, AHEAD);
    if (this.preloadsLeft.size > 50) this.preloadsLeft.delete(/** @type {string} */ (this.preloadsLeft.keys().next().value));
    if (!this.env.ahead()) { this.sequence.shown(client.origin, url); return; }
    const sig = this.env.snapshot().sig;
    for (const u of this.sequence.shown(client.origin, url)) {
      const t = this.tasks.get(`${sig}\n${client.origin}\n${u}`);
      if (t && !t.closed) continue;
      this.add(client, -(++this.aheadId), u, 2, 0);
    }
  }

  /** @param {number} tabId */
  pending(tabId) {
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.closed) continue;
      for (const l of t.ls) if (l.client.tabId === tabId && l.id > 0) { n++; break; }
    }
    return n;
  }

  /**
   * @param {Client} client
   * @param {string} url
   * @param {boolean} [next]
   * @returns {boolean}
   */
  preloaded(client, url, next = false) {
    if (!this.env.ahead() || isEphemeral(url)) return false;
    const shown = this.sequence.recent(client.origin);
    if (next ? !shown.length : !shown.some((s) => sameFolder(url, s))) return false;
    const t = this.tasks.get(`${this.env.snapshot().sig}\n${client.origin}\n${url}`);
    if (t && !t.closed) return true;
    const left = this.preloadsLeft.get(client.origin) ?? 0;
    if (left <= 0) return false;
    this.preloadsLeft.set(client.origin, left - 1);
    this.add(client, -(++this.aheadId), url, 2, 0);
    return true;
  }

  /** @param {Listener} l @param {number} prio */
  setPrio(l, prio) {
    const was = l.prio;
    l.prio = prio;
    if (prio < was) this.env.dispatcher.pump();
    if (prio === 0 && was !== 0) this.ahead(l.client, l.task.url);
  }

  /** @param {Listener} l */
  remove(l) {
    const t = l.task;
    t.ls.delete(l);
    l.client.jobs.delete(l.id);
    if (t.bytesFrom === l && t.bytesWaiter) t.bytesWaiter(null);
    if (t.ls.size === 0 && !t.dispatched) this.cancel(t);
  }

  /** @param {Listener} l @param {string | null} b64 */
  provideBytes(l, b64) {
    const t = l.task;
    if (t.bytesFrom !== l || !t.bytesWaiter) return;
    t.bytesWaiter(b64 && b64.length <= MAX_B64 ? b64ToBytes(b64) : null);
  }

  /** @param {string} sig */
  cancelStale(sig) {
    for (const t of [...this.tasks.values()]) if (t.snap.sig !== sig && !t.dispatched) this.cancel(t);
  }

  /** @param {Task} t */
  cancel(t) {
    if (t.closed) return;
    t.ac.abort();
    if (this.tasks.get(t.key) === t) this.tasks.delete(t.key);
    const i = this.aQueue.indexOf(t);
    if (i >= 0) {
      this.aQueue.splice(i, 1);
      this.close(t, new TaskError('cancelled'));
    }
  }

  /** @param {Task} t */
  prio(t) {
    let p = 9;
    for (const l of t.ls) if (l.prio < p) p = l.prio;
    return p;
  }

  /** @param {Task} t */
  async start(t) {
    if (!isEphemeral(t.url)) {
      const hit = await cacheGet('final', t.finalKey, { fresh: t.fresh, rev: PROMPT_REVISION });
      const regions = hit ? validRegions(hit.value) : null;
      if (regions) {
        this.emit(t, regions);
        recordImage(true);
        this.close(t, null);
        return;
      }
    }
    if (t.closed || t.ac.signal.aborted) { this.close(t, new TaskError('cancelled')); return; }
    this.aQueue.push(t);
    this.pumpA();
  }

  pumpA() {
    while (this.aTotal < A_SLOTS && this.aQueue.length) {
      const pick = (/** @type {boolean} */ fair) => {
        let bi = -1;
        for (let i = 0; i < this.aQueue.length; i++) {
          const a = this.aQueue[i];
          if (fair && (this.aRunning.get(a.origin) ?? 0) >= A_SLOTS_PER_ORIGIN) continue;
          if (bi < 0) { bi = i; continue; }
          const b = this.aQueue[bi];
          const d = this.prio(a) - this.prio(b);
          if (d < 0 || (d === 0 && a.seq < b.seq)) bi = i;
        }
        return bi;
      };
      let bi = pick(true);
      if (bi < 0) bi = pick(false);
      const t = this.aQueue.splice(bi, 1)[0];
      this.aTotal++;
      this.aRunning.set(t.origin, (this.aRunning.get(t.origin) ?? 0) + 1);
      let released = false;
      const releaseA = () => {
        if (released) return;
        released = true;
        this.aTotal--;
        const n = (this.aRunning.get(t.origin) ?? 1) - 1;
        if (n > 0) this.aRunning.set(t.origin, n); else this.aRunning.delete(t.origin);
        this.pumpA();
      };
      this.run(t, releaseA)
        .then(() => this.close(t, null), (e) => this.close(t, asTaskError(e)))
        .finally(releaseA);
    }
  }

  /** @param {Task} t */
  aborted(t) {
    if (t.ac.signal.aborted) throw new TaskError('cancelled');
  }

  /** @param {Task} t @param {() => void} releaseA */
  async run(t, releaseA) {
    const snap = t.snap;
    const keepFinal = !isEphemeral(t.url);
    this.aborted(t);
    this.env.dispatcher.warm(snap.cfg.model.id);

    const bytes = await this.acquireBytes(t);
    this.aborted(t);
    const dims = sniffImageSize(bytes);
    if (dims && tooSmall(dims.w, dims.h)) return;

    const hash = await sha256Hex(bytes);
    const baseKey = `${hash}|${snap.sig}|p${PROMPT_VERSION}`;
    const siteKey = `${baseKey}|${t.origin}`;
    const opt = { fresh: t.fresh, rev: PROMPT_REVISION };
    const hit = (await cacheGet('raw', baseKey, opt)) ?? (await cacheGet('raw', siteKey, opt));
    const raw = hit ? validCachedBlocks(hit.value) : null;
    if (hit && raw) {
      if (raw.length) {
        const placer = this.placer(t, await this.pixels(bytes, dims));
        await first(async () => {
          this.apply(t, await placer.add(raw));
          this.apply(t, await placer.finish());
        });
        await this.polish(t, placer);
        if (placer.rough) t.rough = true;
      }
      if (keepFinal && !t.rough) cachePut('final', t.finalKey, t.out, hit.partial, hit.rev);
      recordImage(true);
      return;
    }

    if (!(await this.env.apiKey())) throw new TaskError('nokey');
    releaseA();
    const disp = this.env.dispatcher;
    await disp.room(() => this.prio(t));
    /** @type {import('./regions.js').Seg[]} */
    let segs = [];
    let W = 0;
    let H = 0;
    /** @type {ImageBitmap | null} */
    let bmp = null;
    try {
      this.aborted(t);
      bmp = await decodeImage(bytes, dims).catch(() => { throw new TaskError('decode'); });
      W = bmp.width;
      H = bmp.height;
      if (!tooSmall(W, H)) segs = planSegments(W, H);
    } finally {
      if (!segs.length) { disp.unreserve(); bmp?.close(); }
    }
    if (!segs.length) return;
    const decoded = /** @type {ImageBitmap} */ (bmp);

    const collector = new BlockCollector(segs.length);
    /** @type {Promise<Pixels> | null} */
    let pxP = null;
    /** @type {{placer: Placer | null}} */
    const at = { placer: null };
    let chain = Promise.resolve();
    /** @param {Block[]} blocks */
    const show = (blocks) => {
      if (!blocks.length) return;
      chain = chain.then(() => first(async () => {
        pxP ??= this.pixels(bytes, dims);
        at.placer ??= this.placer(t, await pxP);
        this.apply(t, await at.placer.add(blocks));
      })).catch((e) => { asTaskError(e); t.rough = true; });
    };

    /** @type {Promise<import('./dispatcher.js').SegResult>[]} */
    const answers = [];
    /** @type {TaskError | null} */
    let unprepared = null;
    /** @type {Promise<Pixels> | null} */
    let early = null;
    try {
      for (const seg of segs) {
        if (!t.dispatched) this.aborted(t);
        const b64 = await encodeSegment(decoded, seg, snap.maxSide);
        if (!t.dispatched) this.aborted(t);
        if (t.dispatched && t.ls.size === 0) break;
        let goneOut = false;
        answers.push(disp.submit({
          b64,
          sent: () => { goneOut = true; },
          origin: t.origin,
          sig: snap.sig,
          cfg: snap.cfg,
          prio: () => this.prio(t),
          cancelled: () => t.ls.size === 0,
          onBlock: (obj) => {
            const b = parseModelBlock(obj, 1);
            if (!b) return false;
            show(collector.add(toFullImage(b, seg, W, H)));
            return true;
          },
        }));
        if (!t.dispatched) {
          t.dispatched = true;
          if (goneOut) {
            /** @type {Promise<Pixels>} */
            const fromUpload = new Promise((resolve, reject) => setTimeout(() => {
              try { resolve(analysisPixels(decoded)); } catch (e) { reject(e); }
            }, 0));
            fromUpload.catch(() => {});
            pxP = fromUpload;
            early = fromUpload;
          }
        }
      }
    } catch (e) {
      const err = asTaskError(e);
      if (!answers.length) throw err.code === 'cancelled' ? err : new TaskError('decode', err.message);
      unprepared = new TaskError('decode', err.message);
    } finally {
      disp.unreserve();
      const taking = pxP;
      if (taking) taking.finally(() => decoded.close()).catch(() => {});
      else decoded.close();
    }
    if (early) {
      const px = early;
      chain = chain.then(async () => { at.placer ??= this.placer(t, await px); }).catch((e) => { asTaskError(e); });
      void chain.then(() => inTurn(() => { if (t.ls.size) void at.placer?.matcherReady; }));
    }
    const results = await Promise.all(answers);
    if (unprepared) results.push({ err: unprepared, batched: false, partial: false });
    for (let k = answers.length; k < segs.length && !unprepared; k++) results.push({ err: new TaskError('cancelled'), batched: false, partial: false });
    show(collector.finish());
    chain = chain.then(() => first(async () => { if (at.placer) this.apply(t, await at.placer.finish()); }))
      .catch((e) => { asTaskError(e); t.rough = true; });
    await chain;
    if (at.placer) await this.polish(t, at.placer).catch((e) => { asTaskError(e); t.rough = true; });
    if (at.placer?.rough) t.rough = true;

    if (t.ls.size > 0 && results.some((r) => r.err?.code === 'cancelled')) throw new TaskError('cancelled');
    const failed = results.find((r) => r.err !== null);
    if (!failed) {
      const partial = results.some((r) => r.partial);
      cachePut('raw', results.some((r) => r.batched) ? siteKey : baseKey, collector.all(), partial, PROMPT_REVISION);
      if (keepFinal && !t.rough) cachePut('final', t.finalKey, t.out, partial, PROMPT_REVISION);
      t.viaModel = true;
      recordImage(false);
    } else if (!t.out.length) {
      throw failed.err;
    }
  }

  /**
   * @param {Task} t
   * @returns {Promise<Uint8Array>}
   */
  async acquireBytes(t) {
    let cap = /** @type {CaptureCap} */ (0);
    for (const l of t.ls) if (l.cap > cap) cap = l.cap;
    if (cap !== 0) {
      const b = await this.requestBytes(t);
      if (b && b.length) return b;
      if (cap === 1) throw new TaskError('fetch', 'page could not provide the image');
    }
    this.aborted(t);
    return fetchImageBytes(t.url, t.origin, t.ac.signal);
  }

  /** @param {Task} t */
  requestBytes(t) {
    /** @type {Listener | null} */
    let from = null;
    for (const l of t.ls) if (l.cap && (!from || l.cap < from.cap)) from = l;
    if (!from) return Promise.resolve(null);
    const l = from;
    return /** @type {Promise<Uint8Array | null>} */ (new Promise((resolve) => {
      const timer = setTimeout(() => finish(null), BYTES_TIMEOUT_MS);
      const onAbort = () => finish(null);
      /** @param {Uint8Array | null} b */
      const finish = (b) => {
        clearTimeout(timer);
        t.ac.signal.removeEventListener('abort', onAbort);
        t.bytesWaiter = null;
        t.bytesFrom = null;
        resolve(b);
      };
      t.ac.signal.addEventListener('abort', onAbort, { once: true });
      t.bytesWaiter = finish;
      t.bytesFrom = l;
      l.client.post({ t: 'need', id: l.id });
    }));
  }

  /** @param {Uint8Array} bytes @param {{w: number, h: number} | null} dims */
  async pixels(bytes, dims) {
    const bmp = await decodeImage(bytes, dims).catch(() => { throw new TaskError('decode'); });
    try { return analysisPixels(bmp); } finally { bmp.close(); }
  }

  /**
   * @param {Task} t
   * @param {Placer} placer
   */
  async polish(t, placer) {
    for (;;) {
      if (t.ac.signal.aborted) {
        if (placer.unpolished.size) placer.rough = true;
        return;
      }
      const u = await polishStep(() => placer.polishNext());
      if (!u) return;
      this.apply(t, u);
    }
  }

  /**
   * @param {Task} t
   * @param {Pixels} px
   */
  placer(t, px) {
    return new Placer(px, { sensitivity: t.snap.sensitivity, lang: t.snap.lang, encode: encodePatch });
  }

  /** @param {Task} t @param {Update} u */
  apply(t, u) {
    if (u.retract.length) this.withdraw(t, u.retract);
    this.emit(t, u.show);
  }

  /**
   * @param {Task} t
   * @param {number[]} ids
   */
  withdraw(t, ids) {
    if (t.closed) return;
    const gone = new Set(ids);
    t.out = t.out.filter((r) => r.i === undefined || !gone.has(r.i));
    for (let i = 0; i < ids.length; i += DROP_MAX) {
      const k = ids.slice(i, i + DROP_MAX);
      for (const l of t.ls) if (l.id > 0) l.client.post({ t: 'drop', id: l.id, k });
    }
  }

  /** @param {Task} t @param {Region[]} regions */
  emit(t, regions) {
    if (!regions.length || t.closed) return;
    for (const r of regions) {
      const k = r.i === undefined ? -1 : t.out.findIndex((o) => o.i === r.i);
      if (k >= 0) t.out[k] = r; else t.out.push(r);
    }
    for (const l of t.ls) if (l.id > 0) l.client.post({ t: 'part', id: l.id, r: regions });
  }

  /** @param {Task} t @param {TaskError | null} err */
  close(t, err) {
    if (t.closed) return;
    t.closed = true;
    if (this.tasks.get(t.key) === t) this.tasks.delete(t.key);
    keepalive.release();
    if (this.tasks.size === 0) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { if (this.tasks.size === 0) releaseScratch(); }, 5000);
    }
    for (const l of t.ls) {
      l.client.jobs.delete(l.id);
      if (l.id < 0) continue;
      if (err) {
        l.client.post({ t: 'err', id: l.id, e: err.code });
        if (err.code !== 'cancelled') this.env.onImageError(l.client, err.code, err.message);
      } else {
        l.client.post({ t: 'done', id: l.id, n: t.out.length });
        this.env.onImageDone(l.client, t.out.length, t.viaModel);
      }
    }
    t.ls.clear();
  }
}
