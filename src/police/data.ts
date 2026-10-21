import equipmentJson from '../data/police/equipment.json';
import itemsJson from '../data/police/items.json';
import lightbarJson from '../data/police/lightbar.json';
import { fail, readArray, readBoolean, readNumber, readObject, readOneOf, readString, readVersion } from '../vehicles/json';

/**
 * Validated police equipment tables (design §4.4). Every parser throws an Error naming the file and
 * the dotted field path, e.g. `lightbar.json: patterns[0].frames[1][0] must have 8 characters, got 7`.
 */

/** Siren tones; identical union to audio's `SirenToneName` (kept separate: no cross-module import). */
export const SIREN_TONE_NAMES = ['wail', 'yelp', 'phaser', 'hilo'] as const;
export type SirenTone = (typeof SIREN_TONE_NAMES)[number];

/** Light bar lens colours (`LightbarPattern` frames hold these values). */
export const SEGMENT_COLOR = { off: 0, red: 1, blue: 2, white: 3, amber: 4 } as const;
export type SegmentColor = (typeof SEGMENT_COLOR)[keyof typeof SEGMENT_COLOR];

const COLOR_CHARS: Readonly<Record<string, SegmentColor>> = {
  '.': SEGMENT_COLOR.off,
  R: SEGMENT_COLOR.red,
  B: SEGMENT_COLOR.blue,
  W: SEGMENT_COLOR.white,
  A: SEGMENT_COLOR.amber,
};

export interface LightbarFrame {
  /** One `SEGMENT_COLOR` per segment, left to right. */
  readonly colors: Uint8Array;
  readonly durationS: number;
}

export interface LightbarPattern {
  readonly id: string;
  readonly label: string;
  readonly frames: readonly LightbarFrame[];
  /** Sum of the frame durations. */
  readonly periodS: number;
}

export interface LightbarData {
  readonly segments: number;
  readonly reducedFlash: { readonly minFrameS: number; readonly level: number };
  readonly patterns: readonly LightbarPattern[];
}

export interface TrunkItem {
  readonly id: string;
  readonly label: string;
  /** Most the officer can carry at once. */
  readonly carryMax: number;
  /** Can be placed in the world (Phase 3 hook; inventory only in Phase 2). */
  readonly deployable: boolean;
  /** Mass of one item in kg (vehicle cargo weight). */
  readonly weightKg: number;
  /** Cargo slots one item takes (0: rides in a box). */
  readonly size: number;
}

/** Items every `items.json` must define (the shipped loadout and UI rely on them). */
export const REQUIRED_TRUNK_ITEMS = [
  'cones',
  'flares',
  'firstAid',
  'aed',
  'spikeStrip',
  'evidenceKit',
  'fireExtinguisher',
  'trafficVest',
] as const;

export interface RackItem {
  readonly id: string;
  readonly label: string;
}

export interface SpotlightSpec {
  /** Yaw limits relative to the heading (rad, + = left). */
  readonly yawMin: number;
  readonly yawMax: number;
  /** Pitch limits (rad, + = up). */
  readonly pitchMin: number;
  readonly pitchMax: number;
  readonly defaultYaw: number;
  readonly defaultPitch: number;
  /** Radians per mouse pixel while aiming (the caller scales mouse deltas by it). */
  readonly aimRate: number;
}

export interface EquipmentData {
  readonly siren: { readonly tones: readonly SirenTone[]; readonly defaultTone: SirenTone };
  readonly spotlight: SpotlightSpec;
  readonly rack: { readonly items: readonly RackItem[]; readonly unlockRequiresStop: boolean };
  /** Loadout id -> item id -> count. */
  readonly trunkLoadouts: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

function readInt(value: unknown, source: string, path: string, min: number, max = Infinity): number {
  const n = readNumber(value, source, path, min, max);
  if (!Number.isInteger(n)) fail(source, path, `must be an integer, got ${n}`);
  return n;
}

function checkUnique(ids: readonly string[], source: string, path: string): void {
  const seen = new Set<string>();
  ids.forEach((id, i) => {
    if (seen.has(id)) fail(source, `${path}[${i}].id`, `duplicates ${JSON.stringify(id)}`);
    seen.add(id);
  });
}

export function parseLightbar(json: unknown, source: string): LightbarData {
  const root = readObject(json, source, '');
  readVersion(root, source);
  const segments = readInt(root.segments, source, 'segments', 1, 64);
  const rf = readObject(root.reducedFlash, source, 'reducedFlash');
  const reducedFlash = {
    minFrameS: readNumber(rf.minFrameS, source, 'reducedFlash.minFrameS', 1e-3, 10),
    level: readNumber(rf.level, source, 'reducedFlash.level', 0, 1),
  };
  const patterns = readArray(root.patterns, source, 'patterns', 1).map((item, i): LightbarPattern => {
    const path = `patterns[${i}]`;
    const p = readObject(item, source, path);
    let periodS = 0;
    const frames = readArray(p.frames, source, `${path}.frames`, 1).map((f, j): LightbarFrame => {
      const fp = `${path}.frames[${j}]`;
      const pair = readArray(f, source, fp, 2);
      if (pair.length !== 2) fail(source, fp, `must be [colors, durationS], got ${pair.length} items`);
      const text = readString(pair[0], source, `${fp}[0]`);
      if (text.length !== segments) fail(source, `${fp}[0]`, `must have ${segments} characters, got ${text.length}`);
      const colors = new Uint8Array(segments);
      for (let k = 0; k < segments; k++) {
        const c = COLOR_CHARS[text.charAt(k)];
        if (c === undefined) fail(source, `${fp}[0]`, `has unknown colour ${JSON.stringify(text.charAt(k))} (use . R B W A)`);
        colors[k] = c;
      }
      const durationS = readNumber(pair[1], source, `${fp}[1]`, 1e-3, 60);
      periodS += durationS;
      return { colors, durationS };
    });
    return { id: readString(p.id, source, `${path}.id`), label: readString(p.label, source, `${path}.label`), frames, periodS };
  });
  checkUnique(
    patterns.map((p) => p.id),
    source,
    'patterns',
  );
  return { segments, reducedFlash, patterns };
}

export function parseItems(json: unknown, source: string): TrunkItem[] {
  const root = readObject(json, source, '');
  readVersion(root, source);
  const items = readArray(root.items, source, 'items', 1).map((item, i): TrunkItem => {
    const path = `items[${i}]`;
    const o = readObject(item, source, path);
    return {
      id: readString(o.id, source, `${path}.id`),
      label: readString(o.label, source, `${path}.label`),
      carryMax: readInt(o.carryMax, source, `${path}.carryMax`, 1, 999),
      deployable: readBoolean(o.deployable, source, `${path}.deployable`),
      weightKg: readNumber(o.weightKg, source, `${path}.weightKg`, 0, 1000),
      size: readInt(o.size, source, `${path}.size`, 0, 999),
    };
  });
  checkUnique(
    items.map((it) => it.id),
    source,
    'items',
  );
  for (const id of REQUIRED_TRUNK_ITEMS) {
    if (!items.some((it) => it.id === id)) fail(source, 'items', `must include ${JSON.stringify(id)}`);
  }
  return items;
}

export function parseEquipment(json: unknown, source: string, items: readonly TrunkItem[]): EquipmentData {
  const root = readObject(json, source, '');
  readVersion(root, source);

  const sirenJson = readObject(root.siren, source, 'siren');
  const tones = readArray(sirenJson.tones, source, 'siren.tones', 1).map((t, i) =>
    readOneOf(t, SIREN_TONE_NAMES, source, `siren.tones[${i}]`),
  );
  tones.forEach((t, i) => {
    if (tones.indexOf(t) !== i) fail(source, `siren.tones[${i}]`, `duplicates ${JSON.stringify(t)}`);
  });
  const defaultTone = readOneOf(sirenJson.defaultTone, tones, source, 'siren.defaultTone');

  const sp = readObject(root.spotlight, source, 'spotlight');
  const num = (key: string, min = -Math.PI, max = Math.PI): number => readNumber(sp[key], source, `spotlight.${key}`, min, max);
  const spotlight: SpotlightSpec = {
    yawMin: num('yawMin'),
    yawMax: num('yawMax'),
    pitchMin: num('pitchMin', -Math.PI / 2, Math.PI / 2),
    pitchMax: num('pitchMax', -Math.PI / 2, Math.PI / 2),
    defaultYaw: num('defaultYaw'),
    defaultPitch: num('defaultPitch', -Math.PI / 2, Math.PI / 2),
    aimRate: num('aimRate', 1e-6, 1),
  };
  if (spotlight.yawMin >= spotlight.yawMax) fail(source, 'spotlight.yawMin', 'must be less than spotlight.yawMax');
  if (spotlight.pitchMin >= spotlight.pitchMax) fail(source, 'spotlight.pitchMin', 'must be less than spotlight.pitchMax');
  if (spotlight.defaultYaw < spotlight.yawMin || spotlight.defaultYaw > spotlight.yawMax) {
    fail(source, 'spotlight.defaultYaw', 'must be within [yawMin, yawMax]');
  }
  if (spotlight.defaultPitch < spotlight.pitchMin || spotlight.defaultPitch > spotlight.pitchMax) {
    fail(source, 'spotlight.defaultPitch', 'must be within [pitchMin, pitchMax]');
  }

  const rackJson = readObject(root.rack, source, 'rack');
  const rackItems = readArray(rackJson.items, source, 'rack.items', 1).map((item, i): RackItem => {
    const o = readObject(item, source, `rack.items[${i}]`);
    return { id: readString(o.id, source, `rack.items[${i}].id`), label: readString(o.label, source, `rack.items[${i}].label`) };
  });
  checkUnique(
    rackItems.map((r) => r.id),
    source,
    'rack.items',
  );
  const rack = { items: rackItems, unlockRequiresStop: readBoolean(rackJson.unlockRequiresStop, source, 'rack.unlockRequiresStop') };

  const loadoutsJson = readObject(root.trunkLoadouts, source, 'trunkLoadouts');
  const trunkLoadouts: Record<string, Record<string, number>> = {};
  for (const [id, value] of Object.entries(loadoutsJson)) {
    const lo = readObject(value, source, `trunkLoadouts.${id}`);
    const counts: Record<string, number> = {};
    for (const [itemId, count] of Object.entries(lo)) {
      if (!items.some((it) => it.id === itemId)) fail(source, `trunkLoadouts.${id}.${itemId}`, 'is not an item in items.json');
      counts[itemId] = readInt(count, source, `trunkLoadouts.${id}.${itemId}`, 0, 999);
    }
    trunkLoadouts[id] = counts;
  }

  return { siren: { tones, defaultTone }, spotlight, rack, trunkLoadouts };
}

export const LIGHTBAR_DATA: LightbarData = parseLightbar(lightbarJson, 'lightbar.json');
export const ITEMS_DATA: readonly TrunkItem[] = parseItems(itemsJson, 'items.json');
export const EQUIPMENT_DATA: EquipmentData = parseEquipment(equipmentJson, 'equipment.json', ITEMS_DATA);
