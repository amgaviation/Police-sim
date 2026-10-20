/**
 * Snapshot media store (design phase 5 §8.2). Bodycam / dashcam frames are small JPEG blobs keyed by
 * `tag:incident:sim:source`. `tag` namespaces one game (a new game never mixes with an old save's frames); `incident`
 * is the incident log key. `MemoryMediaStore` is the Map-based twin used headless and as the fallback;
 * `IdbMediaStore` persists to IndexedDB database `patrol-media`. Presentation only: nothing here feeds the simulation.
 */
import { log } from '../core/log';
import { openDb, requestToPromise } from '../save/db';
import { RECORDING } from './data';

export interface SnapshotMeta {
  key: string;
  tag: string;
  incident: string;
  source: 'body' | 'dash';
  sim: number;
  game: number;
  bytes: number;
  w: number;
  h: number;
}

export interface RetentionPolicy {
  maxCount: number;
  maxBytes: number;
  perIncidentMax: number;
}

export interface MediaStore {
  /** Stores a snapshot (replacing one with the same key); `key` = `${tag}:${incident}:${sim.toFixed(2)}:${source}`, `bytes` = `blob.size`. */
  put(meta: Omit<SnapshotMeta, 'key' | 'bytes'>, blob: Blob): Promise<SnapshotMeta>;
  /** Snapshots of one incident sorted by sim. */
  list(tag: string, incident: string): Promise<SnapshotMeta[]>;
  get(key: string): Promise<Blob | null>;
  /** Deletes incidents of `tag` not in `keep` (when given), then oldest-first until within the caps; returns the deleted count. */
  prune(policy: RetentionPolicy, tag: string, keep?: ReadonlySet<string>): Promise<number>;
  /** Deletes the snapshots of `tag` taken after sim time `sim` (a loaded save discards the timeline it left); returns the deleted count. */
  dropAfter(tag: string, sim: number): Promise<number>;
  stats(): Promise<{ count: number; bytes: number }>;
  clear(): Promise<void>;
}

/** Key of a snapshot. */
export function snapshotKey(tag: string, incident: string, sim: number, source: 'body' | 'dash'): string {
  return `${tag}:${incident}:${sim.toFixed(2)}:${source}`;
}

function byTime(a: SnapshotMeta, b: SnapshotMeta): number {
  return a.sim - b.sim || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/**
 * Keys `prune` deletes from `metas`: every snapshot of `tag` whose incident is not in `keep` (when given), then, while
 * the rest exceeds `maxCount` or `maxBytes`, the oldest by sim, snapshots of other tags (older games) before those of `tag`.
 */
export function planPrune(
  metas: readonly SnapshotMeta[],
  policy: RetentionPolicy,
  tag: string,
  keep?: ReadonlySet<string>,
): string[] {
  const drop: string[] = [];
  const rest: SnapshotMeta[] = [];
  let bytes = 0;
  for (const m of metas) {
    if (keep !== undefined && m.tag === tag && !keep.has(m.incident)) {
      drop.push(m.key);
    } else {
      rest.push(m);
      bytes += m.bytes;
    }
  }
  let count = rest.length;
  if (count <= policy.maxCount && bytes <= policy.maxBytes) return drop;
  rest.sort((a, b) => (a.tag === tag ? 1 : 0) - (b.tag === tag ? 1 : 0) || byTime(a, b));
  for (const m of rest) {
    if (count <= policy.maxCount && bytes <= policy.maxBytes) break;
    drop.push(m.key);
    count--;
    bytes -= m.bytes;
  }
  return drop;
}

/** Keys to delete from `others` (the incident's snapshots except the one being written) so that one more fits. */
function evictForPut(others: SnapshotMeta[], perIncidentMax: number): string[] {
  const excess = others.length - (Math.max(1, perIncidentMax) - 1);
  if (excess <= 0) return [];
  others.sort(byTime);
  return others.slice(0, excess).map((m) => m.key);
}

function metaOf(meta: Omit<SnapshotMeta, 'key' | 'bytes'>, blob: Blob): SnapshotMeta {
  return { ...meta, key: snapshotKey(meta.tag, meta.incident, meta.sim, meta.source), bytes: blob.size };
}

interface Row {
  meta: SnapshotMeta;
  blob: Blob;
}

/** In-memory store (headless, tests, fallback). */
export class MemoryMediaStore implements MediaStore {
  private readonly rows = new Map<string, Row>();
  private readonly perIncidentMax: number;

  constructor(perIncidentMax: number = RECORDING.perIncidentMax) {
    this.perIncidentMax = perIncidentMax;
  }

  put(meta: Omit<SnapshotMeta, 'key' | 'bytes'>, blob: Blob): Promise<SnapshotMeta> {
    const full = metaOf(meta, blob);
    const others: SnapshotMeta[] = [];
    for (const r of this.rows.values()) {
      if (r.meta.tag === full.tag && r.meta.incident === full.incident && r.meta.key !== full.key) others.push(r.meta);
    }
    for (const k of evictForPut(others, this.perIncidentMax)) this.rows.delete(k);
    this.rows.set(full.key, { meta: full, blob });
    return Promise.resolve({ ...full });
  }

  list(tag: string, incident: string): Promise<SnapshotMeta[]> {
    const out: SnapshotMeta[] = [];
    for (const r of this.rows.values()) if (r.meta.tag === tag && r.meta.incident === incident) out.push({ ...r.meta });
    return Promise.resolve(out.sort(byTime));
  }

  get(key: string): Promise<Blob | null> {
    return Promise.resolve(this.rows.get(key)?.blob ?? null);
  }

  prune(policy: RetentionPolicy, tag: string, keep?: ReadonlySet<string>): Promise<number> {
    const metas: SnapshotMeta[] = [];
    for (const r of this.rows.values()) metas.push(r.meta);
    const drop = planPrune(metas, policy, tag, keep);
    for (const k of drop) this.rows.delete(k);
    return Promise.resolve(drop.length);
  }

  dropAfter(tag: string, sim: number): Promise<number> {
    let n = 0;
    for (const [k, r] of [...this.rows]) {
      if (r.meta.tag !== tag || r.meta.sim <= sim) continue;
      this.rows.delete(k);
      n++;
    }
    return Promise.resolve(n);
  }

  stats(): Promise<{ count: number; bytes: number }> {
    let bytes = 0;
    for (const r of this.rows.values()) bytes += r.meta.bytes;
    return Promise.resolve({ count: this.rows.size, bytes });
  }

  clear(): Promise<void> {
    this.rows.clear();
    return Promise.resolve();
  }
}

export const MEDIA_DB_NAME = 'patrol-media';
export const MEDIA_DB_VERSION = 1;
export const MEDIA_STORE_NAME = 'snapshots';

type IdbRow = SnapshotMeta & { blob: Blob };

function toMeta(row: IdbRow): SnapshotMeta {
  const { blob: _blob, ...meta } = row;
  return meta;
}

function upgradeMediaDb(db: IDBDatabase): void {
  if (db.objectStoreNames.contains(MEDIA_STORE_NAME)) return;
  const store = db.createObjectStore(MEDIA_STORE_NAME, { keyPath: 'key' });
  store.createIndex('incident', ['tag', 'incident']);
  store.createIndex('sim', 'sim');
}

/** Resolves when the transaction commits, rejects when it fails or aborts. */
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
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
}

/** IndexedDB store: database `patrol-media` v1, object store `snapshots` (keyPath `key`, indexes `incident` = [tag, incident] and `sim`). Values are `{ ...meta, blob }`. */
export class IdbMediaStore implements MediaStore {
  private readonly factory: IDBFactory | undefined;
  private readonly perIncidentMax: number;
  private dbp: Promise<IDBDatabase> | null = null;

  constructor(factory?: IDBFactory, perIncidentMax: number = RECORDING.perIncidentMax) {
    this.factory = factory;
    this.perIncidentMax = perIncidentMax;
  }

  /** Opens the database (once); rejects when IndexedDB is unavailable or opening fails. */
  ready(): Promise<void> {
    return this.db().then(() => undefined);
  }

  /** Closes the connection; the next call reopens it. */
  close(): void {
    const p = this.dbp;
    this.dbp = null;
    void p?.then((db) => {
      db.close();
    }, () => undefined);
  }

  async put(meta: Omit<SnapshotMeta, 'key' | 'bytes'>, blob: Blob): Promise<SnapshotMeta> {
    const full = metaOf(meta, blob);
    const db = await this.db();
    const tx = db.transaction(MEDIA_STORE_NAME, 'readwrite');
    const done = transactionDone(tx);
    done.catch(() => undefined);
    const store = tx.objectStore(MEDIA_STORE_NAME);
    const rows = await requestToPromise(store.index('incident').getAll(IDBKeyRange.only([full.tag, full.incident])) as IDBRequest<IdbRow[]>);
    const others = rows.filter((r) => r.key !== full.key).map(toMeta);
    for (const k of evictForPut(others, this.perIncidentMax)) store.delete(k);
    const row: IdbRow = { ...full, blob };
    store.put(row);
    await done;
    return full;
  }

  async list(tag: string, incident: string): Promise<SnapshotMeta[]> {
    const db = await this.db();
    const store = db.transaction(MEDIA_STORE_NAME, 'readonly').objectStore(MEDIA_STORE_NAME);
    const rows = await requestToPromise(store.index('incident').getAll(IDBKeyRange.only([tag, incident])) as IDBRequest<IdbRow[]>);
    return rows.map(toMeta).sort(byTime);
  }

  async get(key: string): Promise<Blob | null> {
    const db = await this.db();
    const store = db.transaction(MEDIA_STORE_NAME, 'readonly').objectStore(MEDIA_STORE_NAME);
    const row = await requestToPromise(store.get(key) as IDBRequest<IdbRow | undefined>);
    return row?.blob ?? null;
  }

  async prune(policy: RetentionPolicy, tag: string, keep?: ReadonlySet<string>): Promise<number> {
    const db = await this.db();
    const tx = db.transaction(MEDIA_STORE_NAME, 'readwrite');
    const done = transactionDone(tx);
    done.catch(() => undefined);
    const store = tx.objectStore(MEDIA_STORE_NAME);
    const rows = await requestToPromise(store.getAll() as IDBRequest<IdbRow[]>);
    const drop = planPrune(rows.map(toMeta), policy, tag, keep);
    for (const k of drop) store.delete(k);
    await done;
    return drop.length;
  }

  async dropAfter(tag: string, sim: number): Promise<number> {
    const db = await this.db();
    const tx = db.transaction(MEDIA_STORE_NAME, 'readwrite');
    const done = transactionDone(tx);
    done.catch(() => undefined);
    const store = tx.objectStore(MEDIA_STORE_NAME);
    const rows = await requestToPromise(store.index('sim').getAll(IDBKeyRange.lowerBound(sim, true)) as IDBRequest<IdbRow[]>);
    let n = 0;
    for (const r of rows) {
      if (r.tag !== tag) continue;
      store.delete(r.key);
      n++;
    }
    await done;
    return n;
  }

  async stats(): Promise<{ count: number; bytes: number }> {
    const db = await this.db();
    const store = db.transaction(MEDIA_STORE_NAME, 'readonly').objectStore(MEDIA_STORE_NAME);
    const rows = await requestToPromise(store.getAll() as IDBRequest<IdbRow[]>);
    let bytes = 0;
    for (const r of rows) bytes += r.bytes;
    return { count: rows.length, bytes };
  }

  async clear(): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(MEDIA_STORE_NAME, 'readwrite');
    const done = transactionDone(tx);
    done.catch(() => undefined);
    tx.objectStore(MEDIA_STORE_NAME).clear();
    await done;
  }

  private db(): Promise<IDBDatabase> {
    if (this.dbp) return this.dbp;
    const factory = this.factory ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
    if (!factory) return Promise.reject(new Error('IndexedDB is not available'));
    const p = openDb(MEDIA_DB_NAME, MEDIA_DB_VERSION, upgradeMediaDb, factory, () => {
      if (this.dbp === p) this.dbp = null;
    });
    this.dbp = p;
    p.catch(() => {
      if (this.dbp === p) this.dbp = null;
    });
    return p;
  }
}

/** IndexedDB when it opens, otherwise (after one logged warning) the in-memory store. */
class FallbackMediaStore implements MediaStore {
  private target: Promise<MediaStore> | null = null;
  private readonly idb: IdbMediaStore;
  private readonly perIncidentMax: number;

  constructor(perIncidentMax: number) {
    this.perIncidentMax = perIncidentMax;
    this.idb = new IdbMediaStore(undefined, perIncidentMax);
  }

  put(meta: Omit<SnapshotMeta, 'key' | 'bytes'>, blob: Blob): Promise<SnapshotMeta> {
    return this.store().then((s) => s.put(meta, blob));
  }

  list(tag: string, incident: string): Promise<SnapshotMeta[]> {
    return this.store().then((s) => s.list(tag, incident));
  }

  get(key: string): Promise<Blob | null> {
    return this.store().then((s) => s.get(key));
  }

  prune(policy: RetentionPolicy, tag: string, keep?: ReadonlySet<string>): Promise<number> {
    return this.store().then((s) => s.prune(policy, tag, keep));
  }

  dropAfter(tag: string, sim: number): Promise<number> {
    return this.store().then((s) => s.dropAfter(tag, sim));
  }

  stats(): Promise<{ count: number; bytes: number }> {
    return this.store().then((s) => s.stats());
  }

  clear(): Promise<void> {
    return this.store().then((s) => s.clear());
  }

  private store(): Promise<MediaStore> {
    this.target ??= this.idb.ready().then(
      (): MediaStore => this.idb,
      (error: unknown): MediaStore => {
        log.warn('Snapshot media store: IndexedDB unavailable, keeping snapshots in memory', error);
        return new MemoryMediaStore(this.perIncidentMax);
      },
    );
    return this.target;
  }
}

/** The store the app uses: IndexedDB when `indexedDB` exists and opens, else memory (open failures are logged). */
export function createMediaStore(perIncidentMax: number = RECORDING.perIncidentMax): MediaStore {
  if (typeof indexedDB === 'undefined') return new MemoryMediaStore(perIncidentMax);
  return new FallbackMediaStore(perIncidentMax);
}
