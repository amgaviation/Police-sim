import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modRef } from '../../src/mods/combine';
import type { StoredMod } from '../../src/mods/store';
import type { ModBundle, ModRef } from '../../src/mods/types';
import { ModManager, contentKinds, formatBytes, modRows, planSave, type ModManagerHost, type ModStoreLike } from '../../src/ui/mods/modManager';
import { bundle, fakeContext, fileLike, nightShiftPack, realContext } from '../mods/helpers';
import { SAFE_MODE_KEY } from '../../src/mods/boot';

function stored(b: ModBundle, size = 1500): StoredMod {
  return { id: b.id, bundle: b, ref: modRef(b), size, installedAt: 0 };
}

class FakeStore implements ModStoreLike {
  readonly mods = new Map<string, StoredMod>();
  order: string[] = [];
  fail = false;
  list(): Promise<StoredMod[]> {
    return this.fail ? Promise.reject(new Error('db blocked')) : Promise.resolve([...this.mods.values()].sort((a, b) => (a.id < b.id ? -1 : 1)));
  }
  put(m: StoredMod): Promise<void> {
    if (this.fail) return Promise.reject(new Error('db blocked'));
    this.mods.set(m.id, m);
    return Promise.resolve();
  }
  remove(id: string): Promise<void> {
    this.mods.delete(id);
    return Promise.resolve();
  }
  enabled(): string[] {
    return [...this.order];
  }
  setEnabled(ids: readonly string[]): void {
    this.order = [...ids];
  }
}

class FakeStorage {
  readonly data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

describe('modRows', () => {
  const a = bundle('alpha-pack', { callTypes: [{ family: 'parking', types: [{}] }] });
  const b = { ...bundle('beta-pack', { vehicles: [{}], districts: { harbor: { label: 'x' } } }), name: 'Beta', author: 'Sam', modVersion: '2.1.0' };
  const c = bundle('gamma-pack', {});

  it('lists enabled mods first in load order, then the rest by id, with the order numbers', () => {
    const rows = modRows([stored(a), stored(b), stored(c)], ['gamma-pack', 'ghost', 'alpha-pack'], []);
    expect(rows.map((r) => r.id)).toEqual(['gamma-pack', 'alpha-pack', 'beta-pack']);
    expect(rows.map((r) => r.order)).toEqual([1, 2, 0]);
    expect(rows.map((r) => r.enabled)).toEqual([true, true, false]);
  });

  it('describes name, version, author, kinds and size', () => {
    const rows = modRows([stored(a), stored(b, 3 * 1024 * 1024)], [], []);
    const beta = rows.find((r) => r.id === 'beta-pack');
    expect(beta).toMatchObject({ name: 'Beta', version: '2.1.0', author: 'Sam', kinds: 'vehicles, districts', size: '3.0 MiB' });
    expect(rows.find((r) => r.id === 'alpha-pack')?.kinds).toBe('callTypes');
    expect(contentKinds(c)).toBe('no content');
  });

  it('marks a mod active only when the same version (hash) is applied in this session', () => {
    const active: ModRef[] = [{ id: 'alpha-pack', modVersion: '1.0.0', hash: modRef(a).hash }, { id: 'beta-pack', modVersion: '2.1.0', hash: 'deadbeef' }];
    const rows = modRows([stored(a), stored(b)], ['alpha-pack', 'beta-pack'], active);
    expect(rows.map((r) => r.active)).toEqual([true, false]);
  });

  it('formats sizes', () => {
    expect(formatBytes(640)).toBe('640 B');
    expect(formatBytes(12 * 1024)).toBe('12 KiB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MiB');
    expect(formatBytes(-3)).toBe('0 B');
  });
});

describe('planSave', () => {
  it('accepts a valid set and keeps the order', () => {
    const plan = planSave([stored(bundle('a-mod', {})), stored(bundle('b-mod', {}))], ['b-mod', 'a-mod'], fakeContext());
    expect(plan).toEqual({ ok: true, order: ['b-mod', 'a-mod'] });
  });

  it('accepts an empty set (turn all mods off)', () => {
    expect(planSave([stored(bundle('a-mod', {}))], [], fakeContext())).toEqual({ ok: true, order: [] });
  });

  it('blocks two mods that define the same content id, naming both', () => {
    const one = bundle('one-mod', { callTypes: [{ family: 'parking', types: [{ id: 'sameType' }] }] });
    const two = bundle('two-mod', { callTypes: [{ family: 'parking', types: [{ id: 'sameType' }] }] });
    const plan = planSave([stored(one), stored(two)], ['one-mod', 'two-mod'], fakeContext());
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.errors.join('\n')).toContain('sameType');
      expect(plan.errors.join('\n')).toContain('one-mod');
    }
  });

  it('blocks a combination the context rejects', () => {
    const ctx = fakeContext({ checkStatutes: () => ['statutes[0].fine: must be a number'] });
    const plan = planSave([stored(bundle('law-mod', { statutes: [{}] }))], ['law-mod'], ctx);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.errors.join('\n')).toContain('statutes[0].fine');
  });
});

describe('ModManager flows', () => {
  let storage: FakeStorage;
  beforeEach(() => {
    storage = new FakeStorage();
    vi.stubGlobal('localStorage', storage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setup(opts: { active?: ModRef[]; safe?: boolean; boot?: string[] } = {}) {
    const store = new FakeStore();
    let reloads = 0;
    let closes = 0;
    const host: ModManagerHost = {
      store,
      context: () => realContext(),
      active: () => opts.active ?? [],
      bootErrors: () => opts.boot ?? [],
      safeMode: () => opts.safe ?? false,
      reload: () => void reloads++,
      close: () => void closes++,
    };
    const mm = new ModManager(null, host);
    return { store, mm, host, reloads: () => reloads, closes: () => closes };
  }

  const text = (v: unknown): string => JSON.stringify(v);

  it('validates and stores a good bundle, and lists it unticked', async () => {
    const { store, mm } = setup();
    await mm.open();
    expect(mm.rows).toEqual([]);
    const [r] = await mm.install([fileLike('night-shift-pack.json', text(nightShiftPack()))], 'files');
    expect(r?.ok).toBe(true);
    expect(r?.id).toBe('night-shift-pack');
    expect(store.mods.has('night-shift-pack')).toBe(true);
    expect(store.mods.get('night-shift-pack')?.ref.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(mm.rows).toHaveLength(1);
    expect(mm.rows[0]?.enabled).toBe(false);
    expect(mm.status).toMatch(/installed night-shift-pack/i);
  });

  it('stores nothing and lists readable errors for a bad bundle', async () => {
    const { store, mm } = setup();
    await mm.open();
    const bad = nightShiftPack();
    bad['id'] = 'Bad Id!';
    const results = await mm.install([fileLike('bad.json', text(bad)), fileLike('broken.json', '{ nope'), fileLike('notjson.txt', 'x')], 'files');
    expect(results.map((r) => r.ok)).toEqual([false, false, false]);
    expect(store.mods.size).toBe(0);
    expect(results[0]?.lines.join('\n')).toContain('id');
    expect(results[1]?.lines.join('\n')).toMatch(/not valid json/i);
    expect(results[2]?.lines.join('\n')).toMatch(/\.json/);
    expect(mm.messages.join('\n')).toContain('bad.json was not installed:');
    expect(mm.rows).toEqual([]);
  });

  it('reports a failing store instead of throwing', async () => {
    const { store, mm } = setup();
    await mm.open();
    store.fail = true;
    const [r] = await mm.install([fileLike('night-shift-pack.json', text(nightShiftPack()))], 'files');
    expect(r?.ok).toBe(false);
    expect(r?.lines.join('\n')).toMatch(/db blocked/);
    await mm.load();
    expect(mm.status).toMatch(/could not read/i);
  });

  it('installs a folder as one mod (mod.json plus its files)', async () => {
    const { store, mm } = setup();
    await mm.open();
    const manifest = {
      format: 'patrol-mod',
      version: 1,
      id: 'folder-mod',
      name: 'Folder mod',
      author: 'x',
      description: '',
      modVersion: '1.0.0',
      files: { districts: ['districts/table.json'] },
    };
    const files = [
      fileLike('mod.json', text(manifest), 'folder-mod/mod.json'),
      fileLike('table.json', text({ harbor: { label: 'Harbor Row' } }), 'folder-mod/districts/table.json'),
    ];
    const [r] = await mm.install(files, 'folder');
    expect(r?.lines.join('\n')).toBe('Installed Folder mod 1.0.0');
    expect(store.mods.get('folder-mod')?.bundle.content.districts?.['harbor']?.label).toBe('Harbor Row');
    const [missing] = await mm.install([fileLike('other.json', '{}', 'x/other.json'), fileLike('more.json', '{}', 'x/more.json')], 'folder');
    expect(missing?.ok).toBe(false);
    expect(missing?.lines.join('\n')).toMatch(/mod\.json/);
  });

  it('enables, orders and removes mods', async () => {
    const { store, mm } = setup();
    for (const id of ['a-mod', 'b-mod', 'c-mod']) store.mods.set(id, stored(bundle(id, {})));
    await mm.open();
    expect(mm.rows.map((r) => r.id)).toEqual(['a-mod', 'b-mod', 'c-mod']);
    mm.setEnabled('c-mod', true);
    mm.setEnabled('a-mod', true);
    mm.setEnabled('ghost', true);
    expect(mm.enabledOrder).toEqual(['c-mod', 'a-mod']);
    mm.move('a-mod', -1);
    expect(mm.enabledOrder).toEqual(['a-mod', 'c-mod']);
    mm.move('a-mod', -1); // already first
    mm.move('c-mod', 1); // already last
    mm.move('b-mod', 1); // not enabled
    expect(mm.enabledOrder).toEqual(['a-mod', 'c-mod']);
    expect(mm.rows.map((r) => r.order)).toEqual([1, 2, 0]);
    mm.setEnabled('a-mod', false);
    expect(mm.enabledOrder).toEqual(['c-mod']);
    expect(await mm.remove('c-mod')).toBe(true);
    expect(store.mods.has('c-mod')).toBe(false);
    expect(mm.enabledOrder).toEqual([]);
    expect(mm.rows.map((r) => r.id)).toEqual(['a-mod', 'b-mod']);
  });

  it('Save & reload stores the order, leaves safe mode and reloads', async () => {
    const { store, mm, reloads } = setup({ safe: true });
    storage.setItem(SAFE_MODE_KEY, '1');
    for (const id of ['a-mod', 'b-mod']) store.mods.set(id, stored(bundle(id, {})));
    await mm.open();
    mm.setEnabled('b-mod', true);
    mm.setEnabled('a-mod', true);
    expect(mm.saveAndReload()).toBe(true);
    expect(store.order).toEqual(['b-mod', 'a-mod']);
    expect(storage.getItem(SAFE_MODE_KEY)).toBeNull();
    expect(reloads()).toBe(1);
  });

  it('Save & reload is blocked, with the errors listed, when the enabled set is invalid', async () => {
    const { store, mm, reloads } = setup();
    const pack = nightShiftPack();
    const copy = { ...pack, id: 'night-shift-copy' };
    const r = await (async () => {
      await mm.open();
      return mm.install([fileLike('a.json', text(pack)), fileLike('b.json', text(copy))], 'files');
    })();
    expect(r.every((x) => x.ok)).toBe(true);
    mm.setEnabled('night-shift-pack', true);
    mm.setEnabled('night-shift-copy', true);
    expect(mm.saveAndReload()).toBe(false);
    expect(reloads()).toBe(0);
    expect(store.order).toEqual([]);
    expect(mm.messages[0]).toMatch(/cannot save/i);
    expect(mm.messages.join('\n')).toContain('night-shift-copy');
    // Unticking the duplicate makes it saveable.
    mm.setEnabled('night-shift-copy', false);
    expect(mm.saveAndReload()).toBe(true);
    expect(store.order).toEqual(['night-shift-pack']);
  });

  it('reads the saved order on load and ignores ids that are no longer installed', async () => {
    const { store, mm } = setup();
    store.mods.set('a-mod', stored(bundle('a-mod', {})));
    store.order = ['gone-mod', 'a-mod'];
    await mm.load();
    expect(mm.enabledOrder).toEqual(['a-mod']);
  });

  it('knows when a reload is needed', async () => {
    const a = bundle('a-mod', {});
    const { store, mm } = setup({ active: [{ id: 'a-mod', modVersion: '1.0.0', hash: modRef(a).hash }] });
    store.mods.set('a-mod', stored(a));
    store.order = ['a-mod'];
    await mm.load();
    expect(mm.needsReload).toBe(false);
    mm.setEnabled('a-mod', false);
    expect(mm.needsReload).toBe(true);
  });
});
