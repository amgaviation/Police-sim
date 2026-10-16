import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { log } from '../../src/core/log';
import { STORES, dbGet, dbPut, openPatrolDb } from '../../src/save/db';
import { SaveMigrationError, type MigrationTable } from '../../src/save/migrations';
import { SaveManager, SaveNotFoundError, readSettingsBlob, writeSettingsBlob } from '../../src/save/saveManager';
import { CURRENT_SAVE_VERSION, type SaveEnvelope, type SaveGameV1 } from '../../src/save/schema';

function makeSaveGame(overrides: Partial<SaveGameV1> = {}): SaveGameV1 {
  return {
    seed: 42,
    rngState: { seed: 42, s: [1, 2, 3, 4] },
    clock: { simTime: 12.5, timeScale: 1 },
    officer: { name: 'A. Vance', badge: '4471' },
    world: { entities: [{ kind: 1, x: 0, y: 1, z: 2, qx: 0, qy: 0, qz: 0, qw: 1 }] },
    ...overrides,
  };
}

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
      0: (data) => {
        const legacy = data as { seed: number; officer: string };
        return makeSaveGame({ seed: legacy.seed, officer: { name: legacy.officer, badge: '0' } });
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
