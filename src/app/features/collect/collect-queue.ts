/**
 * Field Collection offline queue — submissions made without a connection
 * are kept in IndexedDB (photos included) until they can be synced.
 */

export interface QueuedSubmission {
  id: string;
  layerId: string;
  layerName: string;
  geometry: Record<string, unknown>;
  properties: Record<string, string>;
  photo: Blob | null;
  photoName: string | null;
  createdAt: string;
}

const DB_NAME = 'gis-field-collection';
const STORE = 'queue';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = body(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export const collectQueue = {
  add: (item: QueuedSubmission) => run('readwrite', (s) => s.put(item)),
  remove: (id: string) => run('readwrite', (s) => s.delete(id)),
  list: async () =>
    ((await run('readonly', (s) => s.getAll())) as QueuedSubmission[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
};
