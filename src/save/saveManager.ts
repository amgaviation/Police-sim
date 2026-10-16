import type { EventMap } from '../core/event-map';
import { bus as appBus, type EventBus } from '../core/events';
import { log } from '../core/log';
import { SETTINGS_KEY, STORES, dbDelete, dbGet, dbGetAll, dbPut, openPatrolDb } from './db';
import { MIGRATION_FAILURES, SaveMigrationError, migrateEnvelope, migrations, type MigrationTable } from './migrations';
import { CURRENT_SAVE_VERSION, isSaveEnvelope, type SaveEnvelope, type SaveGameV1 } from './schema';

export const AUTOSAVE_SLOT = 'autosave';

export interface SaveSummary {
  slot: string;
  createdAt: number;
  updatedAt: number;
  officerName: string;
  version: number;
}

export class SaveNotFoundError extends Error {
  readonly slot: string;

  constructor(slot: string) {
    super(`No save in slot '${slot}'`);
    this.name = 'SaveNotFoundError';
    this.slot = slot;
  }
}

export interface SaveManagerOptions {
  /** IndexedDB factory; defaults to the global `indexedDB` (tests inject a fresh one). */
  factory?: IDBFactory;
  bus?: EventBus<EventMap>;
  /** Clock for `createdAt`/`updatedAt`; defaults to `Date.now`. */
  now?: () => number;
  migrationsTable?: MigrationTable;
}

/**
 * Slot-based persistence for `SaveGameV1`. Loading migrates old envelopes,
 * validates them, and writes the upgraded envelope back.
 */
export class SaveManager {
  private readonly factory: IDBFactory | undefined;
  private readonly bus: EventBus<EventMap>;
  private readonly now: () => number;
  private readonly migrationsTable: MigrationTable;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private autosaveTimer: ReturnType<typeof setInterval> | null = null;
  private autosavePending: Promise<void> | null = null;

  constructor(options: SaveManagerOptions = {}) {
    this.factory = options.factory;
    this.bus = options.bus ?? appBus;
    this.now = options.now ?? Date.now;
    this.migrationsTable = options.migrationsTable ?? migrations;
  }

  /** Writes `data` to `slot`, preserving `createdAt` when the slot already exists. */
  async save(slot: string, data: SaveGameV1): Promise<void> {
    const db = await this.db();
    const existing = await dbGet<unknown>(db, STORES.saves, slot);
    const now = this.now();
    const envelope: SaveEnvelope<SaveGameV1> = {
      version: CURRENT_SAVE_VERSION,
      createdAt: isSaveEnvelope(existing) ? existing.createdAt : now,
      updatedAt: now,
      slot,
      data,
    };
    await dbPut(db, STORES.saves, slot, envelope);
    this.bus.emit('save:completed', { slot });
  }

  /**
   * Reads `slot`, migrating to `CURRENT_SAVE_VERSION` if needed. A migrated
   * envelope is written back so the next load is direct. Throws
   * `SaveNotFoundError` for an empty slot and `SaveMigrationError` for
   * corrupt, unmigratable, or newer-than-supported data.
   */
  async load(slot: string): Promise<SaveEnvelope<SaveGameV1>> {
    const db = await this.db();
    const raw = await dbGet<unknown>(db, STORES.saves, slot);
    if (raw === undefined) throw new SaveNotFoundError(slot);
    if (!isSaveEnvelope(raw)) {
      throw new SaveMigrationError(
        MIGRATION_FAILURES.invalidData,
        `Save '${slot}' is not a valid save envelope`,
        { slot, fromVersion: -1, atVersion: -1 },
      );
    }
    const envelope = migrateEnvelope(raw, this.migrationsTable);
    if (envelope.version !== raw.version) {
      await dbPut(db, STORES.saves, slot, envelope);
    }
    this.bus.emit('save:loaded', { slot });
    return envelope;
  }

  /** Summaries of every readable slot, most recently updated first. */
  async list(): Promise<SaveSummary[]> {
    const db = await this.db();
    const rows = await dbGetAll<unknown>(db, STORES.saves);
    const summaries: SaveSummary[] = [];
    for (const row of rows) {
      if (!isSaveEnvelope(row)) continue;
      summaries.push({
        slot: row.slot,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        officerName: officerNameOf(row.data),
        version: row.version,
      });
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt || a.slot.localeCompare(b.slot));
    return summaries;
  }

  async delete(slot: string): Promise<void> {
    const db = await this.db();
    await dbDelete(db, STORES.saves, slot);
  }

  /**
   * Saves `provider()` into `slot` every `intervalMs`. A tick is skipped while
   * a previous autosave is still writing; failures are logged, not thrown.
   */
  startAutosave(intervalMs: number, provider: () => SaveGameV1, slot: string = AUTOSAVE_SLOT): void {
    this.stopAutosave();
    this.autosaveTimer = setInterval(() => {
      if (this.autosavePending !== null) return;
      let data: SaveGameV1;
      try {
        data = provider();
      } catch (error) {
        log.error('Autosave provider threw:', error);
        return;
      }
      this.autosavePending = this.save(slot, data)
        .catch((error: unknown) => {
          log.error('Autosave failed:', error);
        })
        .finally(() => {
          this.autosavePending = null;
        });
    }, intervalMs);
  }

  /** Stops the autosave timer; an autosave already in flight still completes. */
  stopAutosave(): void {
    if (this.autosaveTimer === null) return;
    clearInterval(this.autosaveTimer);
    this.autosaveTimer = null;
  }

  get autosaveRunning(): boolean {
    return this.autosaveTimer !== null;
  }

  /** Resolves once any in-flight autosave has finished (immediately if none). */
  whenAutosaveIdle(): Promise<void> {
    return this.autosavePending ?? Promise.resolve();
  }

  /** Stops autosave and closes the database connection. */
  close(): void {
    this.stopAutosave();
    const pending = this.dbPromise;
    this.dbPromise = null;
    if (pending) {
      void pending.then((db) => {
        db.close();
      }, () => undefined);
    }
  }

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= openPatrolDb(this.factory).catch((error: unknown) => {
      this.dbPromise = null;
      throw error;
    });
    return this.dbPromise;
  }
}

function officerNameOf(data: unknown): string {
  if (typeof data !== 'object' || data === null) return '';
  const officer = (data as Record<string, unknown>)['officer'];
  if (typeof officer !== 'object' || officer === null) return '';
  const name = (officer as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : '';
}

/** Reads the opaque settings blob, or `undefined` when none has been written. */
export async function readSettingsBlob(factory?: IDBFactory): Promise<unknown> {
  const db = await openPatrolDb(factory);
  try {
    return await dbGet<unknown>(db, STORES.settings, SETTINGS_KEY);
  } finally {
    db.close();
  }
}

/** Replaces the settings blob. The value must be structured-cloneable. */
export async function writeSettingsBlob(value: unknown, factory?: IDBFactory): Promise<void> {
  const db = await openPatrolDb(factory);
  try {
    await dbPut(db, STORES.settings, SETTINGS_KEY, value);
  } finally {
    db.close();
  }
}
