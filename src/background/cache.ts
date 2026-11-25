// Persistent translation cache in IndexedDB (the service worker's in-memory
// state is lost whenever Chrome suspends it, so a Map alone would be useless).
//
// Key: SHA-256(model, targetLang, source text). No eviction yet.

const DB_NAME = "llmt";
const STORE = "translations";

interface Entry {
  text: string;
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

export async function cacheKey(model: string, targetLang: string, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${model}\u0000${targetLang}\u0000${text}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function cacheGetMany(keys: readonly string[]): Promise<Array<string | undefined>> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const store = tx.objectStore(STORE);
  return Promise.all(
    keys.map(
      (k) =>
        new Promise<string | undefined>((resolve, reject) => {
          const req = store.get(k);
          req.onsuccess = () => resolve((req.result as Entry | undefined)?.text);
          req.onerror = () => reject(req.error);
        }),
    ),
  );
}

export async function cachePut(key: string, text: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ text, at: Date.now() } satisfies Entry, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
