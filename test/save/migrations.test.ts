import { describe, expect, it } from 'vitest';
import { CAMERA_MODE } from '../../src/player/cameraRig';
import {
  MIGRATION_FAILURES,
  SaveMigrationError,
  V1_DEFAULT_PITCH,
  migrateEnvelope,
  migrateV1ToV2,
  migrateV2ToV3,
  migrations,
  type MigrationTable,
} from '../../src/save/migrations';
import {
  CURRENT_SAVE_VERSION,
  isSaveGame,
  isSaveGameV1,
  isSaveGameV2,
  isSavedVehicle,
  type SaveEnvelope,
  type SaveGameV1,
} from '../../src/save/schema';
import { makeSaveGame, makeSaveGameV1, makeSaveGameV2, makeSavedVehicle, makeTrafficSnapshot } from './fixtures';

/** Defaults every migrated pre-v3 save gets. */
const V3_DEFAULTS = {
  player: { mode: 'onFoot', vehicle: -1 },
  vehicles: [],
  traffic: null,
  environment: { timeOffset: 0, override: null },
};

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
    expect(CURRENT_SAVE_VERSION).toBe(3);
    for (let v = 1; v < CURRENT_SAVE_VERSION; v++) expect(migrations[v]).toBeTypeOf('function');
  });

  it('migrates v1 saves to v3: bodies at rest and awake, default camera, v3 defaults', () => {
    const out = migrateEnvelope(envelope<unknown>(1, makeSaveGameV1()));
    expect(out.version).toBe(3);
    expect(out.data.camera).toEqual({ pitch: V1_DEFAULT_PITCH, mode: CAMERA_MODE.chase });
    expect(out.data.world.entities).toEqual([
      { kind: 1, x: 0, y: 1, z: 2, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, sleeping: false },
    ]);
    expect(out.data).toMatchObject(V3_DEFAULTS);
    expect(isSaveGame(out.data)).toBe(true);
  });

  it('migrates v2 saves to v3: everything kept, on foot, chase camera, fresh traffic and environment', () => {
    const v2 = makeSaveGameV2();
    const out = migrateEnvelope(envelope<unknown>(2, v2));
    expect(out.version).toBe(3);
    expect(out.data).toEqual({ ...v2, camera: { pitch: 0.4, mode: CAMERA_MODE.chase }, ...V3_DEFAULTS });
    expect(isSaveGame(out.data)).toBe(true);
    expect(isSaveGameV2(out.data)).toBe(true);
  });

  it('migrateV2ToV3 passes invalid data through for validation to reject', () => {
    expect(migrateV2ToV3({ seed: 1 })).toEqual({ seed: 1 });
    expect(() => migrateEnvelope(envelope<unknown>(2, { ...makeSaveGameV2(), camera: {} }))).toThrow(SaveMigrationError);
  });

  it('round-trips a v3 save through structured clone and JSON unchanged', () => {
    const v3 = makeSaveGame();
    expect(isSaveGame(v3)).toBe(true);
    const cloned = structuredClone(v3);
    expect(migrateEnvelope(envelope<unknown>(3, cloned)).data).toEqual(v3);
    const json = JSON.parse(JSON.stringify(v3)) as unknown;
    expect(isSaveGame(json)).toBe(true);
    expect(json).toEqual(v3);
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
    expect(isSaveGame(corrupt)).toBe(false);
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
    expect(isSaveGame(makeSaveGame({ player: { mode: 'onFoot', vehicle: -1 }, vehicles: [], traffic: null }))).toBe(true);
    expect(isSaveGameV1(makeSaveGameV1())).toBe(true);
    expect(isSaveGameV2(makeSaveGameV2())).toBe(true);
  });

  it('rejects malformed payloads', () => {
    expect(isSaveGame(null)).toBe(false);
    expect(isSaveGame('x')).toBe(false);
    expect(isSaveGame(makeSaveGameV1())).toBe(false);
    expect(isSaveGame(makeSaveGameV2())).toBe(false);
    expect(isSaveGame({ ...makeSaveGame(), seed: NaN })).toBe(false);
    expect(isSaveGame({ ...makeSaveGame(), officer: { name: 'x' } })).toBe(false);
    expect(isSaveGame({ ...makeSaveGame(), clock: { simTime: 1 } })).toBe(false);
    expect(isSaveGame({ ...makeSaveGame(), camera: { pitch: Infinity, mode: CAMERA_MODE.chase } })).toBe(false);
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

describe('v3 nested state', () => {
  const vehicle = makeSavedVehicle();

  it('accepts saved vehicles with and without the optional sim block', () => {
    expect(isSavedVehicle(vehicle)).toBe(true);
    const { sim: _sim, ...withoutSim } = vehicle;
    expect(isSavedVehicle(withoutSim)).toBe(true);
  });

  it('rejects malformed vehicles', () => {
    const bad: unknown[] = [
      null,
      { ...vehicle, modelId: 'flying_car' },
      { ...vehicle, x: NaN },
      { ...vehicle, qw: undefined },
      { ...vehicle, fuelL: -1 },
      { ...vehicle, engineHealth: 1.5 },
      { ...vehicle, zones: [0, 0, 0] },
      { ...vehicle, zones: [0, 0, 2, 0] },
      { ...vehicle, tireFlat: [false, false, false, 'no'] },
      { ...vehicle, brakeTempC: [20] },
      { ...vehicle, headlights: 1 },
      { ...vehicle, sim: { ...vehicle.sim, gear: 0 } },
      { ...vehicle, sim: { ...vehicle.sim, wheelLoad: [1, 2, 3] } },
      { ...vehicle, color: 0x1000000 },
      { ...vehicle, color: 1.5 },
      { ...vehicle, rng: { seed: 1, s: [1, 2, 3] } },
      { ...vehicle, rng: undefined },
    ];
    for (const v of bad) {
      expect(isSavedVehicle(v)).toBe(false);
      expect(isSaveGame(makeSaveGame({ vehicles: [v as never], player: { mode: 'onFoot', vehicle: -1 } }))).toBe(false);
    }
  });

  it('rejects a player that does not match the vehicle list', () => {
    expect(isSaveGame(makeSaveGame({ player: { mode: 'driving', vehicle: 2 } }))).toBe(false);
    expect(isSaveGame(makeSaveGame({ player: { mode: 'driving', vehicle: -1 } }))).toBe(false);
    expect(isSaveGame(makeSaveGame({ player: { mode: 'onFoot', vehicle: 0 } }))).toBe(false);
    expect(isSaveGame(makeSaveGame({ player: { mode: 'driving', vehicle: 0.5 } }))).toBe(false);
    expect(isSaveGame({ ...makeSaveGame(), player: { mode: 'flying', vehicle: -1 } })).toBe(false);
    expect(isSaveGame({ ...makeSaveGame(), player: undefined })).toBe(false);
    expect(isSaveGame({ ...makeSaveGame(), vehicles: undefined })).toBe(false);
  });

  it('rejects camera modes that are not driving modes', () => {
    expect(isSaveGame(makeSaveGame({ camera: { pitch: 0.3, mode: CAMERA_MODE.onFoot } }))).toBe(false);
    expect(isSaveGame(makeSaveGame({ camera: { pitch: 0.3, mode: 9 } }))).toBe(false);
    expect(isSaveGame(makeSaveGame({ camera: { pitch: 0.3, mode: CAMERA_MODE.cockpit } }))).toBe(true);
  });

  it('rejects malformed traffic snapshots and environment state', () => {
    const traffic = makeTrafficSnapshot();
    const car = traffic.cars[0];
    expect(isSaveGame(makeSaveGame({ traffic: { ...traffic, version: 2 as 1 } }))).toBe(false);
    expect(isSaveGame(makeSaveGame({ traffic: { ...traffic, rng: { seed: 1, s: [1, 2, 3, -4] } } }))).toBe(false);
    expect(isSaveGame(makeSaveGame({ traffic: { ...traffic, cars: [{ ...car, s: NaN } as never] } }))).toBe(false);
    expect(isSaveGame({ ...makeSaveGame(), traffic: undefined })).toBe(false);
    expect(isSaveGame(makeSaveGame({ environment: { timeOffset: -1, override: null } }))).toBe(false);
    expect(isSaveGame(makeSaveGame({ environment: { timeOffset: 0, override: { kind: 'hail' as 'rain', intensity: 1 } } }))).toBe(false);
    expect(isSaveGame(makeSaveGame({ environment: { timeOffset: 0, override: { kind: 'rain', intensity: 2 } } }))).toBe(false);
    expect(isSaveGame({ ...makeSaveGame(), environment: undefined })).toBe(false);
  });
});
