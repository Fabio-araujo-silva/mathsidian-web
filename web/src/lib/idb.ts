// Cache local das fórmulas compiladas (IndexedDB). Chave = SHA-1 do texto da fórmula + preâmbulo,
// a mesma que o servidor usa: reabrir uma nota não faz nenhum pedido de LaTeX ao servidor.
// Leituras e gravações em lote (uma transação por lote), e tudo falha em silêncio: sem IndexedDB
// (aba anônima, cota cheia) o app só perde o cache.

const DB_NAME = "mathsidian";
const STORE = "svg";
const MAX_ENTRIES = 30000;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE);
        store.createIndex("t", "t");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

// Erro do TeX também é guardado: a mesma fórmula com o mesmo preâmbulo dá sempre o mesmo erro.
export type CachedSvg = { svg: string; width: number; height: number; depth: number; t?: number } | { error: string; t?: number };

export async function getMany(keys: string[]): Promise<(CachedSvg | undefined)[]> {
  const db = await open();
  if (!db || !keys.length) return keys.map(() => undefined);
  return new Promise((resolve) => {
    const out: (CachedSvg | undefined)[] = new Array(keys.length);
    try {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      keys.forEach((k, i) => {
        const r = store.get(k);
        r.onsuccess = () => (out[i] = r.result);
      });
      tx.oncomplete = () => resolve(out);
      tx.onerror = tx.onabort = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
}

let pendingPuts = new Map<string, CachedSvg>();
let putTimer: number | null = null;

// Grava em lote, fora do caminho crítico (a renderização não espera o disco).
export function putLater(key: string, value: CachedSvg) {
  pendingPuts.set(key, { ...value, t: Date.now() });
  if (putTimer == null) putTimer = window.setTimeout(flushPuts, 400);
}

async function flushPuts() {
  putTimer = null;
  const batch = pendingPuts;
  pendingPuts = new Map();
  const db = await open();
  if (!db || !batch.size) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    batch.forEach((v, k) => store.put(v, k));
  } catch {}
  maybePrune(db);
}

let pruneChecked = false;
// De vez em quando, apaga as entradas mais antigas se o cache passou do limite.
function maybePrune(db: IDBDatabase) {
  if (pruneChecked) return;
  pruneChecked = true;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const countReq = store.count();
    countReq.onsuccess = () => {
      let extra = countReq.result - MAX_ENTRIES;
      if (extra <= 0) return;
      const cursorReq = store.index("t").openCursor();
      cursorReq.onsuccess = () => {
        const c = cursorReq.result;
        if (!c || extra-- <= 0) return;
        c.delete();
        c.continue();
      };
    };
  } catch {}
}
