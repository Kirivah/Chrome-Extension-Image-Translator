// @ts-check
import { idbGet, idbPut } from '../shared/idb.js';
import { todayKey } from './util.js';
import { maxOutputTokens } from './limits.js';

const KEY = 'usage';

/** @returns {Usage} */
const zero = () => ({ day: todayKey(), req: 0, img: 0, hits: 0, inTok: 0, outTok: 0, cost: 0 });

/** @type {Usage} */
let u = zero();
const pending = { req: 0, cost: 0 };
/** @type {Promise<void> | null} */
let loading = null;
/** @type {ReturnType<typeof setTimeout> | 0} */
let timer = 0;

export function loadUsage() {
  loading ??= idbGet('kv', KEY).then((raw) => {
    const v = /** @type {Partial<Usage> | undefined} */ (raw);
    if (v && typeof v === 'object' && v.day === todayKey()) {
      u = {
        day: v.day,
        req: Number(v.req) || 0,
        img: Number(v.img) || 0,
        hits: Number(v.hits) || 0,
        inTok: Number(v.inTok) || 0,
        outTok: Number(v.outTok) || 0,
        cost: Number(v.cost) || 0,
      };
    }
  }).catch(() => {});
  return loading;
}

function roll() {
  const d = todayKey();
  if (u.day !== d) u = zero();
}

function persist() {
  clearTimeout(timer);
  timer = setTimeout(() => { idbPut('kv', KEY, u).catch(() => {}); }, 500);
}

/** @returns {Usage} */
export function usageSnapshot() {
  roll();
  return { ...u };
}

/** @param {ModelInfo} m @param {number} inTok @param {number} outTok */
const price = (m, inTok, outTok) => (inTok * m.inUsd + outTok * m.outUsd) / 1e6;

/**
 * @param {ModelInfo} m
 * @param {number} images
 */
export const estimate = (m, images) => price(m, 2300 * images + 500, maxOutputTokens(images));

/**
 * @param {Settings} s
 * @param {ModelInfo} m
 * @param {number} images
 * @returns {ErrCode | 'wait' | null}
 */
export function spendBlock(s, m, images) {
  roll();
  if (s.dailyRequests > 0) {
    if (u.req >= s.dailyRequests) return 'quota';
    if (u.req + pending.req >= s.dailyRequests) return 'wait';
  }
  if (s.dailyBudget > 0) {
    const est = estimate(m, images);
    if (u.cost + est > s.dailyBudget) return 'budget';
    if (pending.req > 0 && u.cost + pending.cost + est > s.dailyBudget) return 'wait';
  }
  return null;
}

/**
 * @param {ModelInfo} m
 * @param {number} images
 * @returns {{est: number, open: boolean}}
 */
export function reserve(m, images) {
  roll();
  const est = estimate(m, images);
  pending.req++;
  pending.cost += est;
  return { est, open: true };
}

/**
 * @param {{est: number, open: boolean}} r
 * @param {ModelInfo} m
 * @param {{billed: boolean, inTok: number, outTok: number}} actual
 */
export function settle(r, m, actual) {
  if (!r.open) return;
  r.open = false;
  pending.req = Math.max(0, pending.req - 1);
  pending.cost = pending.req === 0 ? 0 : Math.max(0, pending.cost - r.est);
  if (!actual.billed) return;
  roll();
  u.req++;
  u.inTok += actual.inTok;
  u.outTok += actual.outTok;
  u.cost += price(m, actual.inTok, actual.outTok);
  persist();
}

/** @param {boolean} cached */
export function recordImage(cached) {
  roll();
  u.img++;
  if (cached) u.hits++;
  persist();
}
