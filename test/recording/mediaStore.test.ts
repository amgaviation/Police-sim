import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IdbMediaStore,
  MEDIA_DB_NAME,
  MemoryMediaStore,
  RECORDING,
  createMediaStore,
  planPrune,
  snapshotKey,
  type MediaStore,
  type RetentionPolicy,
  type SnapshotMeta,
} from '../../src/recording';

type Put = Omit<SnapshotMeta, 'key' | 'bytes'>;

const put = (tag: string, incident: string, sim: number, source: 'body' | 'dash' = 'body'): Put => ({
  tag, incident, source, sim, game: 36000 + sim, w: 160, h: 90,
});
const blobOf = (n: number): Blob => new Blob([new Uint8Array(n).fill(7)]);
const big: RetentionPolicy = { maxCount: 1000, maxBytes: 1_000_000, perIncidentMax: 1000 };

const factories: Array<{ name: string; make: (perIncident?: number) => MediaStore }> = [
  { name: 'MemoryMediaStore', make: (n = 200) => new MemoryMediaStore(n) },
  { name: 'IdbMediaStore', make: (n = 200) => new IdbMediaStore(new IDBFactory(), n) },
];

describe.each(factories)('$name', ({ make }) => {
  it('puts with the documented key and byte size and gets the blob back', async () => {
    const s = make();
    const meta = await s.put(put('g1', 'C-00001', 12.345), blobOf(10));
    expect(meta.key).toBe('g1:C-00001:12.35:body'.replace('12.35', (12.345).toFixed(2)));
    expect(meta.key).toBe(snapshotKey('g1', 'C-00001', 12.345, 'body'));
    expect(meta.bytes).toBe(10);
    expect(meta).toMatchObject({ tag: 'g1', incident: 'C-00001', source: 'body', sim: 12.345, game: 36012.345, w: 160, h: 90 });
    const got = await s.get(meta.key);
    expect(got).not.toBeNull();
    expect(got?.size).toBe(10);
    expect(new Uint8Array(await (got as Blob).arrayBuffer())[0]).toBe(7);
  });

  it('get of a missing key is null', async () => {
    expect(await make().get('nope')).toBeNull();
  });

  it('lists one incident sorted by sim and filters by tag and incident', async () => {
    const s = make();
    await s.put(put('g1', 'C-1', 9), blobOf(1));
    await s.put(put('g1', 'C-1', 3), blobOf(1));
    await s.put(put('g1', 'C-1', 6), blobOf(1));
    await s.put(put('g1', 'C-2', 4), blobOf(1));
    await s.put(put('g2', 'C-1', 5), blobOf(1));
    expect((await s.list('g1', 'C-1')).map((m) => m.sim)).toEqual([3, 6, 9]);
    expect((await s.list('g1', 'C-2')).map((m) => m.sim)).toEqual([4]);
    expect((await s.list('g2', 'C-1')).map((m) => m.sim)).toEqual([5]);
    expect(await s.list('g1', 'C-9')).toEqual([]);
    expect(await s.list('g3', 'C-1')).toEqual([]);
  });

  it('lists body and dash frames of the same sim, body first', async () => {
    const s = make();
    await s.put(put('g', 'C-1', 3, 'dash'), blobOf(2));
    await s.put(put('g', 'C-1', 3, 'body'), blobOf(1));
    expect((await s.list('g', 'C-1')).map((m) => m.source)).toEqual(['body', 'dash']);
  });

  it('putting the same key replaces the snapshot', async () => {
    const s = make();
    await s.put(put('g', 'C-1', 3), blobOf(5));
    await s.put(put('g', 'C-1', 3), blobOf(9));
    const list = await s.list('g', 'C-1');
    expect(list).toHaveLength(1);
    expect(list[0]?.bytes).toBe(9);
    expect(await s.stats()).toEqual({ count: 1, bytes: 9 });
  });

  it('perIncidentMax evicts the incident\'s oldest on put and leaves other incidents alone', async () => {
    const s = make(3);
    await s.put(put('g', 'C-2', 1), blobOf(1));
    for (const sim of [1, 2, 3, 4, 5]) await s.put(put('g', 'C-1', sim), blobOf(1));
    expect((await s.list('g', 'C-1')).map((m) => m.sim)).toEqual([3, 4, 5]);
    expect((await s.list('g', 'C-2')).map((m) => m.sim)).toEqual([1]);
    expect(await s.get(snapshotKey('g', 'C-1', 1, 'body'))).toBeNull();
    // Out-of-order put: the oldest by sim goes (even though the new one is older still).
    await s.put(put('g', 'C-1', 2.5), blobOf(1));
    expect((await s.list('g', 'C-1')).map((m) => m.sim)).toEqual([2.5, 4, 5]);
  });

  it('perIncidentMax is per tag as well', async () => {
    const s = make(2);
    for (const sim of [1, 2]) {
      await s.put(put('a', 'C-1', sim), blobOf(1));
      await s.put(put('b', 'C-1', sim), blobOf(1));
    }
    expect((await s.stats()).count).toBe(4);
  });

  it('stats counts snapshots and bytes; clear empties the store', async () => {
    const s = make();
    expect(await s.stats()).toEqual({ count: 0, bytes: 0 });
    await s.put(put('g', 'C-1', 1), blobOf(100));
    await s.put(put('g', 'C-2', 1), blobOf(250));
    expect(await s.stats()).toEqual({ count: 2, bytes: 350 });
    await s.clear();
    expect(await s.stats()).toEqual({ count: 0, bytes: 0 });
    expect(await s.list('g', 'C-1')).toEqual([]);
  });

  it('prune with a keep set deletes the tag\'s other incidents and nothing else', async () => {
    const s = make();
    await s.put(put('g', 'C-1', 1), blobOf(1));
    await s.put(put('g', 'C-1', 2), blobOf(1));
    await s.put(put('g', 'C-2', 1), blobOf(1));
    await s.put(put('g', 'C-3', 1), blobOf(1));
    await s.put(put('other', 'C-1', 1), blobOf(1));
    const deleted = await s.prune(big, 'g', new Set(['C-1', 'C-3']));
    expect(deleted).toBe(1);
    expect((await s.list('g', 'C-2')).length).toBe(0);
    expect((await s.list('g', 'C-1')).length).toBe(2);
    expect((await s.list('g', 'C-3')).length).toBe(1);
    expect((await s.list('other', 'C-1')).length).toBe(1);
    // An empty keep set deletes every incident of the tag.
    expect(await s.prune(big, 'g', new Set())).toBe(3);
    expect(await s.stats()).toEqual({ count: 1, bytes: 1 });
  });

  it('dropAfter deletes the tag\'s snapshots newer than the sim time, in every incident, and nothing else', async () => {
    const s = make();
    await s.put(put('g', 'C-1', 5), blobOf(1));
    await s.put(put('g', 'C-1', 10), blobOf(1));
    await s.put(put('g', 'C-1', 12), blobOf(1));
    await s.put(put('g', 'C-2', 30, 'dash'), blobOf(1));
    await s.put(put('other', 'C-1', 30), blobOf(1));
    expect(await s.dropAfter('g', 10)).toBe(2);
    expect((await s.list('g', 'C-1')).map((m) => m.sim)).toEqual([5, 10]);
    expect(await s.list('g', 'C-2')).toEqual([]);
    expect((await s.list('other', 'C-1')).length).toBe(1);
    expect(await s.dropAfter('g', 10)).toBe(0);
  });

  it('prune without keep only applies the caps', async () => {
    const s = make();
    await s.put(put('g', 'C-1', 1), blobOf(1));
    await s.put(put('g', 'C-2', 1), blobOf(1));
    expect(await s.prune(big, 'g')).toBe(0);
    expect((await s.stats()).count).toBe(2);
  });

  it('prune deletes oldest-first down to maxCount', async () => {
    const s = make();
    for (const sim of [5, 1, 4, 2, 3]) await s.put(put('g', 'C-1', sim), blobOf(1));
    const deleted = await s.prune({ ...big, maxCount: 3 }, 'g');
    expect(deleted).toBe(2);
    expect((await s.list('g', 'C-1')).map((m) => m.sim)).toEqual([3, 4, 5]);
  });

  it('prune deletes oldest-first down to maxBytes across incidents', async () => {
    const s = make();
    await s.put(put('g', 'C-1', 1), blobOf(40));
    await s.put(put('g', 'C-2', 2), blobOf(40));
    await s.put(put('g', 'C-1', 3), blobOf(40));
    const deleted = await s.prune({ ...big, maxBytes: 90 }, 'g');
    expect(deleted).toBe(1);
    expect((await s.list('g', 'C-1')).map((m) => m.sim)).toEqual([3]);
    expect((await s.list('g', 'C-2')).map((m) => m.sim)).toEqual([2]);
    expect(await s.prune({ ...big, maxBytes: 0 }, 'g')).toBe(2);
    expect(await s.stats()).toEqual({ count: 0, bytes: 0 });
  });

  it('prune applies keep first and then the caps to what is left', async () => {
    const s = make();
    await s.put(put('g', 'C-1', 1), blobOf(10));
    await s.put(put('g', 'C-1', 2), blobOf(10));
    await s.put(put('g', 'C-1', 3), blobOf(10));
    await s.put(put('g', 'C-9', 0), blobOf(10));
    const deleted = await s.prune({ ...big, maxCount: 2 }, 'g', new Set(['C-1']));
    expect(deleted).toBe(2); // C-9 by keep, sim 1 by the cap
    expect((await s.list('g', 'C-1')).map((m) => m.sim)).toEqual([2, 3]);
  });

  it('prune evicts older games\' snapshots before the current tag\'s', async () => {
    const s = make();
    await s.put(put('old', 'C-1', 100), blobOf(1));
    await s.put(put('new', 'C-1', 1), blobOf(1));
    await s.put(put('new', 'C-1', 2), blobOf(1));
    expect(await s.prune({ ...big, maxCount: 2 }, 'new', new Set(['C-1']))).toBe(1);
    expect((await s.list('old', 'C-1')).length).toBe(0);
    expect((await s.list('new', 'C-1')).length).toBe(2);
  });
});

describe('planPrune', () => {
  const m = (tag: string, incident: string, sim: number, bytes: number): SnapshotMeta => ({
    key: `${tag}:${incident}:${String(sim)}`, tag, incident, source: 'body', sim, game: sim, bytes, w: 160, h: 90,
  });

  it('plans nothing within the caps and orders drops: keep first, then oldest', () => {
    const metas = [m('g', 'A', 5, 10), m('g', 'B', 1, 10), m('g', 'A', 2, 10)];
    expect(planPrune(metas, big, 'g')).toEqual([]);
    expect(planPrune(metas, { ...big, maxCount: 2 }, 'g')).toEqual(['g:B:1']);
    expect(planPrune(metas, { ...big, maxCount: 2 }, 'g', new Set(['A']))).toEqual(['g:B:1']);
    expect(planPrune(metas, { ...big, maxCount: 1 }, 'g', new Set(['A']))).toEqual(['g:B:1', 'g:A:2']);
  });

  it('honours both caps at once', () => {
    const metas = [m('g', 'A', 1, 60), m('g', 'A', 2, 60), m('g', 'A', 3, 60)];
    expect(planPrune(metas, { maxCount: 10, maxBytes: 100, perIncidentMax: 10 }, 'g')).toEqual(['g:A:1', 'g:A:2']);
    expect(planPrune(metas, { maxCount: 1, maxBytes: 1000, perIncidentMax: 10 }, 'g')).toEqual(['g:A:1', 'g:A:2']);
  });
});

describe('IdbMediaStore specifics', () => {
  it('creates database patrol-media v1 with the snapshots store and its indexes', async () => {
    const factory = new IDBFactory();
    const s = new IdbMediaStore(factory);
    await s.put(put('g', 'C-1', 1), blobOf(3));
    s.close();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = factory.open(MEDIA_DB_NAME);
      r.onsuccess = () => {
        resolve(r.result);
      };
      r.onerror = () => {
        reject(r.error ?? new Error('open failed'));
      };
    });
    expect(db.version).toBe(1);
    const store = db.transaction('snapshots', 'readonly').objectStore('snapshots');
    expect(store.keyPath).toBe('key');
    expect(Array.from(store.indexNames).sort()).toEqual(['incident', 'sim']);
    expect(store.index('incident').keyPath).toEqual(['tag', 'incident']);
    expect(store.index('sim').keyPath).toBe('sim');
    db.close();
  });

  it('persists across store instances on the same factory', async () => {
    const factory = new IDBFactory();
    const a = new IdbMediaStore(factory);
    await a.put(put('g', 'C-1', 1), blobOf(4));
    a.close();
    const b = new IdbMediaStore(factory);
    expect((await b.list('g', 'C-1')).map((x) => x.bytes)).toEqual([4]);
    expect((await b.get(snapshotKey('g', 'C-1', 1, 'body')))?.size).toBe(4);
    b.close();
  });

  it('rejects when IndexedDB is unavailable', async () => {
    const g = globalThis as { indexedDB?: unknown };
    const saved = g.indexedDB;
    delete g.indexedDB;
    try {
      await expect(new IdbMediaStore().ready()).rejects.toThrow(/not available/);
    } finally {
      g.indexedDB = saved;
    }
  });
});

describe('createMediaStore', () => {
  const g = globalThis as { indexedDB?: unknown };
  const saved = g.indexedDB;
  afterEach(() => {
    g.indexedDB = saved;
    vi.restoreAllMocks();
  });

  it('uses IndexedDB when it exists', async () => {
    const s = createMediaStore();
    await s.put(put('created', 'C-1', 1), blobOf(2));
    expect((await s.list('created', 'C-1')).length).toBe(1);
    await s.clear();
  });

  it('falls back to memory without indexedDB', async () => {
    delete g.indexedDB;
    const s = createMediaStore();
    expect(s).toBeInstanceOf(MemoryMediaStore);
    await s.put(put('g', 'C-1', 1), blobOf(2));
    expect((await s.stats()).count).toBe(1);
  });

  it('falls back to memory (and logs) when opening fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    g.indexedDB = {
      open: () => {
        throw new Error('blocked by policy');
      },
    };
    const s = createMediaStore(2);
    await s.put(put('g', 'C-1', 1), blobOf(2));
    await s.put(put('g', 'C-1', 2), blobOf(2));
    await s.put(put('g', 'C-1', 3), blobOf(2));
    expect((await s.list('g', 'C-1')).map((m) => m.sim)).toEqual([2, 3]);
    expect(await s.get(snapshotKey('g', 'C-1', 3, 'body'))).not.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('defaults the per-incident cap to the configured one', async () => {
    const s = new MemoryMediaStore();
    for (let i = 0; i < RECORDING.perIncidentMax + 5; i++) await s.put(put('g', 'C-1', i), blobOf(1));
    expect((await s.list('g', 'C-1')).length).toBe(RECORDING.perIncidentMax);
  });
});
