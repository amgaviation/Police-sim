/**
 * Minimal promise wrapper over IndexedDB. Every write resolves only after
 * its transaction has committed, so a resolved promise means durable data.
 */
import { log } from '../core/log';

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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Opens (and if needed creates/upgrades) a database. `upgrade` runs inside
 * the `versionchange` transaction when the stored version is older.
 *
 * The connection closes itself when another connection (a newer build in
 * another tab) asks for a higher version. `onClosed` is called then, and also
 * when the browser force-closes the connection (cleared site data, eviction),
 * so the owner can drop it and reopen later. A blocked open is only logged:
 * it resolves by itself once the older connections close.
 */
export function openDb(
  name: string,
  version: number,
  upgrade: UpgradeFn,
  factory: IDBFactory = indexedDB,
  onClosed?: () => void,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(name, version);
    } catch (error) {
      reject(toError(error));
      return;
    }
    request.onupgradeneeded = (event) => {
      upgrade(request.result, event.oldVersion);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        onClosed?.();
      };
      db.onclose = () => {
        onClosed?.();
      };
      resolve(db);
    };
    request.onerror = () => {
      reject(request.error ?? new Error(`Failed to open IndexedDB '${name}'`));
    };
    request.onblocked = () => {
      log.warn(`Opening IndexedDB '${name}' v${String(version)} is waiting for other tabs to close the database`);
    };
  });
}

/** Opens the application database with its standard object stores. */
export function openPatrolDb(factory: IDBFactory = indexedDB, onClosed?: () => void): Promise<IDBDatabase> {
  return openDb(DB_NAME, DB_VERSION, upgradePatrolDb, factory, onClosed);
}

function upgradePatrolDb(db: IDBDatabase): void {
  for (const store of Object.values(STORES)) {
    if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
  }
}

/**
 * The cause of a transaction `error` event. A failed request's error bubbles to
 * the transaction before it aborts, while `tx.error` is still null, so the
 * failing request (the event target) carries the real DOMException.
 */
function transactionError(tx: IDBTransaction, event: Event, store: StoreName): Error {
  const target = event.target as { error?: DOMException | null } | null;
  return tx.error ?? target?.error ?? new Error(`IndexedDB transaction on '${store}' failed`);
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
      reject(toError(error));
      return;
    }
    tx.oncomplete = () => {
      resolve(request.result);
    };
    tx.onerror = (event) => {
      reject(transactionError(tx, event, store));
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

/**
 * Read-modify-write of one key inside a single `readwrite` transaction, so
 * concurrent updates of the same key cannot interleave. `update` receives the
 * stored value (or `undefined`) and returns the value to store; the promise
 * resolves with it once the transaction commits. If `update` throws, the
 * transaction is aborted and nothing is written.
 */
export function dbUpdate<T>(db: IDBDatabase, store: StoreName, key: IDBValidKey, update: (previous: unknown) => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    let next: { value: T } | null = null;
    try {
      tx = db.transaction(store, 'readwrite');
      const objectStore = tx.objectStore(store);
      const get = objectStore.get(key);
      get.onsuccess = () => {
        try {
          next = { value: update(get.result) };
          objectStore.put(next.value, key);
        } catch (error) {
          reject(toError(error));
          tx.abort();
        }
      };
    } catch (error) {
      reject(toError(error));
      return;
    }
    tx.oncomplete = () => {
      if (next) resolve(next.value);
      else reject(new Error(`IndexedDB update in '${store}' wrote nothing`));
    };
    tx.onerror = (event) => {
      reject(transactionError(tx, event, store));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error(`IndexedDB transaction on '${store}' aborted`));
    };
  });
}

/** Every key with its value, read in one transaction (keys and values cannot drift apart). */
export function dbEntries<T>(db: IDBDatabase, store: StoreName): Promise<Array<{ key: IDBValidKey; value: T }>> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    let keys: IDBRequest<IDBValidKey[]>;
    let values: IDBRequest<unknown[]>;
    try {
      tx = db.transaction(store, 'readonly');
      const objectStore = tx.objectStore(store);
      keys = objectStore.getAllKeys();
      values = objectStore.getAll();
    } catch (error) {
      reject(toError(error));
      return;
    }
    tx.oncomplete = () => {
      resolve(keys.result.map((key, i) => ({ key, value: values.result[i] as T })));
    };
    tx.onerror = (event) => {
      reject(transactionError(tx, event, store));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error(`IndexedDB transaction on '${store}' aborted`));
    };
  });
}
