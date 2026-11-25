// @ts-check
import { RateLimiter } from './limiter.js';
import { streamTranslate, newMeter, preconnect } from './gemini.js';
import { spendBlock, reserve, settle } from './usage.js';
import { API_BASE } from '../shared/models.js';
import { TaskError, asTaskError } from './util.js';

const MAX_TRIES = 5;
const HOLD_MS = 2500;
const RATE_WINDOW_MS = 15_000;
const HEDGE = Object.freeze({
  screen: { def: 3500, min: 2500, k: 2 },
  ahead: { def: 6000, min: 4000, k: 2.5 },
});
const HEDGE_MAX_MS = 12_000;
const WARM_MS = 30_000;
const TTFT_SAMPLES = 15;
const BLOCK_FINISH = /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/;

/** @param {string} finish */
function unusable(finish) {
  if (finish === 'LOOP') return 'the model got stuck repeating itself';
  if (finish === 'MAX_TOKENS') return 'the answer was too long and got cut off';
  return `Gemini stopped without an answer (${finish})`;
}

/**
 * @typedef {Object} JobCfg
 * @property {ModelInfo} model
 * @property {string} langName
 * @property {boolean} transcribe
 * @property {boolean} economy
 */

/**
 * @typedef {Object} SegResult
 * @property {TaskError | null} err
 * @property {boolean} batched
 * @property {boolean} partial
 */

/**
 * @typedef {Object} SegJob
 * @property {string} b64
 * @property {string} origin
 * @property {string} sig
 * @property {JobCfg} cfg
 * @property {() => number} prio
 * @property {() => boolean} cancelled
 * @property {(obj: unknown) => boolean} onBlock
 * @property {() => void} [sent]
 * @property {(r: SegResult) => void} settle
 * @property {number} seq
 * @property {number} tries
 * @property {boolean} solo
 * @property {boolean} wasBatched
 * @property {boolean} hot
 * @property {number} got
 * @property {number} since
 */

/**
 * @typedef {Object} DispatchEnv
 * @property {() => Settings} settings
 * @property {() => Promise<string>} apiKey
 * @property {(code: ErrCode) => void} onBlocked
 */

export class Dispatcher {
  /** @param {DispatchEnv} env */
  constructor(env) {
    this.env = env;
    /** @type {SegJob[]} */
    this.queue = [];
    this.inFlight = 0;
    this.reserved = 0;
    this.seq = 0;
    /** @type {ReturnType<typeof setTimeout> | 0} */
    this.timer = 0;
    /** @type {{prio: () => number, resolve: () => void}[]} */
    this.waiters = [];
    this.limiter = new RateLimiter(() => env.settings().rpm);
    /** @type {Map<string, number>} */
    this.served = new Map();
    /** @type {Map<string, string>} */
    this.dead = new Map();
    /** @type {Map<string, number[]>} */
    this.ttft = new Map();
    this.lastHedge = 0;
    this.hedges = 0;
    this.hedging = 0;
    /** @type {number[]} */
    this.arrivals = [];
    this.contactAt = 0;
  }

  /** @param {string} model */
  warm(model) {
    const now = Date.now();
    if (now - this.contactAt < WARM_MS) return;
    this.contactAt = now;
    this.env.apiKey().then((key) => { if (key) preconnect(API_BASE, key, model); }, () => {});
  }

  /** @param {number} now */
  rate(now) {
    let i = 0;
    while (i < this.arrivals.length && this.arrivals[i] < now - RATE_WINDOW_MS) i++;
    if (i) this.arrivals.splice(0, i);
    if (!this.arrivals.length) return 0;
    const span = Math.max(4000, now - this.arrivals[0]);
    return (this.arrivals.length * 60_000) / span;
  }

  limitsChanged() {
    this.limiter.forget();
    this.pump();
  }

  /** @returns {{queued: number, inFlight: number, waitMs: number, limited: boolean, slow: boolean}} */
  status() {
    const now = Date.now();
    const queued = this.queue.length;
    return {
      queued,
      inFlight: this.inFlight,
      waitMs: queued ? this.limiter.waitTime(now) : 0,
      limited: now < this.limiter.pausedUntil && this.limiter.pauseWhy === 'quota',
      slow: now - this.lastHedge < 60_000,
    };
  }

  /** @param {string} model @param {number} ms */
  noteFirstText(model, ms) {
    let a = this.ttft.get(model);
    if (!a) this.ttft.set(model, (a = []));
    a.push(ms);
    if (a.length > TTFT_SAMPLES) a.shift();
  }

  /**
   * @param {string} model
   * @param {number} [images]
   * @param {boolean} [onScreen]
   */
  hedgeDelay(model, images = 1, onScreen = false) {
    const h = onScreen ? HEDGE.screen : HEDGE.ahead;
    const a = this.ttft.get(model);
    const usual = !a || a.length < 4 ? h.def : Math.max(h.min, h.k * [...a].sort((x, y) => x - y)[a.length >> 1]);
    return Math.min(HEDGE_MAX_MS, usual * (1 + 0.25 * (images - 1)));
  }

  reviveModels() {
    this.dead.clear();
    this.pump();
  }

  lookahead() {
    const s = this.env.settings();
    return Math.max(4, s.concurrency * s.batch * 2);
  }

  /**
   * @param {() => number} prio
   * @returns {Promise<void>}
   */
  room(prio) {
    if (this.waiters.length === 0 && this.queue.length + this.reserved < this.lookahead()) {
      this.reserved++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push({ prio, resolve });
      this.releaseRoom();
    });
  }

  unreserve() {
    if (this.reserved > 0) this.reserved--;
    this.releaseRoom();
  }

  releaseRoom() {
    if (!this.waiters.length) return;
    this.waiters.sort((a, b) => a.prio() - b.prio());
    while (this.waiters.length && this.queue.length + this.reserved < this.lookahead()) {
      this.reserved++;
      /** @type {{resolve: () => void}} */ (this.waiters.shift()).resolve();
    }
  }

  /**
   * @param {Omit<SegJob, 'seq'|'tries'|'settle'|'solo'|'wasBatched'|'hot'|'got'|'since'>} job
   * @returns {Promise<SegResult>}
   */
  submit(job) {
    return new Promise((settleJob) => {
      const now = Date.now();
      this.arrivals.push(now);
      if (this.arrivals.length > 1000) this.arrivals.splice(0, 500);
      this.queue.push({ ...job, settle: settleJob, seq: ++this.seq, tries: 0, solo: false, wasBatched: false, hot: false, got: 0, since: now });
      this.pump();
    });
  }

  pump() {
    if (this.timer) { clearTimeout(this.timer); this.timer = 0; }
    this.queue = this.queue.filter((j) => {
      const refusedModel = this.dead.get(j.cfg.model.id);
      if (refusedModel !== undefined) { this.giveUp(j, new TaskError('nomodel', refusedModel)); return false; }
      if (!j.cancelled()) return true;
      this.giveUp(j, new TaskError('cancelled'));
      return false;
    });
    const s = this.env.settings();
    while (this.inFlight < s.concurrency && this.queue.length) {
      const turns = (/** @type {SegJob} */ j) => this.served.get(j.origin) ?? 0;
      this.queue.sort((a, b) => a.prio() - b.prio() || turns(a) - turns(b) || a.seq - b.seq);
      if (this.queue[0].prio() > 0 && s.concurrency > 1 && this.inFlight >= s.concurrency - 1) break;
      const next = this.nextBatch(s, Date.now());
      if (!next) break;
      let batch = next;
      const first = batch[0];
      let blocked = spendBlock(s, first.cfg.model, batch.length);
      if (blocked && blocked !== 'wait' && batch.length > 1) {
        batch = [first];
        blocked = spendBlock(s, first.cfg.model, 1);
      }
      if (blocked === 'wait') break;
      if (blocked) {
        for (const j of this.queue.splice(0)) this.giveUp(j, new TaskError(blocked));
        this.env.onBlocked(blocked);
        break;
      }
      const now = Date.now();
      const wait = this.limiter.waitTime(now);
      if (wait > 0) {
        this.timer = setTimeout(() => { this.timer = 0; this.pump(); }, wait);
        break;
      }
      const taken = new Set(batch);
      this.queue = this.queue.filter((j) => !taken.has(j));
      for (const j of batch) j.sent?.();
      const hold = reserve(first.cfg.model, batch.length);
      this.served.set(first.origin, turns(first) + batch.length);
      this.limiter.take(now);
      this.inFlight++;
      this.run(batch, hold).finally(() => { this.inFlight--; this.pump(); });
    }
    if (!this.queue.length && !this.inFlight) this.served.clear();
    this.releaseRoom();
  }

  /**
   * @param {Settings} s
   * @param {number} now
   * @returns {SegJob[] | null}
   */
  nextBatch(s, now) {
    const first = this.queue[0];
    if (first.solo || s.batch <= 1) return [first];
    const room = this.limiter.room(now);
    if (room <= 0) return [first];
    const mates = this.queue.filter((j) => j !== first && !j.solo && j.origin === first.origin && j.sig === first.sig);
    const rpm = this.limiter.rpm();
    const left = room / rpm;
    const byRoom = left > 2 / 3 ? 1 : left > 1 / 3 ? 2 : s.batch;
    const byRate = Math.ceil(this.rate(now) / rpm);
    let size;
    if (first.prio() === 0) {
      const waiting = 1 + mates.filter((j) => j.prio() === 0).length;
      const can = Math.max(1, Math.min(s.concurrency - this.inFlight - this.hedging, room));
      size = Math.ceil(waiting / can);
      if (left <= 1 / 3 || (left <= 2 / 3 && byRate > 1)) size = Math.max(size, byRoom, byRate);
      size = Math.min(s.batch, size);
    } else {
      size = Math.min(s.batch, Math.max(byRoom, byRate));
      if (size > 1 + mates.length && now - first.since < HOLD_MS) {
        this.timer = setTimeout(() => { this.timer = 0; this.pump(); }, first.since + HOLD_MS - now + 5);
        return null;
      }
    }
    return [first, ...mates.slice(0, size - 1)];
  }

  /** @param {SegJob[]} batch @param {ReturnType<typeof reserve>} hold */
  async run(batch, hold) {
    const { cfg } = batch[0];
    const batched = batch.length > 1;
    try {
      const apiKey = await this.env.apiKey().catch(() => '');
      if (!apiKey) {
        settle(hold, cfg.model, { billed: false, inTok: 0, outTok: 0 });
        this.fail(batch, new TaskError('nokey'));
        return;
      }
      if (batched) for (const j of batch) j.wasBatched = true;
      const r = await this.race(batch, apiKey, hold);
      this.finished(batch, r.finish);
    } catch (e) {
      const err = asTaskError(e);
      if (batched && (err.code === 'blocked' || err.code === 'model')) this.split(batch);
      else this.fail(batch, err);
    }
  }

  /**
   * @param {SegJob[]} batch
   * @param {string} apiKey
   * @param {ReturnType<typeof reserve>} hold
   * @returns {Promise<import('./gemini.js').TranslateResult>}
   */
  race(batch, apiKey, hold) {
    const { cfg } = batch[0];
    const batched = batch.length > 1;
    return new Promise((resolve, reject) => {
      /** @type {AbortController[]} */
      const tries = [];
      let winner = -1;
      let open = 0;
      /** @type {unknown} */
      let firstErr = null;
      /** @type {ReturnType<typeof setTimeout> | 0} */
      let hedge = 0;
      const stopOthers = (/** @type {number} */ k) => {
        if (hedge) { clearTimeout(hedge); hedge = 0; }
        tries.forEach((ac, i) => { if (i !== k) ac.abort(); });
      };
      /** @param {ReturnType<typeof reserve>} h */
      const start = (h) => {
        const k = tries.length;
        const ac = new AbortController();
        const meter = newMeter();
        const t0 = Date.now();
        this.contactAt = t0;
        tries.push(ac);
        open++;
        streamTranslate({
          apiBase: API_BASE,
          apiKey,
          model: cfg.model,
          images: batch.map((j) => j.b64),
          langName: cfg.langName,
          transcribe: cfg.transcribe,
          economy: cfg.economy,
          signal: ac.signal,
          meter,
          hot: !batched && batch[0].hot,
          onText: () => {
            if (winner >= 0) return;
            winner = k;
            this.noteFirstText(cfg.model.id, Date.now() - t0);
            stopOthers(k);
          },
          onBlock: (obj) => {
            if (winner !== k) return;
            let i = 0;
            if (batched) {
              const v = obj && typeof obj === 'object' ? /** @type {Record<string, unknown>} */ (obj).image : undefined;
              i = typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < batch.length ? v : -1;
            }
            if (i >= 0 && batch[i].onBlock(obj)) batch[i].got++;
          },
        }).then((r) => {
          if (winner < 0) { winner = k; stopOthers(k); }
          if (winner === k) resolve(r);
        }, (e) => {
          if (winner === k) { reject(e); return; }
          if (winner >= 0) return;
          if (firstErr === null) firstErr = e;
          if (open > 1 && e instanceof TaskError && e.code === 'quota') {
            this.limiter.onRateLimited(Date.now(), e.retryMs);
            if (e.quota.perMinute) this.limiter.learn(e.quota.perMinute);
          }
        }).finally(() => {
          open--;
          if (k > 0) this.hedging--;
          settle(h, cfg.model, {
            billed: meter.started,
            inTok: meter.inTok || 1800 * batch.length + 400,
            outTok: meter.outTok || Math.ceil(meter.chars / 3),
          });
          if (open === 0 && winner < 0) {
            if (hedge) { clearTimeout(hedge); hedge = 0; }
            reject(firstErr ?? new TaskError('net', 'no answer'));
          }
          this.pump();
        });
      };
      start(hold);
      let looks = 0;
      const tryHedge = () => {
        hedge = 0;
        if (winner >= 0 || open === 0 || tries.length > 1) return;
        const h = this.hedgeHold(batch);
        if (!h) {
          if (++looks < 20 && !batch.every((j) => j.cancelled())) hedge = setTimeout(tryHedge, 1000);
          return;
        }
        this.lastHedge = Date.now();
        this.hedges++;
        this.hedging++;
        start(h);
      };
      hedge = setTimeout(tryHedge, this.hedgeDelay(cfg.model.id, batch.length, batch.some((j) => j.prio() === 0)));
    });
  }

  /**
   * @param {SegJob[]} batch
   * @returns {ReturnType<typeof reserve> | null}
   */
  hedgeHold(batch) {
    const s = this.env.settings();
    const now = Date.now();
    if (batch.every((j) => j.cancelled())) return null;
    if (this.inFlight + this.hedging >= s.concurrency) return null;
    const room = this.limiter.room(now);
    const onScreen = batch.some((j) => j.prio() === 0);
    if (room < 1 || (!onScreen && room <= this.queue.length)) return null;
    if (spendBlock(s, batch[0].cfg.model, batch.length)) return null;
    this.limiter.take(now);
    return reserve(batch[0].cfg.model, batch.length);
  }

  /**
   * @param {SegJob[]} batch
   * @param {string} finish
   */
  finished(batch, finish) {
    if (finish === 'STOP') {
      this.limiter.onSuccess();
      for (const j of batch) j.settle({ err: null, batched: j.wasBatched, partial: false });
      return;
    }
    if (!finish) { this.fail(batch, new TaskError('net', 'the answer ended early', 1500)); return; }
    if (batch.length > 1) {
      this.split(batch);
      return;
    }
    const j = batch[0];
    const refused = BLOCK_FINISH.test(finish);
    if (!refused && !j.hot && (finish === 'LOOP' || j.got === 0)) {
      j.hot = true;
      j.solo = true;
      this.queue.push(j);
      return;
    }
    this.giveUp(j, refused ? new TaskError('blocked', finish) : new TaskError('model', unusable(finish)));
  }

  /** @param {SegJob[]} batch */
  split(batch) {
    for (const j of batch) { j.solo = true; this.queue.push(j); }
  }

  /**
   * @param {SegJob} j
   * @param {TaskError} err
   */
  giveUp(j, err) {
    if (j.got > 0) j.settle({ err: null, batched: j.wasBatched, partial: true });
    else j.settle({ err, batched: j.wasBatched, partial: false });
  }

  /** @param {SegJob[]} batch @param {TaskError} err */
  fail(batch, err) {
    if (err.code === 'quota') {
      this.limiter.onRateLimited(Date.now(), err.retryMs);
      if (err.quota.perMinute) this.limiter.learn(err.quota.perMinute);
    }
    if (err.code === 'nomodel') this.dead.set(batch[0].cfg.model.id, err.message);
    const daily = err.code === 'quota' && (err.quota.perDay > 0 || err.quota.zero);
    const retryable = (err.code === 'quota' && !daily && err.retryMs <= 65_000) || err.code === 'net';
    for (const j of batch) {
      j.tries++;
      if (retryable && j.tries < (err.code === 'net' ? 3 : MAX_TRIES)) this.queue.push(j);
      else this.giveUp(j, err);
    }
    if (err.code === 'quota' && !retryable) this.env.onBlocked('quota');
    if (err.code === 'net' && retryable) {
      this.limiter.pause(Date.now() + (err.retryMs || 1500), 'net');
    }
  }
}
