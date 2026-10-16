import { CURRENT_SAVE_VERSION, isSaveGameV1, type SaveEnvelope, type SaveGameV1 } from './schema';

/** Transforms a payload from version N (the table key) to version N + 1. */
export type Migration = (data: unknown) => unknown;
export type MigrationTable = Readonly<Record<number, Migration>>;

/**
 * Forward migrations keyed by the version they migrate FROM.
 * Add `[1]: migrateV1ToV2` when `CURRENT_SAVE_VERSION` becomes 2, and so on.
 */
export const migrations: MigrationTable = {};

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
): SaveEnvelope<SaveGameV1> {
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

  if (!isSaveGameV1(data)) {
    throw new SaveMigrationError(
      MIGRATION_FAILURES.invalidData,
      `Save '${env.slot}' does not match schema version ${CURRENT_SAVE_VERSION}`,
      { ...info, atVersion: version },
    );
  }

  return { ...env, version, data };
}
