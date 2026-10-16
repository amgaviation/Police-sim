/**
 * Minimal promise wrapper over IndexedDB. Every write resolves only after
 * its transaction has committed, so a resolved promise means durable data.
 */

export const DB_NAME = 'patrol';
export const DB_VERSION = 1;

export const STORES = {
  saves: 'saves',
  settings: 'settings',
  meta: 'meta',
} as const;
export type StoreName = (typeof STORES)[keyof typeof STORES];

/** Key under which the single settings blob lives in the `settings` store. */
export const SETTINGS_KEY = 'settings';

export type UpgradeFn = (db: IDBDatabase, oldVersion: number) => void;

/** Resolves with the request result, or rejects with its `DOMException`. */
export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

/**
 * Opens (and if needed creates/upgrades) a database. `upgrade` runs inside
 * the `versionchange` transaction when the stored version is older.
 */
export function openDb(
  name: string,
  version: number,
  upgrade: UpgradeFn,
  factory: IDBFactory = indexedDB,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, version);
    request.onupgradeneeded = (event) => {
      upgrade(request.result, event.oldVersion);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error(`Failed to open IndexedDB '${name}'`));
    };
    request.onblocked = () => {
      reject(new Error(`Opening IndexedDB '${name}' is blocked by another connection`));
    };
  });
}

/** Opens the application database with its standard object stores. */
export function openPatrolDb(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return openDb(DB_NAME, DB_VERSION, upgradePatrolDb, factory);
}

function upgradePatrolDb(db: IDBDatabase): void {
  for (const store of Object.values(STORES)) {
    if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
  }
}

/** Runs `op` against `store` and resolves with its result once the transaction commits. */
function withStore<T>(
  db: IDBDatabase,
  store: StoreName,
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    let request: IDBRequest<T>;
    try {
      tx = db.transaction(store, mode);
      request = op(tx.objectStore(store));
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    tx.oncomplete = () => {
      resolve(request.result);
    };
    tx.onerror = () => {
      reject(tx.error ?? request.error ?? new Error(`IndexedDB transaction on '${store}' failed`));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error(`IndexedDB transaction on '${store}' aborted`));
    };
  });
}

export function dbGet<T>(db: IDBDatabase, store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return withStore(db, store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}

export function dbPut(db: IDBDatabase, store: StoreName, key: IDBValidKey, value: unknown): Promise<IDBValidKey> {
  return withStore(db, store, 'readwrite', (s) => s.put(value, key));
}

export function dbDelete(db: IDBDatabase, store: StoreName, key: IDBValidKey): Promise<void> {
  return withStore(db, store, 'readwrite', (s) => s.delete(key));
}

export function dbGetAll<T>(db: IDBDatabase, store: StoreName): Promise<T[]> {
  return withStore(db, store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

export function dbKeys(db: IDBDatabase, store: StoreName): Promise<IDBValidKey[]> {
  return withStore(db, store, 'readonly', (s) => s.getAllKeys());
}
