import type { EventMap } from '../core/event-map';
import { bus as appBus, type EventBus } from '../core/events';
import { log } from '../core/log';
import { SETTINGS_KEY, STORES, dbDelete, dbEntries, dbGet, dbPut, dbUpdate, openPatrolDb } from './db';
import { MIGRATION_FAILURES, SaveMigrationError, migrateEnvelope, migrations, type MigrationTable } from './migrations';
import { CURRENT_SAVE_VERSION, isSaveEnvelope, isSaveGame, type SaveEnvelope, type SaveGame } from './schema';

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
 * Slot-based persistence for `SaveGame`. Loading migrates old envelopes,
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

  /**
   * Writes `data` to `slot`, preserving `createdAt` when the slot already
   * exists (read and write share one transaction). Throws
   * `SaveMigrationError('invalid-data')` without touching the slot when
   * `data` would not load back, e.g. a non-finite value.
   */
  async save(slot: string, data: SaveGame): Promise<void> {
    const now = this.now();
    if (!isSaveGame(data)) {
      throw new SaveMigrationError(MIGRATION_FAILURES.invalidData, `Refusing to write an invalid save to '${slot}'`, {
        slot,
        fromVersion: CURRENT_SAVE_VERSION,
        atVersion: CURRENT_SAVE_VERSION,
      });
    }
    const db = await this.db();
    await dbUpdate<SaveEnvelope<SaveGame>>(db, STORES.saves, slot, (existing) => ({
      version: CURRENT_SAVE_VERSION,
      createdAt: isSaveEnvelope(existing) ? existing.createdAt : now,
      updatedAt: now,
      slot,
      data,
    }));
    this.bus.emit('save:completed', { slot });
  }

  /**
   * Reads `slot`, migrating to `CURRENT_SAVE_VERSION` if needed. A migrated
   * envelope is written back so the next load is direct. Throws
   * `SaveNotFoundError` for an empty slot and `SaveMigrationError` for
   * corrupt, unmigratable, or newer-than-supported data.
   */
  async load(slot: string): Promise<SaveEnvelope<SaveGame>> {
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
    // The store key is authoritative; a disagreeing `slot` field is repaired on write-back.
    const envelope = migrateEnvelope({ ...raw, slot }, this.migrationsTable);
    if (envelope.version !== raw.version || raw.slot !== slot) await this.writeBack(db, slot, raw, envelope);
    this.bus.emit('save:loaded', { slot });
    return envelope;
  }

  /**
   * Best-effort write-back of a migrated envelope. It replaces the slot only if
   * the slot still holds the record that was read (a save() in between wins),
   * and a failed write is logged: the migrated envelope is valid either way.
   */
  private async writeBack(db: IDBDatabase, slot: string, read: SaveEnvelope<unknown>, envelope: SaveEnvelope<SaveGame>): Promise<void> {
    try {
      await dbUpdate(db, STORES.saves, slot, (current) => {
        if (!isSaveEnvelope(current) || !sameRecord(current, read)) throw new StaleWriteBack();
        return envelope;
      });
    } catch (error) {
      if (!(error instanceof StaleWriteBack)) log.warn(`Could not persist the migrated save '${slot}':`, error);
    }
  }

  /** Summaries of every readable slot (named by store key), most recently updated first. */
  async list(): Promise<SaveSummary[]> {
    const db = await this.db();
    const rows = await dbEntries<unknown>(db, STORES.saves);
    const summaries: SaveSummary[] = [];
    for (const { key, value: row } of rows) {
      if (typeof key !== 'string' || !isSaveEnvelope(row)) continue;
      summaries.push({
        slot: key,
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
  startAutosave(intervalMs: number, provider: () => SaveGame, slot: string = AUTOSAVE_SLOT): void {
    this.stopAutosave();
    this.autosaveTimer = setInterval(() => {
      if (this.autosavePending !== null) return;
      let data: SaveGame;
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
    if (this.dbPromise) return this.dbPromise;
    // A connection closed by a newer tab's upgrade or by the browser is dropped and reopened on next use.
    const pending: Promise<IDBDatabase> = openPatrolDb(this.factory, () => {
      if (this.dbPromise === pending) this.dbPromise = null;
    }).catch((error: unknown) => {
      if (this.dbPromise === pending) this.dbPromise = null;
      throw error;
    });
    this.dbPromise = pending;
    return pending;
  }
}

/** Aborts a write-back whose slot changed after it was read. */
class StaleWriteBack extends Error {}

function sameRecord(a: SaveEnvelope<unknown>, b: SaveEnvelope<unknown>): boolean {
  return a.version === b.version && a.slot === b.slot && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt;
}

function officerNameOf(data: unknown): string {
  if (typeof data !== 'object' || data === null) return '';
  const officer = (data as Record<string, unknown>)['officer'];
  if (typeof officer !== 'object' || officer === null) return '';
  const name = (officer as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : '';
}

/**
 * Settings blob storage over one long-lived connection, so a write issued from a
 * page-hide handler creates its transaction synchronously (no async open first).
 * A connection closed by the browser or a newer tab is reopened on next use.
 */
export class SettingsBlobStore {
  private readonly factory: IDBFactory | undefined;
  private db: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;
  /** Bumped by `close()`, so an open still in flight knows it was abandoned. */
  private generation = 0;

  constructor(factory?: IDBFactory) {
    this.factory = factory;
  }

  /** Reads the blob (and opens the connection for later writes). */
  async read(): Promise<unknown> {
    const db = await this.connection();
    try {
      return await dbGet<unknown>(db, STORES.settings, SETTINGS_KEY);
    } finally {
      this.releaseIfStale(db);
    }
  }

  /** Replaces the blob; the transaction starts synchronously when the connection is open. */
  async write(value: unknown): Promise<void> {
    const db = this.db ?? (await this.connection());
    try {
      await dbPut(db, STORES.settings, SETTINGS_KEY, value);
    } finally {
      this.releaseIfStale(db);
    }
  }

  /** Closes the connection (also one still opening); a later read or write reopens it. */
  close(): void {
    this.generation += 1;
    this.opening = null;
    this.db?.close();
    this.db = null;
  }

  /** Closes a connection that `close()` abandoned once its caller is done with it. */
  private releaseIfStale(db: IDBDatabase): void {
    if (db !== this.db) db.close();
  }

  private connection(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    if (this.opening) return this.opening;
    const generation = this.generation;
    let opened: IDBDatabase | null = null;
    const opening: Promise<IDBDatabase> = openPatrolDb(this.factory, () => {
      if (opened !== null && this.db === opened) this.db = null;
    }).then(
      (db) => {
        opened = db;
        if (this.opening === opening) this.opening = null;
        // Closed while opening: the caller still gets the connection for its one
        // request and closes it afterwards (releaseIfStale).
        if (generation === this.generation) this.db = db;
        return db;
      },
      (error: unknown) => {
        if (this.opening === opening) this.opening = null;
        throw error;
      },
    );
    this.opening = opening;
    return opening;
  }
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
