// @ts-check

const DB_NAME = 'imgtr';
const DB_VERSION = 2;
export const STORES = /** @type {const} */ (['kv', 'raw', 'final']);

/** @typedef {typeof STORES[number]} StoreName */

/** @type {Promise<IDBDatabase> | null} */
let dbp = null;

/** @returns {Promise<IDBDatabase>} */
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      const up = /** @type {IDBTransaction} */ (req.transaction);
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      for (const name of ['raw', 'final']) {
        if (!d.objectStoreNames.contains(name)) d.createObjectStore(name).createIndex('t', 't');
      }
      const fin = up.objectStore('final');
      if (!fin.indexNames.contains('tw')) fin.createIndex('tw', ['t', 'w']);
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => { d.close(); dbp = null; };
      d.onclose = () => { dbp = null; };
      resolve(d);
    };
    req.onerror = () => { dbp = null; reject(req.error); };
    req.onblocked = () => { dbp = null; reject(new Error('IndexedDB blocked')); };
  });
  return dbp;
}

/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
function done(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * @param {StoreName} store
 * @param {IDBTransactionMode} mode
 */
async function tx(store, mode) {
  const d = await db();
  return d.transaction(store, mode, { durability: 'relaxed' }).objectStore(store);
}

/** @param {StoreName} store @param {string} key @returns {Promise<unknown>} */
export async function idbGet(store, key) {
  return done((await tx(store, 'readonly')).get(key));
}

/** @param {StoreName} store @param {string} key @param {unknown} value */
export async function idbPut(store, key, value) {
  await done((await tx(store, 'readwrite')).put(value, key));
}

/**
 * @template T
 * @param {StoreName} store
 * @param {string} key
 * @param {(current: unknown) => T} fn
 * @returns {Promise<T>}
 */
export async function idbUpdate(store, key, fn) {
  const os = await tx(store, 'readwrite');
  const next = fn(await done(os.get(key)));
  await done(os.put(next, key));
  return next;
}

/** @param {StoreName} store @param {string} key */
export async function idbDel(store, key) {
  await done((await tx(store, 'readwrite')).delete(key));
}

/** @param {StoreName} store */
export async function idbClear(store) {
  await done((await tx(store, 'readwrite')).clear());
}

/** @param {StoreName} store @returns {Promise<number>} */
export async function idbCount(store) {
  return done((await tx(store, 'readonly')).count());
}

/**
 * @param {'raw'|'final'} store
 * @param {number} keep
 */
export async function idbTrim(store, keep) {
  const os = await tx(store, 'readwrite');
  const total = await done(os.count());
  let excess = total - keep;
  if (excess <= 0) return 0;
  const removed = excess;
  await new Promise((resolve, reject) => {
    const cur = os.index('t').openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c || excess <= 0) { resolve(undefined); return; }
      c.delete();
      excess--;
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  return removed;
}

/**
 * @param {number} bytes
 * @returns {Promise<number>}
 */
export async function idbTrimBytes(bytes) {
  const os = await tx('final', 'readwrite');
  return new Promise((resolve, reject) => {
    let sum = 0;
    /** @type {IDBValidKey[]} */
    const old = [];
    const cur = os.index('tw').openKeyCursor(null, 'prev');
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) {
        const w = Number(/** @type {unknown[]} */ (c.key)[1]) || 0;
        sum += w;
        if (sum > bytes) old.push(c.primaryKey);
        c.continue();
        return;
      }
      for (const k of old) os.delete(k);
      os.transaction.oncomplete = () => resolve(old.length);
      os.transaction.onerror = () => reject(os.transaction.error);
    };
    cur.onerror = () => reject(cur.error);
  });
}
