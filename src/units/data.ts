/**
 * Unit data (design §4.2, §5.2-§5.4): the unit types (`unitTypes.json`), the response-time tuning
 * (`eta.json`) and the roster tuning (`roster.json`), validated at import. Every validation error
 * names the file and the dotted JSON path.
 */
import etaJson from '../data/units/eta.json';
import rosterJson from '../data/units/roster.json';
import unitTypesJson from '../data/units/unitTypes.json';
import {
  fail,
  readArray,
  readBoolean,
  readColor,
  readNumber,
  readObject,
  readOneOf,
  readString,
  readVersion,
  type JsonObject,
} from '../vehicles/json';
import { VEHICLE_MODELS } from '../vehicles/model';
import {
  MISTAKE_KINDS,
  RANKS,
  ROSTER_EVENTS,
  SEND_KINDS,
  UNIT_BASES,
  UNIT_BEHAVIORS,
  UNIT_CHANNELS,
  type EtaConfig,
  type MistakeKind,
  type MistakeWeights,
  type OfficerTraits,
  type Rank,
  type ResourceSlot,
  type RosterConfig,
  type RosterEvent,
  type UnitCrew,
  type UnitType,
  type UnitTypesData,
  type Urgency,
} from './types';

/** Scene services a unit arrival may resolve (the scene `SERVICE_KINDS` incl. the Phase 6 additions). */
const SCENE_SERVICES = [
  'ems', 'fire', 'hazmat', 'swat', 'k9', 'coroner', 'interpreter', 'animalControl', 'bombSquad', 'tow', 'supervisor',
  'detectives', 'csu', 'negotiator', 'statePatrol', 'federal', 'airUnit',
] as const;

const URGENCIES: readonly Urgency[] = ['routine', 'respond', 'emergency'];
const TRAIT_KEYS: readonly (keyof OfficerTraits)[] = ['aggression', 'discipline', 'experience', 'composure', 'communication'];
const MAX_MENU_CHARS = 28;
const MAX_UNIT_COUNT = 4;
const MAX_CREW = 4;

// --- Small readers ------------------------------------------------------------------

function rejectUnknown(obj: JsonObject, allowed: readonly string[], file: string, path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(file, path === '' ? key : `${path}.${key}`, `is not one of ${allowed.join(', ')}`);
  }
}

function readInt(value: unknown, file: string, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = readNumber(value, file, path, min, max);
  if (!Number.isInteger(n)) fail(file, path, `must be an integer, got ${n}`);
  return n;
}

/** `[lo, hi]` with `lo <= hi`, both inside [min, max]. */
function readRange(value: unknown, file: string, path: string, min: number, max: number): readonly [number, number] {
  const a = readArray(value, file, path);
  if (a.length !== 2) fail(file, path, `must have exactly 2 items, got ${a.length}`);
  const lo = readNumber(a[0], file, `${path}[0]`, min, max);
  const hi = readNumber(a[1], file, `${path}[1]`, min, max);
  if (lo > hi) fail(file, path, `must be [min, max] with min <= max, got [${lo}, ${hi}]`);
  return [lo, hi];
}

function rootOf(json: unknown, file: string, keys: readonly string[]): JsonObject {
  const root = readObject(json, file, '');
  readVersion(root, file);
  rejectUnknown(root, ['version', ...keys], file, '');
  return root;
}

function sectionOf(root: JsonObject, key: string, keys: readonly string[], file: string): JsonObject {
  const obj = readObject(root[key], file, key);
  rejectUnknown(obj, keys, file, key);
  return obj;
}

// --- Unit types ---------------------------------------------------------------------

const TYPE_BASE_KEYS = ['id', 'label', 'menu', 'voice', 'requestable', 'menuOrder', 'send', 'behavior', 'resolves'] as const;
const TYPE_RESOURCE_KEYS = [
  'callsign', 'count', 'vehicle', 'color', 'base', 'turnoutS', 'speedFactor', 'crew', 'sceneServices', 'onSceneS', 'channel', 'rank',
] as const;

const NO_CREW: UnitCrew = { count: 0, dog: false, top: '#000000', topRgb: 0, bottom: '#000000', bottomRgb: 0 };

function parseCrew(value: unknown, file: string, path: string): UnitCrew {
  const c = readObject(value, file, path);
  rejectUnknown(c, ['count', 'dog', 'top', 'bottom'], file, path);
  const top = readString(c.top, file, `${path}.top`);
  const bottom = readString(c.bottom, file, `${path}.bottom`);
  return {
    count: readInt(c.count, file, `${path}.count`, 0, MAX_CREW),
    dog: c.dog === undefined ? false : readBoolean(c.dog, file, `${path}.dog`),
    top,
    topRgb: readColor(top, file, `${path}.top`),
    bottom,
    bottomRgb: readColor(bottom, file, `${path}.bottom`),
  };
}

function parseUnitType(raw: unknown, file: string, path: string, seen: Set<string>, orders: Set<number>): UnitType {
  const t = readObject(raw, file, path);
  const send = readOneOf(t.send, SEND_KINDS, file, `${path}.send`);
  const resource = send === 'resource';
  rejectUnknown(t, resource ? [...TYPE_BASE_KEYS, ...TYPE_RESOURCE_KEYS] : TYPE_BASE_KEYS, file, path);

  const id = readString(t.id, file, `${path}.id`);
  if (!/^[a-z][A-Za-z0-9]*$/.test(id)) fail(file, `${path}.id`, `must be camelCase, got "${id}"`);
  if (seen.has(id)) fail(file, `${path}.id`, `duplicates id "${id}"`);
  seen.add(id);

  const menu = readString(t.menu, file, `${path}.menu`);
  if (menu.length > MAX_MENU_CHARS) fail(file, `${path}.menu`, `must be at most ${MAX_MENU_CHARS} characters, got ${menu.length}`);
  const voice = readArray(t.voice, file, `${path}.voice`).map((v, i) => {
    const phrase = readString(v, file, `${path}.voice[${i}]`);
    if (phrase !== phrase.toLowerCase()) fail(file, `${path}.voice[${i}]`, `must be lowercase, got "${phrase}"`);
    return phrase;
  });
  const requestable = readBoolean(t.requestable, file, `${path}.requestable`);
  let menuOrder: number | null = null;
  if (requestable) {
    menuOrder = readInt(t.menuOrder, file, `${path}.menuOrder`, 1);
    if (orders.has(menuOrder)) fail(file, `${path}.menuOrder`, `duplicates menuOrder ${menuOrder} among requestable types`);
    orders.add(menuOrder);
  } else if (t.menuOrder !== undefined) {
    fail(file, `${path}.menuOrder`, 'must be omitted when requestable is false');
  }
  const behavior = readOneOf(t.behavior, UNIT_BEHAVIORS, file, `${path}.behavior`);
  const base = {
    id,
    label: readString(t.label, file, `${path}.label`),
    menu,
    voice,
    requestable,
    menuOrder,
    send,
    behavior,
    resolves: readString(t.resolves, file, `${path}.resolves`),
  };
  if (!resource) {
    return {
      ...base,
      callsign: '',
      count: 0,
      vehicle: 'none',
      color: '#000000',
      colorRgb: 0,
      base: 'station',
      turnoutS: [0, 0],
      speedFactor: 1,
      crew: NO_CREW,
      sceneServices: [],
      onSceneS: [0, 0],
      channel: 'dispatch',
      rank: null,
    };
  }

  const callsign = readString(t.callsign, file, `${path}.callsign`);
  if (!callsign.includes('{n}')) fail(file, `${path}.callsign`, `must contain "{n}", got "${callsign}"`);
  const vehicle = readString(t.vehicle, file, `${path}.vehicle`);
  if (behavior === 'air') {
    if (vehicle !== 'none') fail(file, `${path}.vehicle`, `must be "none" for the air behavior, got "${vehicle}"`);
  } else if (vehicle === 'none') {
    fail(file, `${path}.vehicle`, '"none" is only allowed for the air behavior');
  } else if (!VEHICLE_MODELS.some((m) => m.id === vehicle)) {
    fail(file, `${path}.vehicle`, `must be a vehicle model id, got "${vehicle}"`);
  }
  const color = readString(t.color, file, `${path}.color`);
  const services = readArray(t.sceneServices, file, `${path}.sceneServices`).map((s, i) =>
    readOneOf(s, SCENE_SERVICES, file, `${path}.sceneServices[${i}]`),
  );
  return {
    ...base,
    callsign,
    count: readInt(t.count, file, `${path}.count`, 1, MAX_UNIT_COUNT),
    vehicle,
    color,
    colorRgb: readColor(color, file, `${path}.color`),
    base: readOneOf(t.base, UNIT_BASES, file, `${path}.base`),
    turnoutS: readRange(t.turnoutS, file, `${path}.turnoutS`, 0, 3600),
    speedFactor: readNumber(t.speedFactor, file, `${path}.speedFactor`, 0.5, 1.5),
    crew: parseCrew(t.crew, file, `${path}.crew`),
    sceneServices: services,
    onSceneS: readRange(t.onSceneS, file, `${path}.onSceneS`, 0, 36000),
    channel: readOneOf(t.channel, UNIT_CHANNELS, file, `${path}.channel`),
    rank: t.rank === undefined ? null : readOneOf(t.rank, RANKS, file, `${path}.rank`),
  };
}

/** Validates `unitTypes.json`; throws an Error naming `file` and the JSON path. */
export function parseUnitTypes(json: unknown, file = 'unitTypes.json'): UnitTypesData {
  const root = rootOf(json, file, ['fleetIndexBase', 'maxFleetCars', 'airSpeedMps', 'airAltitudeM', 'types']);
  const fleetIndexBase = readInt(root.fleetIndexBase, file, 'fleetIndexBase', 0);
  const maxFleetCars = readInt(root.maxFleetCars, file, 'maxFleetCars', 1, 255);
  const airSpeedMps = readNumber(root.airSpeedMps, file, 'airSpeedMps', 1e-6);
  const airAltitudeM = readNumber(root.airAltitudeM, file, 'airAltitudeM', 1e-6);
  const seen = new Set<string>();
  const orders = new Set<number>();
  const types = readArray(root.types, file, 'types', 1).map((raw, i) => parseUnitType(raw, file, `types[${i}]`, seen, orders));

  let ground = 0;
  const callsigns = new Set<string>();
  types.forEach((t, i) => {
    if (t.send !== 'resource') return;
    if (t.behavior !== 'air') ground += t.count;
    for (let n = 1; n <= t.count; n++) {
      const cs = t.callsign.replace('{n}', String(n));
      if (callsigns.has(cs)) fail(file, `types[${i}].callsign`, `duplicates callsign "${cs}"`);
      callsigns.add(cs);
    }
  });
  const room = maxFleetCars - fleetIndexBase;
  if (ground > room) {
    fail(file, 'types', `ground units (${ground}) must be at most maxFleetCars - fleetIndexBase (${room})`);
  }
  return { fleetIndexBase, maxFleetCars, airSpeedMps, airAltitudeM, types };
}

/**
 * Expands every resource type in file order into slots (design §5.2): `fleetIndex = fleetIndexBase + k`
 * with k the running count over ground slots; the air unit gets -1. The order is a contract.
 */
export function expandResourceSlots(data: UnitTypesData): ResourceSlot[] {
  const out: ResourceSlot[] = [];
  let k = 0;
  for (const t of data.types) {
    if (t.send !== 'resource') continue;
    for (let n = 1; n <= t.count; n++) {
      const air = t.behavior === 'air';
      out.push({ typeId: t.id, callsign: t.callsign.replace('{n}', String(n)), index: n, fleetIndex: air ? -1 : data.fleetIndexBase + k });
      if (!air) k++;
    }
  }
  return out;
}

/** The shipped unit types. */
export const UNIT_TYPES: UnitTypesData = parseUnitTypes(unitTypesJson);

const TYPE_BY_ID = new Map<string, UnitType>(UNIT_TYPES.types.map((t) => [t.id, t]));
const REQUESTABLE: readonly UnitType[] = UNIT_TYPES.types
  .filter((t) => t.requestable)
  .sort((a, b) => (a.menuOrder ?? 0) - (b.menuOrder ?? 0));
const SLOTS: readonly ResourceSlot[] = expandResourceSlots(UNIT_TYPES);

/** Unit type by id, null when unknown. */
export function unitType(id: string): UnitType | null {
  return TYPE_BY_ID.get(id) ?? null;
}

/** Requestable types sorted by `menuOrder`. */
export function requestableTypes(): readonly UnitType[] {
  return REQUESTABLE;
}

/** Every resource unit slot in contract order (design §5.2). */
export function resourceSlots(): readonly ResourceSlot[] {
  return SLOTS;
}

// --- Response-time tuning -----------------------------------------------------------

function readPerUrgency(obj: JsonObject, key: string, file: string, min: number, max: number): Record<Urgency, number> {
  const o = sectionOf(obj, key, URGENCIES, file);
  const out = {} as Record<Urgency, number>;
  for (const u of URGENCIES) out[u] = readNumber(o[u], file, `${key}.${u}`, min, max);
  return out;
}

/** Validates `eta.json`. */
export function parseEtaConfig(json: unknown, file = 'eta.json'): EtaConfig {
  const root = rootOf(json, file, ['urgencyFactor', 'trafficPenalty', 'wetPenalty', 'minTravelS', 'rankCandidates']);
  return {
    urgencyFactor: readPerUrgency(root, 'urgencyFactor', file, 1e-6, 10),
    trafficPenalty: readPerUrgency(root, 'trafficPenalty', file, 0, 10),
    wetPenalty: readNumber(root.wetPenalty, file, 'wetPenalty', 0, 10),
    minTravelS: readNumber(root.minTravelS, file, 'minTravelS', 0),
    rankCandidates: readInt(root.rankCandidates, file, 'rankCandidates', 1, 64),
  };
}

/** The shipped response-time tuning. */
export const ETA_CONFIG: EtaConfig = parseEtaConfig(etaJson);

// --- Roster tuning ------------------------------------------------------------------

function readDeltas(value: unknown, file: string, path: string): Partial<Record<RosterEvent, number>> {
  const o = readObject(value, file, path);
  rejectUnknown(o, ROSTER_EVENTS, file, path);
  const out: Partial<Record<RosterEvent, number>> = {};
  for (const e of ROSTER_EVENTS) {
    if (o[e] !== undefined) out[e] = readNumber(o[e], file, `${path}.${e}`, -1, 1);
  }
  return out;
}

const MISTAKE_WEIGHT_KEYS = ['base', 'stress', 'fatigue', 'loyalty', ...TRAIT_KEYS] as const;

function readWeights(value: unknown, file: string, path: string): MistakeWeights {
  const o = readObject(value, file, path);
  rejectUnknown(o, MISTAKE_WEIGHT_KEYS, file, path);
  const w: Record<string, number> = {};
  for (const k of MISTAKE_WEIGHT_KEYS) w[k] = o[k] === undefined ? 0 : readNumber(o[k], file, `${path}.${k}`, -1, 1);
  if (o.base === undefined) fail(file, `${path}.base`, 'must be a finite number, got undefined');
  return w as unknown as MistakeWeights;
}

/** Validates `roster.json`. */
export function parseRosterConfig(json: unknown, file = 'roster.json'): RosterConfig {
  const root = rootOf(json, file, ['traits', 'rankTitles', 'stress', 'fatigue', 'loyalty', 'mistakes', 'maxChance']);

  const tr = sectionOf(root, 'traits', TRAIT_KEYS, file);
  const traits = {} as Record<keyof OfficerTraits, readonly [number, number]>;
  for (const k of TRAIT_KEYS) traits[k] = readRange(tr[k], file, `traits.${k}`, 0, 1);

  const rt = sectionOf(root, 'rankTitles', RANKS, file);
  const rankTitles = {} as Record<Rank, string>;
  for (const r of RANKS) rankTitles[r] = readString(rt[r], file, `rankTitles.${r}`);

  const st = sectionOf(root, 'stress', ['start', 'decayPerMin', 'events'], file);
  const stress = {
    start: readNumber(st.start, file, 'stress.start', 0, 1),
    decayPerMin: readNumber(st.decayPerMin, file, 'stress.decayPerMin', 0, 1),
    events: readDeltas(st.events, file, 'stress.events'),
  };

  const fa = sectionOf(root, 'fatigue', ['start', 'perHour', 'perCall', 'max'], file);
  const fatigue = {
    start: readNumber(fa.start, file, 'fatigue.start', 0, 1),
    perHour: readNumber(fa.perHour, file, 'fatigue.perHour', 0, 1),
    perCall: readNumber(fa.perCall, file, 'fatigue.perCall', 0, 1),
    max: readNumber(fa.max, file, 'fatigue.max', 1e-6, 1),
  };
  if (fatigue.start > fatigue.max) fail(file, 'fatigue.start', `must be at most fatigue.max (${fatigue.max})`);

  const lo = sectionOf(root, 'loyalty', ['start', 'events'], file);
  const loyalty = {
    start: readRange(lo.start, file, 'loyalty.start', 0, 1),
    events: readDeltas(lo.events, file, 'loyalty.events'),
  };

  for (const e of ROSTER_EVENTS) {
    const inStress = stress.events[e] !== undefined;
    const inLoyalty = loyalty.events[e] !== undefined;
    if (inStress && inLoyalty) fail(file, `loyalty.events.${e}`, `is also in stress.events; an event moves one value`);
    if (!inStress && !inLoyalty) fail(file, 'stress.events', `is missing roster event "${e}" (give it a stress or loyalty delta)`);
  }

  const mi = sectionOf(root, 'mistakes', MISTAKE_KINDS, file);
  const mx = sectionOf(root, 'maxChance', MISTAKE_KINDS, file);
  const mistakes = {} as Record<MistakeKind, MistakeWeights>;
  const maxChance = {} as Record<MistakeKind, number>;
  for (const k of MISTAKE_KINDS) {
    mistakes[k] = readWeights(mi[k], file, `mistakes.${k}`);
    maxChance[k] = readNumber(mx[k], file, `maxChance.${k}`, 0, 1);
  }
  return { traits, rankTitles, stress, fatigue, loyalty, mistakes, maxChance };
}

/** The shipped roster tuning. */
export const ROSTER_CONFIG: RosterConfig = parseRosterConfig(rosterJson);
