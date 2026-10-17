import { IDBFactory, IDBObjectStore as FakeObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { log } from '../../src/core/log';
import { DB_NAME, DB_VERSION, STORES, dbEntries, dbGet, dbPut, dbUpdate, openDb, openPatrolDb } from '../../src/save/db';
import { MIGRATION_FAILURES, SaveMigrationError, migrations, type MigrationTable } from '../../src/save/migrations';
import { SaveManager, SaveNotFoundError, SettingsBlobStore, readSettingsBlob, writeSettingsBlob } from '../../src/save/saveManager';
import { CURRENT_SAVE_VERSION, type SaveEnvelope, type SaveGame } from '../../src/save/schema';
import { makeSaveGame } from './fixtures';

/** Writes a raw record straight into the saves store, bypassing SaveManager. */
async function putRaw(factory: IDBFactory, slot: string, value: unknown): Promise<void> {
  const db = await openPatrolDb(factory);
  try {
    await dbPut(db, STORES.saves, slot, value);
  } finally {
    db.close();
  }
}

async function getRaw(factory: IDBFactory, slot: string): Promise<unknown> {
  const db = await openPatrolDb(factory);
  try {
    return await dbGet<unknown>(db, STORES.saves, slot);
  } finally {
    db.close();
  }
}

describe('SaveManager', () => {
  let factory: IDBFactory;
  let bus: EventBus<EventMap>;
  let clock: number;
  let manager: SaveManager;

  beforeEach(() => {
    factory = new IDBFactory();
    bus = new EventBus<EventMap>();
    clock = 1_000;
    manager = new SaveManager({ factory, bus, now: () => clock });
    log.clear();
    log.setConsoleMirror(false);
  });

  afterEach(() => {
    manager.close();
  });

  it('round-trips a save through load', async () => {
    const completed = vi.fn();
    const loaded = vi.fn();
    bus.on('save:completed', completed);
    bus.on('save:loaded', loaded);

    const game = makeSaveGame();
    await manager.save('slot-1', game);
    const env = await manager.load('slot-1');

    expect(env.version).toBe(CURRENT_SAVE_VERSION);
    expect(env.slot).toBe('slot-1');
    expect(env.createdAt).toBe(1_000);
    expect(env.updatedAt).toBe(1_000);
    expect(env.data).toEqual(game);
    expect(env.data).not.toBe(game);
    expect(completed).toHaveBeenCalledWith({ slot: 'slot-1' });
    expect(loaded).toHaveBeenCalledWith({ slot: 'slot-1' });
  });

  it('preserves createdAt and bumps updatedAt on overwrite', async () => {
    await manager.save('slot-1', makeSaveGame());
    clock = 5_000;
    await manager.save('slot-1', makeSaveGame({ seed: 9 }));
    const env = await manager.load('slot-1');
    expect(env.createdAt).toBe(1_000);
    expect(env.updatedAt).toBe(5_000);
    expect(env.data.seed).toBe(9);
  });

  it('throws SaveNotFoundError for an empty slot', async () => {
    await expect(manager.load('nope')).rejects.toBeInstanceOf(SaveNotFoundError);
  });

  it('lists slots most recently updated first', async () => {
    await manager.save('b', makeSaveGame({ officer: { name: 'Bravo', badge: '2' } }));
    clock = 3_000;
    await manager.save('a', makeSaveGame({ officer: { name: 'Alpha', badge: '1' } }));
    clock = 2_000;
    await manager.save('c', makeSaveGame({ officer: { name: 'Charlie', badge: '3' } }));

    const list = await manager.list();
    expect(list.map((s) => s.slot)).toEqual(['a', 'c', 'b']);
    expect(list[0]).toEqual({
      slot: 'a',
      createdAt: 3_000,
      updatedAt: 3_000,
      officerName: 'Alpha',
      version: CURRENT_SAVE_VERSION,
    });
  });

  it('skips unreadable rows when listing', async () => {
    await manager.save('good', makeSaveGame());
    await putRaw(factory, 'junk', 'not an envelope');
    const list = await manager.list();
    expect(list.map((s) => s.slot)).toEqual(['good']);
  });

  it('deletes a slot', async () => {
    await manager.save('slot-1', makeSaveGame());
    await manager.delete('slot-1');
    expect(await manager.list()).toEqual([]);
    await expect(manager.load('slot-1')).rejects.toBeInstanceOf(SaveNotFoundError);
    await expect(manager.delete('slot-1')).resolves.toBeUndefined();
  });

  it('migrates an old envelope on load and writes the upgraded copy back', async () => {
    const table: MigrationTable = {
      ...migrations,
      0: (data) => {
        // v0 -> v1 (the real v1 -> v2 step then runs from the shipped table).
        const legacy = data as { seed: number; officer: string };
        const { camera: _camera, ...v1 } = makeSaveGame({ seed: legacy.seed, officer: { name: legacy.officer, badge: '0' } });
        return { ...v1, world: { entities: [] } };
      },
    };
    const migrating = new SaveManager({ factory, bus, now: () => clock, migrationsTable: table });
    const legacyEnvelope: SaveEnvelope<unknown> = {
      version: 0,
      createdAt: 10,
      updatedAt: 20,
      slot: 'old',
      data: { seed: 77, officer: 'Legacy' },
    };
    await putRaw(factory, 'old', legacyEnvelope);

    const env = await migrating.load('old');
    expect(env.version).toBe(CURRENT_SAVE_VERSION);
    expect(env.data.seed).toBe(77);
    expect(env.data.officer.name).toBe('Legacy');
    expect(env.createdAt).toBe(10);

    const stored = await getRaw(factory, 'old');
    expect(stored).toEqual(env);
    migrating.close();
  });

  it('migrates a stored v1 save to the current version', async () => {
    const v1 = {
      version: 1,
      createdAt: 5,
      updatedAt: 6,
      slot: 'v1',
      data: {
        seed: 3,
        rngState: { seed: 3, s: [5, 6, 7, 8] },
        clock: { simTime: 2, timeScale: 1 },
        officer: { name: 'Old', badge: '1' },
        world: { entities: [{ kind: 5, x: 1, y: 2, z: 3, qx: 0, qy: 0, qz: 0, qw: 1 }] },
      },
    };
    await putRaw(factory, 'v1', v1);
    const env = await manager.load('v1');
    expect(env.version).toBe(CURRENT_SAVE_VERSION);
    expect(env.data.world.entities[0]).toMatchObject({ x: 1, vx: 0, wz: 0, sleeping: false });
    expect(await getRaw(factory, 'v1')).toEqual(env);
  });

  it('does not let a migration write-back overwrite a save made in between', async () => {
    const v1 = {
      version: 1,
      createdAt: 5,
      updatedAt: 6,
      slot: 'a',
      data: {
        seed: 3,
        rngState: { seed: 3, s: [5, 6, 7, 8] },
        clock: { simTime: 2, timeScale: 1 },
        officer: { name: 'OLD', badge: '1' },
        world: { entities: [] },
      },
    };
    await putRaw(factory, 'a', v1);
    const newer = makeSaveGame({ officer: { name: 'NEW', badge: '2' } });
    const [loaded] = await Promise.all([manager.load('a'), manager.save('a', newer)]);
    expect(loaded.data.officer.name).toBe('OLD');
    expect((await manager.load('a')).data.officer.name).toBe('NEW');
  });

  it('still loads a migrated save when writing it back fails', async () => {
    const v1 = {
      version: 1,
      createdAt: 5,
      updatedAt: 6,
      slot: 'a',
      data: {
        seed: 3,
        rngState: { seed: 3, s: [5, 6, 7, 8] },
        clock: { simTime: 2, timeScale: 1 },
        officer: { name: 'Old', badge: '1' },
        world: { entities: [] },
      },
    };
    await putRaw(factory, 'a', v1);
    const put = vi.spyOn(FakeObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    try {
      const env = await manager.load('a');
      expect(env.version).toBe(CURRENT_SAVE_VERSION);
      expect(env.data.officer.name).toBe('Old');
      expect(log.entries().some((e) => e.level === 'warn' && e.message.includes('QuotaExceededError'))).toBe(true);
    } finally {
      put.mockRestore();
    }
    expect(await getRaw(factory, 'a')).toEqual(v1);
  });

  it('rejects a save whose time scale is out of range', async () => {
    await expect(manager.save('a', makeSaveGame({ clock: { simTime: 0, timeScale: 1e6 } }))).rejects.toBeInstanceOf(SaveMigrationError);
    await putRaw(factory, 'a', { version: CURRENT_SAVE_VERSION, createdAt: 1, updatedAt: 1, slot: 'a', data: makeSaveGame({ clock: { simTime: 0, timeScale: 1e6 } }) });
    await expect(manager.load('a')).rejects.toBeInstanceOf(SaveMigrationError);
  });

  it('reopens after the browser force-closes its connection', async () => {
    const open = vi.spyOn(factory, 'open');
    await manager.save('a', makeSaveGame());
    const request = open.mock.results[0]?.value as IDBOpenDBRequest;
    const db = request.result;
    // A forced close (cleared site data): the connection is unusable and only 'close' fires.
    db.close();
    db.onclose?.call(db, new Event('close'));
    expect((await manager.list()).map((r) => r.slot)).toEqual(['a']);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('refuses to write a save that would not load, keeping the previous one', async () => {
    const good = makeSaveGame({ seed: 7 });
    await manager.save('autosave', good);
    const bad = makeSaveGame({ clock: { simTime: NaN, timeScale: 1 } });
    const error: unknown = await manager.save('autosave', bad).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SaveMigrationError);
    expect((error as SaveMigrationError).reason).toBe(MIGRATION_FAILURES.invalidData);
    await expect(manager.save('autosave', makeSaveGame({ seed: NaN }))).rejects.toBeInstanceOf(SaveMigrationError);
    expect((await manager.load('autosave')).data).toEqual(good);
  });

  it('keeps the first createdAt when two saves to one slot overlap', async () => {
    const first = manager.save('s', makeSaveGame({ seed: 1 }));
    clock = 5_000;
    const second = manager.save('s', makeSaveGame({ seed: 2 }));
    await Promise.all([first, second]);
    const env = await manager.load('s');
    expect(env.createdAt).toBe(1_000);
    expect(env.updatedAt).toBe(5_000);
    expect(env.data.seed).toBe(2);
  });

  it('lists rows by their store key and repairs a mismatched slot field on load', async () => {
    const env: SaveEnvelope<SaveGame> = { version: CURRENT_SAVE_VERSION, createdAt: 1, updatedAt: 1, slot: 'other', data: makeSaveGame() };
    await putRaw(factory, 'real', env);
    const [row] = await manager.list();
    expect(row?.slot).toBe('real');
    const loaded = await manager.load('real');
    expect(loaded.slot).toBe('real');
    expect(await getRaw(factory, 'real')).toEqual({ ...env, slot: 'real' });
  });

  it('drops its connection when a newer database version is opened elsewhere', async () => {
    await manager.save('a', makeSaveGame());
    // Would wait forever if the manager's connection stayed open.
    const upgraded = await openDb(DB_NAME, DB_VERSION + 1, () => undefined, factory);
    upgraded.close();
    // The manager reopens instead of reusing a closed connection: this build is now too old for the database.
    const error: unknown = await manager.list().catch((e: unknown) => e);
    expect((error as DOMException).name).toBe('VersionError');
  });

  it('rejects a corrupt envelope', async () => {
    await putRaw(factory, 'bad', { version: 'one', data: {} });
    await expect(manager.load('bad')).rejects.toBeInstanceOf(SaveMigrationError);
  });

  it('rejects an envelope whose data fails validation', async () => {
    const env: SaveEnvelope<unknown> = {
      version: CURRENT_SAVE_VERSION,
      createdAt: 1,
      updatedAt: 1,
      slot: 'bad',
      data: { seed: 1 },
    };
    await putRaw(factory, 'bad', env);
    await expect(manager.load('bad')).rejects.toBeInstanceOf(SaveMigrationError);
  });

  it('rejects an envelope with a missing migration step', async () => {
    const env: SaveEnvelope<unknown> = { version: 0, createdAt: 1, updatedAt: 1, slot: 'old', data: {} };
    await putRaw(factory, 'old', env);
    await expect(manager.load('old')).rejects.toBeInstanceOf(SaveMigrationError);
  });

  describe('autosave', () => {
    beforeEach(() => {
      // fake-indexeddb schedules its own work with setTimeout/setImmediate,
      // so only the interval timers are faked.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('saves from the provider on each interval', async () => {
      let seed = 1;
      manager.startAutosave(1_000, () => makeSaveGame({ seed: seed++ }));
      expect(manager.autosaveRunning).toBe(true);

      vi.advanceTimersByTime(1_000);
      await manager.whenAutosaveIdle();
      expect((await manager.load('autosave')).data.seed).toBe(1);

      vi.advanceTimersByTime(1_000);
      await manager.whenAutosaveIdle();
      expect((await manager.load('autosave')).data.seed).toBe(2);

      manager.stopAutosave();
      expect(manager.autosaveRunning).toBe(false);
      vi.advanceTimersByTime(5_000);
      await manager.whenAutosaveIdle();
      expect((await manager.load('autosave')).data.seed).toBe(2);
    });

    it('skips a tick while the previous autosave is still writing', async () => {
      const provider = vi.fn(() => makeSaveGame());
      manager.startAutosave(100, provider);
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(100);
      expect(provider).toHaveBeenCalledTimes(1);
      await manager.whenAutosaveIdle();
      vi.advanceTimersByTime(100);
      expect(provider).toHaveBeenCalledTimes(2);
      await manager.whenAutosaveIdle();
    });

    it('logs instead of throwing when the provider fails', () => {
      manager.startAutosave(100, () => {
        throw new Error('no state yet');
      });
      vi.advanceTimersByTime(100);
      expect(log.entries().some((e) => e.level === 'error' && e.message.includes('no state yet'))).toBe(true);
      expect(manager.autosaveRunning).toBe(true);
    });

    it('restarting replaces the previous timer', () => {
      manager.startAutosave(1_000, makeSaveGame);
      manager.startAutosave(2_000, makeSaveGame);
      expect(vi.getTimerCount()).toBe(1);
    });
  });
});

describe('settings blob', () => {
  it('returns undefined before anything is written', async () => {
    const factory = new IDBFactory();
    expect(await readSettingsBlob(factory)).toBeUndefined();
  });

  it('round-trips an arbitrary structured value', async () => {
    const factory = new IDBFactory();
    const blob = { graphics: { quality: 'high' }, audio: { master: 0.8 }, keys: ['w', 'a'] };
    await writeSettingsBlob(blob, factory);
    expect(await readSettingsBlob(factory)).toEqual(blob);
    await writeSettingsBlob({ replaced: true }, factory);
    expect(await readSettingsBlob(factory)).toEqual({ replaced: true });
  });
});

describe('openDb', () => {
  it('closes a connection when a newer version is requested and reports it', async () => {
    const factory = new IDBFactory();
    const onVersionChange = vi.fn();
    const v1 = await openPatrolDb(factory, onVersionChange);
    const v2 = await openDb(DB_NAME, DB_VERSION + 1, () => undefined, factory);
    expect(v2.version).toBe(DB_VERSION + 1);
    expect(onVersionChange).toHaveBeenCalledTimes(1);
    expect(() => v1.transaction(STORES.saves)).toThrow();
    v2.close();
  });

  it('waits (instead of failing) while an older connection blocks the upgrade', async () => {
    const factory = new IDBFactory();
    log.clear();
    log.setConsoleMirror(false);
    // A raw connection without a versionchange handler, like an old build's tab.
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => request.result.createObjectStore(STORES.saves);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('open failed'));
    });
    let settled = false;
    const pending = openDb(DB_NAME, DB_VERSION + 1, () => undefined, factory).finally(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    expect(log.entries().some((e) => e.level === 'warn' && e.message.includes('waiting'))).toBe(true);
    raw.close();
    const db = await pending;
    expect(db.version).toBe(DB_VERSION + 1);
    db.close();
  });
});

describe('transaction errors', () => {
  it('reject with the failing request\'s DOMException, not a generic error', async () => {
    const factory = new IDBFactory();
    const db = await openDb('constraint', 1, (d) => d.createObjectStore(STORES.saves).createIndex('u', 'u', { unique: true }), factory);
    await dbPut(db, STORES.saves, 'a', { u: 1 });
    const name = (p: Promise<unknown>): Promise<string> => p.then(() => 'resolved', (e: unknown) => (e as { name: string }).name);
    expect(await name(dbPut(db, STORES.saves, 'b', { u: 1 }))).toBe('ConstraintError');
    expect(await name(dbUpdate(db, STORES.saves, 'b', () => ({ u: 1 })))).toBe('ConstraintError');
    expect(await dbEntries(db, STORES.saves)).toEqual([{ key: 'a', value: { u: 1 } }]);
    db.close();
  });
});

describe('SettingsBlobStore', () => {
  it('close() while the connection is still opening does not leave it open', async () => {
    const factory = new IDBFactory();
    const store = new SettingsBlobStore(factory);
    const read = store.read();
    store.close();
    await expect(read).resolves.toBeUndefined();
    expect((store as unknown as { db: IDBDatabase | null }).db).toBeNull();
    // Nothing holds the database open: an upgrade elsewhere is not blocked.
    const blocked = vi.fn();
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME, DB_VERSION + 1);
      request.onblocked = blocked;
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('open failed'));
    });
    expect(blocked).not.toHaveBeenCalled();
    upgraded.close();
  });

  it('reopens after close() for later reads and writes', async () => {
    const store = new SettingsBlobStore(new IDBFactory());
    await store.write({ a: 1 });
    store.close();
    await expect(store.read()).resolves.toEqual({ a: 1 });
    store.close();
  });
});
