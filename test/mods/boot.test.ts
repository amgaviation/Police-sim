import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAFE_MODE_KEY, bootMods, enterSafeMode, isSafeMode, leaveSafeMode } from '../../src/mods/boot';
import { modRef } from '../../src/mods/combine';
import { activeModRefs, districtLabel, emptyOverlay, modOverlay, setActiveOverlay } from '../../src/mods/registry';
import { ModStore, type StoredMod } from '../../src/mods/store';
import type { ModBundle } from '../../src/mods/types';
import { bundle } from './helpers';

class FakeStorage {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  vi.stubGlobal('localStorage', storage);
  setActiveOverlay(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setActiveOverlay(null);
});

function stored(b: ModBundle): StoredMod {
  return { id: b.id, bundle: b, ref: modRef(b), size: 10, installedAt: 0 };
}

async function storeWith(mods: ModBundle[], enabled: string[]): Promise<ModStore> {
  const store = new ModStore(new IDBFactory(), storage);
  for (const m of mods) await store.put(stored(m));
  store.setEnabled(enabled);
  return store;
}

describe('registry', () => {
  it('starts empty and resets with null', () => {
    expect(modOverlay()).toEqual(emptyOverlay());
    expect(activeModRefs()).toEqual([]);
    expect(districtLabel('harbor')).toBe('harbor');
    const o = emptyOverlay();
    o.districts.harbor = { label: 'Harbor Row' };
    o.refs.push({ id: 'a-mod', modVersion: '1.0.0', hash: '00000000' });
    setActiveOverlay(o);
    expect(modOverlay()).toBe(o);
    expect(districtLabel('harbor')).toBe('Harbor Row');
    expect(districtLabel('downtown')).toBe('downtown');
    expect(activeModRefs()).toHaveLength(1);
    setActiveOverlay(null);
    expect(modOverlay()).toEqual(emptyOverlay());
  });

  it('does not treat inherited names as districts', () => {
    expect(districtLabel('constructor')).toBe('constructor');
  });
});

describe('bootMods', () => {
  const a = bundle('mod-a', { districts: { harbor: { label: 'Alpha' } } });
  const b = bundle('mod-b', { districts: { harbor: { label: 'Beta' } } });

  it('sets the overlay from the enabled mods in order', async () => {
    const store = await storeWith([a, b], ['mod-b', 'mod-a']);
    const r = await bootMods({ store });
    expect(r).toEqual({ active: [modRef(b), modRef(a)], errors: [], safeMode: false });
    expect(districtLabel('harbor')).toBe('Alpha');
    expect(activeModRefs().map((x) => x.id)).toEqual(['mod-b', 'mod-a']);
  });

  it('applies nothing when nothing is enabled', async () => {
    const store = await storeWith([a], []);
    expect(await bootMods({ store })).toEqual({ active: [], errors: [], safeMode: false });
    expect(modOverlay()).toEqual(emptyOverlay());
  });

  it('skips on request (?nomods) and clears an earlier overlay', async () => {
    const store = await storeWith([a], ['mod-a']);
    await bootMods({ store });
    expect(districtLabel('harbor')).toBe('Alpha');
    const r = await bootMods({ store, skip: true });
    expect(r).toEqual({ active: [], errors: [], safeMode: false });
    expect(districtLabel('harbor')).toBe('harbor');
  });

  it('honours the safe-mode flag and reports it', async () => {
    const store = await storeWith([a], ['mod-a']);
    enterSafeMode();
    expect(storage.getItem(SAFE_MODE_KEY)).toBe('1');
    expect(isSafeMode()).toBe(true);
    expect(await bootMods({ store })).toEqual({ active: [], errors: [], safeMode: true });
    expect(modOverlay()).toEqual(emptyOverlay());
    leaveSafeMode();
    expect(isSafeMode()).toBe(false);
    expect((await bootMods({ store })).active).toHaveLength(1);
  });

  it('reports mods excluded by a content id clash and loads the rest', async () => {
    const x = bundle('mod-x', { statutes: [{ id: 'TR-900' }] });
    const y = bundle('mod-y', { statutes: [{ id: 'TR-900' }], districts: { harbor: { label: 'Y' } } });
    const store = await storeWith([x, y], ['mod-x', 'mod-y']);
    const r = await bootMods({ store });
    expect(r.active.map((m) => m.id)).toEqual(['mod-x']);
    expect(r.errors).toEqual(['mod-y: statutes[0].id: "TR-900" is already defined by mod "mod-x"; "mod-y" was not loaded']);
    expect(districtLabel('harbor')).toBe('harbor');
  });

  it('ignores enabled ids that are not installed', async () => {
    const store = await storeWith([a], ['ghost', 'mod-a']);
    expect((await bootMods({ store })).active.map((m) => m.id)).toEqual(['mod-a']);
  });

  it('ignores a store that cannot be read', async () => {
    const broken = { enabled: () => ['mod-a'], list: () => Promise.reject(new Error('disk gone')), close: () => undefined } as unknown as ModStore;
    const r = await bootMods({ store: broken });
    expect(r).toEqual({ active: [], errors: ['Could not read installed mods: disk gone'], safeMode: false });
    expect(modOverlay()).toEqual(emptyOverlay());
  });

  it('ignores a store whose records are corrupt', async () => {
    const corrupt = { id: 'mod-a', bundle: { id: 'mod-a' }, ref: {}, size: 1, installedAt: 0 } as unknown as StoredMod;
    const broken = { enabled: () => ['mod-a'], list: () => Promise.resolve([corrupt]), close: () => undefined } as unknown as ModStore;
    const r = await bootMods({ store: broken });
    expect(r.active).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(modOverlay()).toEqual(emptyOverlay());
  });

  it('ignores a store whose enabled list is unreadable', async () => {
    const store = new ModStore(new IDBFactory(), storage);
    storage.setItem('patrol-mods-enabled', '{{{');
    expect(await bootMods({ store })).toEqual({ active: [], errors: [], safeMode: false });
  });

  it('never throws when localStorage is missing or throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    });
    expect(isSafeMode()).toBe(false);
    expect(() => enterSafeMode()).not.toThrow();
    expect(() => leaveSafeMode()).not.toThrow();
    const store = new ModStore(new IDBFactory(), null);
    await expect(bootMods({ store })).resolves.toMatchObject({ active: [] });
    vi.stubGlobal('localStorage', undefined);
    await expect(bootMods({ store })).resolves.toMatchObject({ active: [] });
  });

  it('applies two mods in well under 30 ms', async () => {
    const store = await storeWith([a, b], ['mod-a', 'mod-b']);
    await bootMods({ store }); // warm up (module graph, IndexedDB)
    const t = performance.now();
    const r = await bootMods({ store });
    expect(r.active).toHaveLength(2);
    expect(performance.now() - t).toBeLessThan(30);
  });
});
