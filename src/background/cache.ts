// Persistent translation cache in IndexedDB (the service worker's in-memory
// state is lost whenever Chrome suspends it, so a Map alone would be useless).
//
// Key: SHA-256(origin, model, targetLang, source text). Partitioned by origin
// so one site's (possibly prompt-injected) translation is never replayed on
// another. No eviction yet.

import type { CacheEntry } from "./translator";

const DB_NAME = "llmt";
const STORE = "translations";

interface Entry {
  text: string;
  /** Model that produced the translation (absent on entries written before it was recorded). */
  model?: string;
  /** epoch ms; kept for a future eviction policy. */
  at: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

export async function cacheKey(origin: string, model: string, targetLang: string, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${origin}\u0000${model}\u0000${targetLang}\u0000${text}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function cacheGetMany(keys: readonly string[]): Promise<Array<CacheEntry | undefined>> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const store = tx.objectStore(STORE);
  return Promise.all(
    keys.map(
      (k) =>
        new Promise<CacheEntry | undefined>((resolve, reject) => {
          const req = store.get(k);
          req.onsuccess = () => {
            const e = req.result as Entry | undefined;
            resolve(e ? { text: e.text, model: e.model } : undefined);
          };
          req.onerror = () => reject(req.error);
        }),
    ),
  );
}

export async function cachePut(key: string, entry: CacheEntry): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ ...entry, at: Date.now() } satisfies Entry, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
