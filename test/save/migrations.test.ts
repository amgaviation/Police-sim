import { describe, expect, it } from 'vitest';
import { migratedFleetSave } from '../../src/fleet/save';
import { startingGearSave } from '../../src/gear';
import { characterFromLegacy } from '../../src/uniform';
import { emptyBackupSave } from '../../src/backup/save';
import { emptyCadSave } from '../../src/cad/cadState';
import { emptyCommandSave } from '../../src/command/save';
import { newConductSave } from '../../src/conduct/save';
import { emptyContactSave } from '../../src/contact/save';
import { emptyCourtSave } from '../../src/court/save';
import { defaultForceSave } from '../../src/force/save';
import { emptyIncidentsSave } from '../../src/incidents/save';
import { emptyPursuitSave } from '../../src/pursuit/save';
import { emptyResourceSave } from '../../src/resources/save';
import { emptyRosterSave } from '../../src/units/roster';
import { createRng } from '../../src/core/rng';
import { legacyCareerSave } from '../../src/career/save';
import { gameSecondsAt } from '../../src/environment/time';
import { newModeSave } from '../../src/training/mode';
import { newWorldStateSave } from '../../src/worldstate/save';
import { CAMERA_MODE } from '../../src/player/cameraRig';
import { emptyPeopleSave } from '../../src/people';
import { emptyOfficerKit } from '../../src/police/inventory';
import { defaultRadioSave } from '../../src/radio/save';
import { emptyRecordsSave } from '../../src/records/db';
import { emptyInteriorSave } from '../../src/indoors/save';
import { emptyInvestigationSave } from '../../src/investigation/save';
import { emptySceneSave } from '../../src/scene/save';
import { defaultTacticalSave } from '../../src/tactical/save';
import {
  MIGRATION_FAILURES,
  SaveMigrationError,
  V1_DEFAULT_PITCH,
  migrateEnvelope,
  migrateV1ToV2,
  migrateV2ToV3,
  migrateV3ToV4,
  migrateV4ToV5,
  migrateV5ToV6,
  migrateV6ToV7,
  migrateV7ToV8,
  migrateV8ToV9,
  migrateV9ToV10,
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
  isSaveGameV6,
  isSaveGameV7,
  isSaveGameV8,
  isSaveGameV9,
  isSaveGameV10,
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
  makeSaveGameV5,
  makeSaveGameV6,
  makeSaveGameV7,
  makeSaveGameV8,
  makeSaveGameV9,
  makeLegacyEquipmentSave,
  migratedStationSave,
  PHASE4_TRUNK_ITEMS,
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

/** Defaults every migrated pre-v6 save gets (streams depend on the seed; the station block on the badge). */
function v6Defaults(seed: number, badge: string): Partial<SaveGame> {
  return {
    interiors: emptyInteriorSave(createRng(seed).stream('interior').state()),
    tactical: defaultTacticalSave(createRng(seed).stream('tactical').state()),
    investigation: emptyInvestigationSave(createRng(seed).stream('investigation').state()),
    station: migratedStationSave(badge),
  };
}

/** Defaults every migrated pre-v7 save gets (streams depend on the seed). */
function v7Defaults(seed: number): Partial<SaveGame> {
  return {
    force: defaultForceSave(createRng(seed).stream('force').state()),
    incidents: emptyIncidentsSave('generic'),
    conduct: newConductSave(createRng(seed).stream('conduct').state()),
    court: emptyCourtSave(createRng(seed).stream('court').state()),
  };
}

/** Defaults every migrated pre-v8 save gets (streams depend on the seed). */
function v8Defaults(seed: number): Partial<SaveGame> {
  return {
    roster: emptyRosterSave(),
    resources: emptyResourceSave(createRng(seed).stream('resources').state()),
    backup: emptyBackupSave(createRng(seed).stream('backup').state()),
    pursuit: emptyPursuitSave(createRng(seed).stream('pursuit').state()),
    command: emptyCommandSave(createRng(seed).stream('command').state()),
  };
}

/** Defaults every migrated pre-v9 save gets (the fleet stream depends on the seed; the fleet binds the saved vehicles by model). */
function v9Defaults(seed: number, officer: { name: string; badge: string }, models: readonly string[]): Partial<SaveGame> {
  return {
    character: { version: 1, profile: characterFromLegacy(officer.name, officer.badge) },
    gear: startingGearSave(),
    fleet: migratedFleetSave(createRng(seed).stream('fleet').state(), models),
  };
}

/** Defaults every migrated pre-v10 save gets: a patrol-officer career from the save's game time, a blank world, free patrol, no mods. */
function v10Defaults(seed: number, saved: { clock: { simTime: number }; environment: { timeOffset: number } }): Partial<SaveGame> {
  return {
    career: legacyCareerSave(createRng(seed).stream('career').state(), gameSecondsAt(saved.clock.simTime, saved.environment.timeOffset)),
    worldState: newWorldStateSave(createRng(seed).stream('worldstate').state()),
    mode: newModeSave('freePatrol'),
    mods: [],
  };
}

/** The saved patrol-car equipment of the fixtures after the v6 migration (trunks gain the Phase 4 items from the patrol loadout). */
function migratedEquipment(): SaveGame['equipment'] {
  const eq = makeLegacyEquipmentSave();
  return [{ ...eq, trunk: { ...eq.trunk, ram: 1, sceneTape: 1, evidenceMarkers: 20, evidenceBags: 20, fingerprintKit: 1, camera: 1 } }, null];
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
    expect(CURRENT_SAVE_VERSION).toBe(10);
    for (let v = 1; v < CURRENT_SAVE_VERSION; v++) expect(migrations[v]).toBeTypeOf('function');
  });

  it('migrates v1 saves to v10: bodies at rest and awake, default camera, v3 and v4 defaults', () => {
    const out = migrateEnvelope(envelope<unknown>(1, makeSaveGameV1()));
    expect(out.version).toBe(10);
    expect(out.data.camera).toEqual({ pitch: V1_DEFAULT_PITCH, mode: CAMERA_MODE.chase });
    expect(out.data.world.entities).toEqual([
      { kind: 1, x: 0, y: 1, z: 2, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, sleeping: false },
    ]);
    expect(out.data).toMatchObject(V3_DEFAULTS);
    expect(out.data).toMatchObject(v4Defaults(42, 0));
    expect(out.data).toMatchObject(v5Defaults(42));
    expect(out.data).toMatchObject(v6Defaults(42, '4471'));
    expect(out.data).toMatchObject(v7Defaults(42));
    expect(out.data).toMatchObject(v8Defaults(42));
    expect(out.data).toMatchObject(v9Defaults(42, { name: 'A. Vance', badge: '4471' }, []));
    expect(isSaveGame(out.data)).toBe(true);
  });

  it('migrates v2 saves to v10: everything kept, on foot, chase camera, fresh traffic, environment and patrol state', () => {
    const v2 = makeSaveGameV2();
    const out = migrateEnvelope(envelope<unknown>(2, v2));
    expect(out.version).toBe(10);
    expect(out.data).toEqual({ ...v2, camera: { pitch: 0.4, mode: CAMERA_MODE.chase }, ...V3_DEFAULTS, ...v4Defaults(42, 0), ...v5Defaults(42), ...v6Defaults(42, '4471'), ...v7Defaults(42), ...v8Defaults(42), ...v9Defaults(42, { name: 'A. Vance', badge: '4471' }, []), ...v10Defaults(42, out.data) });
    expect(isSaveGame(out.data)).toBe(true);
    expect(isSaveGameV2(out.data)).toBe(true);
  });

  it('migrates v3 saves to v10: everything kept, empty CAD and records, no dispatcher, default radio, null equipment, empty kit', () => {
    const v3 = makeSaveGameV3();
    expect(isSaveGameV3(v3)).toBe(true);
    expect(isSaveGameV4(v3)).toBe(false);
    const out = migrateEnvelope(envelope<unknown>(3, v3));
    expect(out.version).toBe(10);
    expect(out.data).toEqual({ ...v3, ...v4Defaults(42, 2), ...v5Defaults(42), ...v6Defaults(42, '4471'), ...v7Defaults(42), ...v8Defaults(42), ...v9Defaults(42, { name: 'A. Vance', badge: '4471' }, ['patrol_sedan', 'patrol_suv']), ...v10Defaults(42, out.data) });
    expect(out.data.equipment).toEqual([null, null]);
    // The radio continues from the seed's own 'radio' stream, as a new game would.
    expect(out.data.radio.rng).toEqual(createRng(42).stream('radio').state());
    expect(isSaveGame(out.data)).toBe(true);
    expect(isSaveGameV3(out.data)).toBe(true);
    expect(isSaveGameV4(out.data)).toBe(true);
  });

  it('migrates v4 saves to v10: everything kept, no touched people, no saved pedestrians, empty contacts, empty scenes on the seed stream, Phase 4 blocks', () => {
    const v4 = makeSaveGameV4();
    expect(isSaveGameV4(v4)).toBe(true);
    expect(isSaveGameV5(v4)).toBe(false);
    const out = migrateEnvelope(envelope<unknown>(4, v4));
    expect(out.version).toBe(10);
    expect(out.data).toEqual({ ...v4, ...v5Defaults(42), ...v6Defaults(42, '4471'), ...v7Defaults(42), ...v8Defaults(42), ...v9Defaults(42, { name: 'A. Vance', badge: '4471' }, ['patrol_sedan', 'patrol_suv']), ...v10Defaults(42, out.data), equipment: migratedEquipment() });
    expect(out.data.npc).toBeNull();
    expect(out.data.scenes.rng).toEqual(createRng(42).stream('scene').state());
    expect(out.data.scenes.scenarios).toEqual([]);
    expect(isSaveGame(out.data)).toBe(true);
    expect(isSaveGameV4(out.data)).toBe(true);
  });

  it('migrates v5 saves to v10: everything kept, outdoors, empty interior / tactical / investigation on the seed streams, patrol station state, trunks gain the Phase 4 items', () => {
    const v5 = makeSaveGameV5();
    expect(isSaveGameV5(v5)).toBe(true);
    expect(isSaveGameV6(v5)).toBe(false);
    const out = migrateEnvelope(envelope<unknown>(5, v5));
    expect(out.version).toBe(10);
    expect(out.data).toEqual({ ...v5, ...v6Defaults(42, '4471'), ...v7Defaults(42), ...v8Defaults(42), ...v9Defaults(42, { name: 'A. Vance', badge: '4471' }, ['patrol_sedan', 'patrol_suv']), ...v10Defaults(42, out.data), equipment: migratedEquipment() });
    expect(out.data.station.flow).toBe('onPatrol');
    expect(out.data.station.armory.map((e) => e.item)).toEqual(['sidearm', 'taser']);
    expect(out.data.interiors.rng).toEqual(createRng(42).stream('interior').state());
    for (const id of PHASE4_TRUNK_ITEMS) expect(out.data.equipment[0]?.trunk[id]).toBeGreaterThan(0);
    // The old trunk contents are untouched.
    expect(out.data.equipment[0]?.trunk['cones']).toBe(v5.equipment[0]?.trunk['cones']);
    expect(isSaveGame(out.data)).toBe(true);
    expect(migrateV5ToV6(out.data)).toEqual(out.data);
  });

  it('migrates v6 saves to v10: everything kept; force, incidents (generic), conduct (baselines, active) and court start fresh on the seed streams', () => {
    const v6 = makeSaveGameV6();
    expect(isSaveGameV6(v6)).toBe(true);
    expect(isSaveGameV7(v6)).toBe(false);
    const out = migrateEnvelope(envelope<unknown>(6, v6));
    expect(out.version).toBe(10);
    expect(out.data).toEqual({ ...v6, ...v7Defaults(42), ...v8Defaults(42), ...v9Defaults(42, { name: 'A. Vance', badge: '4471' }, ['patrol_sedan', 'patrol_suv']), ...v10Defaults(42, out.data) });
    expect(out.data.incidents.jurisdiction).toBe('generic');
    expect(out.data.incidents.logs).toEqual([]);
    expect(out.data.conduct.status).toBe('active');
    expect(out.data.court.cases).toEqual([]);
    expect(out.data.force.rng).toEqual(createRng(42).stream('force').state());
    expect(isSaveGame(out.data)).toBe(true);
    expect(migrateV6ToV7(out.data)).toEqual(out.data);
    expect(migrateV6ToV7({ seed: 1 })).toEqual({ seed: 1 });
  });

  it('migrates v7 saves to v10: everything kept; roster, resources, backup, pursuit and command start empty on the seed streams', () => {
    const v7 = makeSaveGameV7();
    expect(isSaveGameV7(v7)).toBe(true);
    expect(isSaveGameV8(v7)).toBe(false);
    const out = migrateEnvelope(envelope<unknown>(7, v7));
    expect(out.version).toBe(10);
    expect(out.data).toEqual({ ...v7, ...v8Defaults(42), ...v9Defaults(42, { name: 'A. Vance', badge: '4471' }, ['patrol_sedan', 'patrol_suv']), ...v10Defaults(42, out.data) });
    expect(out.data.roster.officers).toEqual([]);
    expect(out.data.resources.rng).toEqual(createRng(42).stream('resources').state());
    expect(out.data.backup.rng).toEqual(createRng(42).stream('backup').state());
    expect(out.data.pursuit.rng).toEqual(createRng(42).stream('pursuit').state());
    expect(out.data.command.rng).toEqual(createRng(42).stream('command').state());
    expect(isSaveGame(out.data)).toBe(true);
    expect(migrateV7ToV8(out.data)).toEqual(out.data);
    expect(migrateV7ToV8({ seed: 1 })).toEqual({ seed: 1 });
  });

  it('migrates v8 saves to v10: everything kept; the officer becomes a legacy character, default gear, a fleet bound to the saved vehicles', () => {
    const v8 = makeSaveGameV8();
    expect(isSaveGameV8(v8)).toBe(true);
    expect(isSaveGameV9(v8)).toBe(false);
    const out = migrateEnvelope(envelope<unknown>(8, v8));
    expect(out.version).toBe(10);
    expect(out.data).toEqual({ ...v8, ...v9Defaults(42, v8.officer, ['patrol_sedan', 'patrol_suv']), ...v10Defaults(42, out.data) });
    expect(out.data.character.profile.badge).toBe('4471');
    expect(out.data.character.profile.lastName).toBe('Vance');
    // The migrated officer keeps the evidence field kit the earlier phases always gave.
    expect(out.data.gear.loadout.items.some((i) => i.id === 'evidenceKit')).toBe(true);
    expect(out.data.fleet.rng).toEqual(createRng(42).stream('fleet').state());
    expect(out.data.fleet.units.find((u) => u.id === 'P-101')?.vehicleIndex).toBe(0);
    expect(out.data.fleet.units.find((u) => u.id === 'P-102')?.vehicleIndex).toBe(1);
    expect(out.data.fleet.units.find((u) => u.id === 'M-601')?.vehicleIndex).toBe(-1);
    expect(isSaveGame(out.data)).toBe(true);
    expect(migrateV8ToV9(out.data)).toEqual(out.data);
    expect(migrateV8ToV9({ seed: 1 })).toEqual({ seed: 1 });
  });

  it('migrates v9 saves to v10: everything kept; a patrol-officer career from the save time, a blank world, free patrol, no mods', () => {
    const v9 = makeSaveGameV9();
    expect(isSaveGameV9(v9)).toBe(true);
    expect(isSaveGameV10(v9)).toBe(false);
    const out = migrateEnvelope(envelope<unknown>(9, v9));
    expect(out.version).toBe(10);
    expect(out.data).toEqual({ ...v9, ...v10Defaults(42, v9) });
    const nowGame = gameSecondsAt(v9.clock.simTime, v9.environment.timeOffset);
    expect(out.data.career.stage).toBe('patrol');
    expect(out.data.career.shift).toMatchObject({ onDuty: true, shiftNo: 1, startGame: nowGame });
    expect(out.data.career.rng).toEqual(createRng(42).stream('career').state());
    expect(out.data.worldState.rng).toEqual(createRng(42).stream('worldstate').state());
    expect(out.data.worldState.premises).toEqual([]);
    expect(out.data.mode.id).toBe('freePatrol');
    expect(out.data.mods).toEqual([]);
    expect(isSaveGame(out.data)).toBe(true);
    expect(migrateV9ToV10(out.data)).toEqual(out.data);
    expect(migrateV9ToV10({ seed: 1 })).toEqual({ seed: 1 });
  });

  it('rejects every malformed Phase 8 block of a v10 save', () => {
    const good = makeSaveGame();
    expect(isSaveGameV10(good)).toBe(true);
    const bad: [string, unknown][] = [
      ['career missing', { ...good, career: undefined }],
      ['career wrong version', { ...good, career: { ...good.career, version: 2 } }],
      ['career bad stage', { ...good, career: { ...good.career, stage: 'chief' } }],
      ['world missing', { ...good, worldState: null }],
      ['world wrong version', { ...good, worldState: { ...good.worldState, version: 3 } }],
      ['world premises not a list', { ...good, worldState: { ...good.worldState, premises: {} } }],
      ['mode missing', { ...good, mode: undefined }],
      ['mode unknown id', { ...good, mode: { ...good.mode, id: 'arcade' } }],
      ['mods not a list', { ...good, mods: {} }],
      ['mod ref bad hash', { ...good, mods: [{ id: 'a', modVersion: '1.0.0', hash: 'zz' }] }],
      ['mod ref missing id', { ...good, mods: [{ modVersion: '1.0.0', hash: '0123abcd' }] }],
    ];
    for (const [name, value] of bad) expect(isSaveGame(value), name).toBe(false);
    expect(isSaveGame({ ...good, mods: [{ id: 'night-shift-pack', modVersion: '1.0.0', hash: '0123abcd' }] })).toBe(true);
  });

  it('migrateV2ToV3 and migrateV3ToV4 pass invalid data through for validation to reject', () => {
    expect(migrateV2ToV3({ seed: 1 })).toEqual({ seed: 1 });
    expect(migrateV3ToV4({ seed: 1 })).toEqual({ seed: 1 });
    expect(migrateV4ToV5({ seed: 1 })).toEqual({ seed: 1 });
    expect(migrateV5ToV6({ seed: 1 })).toEqual({ seed: 1 });
    expect(() => migrateEnvelope(envelope<unknown>(2, { ...makeSaveGameV2(), camera: {} }))).toThrow(SaveMigrationError);
    expect(() => migrateEnvelope(envelope<unknown>(3, { ...makeSaveGameV3(), vehicles: undefined }))).toThrow(SaveMigrationError);
  });

  it('round-trips a v10 save through structured clone and JSON unchanged', () => {
    const v5 = makeSaveGame();
    expect(isSaveGame(v5)).toBe(true);
    const cloned = structuredClone(v5);
    expect(migrateEnvelope(envelope<unknown>(CURRENT_SAVE_VERSION, cloned)).data).toEqual(v5);
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

  it('rejects a future version even when the payload is a valid current save', () => {
    let caught: unknown;
    try {
      migrateEnvelope(envelope<unknown>(11, makeSaveGame()));
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

describe('v6 nested state', () => {
  it('accepts the Phase 4 blocks in their valid forms', () => {
    expect(isSaveGame(makeSaveGame({ station: migratedStationSave('4071') }))).toBe(true);
    expect(isSaveGame(makeSaveGame())).toBe(true);
  });

  it('rejects each malformed block', () => {
    const good = makeSaveGame();
    const bad: Array<[string, unknown]> = [
      ['interiors missing', { ...good, interiors: undefined }],
      ['interiors wrong version', { ...good, interiors: { ...good.interiors, version: 9 } }],
      ['interiors bad rng', { ...good, interiors: { ...good.interiors, rng: { seed: 1, s: [1, 2] } } }],
      ['tactical missing', { ...good, tactical: undefined }],
      ['tactical wrong version', { ...good, tactical: { ...good.tactical, version: 9 } }],
      ['tactical bad rng', { ...good, tactical: { ...good.tactical, rng: { seed: 1, s: [1] } } }],
      ['investigation missing', { ...good, investigation: undefined }],
      ['investigation wrong version', { ...good, investigation: { ...good.investigation, version: 9 } }],
      ['investigation ledger malformed', { ...good, investigation: { ...good.investigation, ledger: [{ seq: 'x' }] } }],
      ['station missing', { ...good, station: undefined }],
      ['station wrong version', { ...good, station: { ...good.station, version: 2 } }],
      ['station bad flow', { ...good, station: { ...good.station, flow: 'lunch' } }],
      ['station bad loadout', { ...good, station: { ...good.station, loadout: {} } }],
    ];
    for (const [label, data] of bad) {
      expect(isSaveGame(data), label).toBe(false);
      expect(() => migrateEnvelope(envelope<unknown>(CURRENT_SAVE_VERSION, data)), label).toThrow(SaveMigrationError);
    }
  });
});

describe('v7 nested state', () => {
  it('accepts the Phase 5 blocks in their valid forms', () => {
    expect(isSaveGame(makeSaveGame())).toBe(true);
    expect(isSaveGameV7(makeSaveGame())).toBe(true);
    expect(isSaveGame(makeSaveGame({ incidents: emptyIncidentsSave('strict') }))).toBe(true);
  });

  it('rejects each malformed block', () => {
    const good = makeSaveGame();
    const bad: Array<[string, unknown]> = [
      ['force missing', { ...good, force: undefined }],
      ['force wrong version', { ...good, force: { ...good.force, version: 9 } }],
      ['force bad rng', { ...good, force: { ...good.force, rng: { seed: 1, s: [1] } } }],
      ['force bad cartridges', { ...good, force: { ...good.force, cartridges: 'two' } }],
      ['force bad queue', { ...good, force: { ...good.force, queue: [{ kind: 'nuke' }] } }],
      ['incidents missing', { ...good, incidents: undefined }],
      ['incidents wrong version', { ...good, incidents: { ...good.incidents, version: 9 } }],
      ['incidents bad jurisdiction', { ...good, incidents: { ...good.incidents, jurisdiction: 5 } }],
      ['incidents logs not a list', { ...good, incidents: { ...good.incidents, logs: {} } }],
      ['incidents bad cam', { ...good, incidents: { ...good.incidents, cam: { body: 1 } } }],
      ['conduct missing', { ...good, conduct: undefined }],
      ['conduct wrong version', { ...good, conduct: { ...good.conduct, version: 9 } }],
      ['conduct bad rng', { ...good, conduct: { ...good.conduct, rng: { seed: 1, s: [1] } } }],
      ['conduct bad status', { ...good, conduct: { ...good.conduct, status: 'asleep' } }],
      ['court missing', { ...good, court: undefined }],
      ['court wrong version', { ...good, court: { ...good.court, version: 9 } }],
      ['court bad nextId', { ...good, court: { ...good.court, nextId: 'x' } }],
      ['court cases malformed', { ...good, court: { ...good.court, cases: [{ id: 1 }] } }],
    ];
    for (const [label, data] of bad) {
      expect(isSaveGame(data), label).toBe(false);
      expect(() => migrateEnvelope(envelope<unknown>(CURRENT_SAVE_VERSION, data)), label).toThrow(SaveMigrationError);
    }
  });
});

describe('v8 nested state', () => {
  it('accepts the Phase 6 blocks in their valid forms', () => {
    expect(isSaveGame(makeSaveGame())).toBe(true);
    expect(isSaveGameV8(makeSaveGame())).toBe(true);
  });

  it('rejects each malformed block', () => {
    const good = makeSaveGame();
    const bad: Array<[string, unknown]> = [
      ['roster missing', { ...good, roster: undefined }],
      ['roster wrong version', { ...good, roster: { ...good.roster, version: 9 } }],
      ['roster officers not a list', { ...good, roster: { ...good.roster, officers: {} } }],
      ['resources missing', { ...good, resources: undefined }],
      ['resources wrong version', { ...good, resources: { ...good.resources, version: 9 } }],
      ['resources bad rng', { ...good, resources: { ...good.resources, rng: { seed: 1, s: [1] } } }],
      ['resources units not a list', { ...good, resources: { ...good.resources, units: 'x' } }],
      ['backup missing', { ...good, backup: undefined }],
      ['backup wrong version', { ...good, backup: { ...good.backup, version: 9 } }],
      ['backup bad rng', { ...good, backup: { ...good.backup, rng: { seed: 1, s: [1] } } }],
      ['pursuit missing', { ...good, pursuit: undefined }],
      ['pursuit wrong version', { ...good, pursuit: { ...good.pursuit, version: 9 } }],
      ['pursuit bad rng', { ...good, pursuit: { ...good.pursuit, rng: { seed: 1, s: [1] } } }],
      ['command missing', { ...good, command: undefined }],
      ['command wrong version', { ...good, command: { ...good.command, version: 9 } }],
      ['command bad rng', { ...good, command: { ...good.command, rng: { seed: 1, s: [1] } } }],
    ];
    for (const [label, data] of bad) {
      expect(isSaveGame(data), label).toBe(false);
      expect(() => migrateEnvelope(envelope<unknown>(CURRENT_SAVE_VERSION, data)), label).toThrow(SaveMigrationError);
    }
  });
});

describe('v9 nested state', () => {
  it('accepts the Phase 7 blocks in their valid forms', () => {
    expect(isSaveGame(makeSaveGame())).toBe(true);
    expect(isSaveGameV9(makeSaveGame())).toBe(true);
  });

  it('rejects each malformed block', () => {
    const good = makeSaveGame();
    const bad: Array<[string, unknown]> = [
      ['character missing', { ...good, character: undefined }],
      ['character wrong version', { ...good, character: { ...good.character, version: 2 } }],
      ['character bad badge', { ...good, character: { ...good.character, profile: { ...good.character.profile, badge: 'x' } } }],
      ['character bad height', { ...good, character: { ...good.character, profile: { ...good.character.profile, body: { ...good.character.profile.body, heightM: 9 } } } }],
      ['gear missing', { ...good, gear: undefined }],
      ['gear wrong version', { ...good, gear: { ...good.gear, version: 9 } }],
      ['gear loadout not a list', { ...good, gear: { ...good.gear, loadout: {} } }],
      ['fleet missing', { ...good, fleet: undefined }],
      ['fleet wrong version', { ...good, fleet: { ...good.fleet, version: 2 } }],
      ['fleet bad rng', { ...good, fleet: { ...good.fleet, rng: { seed: 1, s: [1] } } }],
      ['fleet units not a list', { ...good, fleet: { ...good.fleet, units: {} } }],
      ['fleet livery malformed', { ...good, fleet: { ...good.fleet, liveries: [{ id: 'x' }] } }],
      ['fleet ledger malformed', { ...good, fleet: { ...good.fleet, ledger: 5 } }],
      ['fleet incident malformed', { ...good, fleet: { ...good.fleet, incidents: [{ id: 1 }] } }],
    ];
    for (const [label, data] of bad) {
      expect(isSaveGame(data), label).toBe(false);
      expect(() => migrateEnvelope(envelope<unknown>(CURRENT_SAVE_VERSION, data)), label).toThrow(SaveMigrationError);
    }
  });

  it('accepts the optional vehicle wear / craft / pushBar blocks and rejects malformed ones', () => {
    const wear = { oilL: 4.5, tread: [1, 0.9, 0.8, 0.7], odometerM: 1200 };
    const craft = { speed: 3, vy: 0, yaw: 1, pitch: 0, roll: 0 };
    expect(isSavedVehicle(makeSavedVehicle({ wear: wear as never, pushBar: true }))).toBe(true);
    expect(isSavedVehicle(makeSavedVehicle({ craft }))).toBe(true);
    expect(isSavedVehicle(makeSavedVehicle({ wear: { ...wear, tread: [1, 1, 1] } as never }))).toBe(false);
    expect(isSavedVehicle(makeSavedVehicle({ wear: { ...wear, tread: [1, 1, 1, 2] } as never }))).toBe(false);
    expect(isSavedVehicle(makeSavedVehicle({ wear: { ...wear, oilL: -1 } as never }))).toBe(false);
    expect(isSavedVehicle(makeSavedVehicle({ craft: { ...craft, yaw: Number.NaN } }))).toBe(false);
    expect(isSavedVehicle(makeSavedVehicle({ pushBar: 'yes' as never }))).toBe(false);
  });

  it('accepts the remote player mode only with a valid vehicle index, and equipment with extra prisoners', () => {
    const good = makeSaveGame();
    expect(isSaveGame({ ...good, player: { mode: 'remote', vehicle: 1, lastVehicle: 0 } })).toBe(true);
    expect(isSaveGame({ ...good, player: { mode: 'remote', vehicle: 9, lastVehicle: 0 } })).toBe(false);
    expect(isSaveGame({ ...good, player: { mode: 'remote', vehicle: -1 } })).toBe(false);
    const eq = { ...(good.equipment[0] as NonNullable<SaveGame['equipment'][number]>), extraPrisoners: [12, -1] };
    expect(isSaveGame({ ...good, equipment: [eq, null] })).toBe(true);
    expect(isSaveGame({ ...good, equipment: [{ ...eq, extraPrisoners: ['x'] }, null] })).toBe(false);
  });
});
