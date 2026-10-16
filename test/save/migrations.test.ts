import { describe, expect, it } from 'vitest';
import {
  MIGRATION_FAILURES,
  SaveMigrationError,
  migrateEnvelope,
  migrations,
  type MigrationTable,
} from '../../src/save/migrations';
import { CURRENT_SAVE_VERSION, isSaveGameV1, type SaveEnvelope, type SaveGameV1 } from '../../src/save/schema';

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

/** Throwaway "legacy" v0 shape used only to exercise the migration chain. */
interface LegacyV0 {
  seed: number;
  rngState: { seed: number; s: [number, number, number, number] };
  simTime: number;
  officer: string;
  entities: SaveGameV1['world']['entities'];
}

const legacyFixture: MigrationTable = {
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
  it('ships with an empty table at the current version', () => {
    expect(CURRENT_SAVE_VERSION).toBe(1);
    expect(Object.keys(migrations)).toHaveLength(0);
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
    expect(isSaveGameV1(out.data)).toBe(true);
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
    const table: MigrationTable = { 0: () => ({ seed: 'not-a-number' }) };
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

describe('isSaveGameV1', () => {
  it('accepts a well-formed payload', () => {
    expect(isSaveGameV1(makeSaveGame())).toBe(true);
    expect(isSaveGameV1(makeSaveGame({ world: { entities: [] } }))).toBe(true);
  });

  it('rejects malformed payloads', () => {
    expect(isSaveGameV1(null)).toBe(false);
    expect(isSaveGameV1('x')).toBe(false);
    expect(isSaveGameV1({ ...makeSaveGame(), seed: NaN })).toBe(false);
    expect(isSaveGameV1({ ...makeSaveGame(), officer: { name: 'x' } })).toBe(false);
    expect(isSaveGameV1({ ...makeSaveGame(), clock: { simTime: 1 } })).toBe(false);
    expect(
      isSaveGameV1({ ...makeSaveGame(), world: { entities: [{ kind: 1, x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0 }] } }),
    ).toBe(false);
  });
});
