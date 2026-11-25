// @ts-check
export class RateLimiter {
  /** @param {() => number} getRpm */
  constructor(getRpm) {
    this.getRpm = getRpm;
    /** @type {number[]} */
    this.stamps = [];
    this.pausedUntil = 0;
    this.factor = 1;
    this.cap = Infinity;
    this.pauseWhy = /** @type {'quota'|'net'} */ ('quota');
  }

  rpm() {
    return Math.max(1, Math.floor(Math.min(this.getRpm(), this.cap) * this.factor));
  }

  /** @param {number} now */
  prune(now) {
    const cutoff = now - 60_000;
    let i = 0;
    while (i < this.stamps.length && this.stamps[i] <= cutoff) i++;
    if (i) this.stamps.splice(0, i);
  }

  /** @param {number} now @returns {number} */
  waitTime(now) {
    if (now < this.pausedUntil) return this.pausedUntil - now;
    this.prune(now);
    const limit = this.rpm();
    if (this.stamps.length < limit) return 0;
    return this.stamps[this.stamps.length - limit] + 60_000 - now + 1;
  }

  /** @param {number} now */
  room(now) {
    if (now < this.pausedUntil) return 0;
    this.prune(now);
    return Math.max(0, this.rpm() - this.stamps.length);
  }

  /** @param {number} now */
  take(now) {
    this.stamps.push(now);
  }

  /** @param {number} until @param {'quota'|'net'} why */
  pause(until, why) {
    if (until > this.pausedUntil) { this.pausedUntil = until; this.pauseWhy = why; }
  }

  /** @param {number} now @param {number} retryMs */
  onRateLimited(now, retryMs) {
    this.pause(now + Math.max(1000, retryMs), 'quota');
    this.factor = Math.max(0.2, this.factor * 0.7);
  }

  forget() {
    this.cap = Infinity;
    this.factor = 1;
  }

  /** @param {number} perMinute */
  learn(perMinute) {
    if (Number.isFinite(perMinute) && perMinute >= 1) this.cap = Math.min(this.cap, Math.floor(perMinute));
  }

  onSuccess() {
    this.factor = Math.min(1, this.factor + 0.05);
  }
}
