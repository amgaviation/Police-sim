import { emptyCadSave } from '../cad/cadState';
import { emptyContactSave } from '../contact/save';
import { createRng } from '../core/rng';
import { MAX_TIME_SCALE } from '../core/time';
import { CAMERA_MODE } from '../player/cameraRig';
import { emptyInteriorSave } from '../indoors/save';
import { emptyInvestigationSave } from '../investigation/save';
import { emptyPeopleSave } from '../people';
import { EQUIPMENT_DATA } from '../police/data';
import { emptyOfficerKit } from '../police/inventory';
import { defaultRadioSave } from '../radio/save';
import { emptyRecordsSave } from '../records/db';
import { emptySceneSave } from '../scene/save';
import { migratedStationSave } from '../station/stationState';
import { defaultTacticalSave } from '../tactical/save';
import {
  CURRENT_SAVE_VERSION,
  isSaveGame,
  isSaveGameV1,
  isSaveGameV2,
  isSaveGameV3,
  isSaveGameV4,
  isSaveGameV5,
  type SaveEnvelope,
  type SaveGame,
  type SaveGameV2,
  type SaveGameV3,
  type SaveGameV4,
  type SaveGameV5,
  type SaveGameV6,
} from './schema';

/** Transforms a payload from version N (the table key) to version N + 1. */
export type Migration = (data: unknown) => unknown;
export type MigrationTable = Readonly<Record<number, Migration>>;

/** Camera pitch v1 saves did not record (the player controller's default). */
export const V1_DEFAULT_PITCH = 0.25;

/**
 * v1 -> v2: adds per-entity motion state (v1 bodies were saved without it, so
 * they load at rest and awake, as before) and the camera pitch, and clamps the
 * time scale to `MAX_TIME_SCALE`. Data that is
 * not a valid v1 payload is passed through for the final validation to reject.
 */
export function migrateV1ToV2(data: unknown): unknown {
  if (!isSaveGameV1(data)) return data;
  const v2: SaveGameV2 = {
    seed: data.seed,
    rngState: data.rngState,
    // v1 builds allowed any time scale >= 0; v2 caps it.
    clock: { simTime: data.clock.simTime, timeScale: Math.min(data.clock.timeScale, MAX_TIME_SCALE) },
    officer: { ...data.officer },
    camera: { pitch: V1_DEFAULT_PITCH },
    world: {
      entities: data.world.entities.map((e) => ({ ...e, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, sleeping: false })),
    },
  };
  return v2;
}

/**
 * v2 -> v3: the Phase 0 demo save becomes a city session. Everything is kept
 * (the officer and debug boxes stay where they were) and the new state gets
 * defaults: on foot, chase camera, no saved vehicles (loading re-parks the two
 * station patrol cars), fresh traffic and the session's own time and weather.
 */
export function migrateV2ToV3(data: unknown): unknown {
  if (!isSaveGameV2(data)) return data;
  const v3: SaveGameV3 = {
    ...data,
    camera: { pitch: data.camera.pitch, mode: CAMERA_MODE.chase },
    player: { mode: 'onFoot', vehicle: -1, lastVehicle: -1 },
    vehicles: [],
    traffic: null,
    violations: [],
    environment: { timeOffset: 0, override: null },
  };
  return v3;
}

/**
 * v3 -> v4: a Phase 1 city session becomes a patrol shift. Everything is kept; the new blocks get
 * defaults: an empty CAD, no dispatcher state (loading adds a fresh roster and fleet), no touched
 * records, the radio at its defaults with the seed's own 'radio' stream, new-car equipment for every
 * vehicle (null entries) and an empty officer kit.
 */
export function migrateV3ToV4(data: unknown): unknown {
  if (!isSaveGameV3(data)) return data;
  const v4: SaveGameV4 = {
    ...data,
    cad: emptyCadSave(),
    dispatch: null,
    records: emptyRecordsSave(),
    radio: defaultRadioSave(createRng(data.seed).stream('radio').state()),
    equipment: data.vehicles.map(() => null),
    officerKit: emptyOfficerKit(),
  };
  return v4;
}

/**
 * v4 -> v5: a Phase 2 patrol shift gets people and calls. Everything is kept; the new blocks start empty:
 * no touched persons, no saved pedestrians (fresh ones at load), no open contacts and an empty scene
 * block with the seed's own 'scene' stream (loading then gives the open CAD calls scenarios).
 */
export function migrateV4ToV5(data: unknown): unknown {
  if (!isSaveGameV4(data)) return data;
  const v5: SaveGameV5 = {
    ...data,
    people: emptyPeopleSave(),
    npc: null,
    contacts: emptyContactSave(),
    scenes: emptySceneSave(createRng(data.seed).stream('scene').state()),
  };
  return v5;
}

/**
 * v5 -> v6: a Phase 3 shift gets interiors and scene work. Everything is kept and the officer stays outdoors; the new
 * blocks start empty with the seed's own 'interior', 'tactical' and 'investigation' streams, the station state is a shift
 * already on patrol with the pistol and the taser signed out, and each patrol car's trunk gains the Phase 4 items it lacks
 * (counts from the `patrol` trunk loadout).
 */
export function migrateV5ToV6(data: unknown): unknown {
  if (!isSaveGameV5(data)) return data;
  const stream = (name: string) => createRng(data.seed).stream(name).state();
  const loadout = EQUIPMENT_DATA.trunkLoadouts['patrol'] ?? {};
  const v6: SaveGameV6 = {
    ...data,
    equipment: data.equipment.map((eq) => {
      if (eq === null) return null;
      const trunk = { ...eq.trunk };
      for (const id of PHASE4_TRUNK_ITEMS) {
        if (trunk[id] === undefined) trunk[id] = loadout[id] ?? 0;
      }
      return { ...eq, trunk };
    }),
    interiors: emptyInteriorSave(stream('interior')),
    tactical: defaultTacticalSave(stream('tactical')),
    investigation: emptyInvestigationSave(stream('investigation')),
    station: migratedStationSave(data.officer.badge),
  };
  return v6;
}

/** Trunk items Phase 4 added (a v5 trunk lacks them). */
const PHASE4_TRUNK_ITEMS = ['ram', 'sceneTape', 'evidenceMarkers', 'evidenceBags', 'fingerprintKit', 'camera'] as const;

/** Forward migrations keyed by the version they migrate FROM. */
export const migrations: MigrationTable = {
  1: migrateV1ToV2,
  2: migrateV2ToV3,
  3: migrateV3ToV4,
  4: migrateV4ToV5,
  5: migrateV5ToV6,
};

export const MIGRATION_FAILURES = {
  missingStep: 'missing-step',
  stepThrew: 'step-threw',
  futureVersion: 'future-version',
  invalidData: 'invalid-data',
} as const;
export type MigrationFailure = (typeof MIGRATION_FAILURES)[keyof typeof MIGRATION_FAILURES];

export class SaveMigrationError extends Error {
  readonly reason: MigrationFailure;
  readonly slot: string;
  readonly fromVersion: number;
  readonly atVersion: number;

  constructor(
    reason: MigrationFailure,
    message: string,
    info: { slot: string; fromVersion: number; atVersion: number },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SaveMigrationError';
    this.reason = reason;
    this.slot = info.slot;
    this.fromVersion = info.fromVersion;
    this.atVersion = info.atVersion;
  }
}

/**
 * Applies migrations sequentially from `env.version` up to
 * `CURRENT_SAVE_VERSION`, then validates the result. Throws
 * `SaveMigrationError` when a step is missing or throws, when the envelope is
 * from a newer version than this build, or when the final payload is invalid.
 */
export function migrateEnvelope(
  env: SaveEnvelope<unknown>,
  migrationsTable: MigrationTable = migrations,
): SaveEnvelope<SaveGame> {
  const fromVersion = env.version;
  const info = { slot: env.slot, fromVersion, atVersion: fromVersion };

  if (fromVersion > CURRENT_SAVE_VERSION) {
    throw new SaveMigrationError(
      MIGRATION_FAILURES.futureVersion,
      `Save '${env.slot}' is version ${fromVersion}, newer than supported ${CURRENT_SAVE_VERSION}`,
      info,
    );
  }

  let data = env.data;
  let version = fromVersion;
  while (version < CURRENT_SAVE_VERSION) {
    const step = migrationsTable[version];
    if (step === undefined) {
      throw new SaveMigrationError(
        MIGRATION_FAILURES.missingStep,
        `No migration from save version ${version} to ${version + 1}`,
        { ...info, atVersion: version },
      );
    }
    try {
      data = step(data);
    } catch (error) {
      throw new SaveMigrationError(
        MIGRATION_FAILURES.stepThrew,
        `Migration from save version ${version} to ${version + 1} failed`,
        { ...info, atVersion: version },
        { cause: error },
      );
    }
    version += 1;
  }

  if (!isSaveGame(data)) {
    throw new SaveMigrationError(
      MIGRATION_FAILURES.invalidData,
      `Save '${env.slot}' does not match schema version ${CURRENT_SAVE_VERSION}`,
      { ...info, atVersion: version },
    );
  }

  return { ...env, version, data };
}
