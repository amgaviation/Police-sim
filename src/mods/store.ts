/**
 * Installed mods (design §10.4): IndexedDB database 'patrol-mods' (store 'mods', keyed by mod id) and the enabled load
 * order in localStorage 'patrol-mods-enabled'. Storage can be missing or blocked (private windows), so every
 * localStorage access is wrapped; a broken order reads as empty.
 */
import { openDb, requestToPromise } from '../save/db';
import type { ModBundle, ModRef } from './types';

export const MODS_DB_NAME = 'patrol-mods';
export const MODS_DB_VERSION = 1;
export const MODS_STORE = 'mods';
export const ENABLED_KEY = 'patrol-mods-enabled';

export interface StoredMod {
  id: string;
  bundle: ModBundle;
  ref: ModRef;
  /** Bytes of the installed file(s). */
  size: number;
  /** Wall-clock install time (ms since epoch; UI only, never read by the simulation). */
  installedAt: number;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function upgrade(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(MODS_STORE)) db.createObjectStore(MODS_STORE, { keyPath: 'id' });
}

function isStoredMod(x: unknown): x is StoredMod {
  if (typeof x !== 'object' || x === null) return false;
  const m = x as Partial<StoredMod>;
  return typeof m.id === 'string' && typeof m.bundle === 'object' && m.bundle !== null && typeof m.ref === 'object' && m.ref !== null;
}

export class ModStore {
  private readonly factory: IDBFactory | undefined;
  private readonly storage: StorageLike | null;
  private db: Promise<IDBDatabase> | null = null;

  /** `factory` defaults to the browser's `indexedDB`; `storage` to `localStorage` (null = no persistence of the order). */
  constructor(factory?: IDBFactory, storage?: StorageLike | null) {
    this.factory = factory;
    this.storage = storage === undefined ? browserStorage() : storage;
  }

  private open(): Promise<IDBDatabase> {
    if (this.db === null) {
      const p = openDb(MODS_DB_NAME, MODS_DB_VERSION, upgrade, this.factory, () => {
        this.db = null;
      });
      p.catch(() => {
        this.db = null;
      });
      this.db = p;
    }
    return this.db;
  }

  private async run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    const tx = db.transaction(MODS_STORE, mode);
    const result = requestToPromise(op(tx.objectStore(MODS_STORE)));
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('IndexedDB transaction failed'));
      };
      tx.onabort = () => {
        reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      };
    });
    const value = await result;
    await done;
    return value;
  }

  /** Every installed mod (entries that are not mods are skipped), sorted by id. */
  async list(): Promise<StoredMod[]> {
    const all = await this.run('readonly', (s) => s.getAll() as IDBRequest<unknown[]>);
    return all.filter(isStoredMod).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async get(id: string): Promise<StoredMod | null> {
    const v = await this.run('readonly', (s) => s.get(id) as IDBRequest<unknown>);
    return isStoredMod(v) ? v : null;
  }

  async put(m: StoredMod): Promise<void> {
    await this.run('readwrite', (s) => s.put(m));
  }

  async remove(id: string): Promise<void> {
    await this.run('readwrite', (s) => s.delete(id));
  }

  /** Enabled mod ids in load order; [] when unset, unreadable or not a list of strings. */
  enabled(): string[] {
    try {
      const raw = this.storage?.getItem(ENABLED_KEY);
      if (raw === null || raw === undefined) return [];
      const v: unknown = JSON.parse(raw);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  setEnabled(ids: readonly string[]): void {
    try {
      this.storage?.setItem(ENABLED_KEY, JSON.stringify([...new Set(ids)]));
    } catch {
      // storage full or blocked: the order is not remembered
    }
  }

  /** Closes the database connection (it reopens on the next call). */
  close(): void {
    const p = this.db;
    this.db = null;
    p?.then((db) => {
      db.close();
    }).catch(() => undefined);
  }
}
