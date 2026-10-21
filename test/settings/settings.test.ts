import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { log } from '../../src/core/log';
import { ACTION_IDS } from '../../src/input/actions';
import { DEFAULT_BINDINGS } from '../../src/input/bindings';
import { readSettingsBlob } from '../../src/save/saveManager';
import {
  DEFAULT_SETTINGS,
  SETTINGS_FIELDS,
  SETTINGS_MIGRATIONS,
  SETTINGS_PATHS,
  SETTINGS_SECTIONS,
  SETTINGS_VERSION,
  SettingsStore,
  coerceSetting,
  fieldsOfSection,
  getSetting,
  isImplemented,
  isSettingsPath,
  migrateSettings,
  parseSettings,
  serializeSettings,
  visibleSections,
  type Settings,
  type SettingsChange,
  type SettingsStorage,
} from '../../src/settings/settings';

function memoryStorage(initial: unknown = undefined): SettingsStorage & { blob: unknown; writes: number } {
  const store = {
    blob: initial,
    writes: 0,
    read: () => Promise.resolve(store.blob),
    write: (value: unknown) => {
      store.blob = JSON.parse(JSON.stringify(value)) as unknown;
      store.writes += 1;
      return Promise.resolve();
    },
  };
  return store;
}

beforeEach(() => {
  log.setConsoleMirror(false);
  log.clear();
});

afterEach(() => {
  vi.useRealTimers();
  log.setConsoleMirror(true);
});

describe('field table', () => {
  it('covers every section and matches the defaults', () => {
    for (const section of SETTINGS_SECTIONS) {
      const keys = Object.keys(DEFAULT_SETTINGS[section]);
      expect(fieldsOfSection(section).map((p) => p.slice(section.length + 1))).toEqual(keys);
    }
    for (const path of SETTINGS_PATHS) {
      const value = getSetting(DEFAULT_SETTINGS, path);
      expect(coerceSetting(path, value), path).toEqual(value);
    }
  });

  it('identifies paths', () => {
    expect(isSettingsPath('graphics.fov')).toBe(true);
    expect(isSettingsPath('graphics')).toBe(false);
    expect(isSettingsPath('graphics.nope')).toBe(false);
    expect(isSettingsPath(42)).toBe(false);
  });
});

describe('coerceSetting', () => {
  it('clamps numbers into range and rejects non-finite values', () => {
    expect(coerceSetting('graphics.fov', 200)).toBe(110);
    expect(coerceSetting('graphics.fov', 10)).toBe(60);
    expect(coerceSetting('graphics.renderScale', 1.25)).toBe(1.25);
    expect(coerceSetting('accessibility.textScale', 0.1)).toBe(0.8);
    expect(coerceSetting('audio.master', Number.NaN)).toBeUndefined();
    expect(coerceSetting('audio.master', Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(coerceSetting('audio.master', '0.5')).toBeUndefined();
  });

  it('accepts only listed enum values', () => {
    expect(coerceSetting('graphics.shadows', 'high')).toBe('high');
    expect(coerceSetting('graphics.shadows', 'ultra')).toBeUndefined();
    expect(coerceSetting('graphics.frameCap', 60)).toBe(60);
    expect(coerceSetting('graphics.frameCap', '60')).toBeUndefined();
    expect(coerceSetting('accessibility.colorblind', 'tritanopia')).toBe('tritanopia');
  });

  it('requires real booleans', () => {
    expect(coerceSetting('controls.invertY', true)).toBe(true);
    expect(coerceSetting('controls.invertY', 1)).toBeUndefined();
    expect(coerceSetting('controls.invertY', 'true')).toBeUndefined();
  });

  it('maps empty text to null when nullable', () => {
    expect(coerceSetting('audio.ttsVoice', 'Samantha')).toBe('Samantha');
    expect(coerceSetting('audio.ttsVoice', '')).toBeNull();
    expect(coerceSetting('audio.ttsVoice', null)).toBeNull();
    expect(coerceSetting('audio.ttsVoice', 7)).toBeUndefined();
  });

  it('parses bindings leniently and rejects non-objects', () => {
    const map = coerceSetting('controls.bindings', {
      interact: [{ device: 'keyboard', code: 'KeyF' }, { device: 'bogus', code: 'x' }],
      unknownAction: [{ device: 'keyboard', code: 'KeyZ' }],
    });
    expect(map?.interact).toEqual([{ device: 'keyboard', code: 'KeyF' }]);
    expect(map?.['move.forward']).toEqual(DEFAULT_BINDINGS['move.forward']);
    expect(coerceSetting('controls.bindings', 'nope')).toBeUndefined();
    expect(coerceSetting('controls.bindings', null)).toBeUndefined();
  });
});

describe('parseSettings', () => {
  it('returns defaults for garbage input', () => {
    for (const input of [undefined, null, 42, 'x', [], {}]) {
      expect(parseSettings(input)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('merges partial input over defaults, dropping invalid and unknown keys', () => {
    const parsed = parseSettings({
      version: SETTINGS_VERSION,
      graphics: { fov: 95, shadows: 'ultra', fancy: true },
      audio: { master: 2 },
      accessibility: 'broken',
      extra: { a: 1 },
    });
    expect(parsed.graphics.fov).toBe(95);
    expect(parsed.graphics.shadows).toBe(DEFAULT_SETTINGS.graphics.shadows);
    expect(parsed.audio.master).toBe(1);
    expect(parsed.accessibility).toEqual(DEFAULT_SETTINGS.accessibility);
    expect(parsed.version).toBe(SETTINGS_VERSION);
    expect('extra' in parsed).toBe(false);
    expect('fancy' in parsed.graphics).toBe(false);
  });

  it('does not alias the defaults', () => {
    const parsed = parseSettings({});
    parsed.controls.bindings.interact.push({ device: 'keyboard', code: 'KeyX' });
    parsed.graphics.fov = 1;
    expect(DEFAULT_SETTINGS.controls.bindings.interact).toEqual(DEFAULT_BINDINGS.interact);
    expect(DEFAULT_SETTINGS.graphics.fov).toBe(75);
  });

  it('round-trips through serializeSettings', () => {
    const settings: Settings = parseSettings({
      graphics: { fov: 100, frameCap: 120 },
      audio: { ttsVoice: 'Daniel' },
      controls: { invertY: true, bindings: { interact: [{ device: 'keyboard', code: 'KeyF' }] } },
      accessibility: { colorblind: 'protanopia', textScale: 1.4, oneHanded: 'right' },
    });
    const blob = JSON.parse(JSON.stringify(serializeSettings(settings))) as unknown;
    expect(parseSettings(blob)).toEqual(settings);
    expect((blob as { controls: { bindings: { version: number } } }).controls.bindings.version).toBe(1);
  });
});

describe('migrateSettings', () => {
  it('applies steps from the blob version up to the current version', () => {
    const table = { 0: (d: Record<string, unknown>) => ({ ...d, graphics: { fov: 90 } }), 1: (d: Record<string, unknown>) => d };
    const out = migrateSettings({ version: 0, graphics: { oldFov: 90 } }, table);
    expect(out).toEqual({ version: SETTINGS_VERSION, graphics: { fov: 90 } });
    expect(parseSettings({ version: 0 }, table).graphics.fov).toBe(90);
  });

  it('treats a missing version as current and tolerates missing steps or future versions', () => {
    expect(migrateSettings({ graphics: { fov: 80 } })).toEqual({ graphics: { fov: 80 } });
    expect(migrateSettings({ version: 0, graphics: { fov: 80 } }, {})).toEqual({ version: 0, graphics: { fov: 80 } });
    expect(parseSettings({ version: 0, graphics: { fov: 80 } }, {}).graphics.fov).toBe(80);
    expect(parseSettings({ version: 99, graphics: { fov: 80 } }).graphics.fov).toBe(80);
    expect(log.entries().filter((e) => e.level === 'warn')).toHaveLength(3);
  });
});

describe('settings v1 -> v2 (one-handed layout, Phase 8)', () => {
  const v1 = (oneHanded: unknown): Record<string, unknown> => ({
    version: 1,
    graphics: { fov: 85 },
    accessibility: { textScale: 1.2, colorblind: 'tritanopia', reducedFlash: true, subtitles: false, oneHanded },
  });

  it('is version 2 and keeps a migration step for version 1', () => {
    expect(SETTINGS_VERSION).toBe(2);
    expect(SETTINGS_MIGRATIONS[1]).toBeTypeOf('function');
  });

  it('maps the old boolean true to the left-hand layout and everything else to off', () => {
    expect(parseSettings(v1(true)).accessibility.oneHanded).toBe('left');
    for (const old of [false, undefined, null, 'yes', 1, 'right']) {
      expect(parseSettings(v1(old)).accessibility.oneHanded, String(old)).toBe('off');
    }
  });

  it('keeps every other field and logs nothing', () => {
    const parsed = parseSettings(v1(true));
    expect(parsed.graphics.fov).toBe(85);
    expect(parsed.accessibility).toEqual({
      textScale: 1.2,
      colorblind: 'tritanopia',
      reducedFlash: true,
      subtitles: false,
      oneHanded: 'left',
    });
    expect(parsed.version).toBe(SETTINGS_VERSION);
    expect(log.entries().filter((e) => e.level === 'warn')).toHaveLength(0);
  });

  it('migrates a blob without an accessibility group untouched', () => {
    const migrated = migrateSettings({ version: 1, graphics: { fov: 70 } });
    expect(migrated).toEqual({ version: 2, graphics: { fov: 70 } });
    expect(parseSettings({ version: 1 }).accessibility.oneHanded).toBe('off');
  });

  it('accepts only the three layout ids for the enum field', () => {
    expect(SETTINGS_FIELDS['accessibility.oneHanded'].label).toBe('One-handed layout');
    expect(SETTINGS_FIELDS['accessibility.oneHanded'].options.map((o) => o.label)).toEqual(['Off', 'Left hand', 'Right hand']);
    for (const ok of ['off', 'left', 'right']) expect(coerceSetting('accessibility.oneHanded', ok)).toBe(ok);
    for (const bad of [true, false, 'both', 'Left', 0, null]) expect(coerceSetting('accessibility.oneHanded', bad)).toBeUndefined();
    expect(DEFAULT_SETTINGS.accessibility.oneHanded).toBe('off');
  });

  it('round-trips a v2 blob and a layout survives serialization', () => {
    const settings = parseSettings({ accessibility: { oneHanded: 'right', colorblind: 'deuteranopia' } });
    const blob = JSON.parse(JSON.stringify(serializeSettings(settings))) as { version: number };
    expect(blob.version).toBe(2);
    expect(parseSettings(blob)).toEqual(settings);
  });

  it('does not rewrite a stored left-hand v2 value', () => {
    expect(parseSettings({ version: 2, accessibility: { oneHanded: 'left' } }).accessibility.oneHanded).toBe('left');
  });
});

describe('implemented settings', () => {
  it('hides settings nothing consumes yet, and sections left empty by that', () => {
    expect(isImplemented('graphics.frameCap')).toBe(true);
    expect(isImplemented('graphics.drawDistance')).toBe(true);
    expect(isImplemented('controls.gamepadDeadzone')).toBe(true);
    expect(isImplemented('audio.music')).toBe(false);
    expect(isImplemented('accessibility.colorblind')).toBe(true);
    expect(isImplemented('accessibility.oneHanded')).toBe(true);
    expect(visibleSections()).toEqual(['graphics', 'audio', 'controls', 'accessibility']);
  });

  it('shows the Phase 2 audio and radio settings', () => {
    for (const path of [
      'audio.master',
      'audio.sfx',
      'audio.radio',
      'audio.ttsVoice',
      'audio.tts',
      'audio.radioMode',
      'audio.voiceCommands',
      'accessibility.subtitles',
    ] as const) {
      expect(isImplemented(path), path).toBe(true);
    }
    expect(SETTINGS_FIELDS['audio.ttsVoice'].label).toBe('Dispatcher voice');
    expect(SETTINGS_FIELDS['audio.tts'].label).toBe('Spoken radio (text-to-speech)');
    expect(SETTINGS_FIELDS['audio.radioMode'].label).toBe('Radio language');
    expect(SETTINGS_FIELDS['audio.radioMode'].options.map((o) => o.label)).toEqual(['Ten-codes', 'Plain language']);
    expect(SETTINGS_FIELDS['audio.voiceCommands'].label).toBe('Voice commands (push-to-talk, browser speech service)');
    expect(SETTINGS_FIELDS['accessibility.subtitles'].label).toBe('Radio captions');
  });
});

describe('audio and radio settings', () => {
  it('defaults: speech on, ten-codes, voice commands off', () => {
    expect(DEFAULT_SETTINGS.audio).toEqual({
      master: 0.8,
      sfx: 1,
      radio: 1,
      music: 0.6,
      ttsVoice: null,
      tts: true,
      radioMode: 'tenCode',
      voiceCommands: false,
    });
    expect(SETTINGS_VERSION).toBe(2);
  });

  it('coerces radioMode to the two known modes only', () => {
    expect(coerceSetting('audio.radioMode', 'plain')).toBe('plain');
    expect(coerceSetting('audio.radioMode', 'tenCode')).toBe('tenCode');
    for (const bad of ['TenCode', 'tencode', 'ten-codes', '', 1, null, true]) {
      expect(coerceSetting('audio.radioMode', bad)).toBeUndefined();
    }
    expect(parseSettings({ audio: { radioMode: 'pirate' } }).audio.radioMode).toBe('tenCode');
  });

  it('coerces the new booleans strictly', () => {
    expect(coerceSetting('audio.tts', false)).toBe(false);
    expect(coerceSetting('audio.voiceCommands', true)).toBe(true);
    expect(coerceSetting('audio.tts', 'false')).toBeUndefined();
    expect(coerceSetting('audio.voiceCommands', 1)).toBeUndefined();
  });

  it('parses an old version-1 blob without the new fields using defaults', () => {
    const oldBlob = {
      version: 1,
      graphics: { renderScale: 1, shadows: 'high', fov: 80, frameCap: 60, drawDistance: 900 },
      audio: { master: 0.5, sfx: 0.7, radio: 0.9, music: 0.2, ttsVoice: 'Daniel' },
      controls: { mouseSensitivity: 1, invertY: false, gamepadDeadzone: 0.15 },
      accessibility: { textScale: 1, colorblind: 'none', reducedFlash: false, subtitles: false, oneHanded: false },
    };
    const parsed = parseSettings(oldBlob);
    expect(parsed.audio).toEqual({
      master: 0.5,
      sfx: 0.7,
      radio: 0.9,
      music: 0.2,
      ttsVoice: 'Daniel',
      tts: true,
      radioMode: 'tenCode',
      voiceCommands: false,
    });
    expect(parsed.accessibility.subtitles).toBe(false);
    expect(log.entries().filter((e) => e.level === 'warn')).toHaveLength(0);
  });

  it('round-trips the new fields', () => {
    const settings = parseSettings({ audio: { tts: false, radioMode: 'plain', voiceCommands: true } });
    const blob = JSON.parse(JSON.stringify(serializeSettings(settings))) as unknown;
    const again = parseSettings(blob);
    expect(again.audio.tts).toBe(false);
    expect(again.audio.radioMode).toBe('plain');
    expect(again.audio.voiceCommands).toBe(true);
  });
});

describe('SettingsStore', () => {
  let bus: EventBus<EventMap>;
  let events: EventMap['settings:changed'][];
  let storage: ReturnType<typeof memoryStorage>;
  let store: SettingsStore;

  beforeEach(() => {
    bus = new EventBus<EventMap>();
    events = [];
    bus.on('settings:changed', (p) => events.push(p));
    storage = memoryStorage();
    store = new SettingsStore({ bus, storage, autosaveDelayMs: 0 });
  });

  it('starts at defaults and get() returns copies', () => {
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    const snap = store.get();
    snap.graphics.fov = 1;
    snap.controls.bindings.interact.length = 0;
    expect(store.get('graphics.fov')).toBe(75);
    expect(store.get('controls.bindings').interact).toEqual(DEFAULT_BINDINGS.interact);
  });

  it('sets by path with clamping, notifying subscribers and the bus once per change', () => {
    const seen: SettingsChange[] = [];
    const unsubscribe = store.subscribe((change, settings) => {
      seen.push(change);
      expect(settings.graphics.fov).toBe(change.value);
    });
    expect(store.set('graphics.fov', 500)).toBe(true);
    expect(store.get('graphics.fov')).toBe(110);
    expect(store.set('graphics.fov', 110)).toBe(false);
    expect(seen).toEqual([{ path: 'graphics.fov', value: 110 }]);
    expect(events).toEqual([{ path: 'graphics.fov', value: 110 }]);
    unsubscribe();
    store.set('graphics.fov', 70);
    expect(seen).toHaveLength(1);
    expect(events).toHaveLength(2);
  });

  it('throws on invalid values and leaves state untouched', () => {
    expect(() => store.set('graphics.shadows', 'ultra' as never)).toThrow(TypeError);
    expect(() => store.set('audio.master', Number.NaN)).toThrow(TypeError);
    expect(store.get('graphics.shadows')).toBe('low');
    expect(events).toHaveLength(0);
  });

  it('trySet reports failure instead of throwing', () => {
    expect(store.trySet('nope.nothing', 1)).toBe(false);
    expect(store.trySet('graphics.shadows', 'ultra')).toBe(false);
    expect(store.trySet('graphics.shadows', 'high')).toBe(true);
    expect(store.trySet('graphics.shadows', 'high')).toBe(false);
    expect(store.get('graphics.shadows')).toBe('high');
  });

  it('setMany validates everything before applying anything', () => {
    expect(() => store.setMany({ 'graphics.fov': 90, 'graphics.shadows': 'ultra' as never })).toThrow(TypeError);
    expect(store.get('graphics.fov')).toBe(75);
    store.setMany({ 'graphics.fov': 90, 'audio.music': 0 });
    expect(store.get('graphics.fov')).toBe(90);
    expect(store.get('audio.music')).toBe(0);
    expect(events).toHaveLength(2);
  });

  it('stores bindings by value and detects unchanged maps', () => {
    const map = store.get('controls.bindings');
    map.interact = [{ device: 'keyboard', code: 'KeyF' }];
    expect(store.set('controls.bindings', map)).toBe(true);
    map.interact = [];
    expect(store.get('controls.bindings').interact).toEqual([{ device: 'keyboard', code: 'KeyF' }]);
    expect(store.set('controls.bindings', store.get('controls.bindings'))).toBe(false);
    for (const id of ACTION_IDS) expect(Array.isArray(store.get('controls.bindings')[id])).toBe(true);
  });

  it('reset restores defaults and notifies with "*"', () => {
    store.set('graphics.fov', 100);
    store.set('controls.invertY', true);
    store.reset();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(events.at(-1)).toEqual({ path: '*', value: DEFAULT_SETTINGS });
  });

  it('save writes the serialized blob and load restores it', async () => {
    store.set('graphics.fov', 100);
    store.set('audio.ttsVoice', 'Daniel');
    await store.save();
    expect(storage.writes).toBe(1);
    expect(storage.blob).toEqual(serializeSettings(store.get()));

    const other = new SettingsStore({ bus, storage, autosaveDelayMs: 0 });
    await other.load();
    expect(other.get()).toEqual(store.get());
    expect(events.at(-1)).toEqual({ path: '*', value: store.get() });
  });

  it('load falls back to defaults for a missing or corrupt blob', async () => {
    store.set('graphics.fov', 100);
    await store.load();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    storage.blob = { version: SETTINGS_VERSION, graphics: { fov: 'tall' } };
    await store.load();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('load uses defaults (and still notifies) when storage cannot be read', async () => {
    const failing = new SettingsStore({
      bus,
      storage: { read: () => Promise.reject(new Error('idb unavailable')), write: () => Promise.resolve() },
      autosaveDelayMs: 0,
    });
    const seen: string[] = [];
    failing.subscribe((c) => seen.push(c.path));
    await expect(failing.load()).resolves.toBeUndefined();
    expect(failing.get()).toEqual(DEFAULT_SETTINGS);
    expect(seen).toEqual(['*']);
    expect(log.entries().some((e) => e.level === 'error' && e.message.includes('idb unavailable'))).toBe(true);
  });

  it('isolates listener errors', () => {
    store.subscribe(() => {
      throw new Error('boom');
    });
    const seen: string[] = [];
    store.subscribe((c) => seen.push(c.path));
    expect(() => store.set('graphics.fov', 90)).not.toThrow();
    expect(seen).toEqual(['graphics.fov']);
    expect(log.entries().some((e) => e.level === 'error' && e.message.includes('boom'))).toBe(true);
  });

  it('debounces autosave after changes', async () => {
    vi.useFakeTimers();
    const debounced = new SettingsStore({ bus, storage, autosaveDelayMs: 100 });
    debounced.set('graphics.fov', 90);
    debounced.set('graphics.fov', 95);
    expect(debounced.hasPendingSave).toBe(true);
    expect(storage.writes).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(storage.writes).toBe(1);
    expect((storage.blob as Settings).graphics.fov).toBe(95);
    await debounced.flush();
    expect(debounced.hasPendingSave).toBe(false);

    debounced.set('graphics.fov', 100);
    await debounced.flush();
    expect(storage.writes).toBe(2);
    debounced.set('graphics.fov', 105);
    debounced.dispose(); // a change still waiting for its autosave is written, not dropped
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.writes).toBe(3);
    expect((storage.blob as Settings).graphics.fov).toBe(105);
    debounced.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.writes).toBe(3);
  });

  it('dispose() writes a pending change and then closes the storage', async () => {
    let written: unknown;
    const close = vi.fn();
    const s = new SettingsStore({
      bus,
      storage: { read: () => Promise.resolve(undefined), write: (v) => ((written = v), Promise.resolve()), close },
    });
    await s.load();
    s.set('graphics.fov', 90);
    s.dispose();
    expect(close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect((written as Settings).graphics.fov).toBe(90);
  });

  it('persists through the real settings blob in IndexedDB', async () => {
    const factory = new IDBFactory();
    const idbStore = new SettingsStore({ bus, factory, autosaveDelayMs: 0 });
    idbStore.set('accessibility.subtitles', false);
    idbStore.set('graphics.frameCap', 30);
    await idbStore.save();
    expect(await readSettingsBlob(factory)).toEqual(idbStore.toJSON());

    const again = new SettingsStore({ bus, factory, autosaveDelayMs: 0 });
    await again.load();
    expect(again.get('accessibility.subtitles')).toBe(false);
    expect(again.get('graphics.frameCap')).toBe(30);
  });

  it('does not write over a blob saved by a newer version', async () => {
    const newer = { version: SETTINGS_VERSION + 1, graphics: { fov: 90, antialias: 'taa' }, hud: { minimap: false } };
    storage.blob = newer;
    await store.load();
    expect(store.get('graphics.fov')).toBe(90);
    store.set('graphics.fov', 95);
    await store.save();
    store.reset();
    await store.flush();
    expect(storage.writes).toBe(0);
    expect(storage.blob).toEqual(newer);
    // A blob of this version (or none) is written normally again.
    storage.blob = undefined;
    await store.load();
    store.set('graphics.fov', 80);
    await store.save();
    expect(storage.writes).toBe(1);
  });

  it('starts every write synchronously even while an earlier one is still committing', async () => {
    const values: number[] = [];
    let finishFirst = (): void => undefined;
    const slow = new SettingsStore({
      bus,
      autosaveDelayMs: 0,
      storage: {
        read: () => Promise.resolve(undefined),
        write: (v) => {
          values.push((v as Settings).graphics.fov);
          return values.length === 1 ? new Promise<void>((resolve) => (finishFirst = resolve)) : Promise.resolve();
        },
      },
    });
    slow.set('graphics.fov', 80);
    const first = slow.save();
    slow.set('graphics.fov', 81);
    const second = slow.save();
    expect(values).toEqual([80, 81]); // both started in this task, e.g. inside pagehide
    expect(slow.hasPendingSave).toBe(true);
    finishFirst();
    await Promise.all([first, second]);
    expect(slow.hasPendingSave).toBe(false);
  });

  it('exposes the field table used by the UI', () => {
    expect(SETTINGS_FIELDS['graphics.fov'].kind).toBe('number');
    expect(SETTINGS_FIELDS['controls.bindings'].kind).toBe('bindings');
    expect(fieldsOfSection('controls')).toContain('controls.bindings');
  });
});
