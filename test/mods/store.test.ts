import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { ENABLED_KEY, ModStore, MODS_DB_NAME, type StoredMod } from '../../src/mods/store';
import { modRef } from '../../src/mods/combine';
import { bundle } from './helpers';

class FakeStorage {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function stored(id: string): StoredMod {
  const b = bundle(id, { districts: { harbor: { label: id } } });
  return { id, bundle: b, ref: modRef(b), size: 100, installedAt: 1 };
}

describe('ModStore: IndexedDB', () => {
  it('puts, gets, lists (sorted by id) and removes mods', async () => {
    const store = new ModStore(new IDBFactory(), new FakeStorage());
    expect(await store.list()).toEqual([]);
    await store.put(stored('mod-b'));
    await store.put(stored('mod-a'));
    expect((await store.list()).map((m) => m.id)).toEqual(['mod-a', 'mod-b']);
    expect(await store.get('mod-a')).toEqual(stored('mod-a'));
    expect(await store.get('ghost')).toBeNull();
    await store.remove('mod-a');
    expect((await store.list()).map((m) => m.id)).toEqual(['mod-b']);
    await store.remove('ghost');
    store.close();
  });

  it('replaces a mod with the same id and survives a reopen', async () => {
    const factory = new IDBFactory();
    const one = new ModStore(factory, null);
    await one.put(stored('mod-a'));
    await one.put({ ...stored('mod-a'), size: 5 });
    one.close();
    const two = new ModStore(factory, null);
    const list = await two.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.size).toBe(5);
    two.close();
  });

  it('uses the database name "patrol-mods"', async () => {
    const factory = new IDBFactory();
    const store = new ModStore(factory, null);
    await store.put(stored('mod-a'));
    expect((await factory.databases()).map((d) => d.name)).toEqual([MODS_DB_NAME]);
    expect(MODS_DB_NAME).toBe('patrol-mods');
    store.close();
  });

  it('skips records that are not mods', async () => {
    const factory = new IDBFactory();
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(MODS_DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('mods', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('open failed'));
    });
    await new Promise<void>((resolve) => {
      const tx = raw.transaction('mods', 'readwrite');
      tx.objectStore('mods').put({ id: 'junk' });
      tx.oncomplete = () => resolve();
    });
    raw.close();
    const store = new ModStore(factory, null);
    await store.put(stored('mod-a'));
    expect((await store.list()).map((m) => m.id)).toEqual(['mod-a']);
    expect(await store.get('junk')).toBeNull();
    store.close();
  });

  it('rejects when IndexedDB cannot be opened', async () => {
    const broken = { open: () => { throw new Error('blocked'); } } as unknown as IDBFactory;
    const store = new ModStore(broken, null);
    await expect(store.list()).rejects.toThrow('blocked');
  });
});

describe('ModStore: enabled order', () => {
  it('round-trips through the storage key and drops duplicates', () => {
    const storage = new FakeStorage();
    const store = new ModStore(new IDBFactory(), storage);
    expect(store.enabled()).toEqual([]);
    store.setEnabled(['b', 'a', 'b']);
    expect(storage.getItem(ENABLED_KEY)).toBe('["b","a"]');
    expect(store.enabled()).toEqual(['b', 'a']);
    expect(ENABLED_KEY).toBe('patrol-mods-enabled');
  });

  it('reads an unusable value as empty', () => {
    const storage = new FakeStorage();
    const store = new ModStore(new IDBFactory(), storage);
    storage.setItem(ENABLED_KEY, 'not json');
    expect(store.enabled()).toEqual([]);
    storage.setItem(ENABLED_KEY, '{"a":1}');
    expect(store.enabled()).toEqual([]);
    storage.setItem(ENABLED_KEY, '["a",3,null,"b"]');
    expect(store.enabled()).toEqual(['a', 'b']);
  });

  it('never throws when the storage does', () => {
    const boom = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('full'); },
    };
    const store = new ModStore(new IDBFactory(), boom);
    expect(store.enabled()).toEqual([]);
    expect(() => store.setEnabled(['a'])).not.toThrow();
  });

  it('works without any storage', () => {
    const store = new ModStore(new IDBFactory(), null);
    expect(store.enabled()).toEqual([]);
    expect(() => store.setEnabled(['a'])).not.toThrow();
  });
});
