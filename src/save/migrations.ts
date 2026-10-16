import { MAX_TIME_SCALE } from '../core/time';
import { CURRENT_SAVE_VERSION, isSaveGame, isSaveGameV1, type SaveEnvelope, type SaveGame, type SaveGameV2 } from './schema';

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

/** Forward migrations keyed by the version they migrate FROM. */
export const migrations: MigrationTable = { 1: migrateV1ToV2 };

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
