import { describe, expect, it } from 'vitest';
import {
  MIGRATION_FAILURES,
  SaveMigrationError,
  V1_DEFAULT_PITCH,
  migrateEnvelope,
  migrateV1ToV2,
  migrations,
  type MigrationTable,
} from '../../src/save/migrations';
import {
  CURRENT_SAVE_VERSION,
  isSaveGame,
  isSaveGameV1,
  type SaveEnvelope,
  type SaveGame,
  type SaveGameV1,
} from '../../src/save/schema';

function makeSaveGameV1(overrides: Partial<SaveGameV1> = {}): SaveGameV1 {
  return {
    seed: 42,
    rngState: { seed: 42, s: [1, 2, 3, 4] },
    clock: { simTime: 12.5, timeScale: 1 },
    officer: { name: 'A. Vance', badge: '4471' },
    world: { entities: [{ kind: 1, x: 0, y: 1, z: 2, qx: 0, qy: 0, qz: 0, qw: 1 }] },
    ...overrides,
  };
}

function makeSaveGame(overrides: Partial<SaveGame> = {}): SaveGame {
  return {
    ...makeSaveGameV1(),
    camera: { pitch: 0.4 },
    world: {
      entities: [
        { kind: 1, x: 0, y: 1, z: 2, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: -1, vz: 0, wx: 0, wy: 0, wz: 2, sleeping: false },
      ],
    },
    ...overrides,
  };
}

/** Throwaway "legacy" v0 shape used only to exercise the migration chain. */
interface LegacyV0 {
  seed: number;
  rngState: { seed: number; s: [number, number, number, number] };
  simTime: number;
  officer: string;
  entities: SaveGameV1['world']['entities'];
}

const legacyFixture: MigrationTable = {
  ...migrations,
  0: (data) => {
    const v0 = data as LegacyV0;
    const [name, badge] = v0.officer.split('#');
    return {
      seed: v0.seed,
      rngState: v0.rngState,
      clock: { simTime: v0.simTime, timeScale: 1 },
      officer: { name: name ?? '', badge: badge ?? '' },
      world: { entities: v0.entities },
    } satisfies SaveGameV1;
  },
};

function envelope<T>(version: number, data: T): SaveEnvelope<T> {
  return { version, createdAt: 1000, updatedAt: 2000, slot: 'slot-a', data };
}

describe('migrateEnvelope', () => {
  it('ships a step for every version below the current one', () => {
    expect(CURRENT_SAVE_VERSION).toBe(2);
    for (let v = 1; v < CURRENT_SAVE_VERSION; v++) expect(migrations[v]).toBeTypeOf('function');
  });

  it('migrates v1 saves: bodies at rest and awake, default camera pitch', () => {
    const out = migrateEnvelope(envelope<unknown>(1, makeSaveGameV1()));
    expect(out.version).toBe(2);
    expect(out.data.camera).toEqual({ pitch: V1_DEFAULT_PITCH });
    expect(out.data.world.entities).toEqual([
      { kind: 1, x: 0, y: 1, z: 2, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, sleeping: false },
    ]);
    expect(isSaveGame(out.data)).toBe(true);
  });

  it('migrates a v1 save made above the v2 time-scale cap by clamping it', () => {
    const v1 = makeSaveGameV1({ clock: { simTime: 12, timeScale: 10 } });
    expect(isSaveGameV1(v1)).toBe(true);
    const out = migrateEnvelope(envelope<unknown>(1, v1));
    expect(out.data.clock).toEqual({ simTime: 12, timeScale: 8 });
    expect(isSaveGame(out.data)).toBe(true);
    expect(isSaveGameV1(makeSaveGameV1({ clock: { simTime: 12, timeScale: -1 } }))).toBe(false);
  });

  it('migrateV1ToV2 passes invalid data through for validation to reject', () => {
    expect(migrateV1ToV2({ seed: 1 })).toEqual({ seed: 1 });
    let caught: unknown;
    try {
      migrateEnvelope(envelope<unknown>(1, { seed: 1 }));
    } catch (error) {
      caught = error;
    }
    expect((caught as SaveMigrationError).reason).toBe(MIGRATION_FAILURES.invalidData);
  });

  it('returns a current-version envelope untouched', () => {
    const env = envelope(CURRENT_SAVE_VERSION, makeSaveGame());
    const out = migrateEnvelope(env);
    expect(out).toEqual(env);
  });

  it('applies an injected migration chain from a legacy version', () => {
    const legacy: LegacyV0 = {
      seed: 7,
      rngState: { seed: 7, s: [9, 8, 7, 6] },
      simTime: 3,
      officer: 'B. Okafor#1203',
      entities: [],
    };
    const out = migrateEnvelope(envelope<unknown>(0, legacy), legacyFixture);
    expect(out.version).toBe(CURRENT_SAVE_VERSION);
    expect(out.slot).toBe('slot-a');
    expect(out.createdAt).toBe(1000);
    expect(out.data.officer).toEqual({ name: 'B. Okafor', badge: '1203' });
    expect(out.data.clock).toEqual({ simTime: 3, timeScale: 1 });
    expect(isSaveGame(out.data)).toBe(true);
  });

  it('throws a typed error when a migration step is missing', () => {
    const env = envelope<unknown>(0, { anything: true });
    expect(() => migrateEnvelope(env, {})).toThrow(SaveMigrationError);
    try {
      migrateEnvelope(env, {});
    } catch (error) {
      expect(error).toBeInstanceOf(SaveMigrationError);
      const e = error as SaveMigrationError;
      expect(e.reason).toBe(MIGRATION_FAILURES.missingStep);
      expect(e.fromVersion).toBe(0);
      expect(e.atVersion).toBe(0);
      expect(e.slot).toBe('slot-a');
    }
  });

  it('wraps a throwing migration step with its cause', () => {
    const boom = new Error('boom');
    const table: MigrationTable = {
      0: () => {
        throw boom;
      },
    };
    let caught: unknown;
    try {
      migrateEnvelope(envelope<unknown>(0, {}), table);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SaveMigrationError);
    expect((caught as SaveMigrationError).reason).toBe(MIGRATION_FAILURES.stepThrew);
    expect((caught as SaveMigrationError).cause).toBe(boom);
  });

  it('rejects data that fails validation after migration', () => {
    const table: MigrationTable = { ...migrations, 0: () => ({ seed: 'not-a-number' }) };
    let caught: unknown;
    try {
      migrateEnvelope(envelope<unknown>(0, {}), table);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SaveMigrationError);
    expect((caught as SaveMigrationError).reason).toBe(MIGRATION_FAILURES.invalidData);
  });

  it('rejects a current-version envelope with corrupt data', () => {
    const corrupt = { ...makeSaveGame(), rngState: { seed: 1, s: [1, 2] } };
    expect(() => migrateEnvelope(envelope<unknown>(CURRENT_SAVE_VERSION, corrupt))).toThrow(SaveMigrationError);
  });

  it('rejects envelopes from a newer version', () => {
    let caught: unknown;
    try {
      migrateEnvelope(envelope<unknown>(CURRENT_SAVE_VERSION + 1, makeSaveGame()));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SaveMigrationError);
    expect((caught as SaveMigrationError).reason).toBe(MIGRATION_FAILURES.futureVersion);
  });
});

describe('isSaveGame', () => {
  it('accepts a well-formed payload', () => {
    expect(isSaveGame(makeSaveGame())).toBe(true);
    expect(isSaveGame(makeSaveGame({ world: { entities: [] } }))).toBe(true);
    expect(isSaveGameV1(makeSaveGameV1())).toBe(true);
  });

  it('rejects malformed payloads', () => {
    expect(isSaveGame(null)).toBe(false);
    expect(isSaveGame('x')).toBe(false);
    expect(isSaveGame(makeSaveGameV1())).toBe(false);
    expect(isSaveGame({ ...makeSaveGame(), seed: NaN })).toBe(false);
    expect(isSaveGame({ ...makeSaveGame(), officer: { name: 'x' } })).toBe(false);
    expect(isSaveGame({ ...makeSaveGame(), clock: { simTime: 1 } })).toBe(false);
    expect(isSaveGame({ ...makeSaveGame(), camera: { pitch: Infinity } })).toBe(false);
    expect(
      isSaveGame({ ...makeSaveGame(), world: { entities: [{ kind: 1, x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0 }] } }),
    ).toBe(false);
    const entity = makeSaveGame().world.entities[0];
    expect(isSaveGame({ ...makeSaveGame(), world: { entities: [{ ...entity, sleeping: 'no' }] } })).toBe(false);
    expect(isSaveGame({ ...makeSaveGame(), world: { entities: [{ ...entity, vx: NaN }] } })).toBe(false);
  });

  it('rejects values the loader cannot restore (non-uint32 RNG state, negative time scale)', () => {
    expect(isSaveGame({ ...makeSaveGame(), rngState: { seed: 42, s: [1.5, 2, 3, 4] } })).toBe(false);
    expect(isSaveGame({ ...makeSaveGame(), rngState: { seed: 42, s: [-1, 2, 3, 4] } })).toBe(false);
    expect(isSaveGame({ ...makeSaveGame(), rngState: { seed: 42, s: [2 ** 32, 2, 3, 4] } })).toBe(false);
    expect(isSaveGame({ ...makeSaveGame(), rngState: { seed: -3, s: [1, 2, 3, 4] } })).toBe(false);
    expect(isSaveGame({ ...makeSaveGame(), clock: { simTime: 1, timeScale: -1 } })).toBe(false);
    expect(isSaveGame({ ...makeSaveGame(), clock: { simTime: 1, timeScale: 0 } })).toBe(true);
    expect(isSaveGame({ ...makeSaveGame(), rngState: { seed: 0xffffffff, s: [0, 0, 0, 0xffffffff] } })).toBe(true);
  });
});
