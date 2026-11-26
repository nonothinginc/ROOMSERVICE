/**
 * IndexedDB persistence for the sample library.
 *  - packs:   { id, name, count, bytes, addedAt }
 *  - samples: metadata only (fast to list on a handheld)
 *  - blobs:   original encoded file bytes, keyed by sample id (decoded on demand)
 */
const DB_NAME = 'roomservice-library';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('packs')) db.createObjectStore('packs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('samples')) {
        const s = db.createObjectStore('samples', { keyPath: 'id' });
        s.createIndex('packId', 'packId');
      }
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putPack(pack) {
  const db = await openDb();
  const tx = db.transaction('packs', 'readwrite');
  tx.objectStore('packs').put(pack);
  return done(tx);
}

export async function putSample(meta, bytes) {
  const db = await openDb();
  const tx = db.transaction(['samples', 'blobs'], 'readwrite');
  tx.objectStore('samples').put(meta);
  tx.objectStore('blobs').put(bytes, meta.id);
  return done(tx);
}

export async function updateSampleMeta(meta) {
  const db = await openDb();
  const tx = db.transaction('samples', 'readwrite');
  tx.objectStore('samples').put(meta);
  return done(tx);
}

export async function getAllPacks() {
  const db = await openDb();
  return reqP(db.transaction('packs').objectStore('packs').getAll());
}

export async function getAllSamples() {
  const db = await openDb();
  return reqP(db.transaction('samples').objectStore('samples').getAll());
}

export async function getSampleBytes(id) {
  const db = await openDb();
  return reqP(db.transaction('blobs').objectStore('blobs').get(id));
}

export async function deletePack(packId) {
  const db = await openDb();
  const ids = await reqP(db.transaction('samples').objectStore('samples').index('packId').getAllKeys(packId));
  const tx = db.transaction(['packs', 'samples', 'blobs'], 'readwrite');
  tx.objectStore('packs').delete(packId);
  for (const id of ids) {
    tx.objectStore('samples').delete(id);
    tx.objectStore('blobs').delete(id);
  }
  await done(tx);
  return ids;
}

/** Ask the browser not to evict the library under storage pressure (Android Chrome honours this for installed PWAs). */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) || false;
  } catch {
    return false;
  }
}

export async function storageEstimate() {
  try {
    return (await navigator.storage?.estimate?.()) || null;
  } catch {
    return null;
  }
}
