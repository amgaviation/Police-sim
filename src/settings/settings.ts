import type { EventMap } from '../core/event-map';
import { bus as defaultBus, type EventBus } from '../core/events';
import { log } from '../core/log';
import {
  DEFAULT_BINDINGS,
  cloneBindings,
  parseBindings,
  serializeBindings,
  type BindingMap,
  type SerializedBindings,
} from '../input/bindings';
import { SettingsBlobStore } from '../save/saveManager';

/** Bump when the persisted shape changes and add a step to `SETTINGS_MIGRATIONS`. */
export const SETTINGS_VERSION = 1;

export type ShadowQuality = 'off' | 'low' | 'high';
export type FrameCap = 0 | 30 | 60 | 120;
export type ColorblindMode = 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia';

export interface GraphicsSettings {
  renderScale: number;
  shadows: ShadowQuality;
  fov: number;
  /** Frames per second; 0 means uncapped (display refresh). */
  frameCap: FrameCap;
  drawDistance: number;
}

export interface AudioSettings {
  master: number;
  sfx: number;
  radio: number;
  music: number;
  /** Web Speech voice name; null picks the browser default. */
  ttsVoice: string | null;
}

export interface ControlsSettings {
  mouseSensitivity: number;
  invertY: boolean;
  gamepadDeadzone: number;
  bindings: BindingMap;
}

export interface AccessibilitySettings {
  textScale: number;
  colorblind: ColorblindMode;
  reducedFlash: boolean;
  subtitles: boolean;
  oneHanded: boolean;
}

export interface Settings {
  version: number;
  graphics: GraphicsSettings;
  audio: AudioSettings;
  controls: ControlsSettings;
  accessibility: AccessibilitySettings;
}

export const SETTINGS_SECTIONS = ['graphics', 'audio', 'controls', 'accessibility'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Dotted `section.key` path of every leaf setting. */
export type SettingsPath = {
  [S in SettingsSection]: `${S}.${keyof Settings[S] & string}`;
}[SettingsSection];

/** Value type stored at `P`. */
export type SettingsValue<P extends SettingsPath> = P extends `${infer S}.${infer K}`
  ? S extends SettingsSection
    ? K extends keyof Settings[S]
      ? Settings[S][K]
      : never
    : never
  : never;

// --- Field table --------------------------------------------------------------

interface FieldBase {
  readonly label: string;
  /** False for settings that are stored but not consumed by anything yet; the menu hides them. */
  readonly implemented?: boolean;
}

export interface NumberField extends FieldBase {
  readonly kind: 'number';
  readonly min: number;
  readonly max: number;
  /** UI slider granularity; values are clamped, not snapped. */
  readonly step: number;
  readonly unit?: string;
}

export interface EnumOption {
  readonly value: string | number;
  readonly label: string;
}

export interface EnumField extends FieldBase {
  readonly kind: 'enum';
  readonly options: readonly EnumOption[];
}

export interface BooleanField extends FieldBase {
  readonly kind: 'boolean';
}

export interface TextField extends FieldBase {
  readonly kind: 'text';
  /** When true an empty string is stored as null. */
  readonly nullable: boolean;
  readonly placeholder?: string;
}

export interface BindingsField extends FieldBase {
  readonly kind: 'bindings';
}

export type SettingsField = NumberField | EnumField | BooleanField | TextField | BindingsField;

/** Declarative description of every setting; drives validation and the settings menu. */
export const SETTINGS_FIELDS = {
  'graphics.renderScale': { kind: 'number', label: 'Render scale', min: 0.5, max: 2, step: 0.05, unit: 'x' },
  'graphics.shadows': {
    kind: 'enum',
    label: 'Shadows',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
    ],
  },
  'graphics.fov': { kind: 'number', label: 'Field of view', min: 60, max: 110, step: 1, unit: '°' },
  'graphics.frameCap': {
    kind: 'enum',
    label: 'Frame cap',
    options: [
      { value: 0, label: 'Uncapped' },
      { value: 30, label: '30 fps' },
      { value: 60, label: '60 fps' },
      { value: 120, label: '120 fps' },
    ],
  },
  'graphics.drawDistance': { kind: 'number', label: 'Draw distance', min: 200, max: 2000, step: 50, unit: 'm' },
  // Audio arrives in a later phase; the values persist but nothing plays yet.
  'audio.master': { kind: 'number', label: 'Master volume', min: 0, max: 1, step: 0.01, implemented: false },
  'audio.sfx': { kind: 'number', label: 'Effects volume', min: 0, max: 1, step: 0.01, implemented: false },
  'audio.radio': { kind: 'number', label: 'Radio volume', min: 0, max: 1, step: 0.01, implemented: false },
  'audio.music': { kind: 'number', label: 'Music volume', min: 0, max: 1, step: 0.01, implemented: false },
  'audio.ttsVoice': {
    kind: 'text',
    label: 'Dispatch voice',
    nullable: true,
    placeholder: 'Browser default',
    implemented: false,
  },
  'controls.mouseSensitivity': { kind: 'number', label: 'Mouse sensitivity', min: 0.1, max: 5, step: 0.05 },
  'controls.invertY': { kind: 'boolean', label: 'Invert look Y' },
  'controls.gamepadDeadzone': { kind: 'number', label: 'Gamepad deadzone', min: 0, max: 0.5, step: 0.01 },
  'controls.bindings': { kind: 'bindings', label: 'Key bindings' },
  'accessibility.textScale': { kind: 'number', label: 'Text size', min: 0.8, max: 1.6, step: 0.05, unit: 'x' },
  'accessibility.colorblind': {
    kind: 'enum',
    label: 'Color vision',
    implemented: false,
    options: [
      { value: 'none', label: 'Default' },
      { value: 'protanopia', label: 'Protanopia' },
      { value: 'deuteranopia', label: 'Deuteranopia' },
      { value: 'tritanopia', label: 'Tritanopia' },
    ],
  },
  'accessibility.reducedFlash': { kind: 'boolean', label: 'Reduce flashing lights' },
  'accessibility.subtitles': { kind: 'boolean', label: 'Subtitles', implemented: false },
  'accessibility.oneHanded': { kind: 'boolean', label: 'One-handed mode', implemented: false },
} as const satisfies Record<SettingsPath, SettingsField>;

/** All setting paths in declaration order. */
export const SETTINGS_PATHS: readonly SettingsPath[] = Object.keys(SETTINGS_FIELDS) as SettingsPath[];

export function isSettingsPath(value: unknown): value is SettingsPath {
  return typeof value === 'string' && Object.hasOwn(SETTINGS_FIELDS, value);
}

export function settingsField(path: SettingsPath): SettingsField {
  return SETTINGS_FIELDS[path];
}

/** Paths belonging to one section, in declaration order. */
export function fieldsOfSection(section: SettingsSection): SettingsPath[] {
  return SETTINGS_PATHS.filter((p) => p.startsWith(`${section}.`));
}

/** True when something in the game consumes the setting (the menu only shows these). */
export function isImplemented(path: SettingsPath): boolean {
  return settingsField(path).implemented !== false;
}

/** Sections with at least one implemented setting, in menu order. */
export function visibleSections(): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => fieldsOfSection(section).some(isImplemented));
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  version: SETTINGS_VERSION,
  graphics: { renderScale: 1, shadows: 'low', fov: 75, frameCap: 0, drawDistance: 800 },
  audio: { master: 0.8, sfx: 1, radio: 1, music: 0.6, ttsVoice: null },
  controls: { mouseSensitivity: 1, invertY: false, gamepadDeadzone: 0.15, bindings: cloneBindings(DEFAULT_BINDINGS) },
  accessibility: { textScale: 1, colorblind: 'none', reducedFlash: false, subtitles: true, oneHanded: false },
};

// --- Pure helpers -------------------------------------------------------------

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function splitPath(path: SettingsPath): [SettingsSection, string] {
  const dot = path.indexOf('.');
  return [path.slice(0, dot) as SettingsSection, path.slice(dot + 1)];
}

export function cloneSettings(settings: Readonly<Settings>): Settings {
  return {
    version: settings.version,
    graphics: { ...settings.graphics },
    audio: { ...settings.audio },
    controls: { ...settings.controls, bindings: cloneBindings(settings.controls.bindings) },
    accessibility: { ...settings.accessibility },
  };
}

/** Reads the value at `path` (bindings are returned as a copy). */
export function getSetting<P extends SettingsPath>(settings: Readonly<Settings>, path: P): SettingsValue<P> {
  const [section, key] = splitPath(path);
  const value = (settings[section] as unknown as AnyRecord)[key];
  return (path === 'controls.bindings' ? cloneBindings(value as BindingMap) : value) as SettingsValue<P>;
}

/** Writes `value` at `path` without validation; see `coerceSetting`. */
export function setSettingRaw<P extends SettingsPath>(settings: Settings, path: P, value: SettingsValue<P>): void {
  const [section, key] = splitPath(path);
  (settings[section] as unknown as AnyRecord)[key] = value;
}

/**
 * Normalizes untrusted `value` for `path` against the field table: numbers
 * are clamped into range, enums/booleans must match exactly, text may be
 * null when nullable, bindings go through `parseBindings`. Returns
 * `undefined` when the value cannot be accepted.
 */
export function coerceSetting<P extends SettingsPath>(path: P, value: unknown): SettingsValue<P> | undefined {
  const field: SettingsField = SETTINGS_FIELDS[path];
  let out: unknown;
  switch (field.kind) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      out = Math.min(field.max, Math.max(field.min, value));
      break;
    case 'enum':
      if (!field.options.some((o) => o.value === value)) return undefined;
      out = value;
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return undefined;
      out = value;
      break;
    case 'text':
      if (value === null || value === '') {
        if (!field.nullable) return undefined;
        out = null;
      } else if (typeof value === 'string') {
        out = value;
      } else {
        return undefined;
      }
      break;
    case 'bindings':
      if (!isRecord(value)) return undefined;
      out = parseBindings(value);
      break;
  }
  return out as SettingsValue<P>;
}

export function settingsEqual<P extends SettingsPath>(path: P, a: SettingsValue<P>, b: SettingsValue<P>): boolean {
  if (path === 'controls.bindings') return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

// --- Serialization and migration ------------------------------------------------

export interface SerializedSettings {
  readonly version: number;
  readonly graphics: GraphicsSettings;
  readonly audio: AudioSettings;
  readonly controls: Omit<ControlsSettings, 'bindings'> & { readonly bindings: SerializedBindings };
  readonly accessibility: AccessibilitySettings;
}

/** Plain-JSON form stored in the settings blob. */
export function serializeSettings(settings: Readonly<Settings>): SerializedSettings {
  const { bindings, ...controls } = settings.controls;
  return {
    version: SETTINGS_VERSION,
    graphics: { ...settings.graphics },
    audio: { ...settings.audio },
    controls: { ...controls, bindings: serializeBindings(bindings) },
    accessibility: { ...settings.accessibility },
  };
}

/** Rewrites a blob of version N into version N+1; keyed by FROM version. */
export type SettingsMigration = (data: AnyRecord) => AnyRecord;
export type SettingsMigrationTable = Readonly<Record<number, SettingsMigration>>;

export const SETTINGS_MIGRATIONS: SettingsMigrationTable = {};

/**
 * Applies migrations from the blob's `version` up to `SETTINGS_VERSION`. A
 * missing `version` is treated as current (partial input). A missing step or
 * a future version is logged and the data is passed through unchanged so
 * per-field parsing can still salvage what it recognizes.
 */
export function migrateSettings(data: AnyRecord, table: SettingsMigrationTable = SETTINGS_MIGRATIONS): AnyRecord {
  const raw = data['version'];
  let version = typeof raw === 'number' && Number.isInteger(raw) ? raw : SETTINGS_VERSION;
  if (version > SETTINGS_VERSION) {
    log.warn(`Settings blob is version ${version}, newer than ${SETTINGS_VERSION}; loading best-effort`);
    return data;
  }
  let current = data;
  while (version < SETTINGS_VERSION) {
    const step = table[version];
    if (!step) {
      log.warn(`No settings migration from version ${version}; using defaults for unknown fields`);
      break;
    }
    current = { ...step(current), version: version + 1 };
    version += 1;
  }
  return current;
}

/**
 * Builds a complete, valid `Settings` from untrusted data (a previous blob,
 * a partial override or garbage). Unknown keys are ignored, invalid or
 * missing values fall back to defaults, and older versions are migrated.
 */
export function parseSettings(input: unknown, table: SettingsMigrationTable = SETTINGS_MIGRATIONS): Settings {
  const out = cloneSettings(DEFAULT_SETTINGS);
  if (!isRecord(input)) return out;
  const data = migrateSettings(input, table);
  for (const path of SETTINGS_PATHS) {
    const [section, key] = splitPath(path);
    const group = data[section];
    if (!isRecord(group) || group[key] === undefined) continue;
    const value = coerceSetting(path, group[key]);
    if (value !== undefined) setSettingRaw(out, path, value);
  }
  return out;
}

// --- Store --------------------------------------------------------------------

export interface SettingsChange {
  /** A leaf path, or `'*'` when the whole object was replaced (load/reset). */
  readonly path: SettingsPath | '*';
  readonly value: unknown;
}

export type SettingsListener = (change: SettingsChange, settings: Readonly<Settings>) => void;

/** Backing store for the blob; defaults to IndexedDB via `save/saveManager`. */
export interface SettingsStorage {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
  /** Releases the backing connection, if any (called by `SettingsStore.dispose`). */
  close?(): void;
}

export interface SettingsStoreOptions {
  bus?: EventBus<EventMap>;
  storage?: SettingsStorage;
  /** IndexedDB factory for the default storage (tests inject fake-indexeddb). */
  factory?: IDBFactory;
  /** Debounce for automatic saves after a change; 0 disables autosave. Default 500. */
  autosaveDelayMs?: number;
  migrations?: SettingsMigrationTable;
}

function idbStorage(factory?: IDBFactory): SettingsStorage {
  return new SettingsBlobStore(factory);
}

/**
 * Holds the live settings, validates writes against the field table, and
 * publishes changes to subscribers and the event bus as `'settings:changed'`.
 */
export class SettingsStore {
  private state: Settings = cloneSettings(DEFAULT_SETTINGS);
  private readonly listeners = new Set<SettingsListener>();
  private readonly bus: EventBus<EventMap>;
  private readonly storage: SettingsStorage;
  private readonly autosaveDelayMs: number;
  private readonly migrations: SettingsMigrationTable;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSave: Promise<void> | null = null;
  /** Version of a stored blob newer than this build; while set, nothing is written over it. */
  private newerBlobVersion: number | null = null;

  constructor(options: SettingsStoreOptions = {}) {
    this.bus = options.bus ?? defaultBus;
    this.storage = options.storage ?? idbStorage(options.factory);
    this.autosaveDelayMs = options.autosaveDelayMs ?? 500;
    this.migrations = options.migrations ?? SETTINGS_MIGRATIONS;
  }

  /** Returns a deep copy of all settings, or the value at `path`. */
  get(): Settings;
  get<P extends SettingsPath>(path: P): SettingsValue<P>;
  get<P extends SettingsPath>(path?: P): Settings | SettingsValue<P> {
    return path === undefined ? cloneSettings(this.state) : getSetting(this.state, path);
  }

  /**
   * Validates and stores `value` at `path`. Returns true when the stored
   * value changed. Throws `TypeError` when the value is not acceptable.
   */
  set<P extends SettingsPath>(path: P, value: SettingsValue<P>): boolean {
    const coerced = coerceSetting(path, value);
    if (coerced === undefined) throw new TypeError(`Invalid value for '${path}': ${JSON.stringify(value)}`);
    return this.store(path, coerced);
  }

  /**
   * Untyped variant for UI controls and the console: returns false (without
   * throwing) when `path` is unknown or `value` is rejected.
   */
  trySet(path: string, value: unknown): boolean {
    if (!isSettingsPath(path)) return false;
    const coerced = coerceSetting(path, value);
    if (coerced === undefined) return false;
    return this.store(path, coerced);
  }

  /** Applies several changes at once; invalid entries throw before any change is applied. */
  setMany(values: Partial<{ [P in SettingsPath]: SettingsValue<P> }>): void {
    const entries = Object.entries(values) as [SettingsPath, unknown][];
    for (const [path, value] of entries) {
      if (!isSettingsPath(path) || coerceSetting(path, value) === undefined) {
        throw new TypeError(`Invalid value for '${path}': ${JSON.stringify(value)}`);
      }
    }
    for (const [path, value] of entries) this.trySet(path, value);
  }

  private store<P extends SettingsPath>(path: P, value: SettingsValue<P>): boolean {
    const current = getSetting(this.state, path);
    if (settingsEqual(path, current, value)) return false;
    setSettingRaw(this.state, path, value);
    this.notify(path, getSetting(this.state, path));
    return true;
  }

  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Reads the blob, migrates and validates it, then notifies with path `'*'`.
   * Settings are best-effort: when storage cannot be read the defaults are used.
   */
  async load(): Promise<void> {
    let blob: unknown;
    try {
      blob = await this.storage.read();
    } catch (error) {
      log.error('Settings could not be read; using defaults:', error);
      blob = undefined;
    }
    const version = isRecord(blob) ? blob['version'] : undefined;
    this.newerBlobVersion = typeof version === 'number' && version > SETTINGS_VERSION ? version : null;
    if (this.newerBlobVersion !== null) {
      log.warn(`Settings were saved by a newer version (${this.newerBlobVersion}); changes will not be saved over them`);
    }
    this.state = parseSettings(blob, this.migrations);
    this.notify('*', this.get(), false);
  }

  /**
   * Writes the blob immediately (cancelling any pending autosave). The write
   * starts synchronously, so it can run inside a page-hide handler; the store
   * commits writes in call order. Does nothing while the stored blob is from a
   * newer version (see `load`), so its unknown fields are not lost.
   */
  save(): Promise<void> {
    this.cancelTimer();
    if (this.newerBlobVersion !== null) return Promise.resolve();
    let write: Promise<void>;
    try {
      write = this.storage.write(this.toJSON());
    } catch (error) {
      write = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const previous = this.pendingSave;
    const next: Promise<void> = (previous ? Promise.allSettled([previous, write]).then(() => write) : write).finally(() => {
      if (this.pendingSave === next) this.pendingSave = null;
    });
    this.pendingSave = next;
    return next;
  }

  /** Resolves once any scheduled or in-flight save has finished. */
  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      await this.save();
      return;
    }
    if (this.pendingSave) await this.pendingSave;
  }

  get hasPendingSave(): boolean {
    return this.saveTimer !== null || this.pendingSave !== null;
  }

  /** Restores defaults (including bindings) and notifies with path `'*'`. */
  reset(): void {
    this.state = cloneSettings(DEFAULT_SETTINGS);
    this.notify('*', this.get());
  }

  toJSON(): SerializedSettings {
    return serializeSettings(this.state);
  }

  /**
   * Drops listeners, writes a change still waiting for its autosave, and
   * closes the storage once the last write has finished.
   */
  dispose(): void {
    this.listeners.clear();
    const pending = this.saveTimer !== null ? this.save() : this.pendingSave;
    const close = (): void => this.storage.close?.();
    if (!pending) {
      close();
      return;
    }
    void pending
      .catch((error: unknown) => {
        log.error('Settings save on dispose failed:', error);
      })
      .finally(close);
  }

  private notify(path: SettingsPath | '*', value: unknown, schedule = true): void {
    const change: SettingsChange = { path, value };
    const snapshot = this.state;
    for (const listener of [...this.listeners]) {
      try {
        listener(change, snapshot);
      } catch (error) {
        log.error(`Settings listener for '${path}' threw:`, error);
      }
    }
    this.bus.emit('settings:changed', { path, value });
    if (schedule) this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.autosaveDelayMs <= 0) return;
    this.cancelTimer();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch((error: unknown) => {
        log.error('Settings autosave failed:', error);
      });
    }, this.autosaveDelayMs);
  }

  private cancelTimer(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }
}
