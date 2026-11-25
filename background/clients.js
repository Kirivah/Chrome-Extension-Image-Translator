// @ts-check
import { parseCsMessage } from './validate.js';

const PORT_NAME = 'imgtr';
const MAX_JOBS_PER_TAB = 600;
const MSG_WINDOW_MS = 10_000;
const MSG_PER_WINDOW = 3000;
const MAX_STRIKES = 25;
const STRIKE_HALF_LIFE_MS = 60_000;
const LOCKOUT_MS = 10 * 60_000;
const AHEAD_PER_MIN = 12;

/** @typedef {import('./tasks.js').TaskHub} TaskHub */
/** @typedef {import('./tasks.js').Client} BaseClient */

/**
 * @typedef {BaseClient & {
 *   port: chrome.runtime.Port,
 *   frameId: number,
 *   winStart: number,
 *   winCount: number,
 *   aheadAt: number[],
 *   alive: boolean,
 *   }} Client
 */

/**
 * @typedef {Object} RegistryEnv
 * @property {Promise<void>} ready
 * @property {TaskHub} hub
 * @property {(origin: string) => boolean} allowed
 * @property {() => ContentConfig} config
 */

export class ClientRegistry {
  /** @param {RegistryEnv} env */
  constructor(env) {
    this.env = env;
    /** @type {Set<Client>} */
    this.clients = new Set();
    /** @type {Map<string, {strikes: number, at: number, lockedUntil: number}>} */
    this.records = new Map();
  }

  /** @param {number} tabId */
  openJobs(tabId) {
    let n = 0;
    for (const c of this.clients) if (c.tabId === tabId) n += c.jobs.size;
    return n;
  }

  /** @param {string} origin */
  record(origin) {
    const now = Date.now();
    let r = this.records.get(origin);
    if (!r) { r = { strikes: 0, at: now, lockedUntil: 0 }; this.records.set(origin, r); }
    r.strikes *= 0.5 ** ((now - r.at) / STRIKE_HALF_LIFE_MS);
    r.at = now;
    return r;
  }

  /** @param {chrome.runtime.Port} port */
  connect(port) {
    const s = port.sender;
    if (port.name !== PORT_NAME || !s || s.id !== chrome.runtime.id || !s.tab || typeof s.tab.id !== 'number') {
      port.disconnect();
      return;
    }
    let origin = s.origin || '';
    if (!origin && s.url) {
      try { origin = new URL(s.url).origin; } catch { origin = ''; }
    }
    if (!/^https?:\/\//.test(origin) || this.record(origin).lockedUntil > Date.now()) { port.disconnect(); return; }

    /** @type {Client} */
    const client = {
      port,
      tabId: s.tab.id,
      frameId: typeof s.frameId === 'number' ? s.frameId : 0,
      origin,
      jobs: new Map(),
      winStart: Date.now(),
      winCount: 0,
      aheadAt: [],
      alive: true,
      post: (m) => {
        if (!client.alive) return;
        try { port.postMessage(m); } catch { this.drop(client); }
      },
    };

    /** @type {unknown[] | null} */
    let early = [];
    port.onMessage.addListener((m) => {
      if (early) { if (early.length < 2000) early.push(m); } else this.handle(client, m);
    });
    port.onDisconnect.addListener(() => this.drop(client));

    this.env.ready.then(() => {
      if (!client.alive) return;
      if (!this.env.allowed(origin)) {
        client.post({ t: 'cfg', c: { ...this.env.config(), on: false } });
        this.drop(client);
        port.disconnect();
        return;
      }
      this.clients.add(client);
      client.post({ t: 'cfg', c: this.env.config() });
      const queued = early || [];
      early = null;
      for (const m of queued) this.handle(client, m);
    });
  }

  /** @param {Client} c @param {unknown} raw */
  handle(c, raw) {
    if (!c.alive) return;
    const now = Date.now();
    if (now - c.winStart > MSG_WINDOW_MS) { c.winStart = now; c.winCount = 0; }
    if (++c.winCount > MSG_PER_WINDOW) {
      if ((c.winCount - MSG_PER_WINDOW) % 500 === 1) this.strike(c, 1);
      return;
    }

    const m = parseCsMessage(raw);
    if (!m) { this.strike(c, 1); return; }
    const hub = this.env.hub;
    switch (m.t) {
      case 'job': {
        if (c.jobs.has(m.id)) { this.strike(c, 1); return; }
        if (this.openJobs(c.tabId) >= MAX_JOBS_PER_TAB) { c.post({ t: 'err', id: m.id, e: 'busy' }); return; }
        hub.add(c, m.id, m.u, m.p, m.l);
        return;
      }
      case 'prio': {
        const l = c.jobs.get(m.id);
        if (l) hub.setPrio(l, m.p);
        return;
      }
      case 'cancel': {
        const l = c.jobs.get(m.id);
        if (l) hub.remove(l);
        return;
      }
      case 'bytes': {
        const l = c.jobs.get(m.id);
        if (l) hub.provideBytes(l, m.b);
        return;
      }
      case 'ahead': {
        c.aheadAt = c.aheadAt.filter((at) => now - at < 60_000);
        if (c.aheadAt.length >= AHEAD_PER_MIN || this.openJobs(c.tabId) >= MAX_JOBS_PER_TAB) return;
        if (hub.preloaded(c, m.u, m.n)) c.aheadAt.push(now);
        return;
      }
    }
  }

  /** @param {Client} c @param {number} n */
  strike(c, n) {
    const r = this.record(c.origin);
    r.strikes += n;
    if (r.strikes >= MAX_STRIKES) {
      r.lockedUntil = Date.now() + LOCKOUT_MS;
      console.warn('[imgtr] locking out misbehaving site for 10 minutes:', c.origin);
      for (const other of [...this.clients]) {
        if (other.origin === c.origin) { this.drop(other); try { other.port.disconnect(); } catch {} }
      }
      this.drop(c);
      try { c.port.disconnect(); } catch {}
    }
  }

  /** @param {Client} c */
  drop(c) {
    if (!c.alive) return;
    c.alive = false;
    this.clients.delete(c);
    for (const l of [...c.jobs.values()]) this.env.hub.remove(l);
    c.jobs.clear();
  }

  broadcastConfig() {
    const cfg = this.env.config();
    for (const c of [...this.clients]) {
      if (this.env.allowed(c.origin)) {
        c.post({ t: 'cfg', c: cfg });
      } else {
        c.post({ t: 'cfg', c: { ...cfg, on: false } });
        this.drop(c);
        try { c.port.disconnect(); } catch {}
      }
    }
  }

  /** @param {number} tabId */
  hasTab(tabId) {
    for (const c of this.clients) if (c.tabId === tabId) return true;
    return false;
  }
}
