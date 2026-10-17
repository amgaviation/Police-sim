import { describe, expect, it } from 'vitest';
import { emptyCadSave } from '../../src/cad/cadState';
import { emptyContactSave } from '../../src/contact/save';
import { createRng } from '../../src/core/rng';
import { CAMERA_MODE } from '../../src/player/cameraRig';
import { emptyPeopleSave } from '../../src/people';
import { emptyOfficerKit } from '../../src/police/inventory';
import { defaultRadioSave } from '../../src/radio/save';
import { emptyRecordsSave } from '../../src/records/db';
import { emptySceneSave } from '../../src/scene/save';
import {
  MIGRATION_FAILURES,
  SaveMigrationError,
  V1_DEFAULT_PITCH,
  migrateEnvelope,
  migrateV1ToV2,
  migrateV2ToV3,
  migrateV3ToV4,
  migrateV4ToV5,
  migrations,
  type MigrationTable,
} from '../../src/save/migrations';
import {
  CURRENT_SAVE_VERSION,
  isSaveGame,
  isSaveGameV1,
  isSaveGameV2,
  isSaveGameV3,
  isSaveGameV4,
  isSaveGameV5,
  isSavedVehicle,
  type SaveEnvelope,
  type SaveGame,
  type SaveGameV1,
} from '../../src/save/schema';
import {
  makeCadSave,
  makeDispatchSave,
  makeEquipmentSave,
  makeRecordsSave,
  makeSaveGame,
  makeSaveGameV1,
  makeSaveGameV2,
  makeSaveGameV3,
  makeSaveGameV4,
  makeSavedVehicle,
  makeTrafficSnapshot,
} from './fixtures';

/** Defaults every migrated pre-v3 save gets. */
const V3_DEFAULTS = {
  player: { mode: 'onFoot', vehicle: -1, lastVehicle: -1 },
  vehicles: [],
  traffic: null,
  violations: [],
  environment: { timeOffset: 0, override: null },
};

/** Defaults every migrated pre-v4 save gets (the radio stream depends on the seed, 42 in the fixtures). */
function v4Defaults(seed: number, vehicles: number): Partial<SaveGame> {
  return {
    cad: emptyCadSave(),
    dispatch: null,
    records: emptyRecordsSave(),
    radio: defaultRadioSave(createRng(seed).stream('radio').state()),
    equipment: Array.from({ length: vehicles }, () => null),
    officerKit: emptyOfficerKit(),
  };
}

/** Defaults every migrated pre-v5 save gets (the scene stream depends on the seed). */
function v5Defaults(seed: number): Partial<SaveGame> {
  return {
    people: emptyPeopleSave(),
    npc: null,
    contacts: emptyContactSave(),
    scenes: emptySceneSave(createRng(seed).stream('scene').state()),
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
    expect(CURRENT_SAVE_VERSION).toBe(5);
    for (let v = 1; v < CURRENT_SAVE_VERSION; v++) expect(migrations[v]).toBeTypeOf('function');
  });

  it('migrates v1 saves to v5: bodies at rest and awake, default camera, v3 and v4 defaults', () => {
    const out = migrateEnvelope(envelope<unknown>(1, makeSaveGameV1()));
    expect(out.version).toBe(5);
    expect(out.data.camera).toEqual({ pitch: V1_DEFAULT_PITCH, mode: CAMERA_MODE.chase });
    expect(out.data.world.entities).toEqual([
      { kind: 1, x: 0, y: 1, z: 2, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, sleeping: false },
    ]);
    expect(out.data).toMatchObject(V3_DEFAULTS);
    expect(out.data).toMatchObject(v4Defaults(42, 0));
    expect(out.data).toMatchObject(v5Defaults(42));
    expect(isSaveGame(out.data)).toBe(true);
  });

  it('migrates v2 saves to v5: everything kept, on foot, chase camera, fresh traffic, environment and patrol state', () => {
    const v2 = makeSaveGameV2();
    const out = migrateEnvelope(envelope<unknown>(2, v2));
    expect(out.version).toBe(5);
    expect(out.data).toEqual({ ...v2, camera: { pitch: 0.4, mode: CAMERA_MODE.chase }, ...V3_DEFAULTS, ...v4Defaults(42, 0), ...v5Defaults(42) });
    expect(isSaveGame(out.data)).toBe(true);
    expect(isSaveGameV2(out.data)).toBe(true);
  });

  it('migrates v3 saves to v5: everything kept, empty CAD and records, no dispatcher, default radio, null equipment, empty kit', () => {
    const v3 = makeSaveGameV3();
    expect(isSaveGameV3(v3)).toBe(true);
    expect(isSaveGameV4(v3)).toBe(false);
    const out = migrateEnvelope(envelope<unknown>(3, v3));
    expect(out.version).toBe(5);
    expect(out.data).toEqual({ ...v3, ...v4Defaults(42, 2), ...v5Defaults(42) });
    expect(out.data.equipment).toEqual([null, null]);
    // The radio continues from the seed's own 'radio' stream, as a new game would.
    expect(out.data.radio.rng).toEqual(createRng(42).stream('radio').state());
    expect(isSaveGame(out.data)).toBe(true);
    expect(isSaveGameV3(out.data)).toBe(true);
    expect(isSaveGameV4(out.data)).toBe(true);
  });

  it('migrates v4 saves to v5: everything kept, no touched people, no saved pedestrians, empty contacts, empty scenes on the seed stream', () => {
    const v4 = makeSaveGameV4();
    expect(isSaveGameV4(v4)).toBe(true);
    expect(isSaveGameV5(v4)).toBe(false);
    const out = migrateEnvelope(envelope<unknown>(4, v4));
    expect(out.version).toBe(5);
    expect(out.data).toEqual({ ...v4, ...v5Defaults(42) });
    expect(out.data.npc).toBeNull();
    expect(out.data.scenes.rng).toEqual(createRng(42).stream('scene').state());
    expect(out.data.scenes.scenarios).toEqual([]);
    expect(isSaveGame(out.data)).toBe(true);
    expect(isSaveGameV4(out.data)).toBe(true);
  });

  it('migrateV2ToV3 and migrateV3ToV4 pass invalid data through for validation to reject', () => {
    expect(migrateV2ToV3({ seed: 1 })).toEqual({ seed: 1 });
    expect(migrateV3ToV4({ seed: 1 })).toEqual({ seed: 1 });
    expect(migrateV4ToV5({ seed: 1 })).toEqual({ seed: 1 });
    expect(() => migrateEnvelope(envelope<unknown>(2, { ...makeSaveGameV2(), camera: {} }))).toThrow(SaveMigrationError);
    expect(() => migrateEnvelope(envelope<unknown>(3, { ...makeSaveGameV3(), vehicles: undefined }))).toThrow(SaveMigrationError);
  });

  it('round-trips a v5 save through structured clone and JSON unchanged', () => {
    const v5 = makeSaveGame();
    expect(isSaveGame(v5)).toBe(true);
    const cloned = structuredClone(v5);
    expect(migrateEnvelope(envelope<unknown>(5, cloned)).data).toEqual(v5);
    const json = JSON.parse(JSON.stringify(v5)) as unknown;
    expect(isSaveGame(json)).toBe(true);
    expect(json).toEqual(v5);
    expect(v5.people.persons.length).toBeGreaterThan(0);
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
    expect(isSaveGame(makeSaveGame({ player: { mode: 'onFoot', vehicle: -1 }, vehicles: [], equipment: [], traffic: null }))).toBe(true);
    expect(isSaveGameV1(makeSaveGameV1())).toBe(true);
    expect(isSaveGameV2(makeSaveGameV2())).toBe(true);
    expect(isSaveGameV3(makeSaveGameV3())).toBe(true);
  });

  it('rejects malformed payloads', () => {
    expect(isSaveGame(null)).toBe(false);
    expect(isSaveGame('x')).toBe(false);
    expect(isSaveGame(makeSaveGameV1())).toBe(false);
    expect(isSaveGame(makeSaveGameV2())).toBe(false);
    expect(isSaveGame(makeSaveGameV3())).toBe(false);
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
      expect(isSaveGame(makeSaveGame({ vehicles: [v as never], equipment: [null], player: { mode: 'onFoot', vehicle: -1 } }))).toBe(false);
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

  it('checks the last-driven vehicle and the observed violations (both optional, as in early v3 saves)', () => {
    expect(isSaveGame(makeSaveGame({ player: { mode: 'onFoot', vehicle: -1, lastVehicle: 1 } }))).toBe(true);
    expect(isSaveGame(makeSaveGame({ player: { mode: 'onFoot', vehicle: -1 }, violations: undefined }))).toBe(true);
    expect(isSaveGame(makeSaveGame({ violations: [] }))).toBe(true);
    for (const lastVehicle of [2, -2, 0.5]) {
      expect(isSaveGame(makeSaveGame({ player: { mode: 'onFoot', vehicle: -1, lastVehicle } }))).toBe(false);
    }
    const bad: unknown[] = [{}, [[1]], [[-1, {}]], [[1, { flying: 1 }]], [[1, { speeding: -1 }]], [[1, { speeding: 0.5 }]], [[1, null]]];
    for (const violations of bad) expect(isSaveGame({ ...makeSaveGame(), violations })).toBe(false);
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

describe('v4 nested state', () => {
  it('accepts each Phase 2 block in its valid forms (dispatch null in migrated saves, speeding optional)', () => {
    expect(isSaveGame(makeSaveGame({ dispatch: null }))).toBe(true);
    expect(isSaveGame(makeSaveGame({ speeding: undefined }))).toBe(true);
    expect(isSaveGame(makeSaveGame({ equipment: [null, null] }))).toBe(true);
    expect(isSaveGame(makeSaveGame({ equipment: [makeEquipmentSave(), makeEquipmentSave()] }))).toBe(true);
    const v = makeSavedVehicle();
    expect(isSaveGame(makeSaveGame({ vehicles: [v], equipment: [null], player: { mode: 'onFoot', vehicle: -1 } }))).toBe(true);
  });

  it('rejects each malformed block', () => {
    const cad = makeCadSave();
    const dispatch = makeDispatchSave();
    const records = makeRecordsSave();
    const good = makeSaveGame();
    const bad: Array<[string, unknown]> = [
      ['cad missing', { ...good, cad: undefined }],
      ['cad wrong version', { ...good, cad: { ...cad, version: 2 } }],
      ['cad call broken', { ...good, cad: { ...cad, calls: [{ ...cad.calls[0], priority: 7 }] } }],
      ['dispatch missing', { ...good, dispatch: undefined }],
      ['dispatch wrong version', { ...good, dispatch: { ...dispatch, version: 2 } }],
      ['dispatch bad rng', { ...good, dispatch: { ...dispatch, rng: { ...dispatch.rng, calls: { seed: 1, s: [1, 2, 3] } } } }],
      ['dispatch bad request', { ...good, dispatch: { ...dispatch, requests: [{ callsign: '12', request: { kind: 'fly' }, via: 'mdt' }] } }],
      ['records missing', { ...good, records: undefined }],
      ['records wrong version', { ...good, records: { ...records, version: 9 } }],
      ['records bad queries', { ...good, records: { ...records, queries: [{ gameSeconds: 'x' }] } }],
      ['radio missing', { ...good, radio: undefined }],
      ['radio bad channel', { ...good, radio: { ...good.radio, selected: 'cb' } }],
      ['radio bad rng', { ...good, radio: { ...good.radio, rng: { seed: 1, s: [1, 2] } } }],
      ['equipment missing', { ...good, equipment: undefined }],
      ['equipment shorter than vehicles', { ...good, equipment: [null] }],
      ['equipment longer than vehicles', { ...good, equipment: [null, null, null] }],
      ['equipment entry malformed', { ...good, equipment: [{ ...makeEquipmentSave(), sirenOn: 'yes' }, null] }],
      ['officer kit missing', { ...good, officerKit: undefined }],
      ['officer kit bad count', { ...good, officerKit: { version: 1, carried: { cones: -1 }, longGun: null } }],
      ['officer kit bad gun', { ...good, officerKit: { version: 1, carried: {}, longGun: 5 } }],
      ['speeding not a list', { ...good, speeding: {} }],
      ['speeding bad entry', { ...good, speeding: [[1, NaN, 35]] }],
      ['speeding negative id', { ...good, speeding: [[-1, 40, 35]] }],
    ];
    for (const [label, data] of bad) {
      expect(isSaveGame(data), label).toBe(false);
      expect(() => migrateEnvelope(envelope<unknown>(CURRENT_SAVE_VERSION, data)), label).toThrow(SaveMigrationError);
    }
  });

  it('rejects a future version even when the payload is a valid v5 save', () => {
    let caught: unknown;
    try {
      migrateEnvelope(envelope<unknown>(6, makeSaveGame()));
    } catch (error) {
      caught = error;
    }
    expect((caught as SaveMigrationError).reason).toBe(MIGRATION_FAILURES.futureVersion);
  });
});

describe('v5 nested state', () => {
  it('accepts each Phase 3 block in its valid forms (npc null in migrated saves)', () => {
    expect(isSaveGame(makeSaveGame({ npc: null }))).toBe(true);
    expect(isSaveGame(makeSaveGame({ people: emptyPeopleSave() }))).toBe(true);
    expect(isSaveGame(makeSaveGame({ contacts: emptyContactSave() }))).toBe(true);
  });

  it('rejects each malformed block', () => {
    const good = makeSaveGame();
    const bad: Array<[string, unknown]> = [
      ['people missing', { ...good, people: undefined }],
      ['people wrong version', { ...good, people: { ...good.people, version: 2 } }],
      ['people wrong identity version', { ...good, people: { ...good.people, identityVersion: 2 } }],
      ['people persons not a list', { ...good, people: { ...good.people, persons: {} } }],
      ['npc missing', { ...good, npc: undefined }],
      ['npc wrong version', { ...good, npc: { version: 2 } }],
      ['npc not an object', { ...good, npc: 5 }],
      ['contacts missing', { ...good, contacts: undefined }],
      ['contacts wrong version', { ...good, contacts: { ...good.contacts, version: 2 } }],
      ['contacts bad nextId', { ...good, contacts: { ...good.contacts, nextId: 0 } }],
      ['contacts entry malformed', { ...good, contacts: { ...good.contacts, contacts: [{ id: 1 }] } }],
      ['scenes missing', { ...good, scenes: undefined }],
      ['scenes wrong version', { ...good, scenes: { ...good.scenes, version: 2 } }],
      ['scenes bad rng', { ...good, scenes: { ...good.scenes, rng: { seed: 1, s: [1, 2] } } }],
      ['scenes bad weapon', { ...good, scenes: { ...good.scenes, officerWeapon: 'rifle' } }],
      ['scenes scenario malformed', { ...good, scenes: { ...good.scenes, scenarios: [{ scenario: {} }] } }],
      ['scenes outcome malformed', { ...good, scenes: { ...good.scenes, closed: [{ callId: 'x' }] } }],
    ];
    for (const [label, data] of bad) {
      expect(isSaveGame(data), label).toBe(false);
      expect(() => migrateEnvelope(envelope<unknown>(CURRENT_SAVE_VERSION, data)), label).toThrow(SaveMigrationError);
    }
  });
});
