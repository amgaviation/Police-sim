/**
 * Gear data tables (design §8.1, §8.2): the officer item catalog, the per-assignment policy and the officer presets,
 * validated at import. Every validation error names the file and the JSON path.
 */
import itemsJson from '../data/gear/items.json';
import loadoutsJson from '../data/gear/loadouts.json';
import policyJson from '../data/gear/policy.json';
import { ITEMS_DATA } from '../police/data';
import { ARMORY_ITEMS } from '../station/data';
import { fail, readArray, readNumber, readObject, readOneOf, readString, readVersion } from '../vehicles/json';
import { ASSIGNMENTS, GEAR_SLOTS, type Assignment, type GearSlot, type OfficerLoadout } from './types';

export interface GearItemDef {
  readonly id: string;
  readonly label: string;
  readonly slot: GearSlot;
  /** Slots taken in `slot`, per item. */
  readonly size: number;
  readonly weightKg: number;
  /** Most the loadout may hold (default 1). */
  readonly max: number;
  /** Extra capacity this item adds to slots, per item. */
  readonly provides: Readonly<Partial<Record<GearSlot, number>>>;
  /** The item takes a holster retention level 1..3. */
  readonly retention: boolean;
  /** `ARMORY_ITEMS` id signed out with this item, null for none. */
  readonly armory: string | null;
  /** Gear ids that must also be in the loadout. */
  readonly requires: readonly string[];
  /** Trunk item id -> count granted at shift start, per item. */
  readonly kit: Readonly<Record<string, number>>;
  /** Share of torso rounds a worn item stops (0..1). */
  readonly protection: number;
}

export interface AssignmentPolicy {
  readonly id: Assignment;
  readonly label: string;
  readonly maxKg: number;
  readonly required: readonly string[];
  readonly forbidden: readonly string[];
  readonly minRetention: 1 | 2 | 3;
  readonly maxLongGuns: number;
}

export interface Ballistics {
  /** Chance a round fired at the officer hits at all. */
  readonly hitChance: number;
  /** Share of hits that land on the torso. */
  readonly torsoShare: number;
  readonly maxRangeM: number;
}

export interface GearPolicy {
  readonly assignments: readonly AssignmentPolicy[];
  /** Fleet class -> officer assignment. */
  readonly fleetAssignment: Readonly<Record<string, Assignment>>;
  /** Fleet class -> trunk items the vehicle loadout must contain. */
  readonly vehicleRequired: Readonly<Record<string, readonly string[]>>;
  readonly ballistics: Ballistics;
}

/** Fleet classes (design §4.1); plain strings here because the fleet module comes in a later wave. */
export const GEAR_FLEET_CLASSES = [
  'patrol', 'supervisor', 'unmarked', 'traffic', 'k9', 'motor', 'bicycle', 'atv', 'swat', 'armored', 'transport', 'command', 'lab', 'marine', 'air', 'drone',
] as const;

/** Officer presets every `loadouts.json` must define. */
export const REQUIRED_OFFICER_PRESETS = [
  'patrolStandard', 'trafficStandard', 'k9Handler', 'motorOfficer', 'bikeOfficer', 'swatOperator', 'detective', 'supervisor', 'marineUnit', 'airCrew',
] as const;

function readInt(value: unknown, source: string, path: string, min: number, max = Infinity): number {
  const n = readNumber(value, source, path, min, max);
  if (!Number.isInteger(n)) fail(source, path, `must be an integer, got ${String(n)}`);
  return n;
}

function readIdList(value: unknown, source: string, path: string, known: ReadonlySet<string>, what: string): string[] {
  return readArray(value, source, path).map((v, i) => {
    const id = readString(v, source, `${path}[${String(i)}]`);
    if (!known.has(id)) fail(source, `${path}[${String(i)}]`, `is not a ${what} id, got ${JSON.stringify(id)}`);
    return id;
  });
}

export function parseGearItems(json: unknown, source: string): GearItemDef[] {
  const root = readObject(json, source, '');
  readVersion(root, source);
  const raw = readArray(root['items'], source, 'items', 1);
  const ids = new Set<string>();
  raw.forEach((item, i) => {
    const id = readString(readObject(item, source, `items[${String(i)}]`)['id'], source, `items[${String(i)}].id`);
    if (ids.has(id)) fail(source, `items[${String(i)}].id`, `duplicates ${JSON.stringify(id)}`);
    ids.add(id);
  });
  const armoryIds = new Set(ARMORY_ITEMS.map((a) => a.id));
  const trunkIds = new Set(ITEMS_DATA.map((t) => t.id));
  return raw.map((item, i): GearItemDef => {
    const path = `items[${String(i)}]`;
    const o = readObject(item, source, path);
    const provides: Partial<Record<GearSlot, number>> = {};
    if (o['provides'] !== undefined) {
      const p = readObject(o['provides'], source, `${path}.provides`);
      for (const [slot, n] of Object.entries(p)) {
        const s = readOneOf(slot, GEAR_SLOTS, source, `${path}.provides.${slot}`);
        provides[s] = readInt(n, source, `${path}.provides.${slot}`, 0, 999);
      }
    }
    const kit: Record<string, number> = {};
    if (o['kit'] !== undefined) {
      const k = readObject(o['kit'], source, `${path}.kit`);
      for (const [trunk, n] of Object.entries(k)) {
        if (!trunkIds.has(trunk)) fail(source, `${path}.kit.${trunk}`, 'is not an item in the police items.json');
        kit[trunk] = readInt(n, source, `${path}.kit.${trunk}`, 1, 999);
      }
    }
    let armory: string | null = null;
    if (o['armory'] !== undefined) {
      armory = readString(o['armory'], source, `${path}.armory`);
      if (!armoryIds.has(armory)) fail(source, `${path}.armory`, `is not an armory item, got ${JSON.stringify(armory)}`);
    }
    const retention = o['retention'] === undefined ? false : o['retention'];
    if (typeof retention !== 'boolean') fail(source, `${path}.retention`, `must be true or false, got ${JSON.stringify(retention)}`);
    const requires = o['requires'] === undefined ? [] : readIdList(o['requires'], source, `${path}.requires`, ids, 'gear item');
    return {
      id: readString(o['id'], source, `${path}.id`),
      label: readString(o['label'], source, `${path}.label`),
      slot: readOneOf(o['slot'], GEAR_SLOTS, source, `${path}.slot`),
      size: readInt(o['size'], source, `${path}.size`, 0, 999),
      weightKg: readNumber(o['weightKg'], source, `${path}.weightKg`, 0, 1000),
      max: o['max'] === undefined ? 1 : readInt(o['max'], source, `${path}.max`, 1, 99),
      provides,
      retention,
      armory,
      requires,
      kit,
      protection: o['protection'] === undefined ? 0 : readNumber(o['protection'], source, `${path}.protection`, 0, 1),
    };
  });
}

export function parsePolicy(json: unknown, source: string, items: readonly GearItemDef[] = GEAR_ITEMS): GearPolicy {
  const root = readObject(json, source, '');
  readVersion(root, source);
  const gearIds = new Set(items.map((it) => it.id));
  const trunkIds = new Set(ITEMS_DATA.map((t) => t.id));

  const seen = new Set<string>();
  const assignments = readArray(root['assignments'], source, 'assignments', 1).map((raw, i): AssignmentPolicy => {
    const path = `assignments[${String(i)}]`;
    const o = readObject(raw, source, path);
    const id = readOneOf(o['id'], ASSIGNMENTS, source, `${path}.id`);
    if (seen.has(id)) fail(source, `${path}.id`, `duplicates ${JSON.stringify(id)}`);
    seen.add(id);
    return {
      id,
      label: readString(o['label'], source, `${path}.label`),
      maxKg: readNumber(o['maxKg'], source, `${path}.maxKg`, 0, 1000),
      required: readIdList(o['required'], source, `${path}.required`, gearIds, 'gear item'),
      forbidden: readIdList(o['forbidden'], source, `${path}.forbidden`, gearIds, 'gear item'),
      minRetention: readInt(o['minRetention'], source, `${path}.minRetention`, 1, 3) as 1 | 2 | 3,
      maxLongGuns: readInt(o['maxLongGuns'], source, `${path}.maxLongGuns`, 0, 9),
    };
  });
  for (const a of ASSIGNMENTS) if (!seen.has(a)) fail(source, 'assignments', `must include ${JSON.stringify(a)}`);

  const fa = readObject(root['fleetAssignment'], source, 'fleetAssignment');
  const fleetAssignment: Record<string, Assignment> = {};
  for (const cls of GEAR_FLEET_CLASSES) fleetAssignment[cls] = readOneOf(fa[cls], ASSIGNMENTS, source, `fleetAssignment.${cls}`);
  for (const key of Object.keys(fa)) {
    if (!(GEAR_FLEET_CLASSES as readonly string[]).includes(key)) fail(source, `fleetAssignment.${key}`, 'is not a fleet class');
  }

  const vr = readObject(root['vehicleRequired'], source, 'vehicleRequired');
  const vehicleRequired: Record<string, string[]> = {};
  for (const [cls, list] of Object.entries(vr)) {
    if (!(GEAR_FLEET_CLASSES as readonly string[]).includes(cls)) fail(source, `vehicleRequired.${cls}`, 'is not a fleet class');
    vehicleRequired[cls] = readIdList(list, source, `vehicleRequired.${cls}`, trunkIds, 'trunk item');
  }

  const b = readObject(root['ballistics'], source, 'ballistics');
  const ballistics: Ballistics = {
    hitChance: readNumber(b['hitChance'], source, 'ballistics.hitChance', 0, 1),
    torsoShare: readNumber(b['torsoShare'], source, 'ballistics.torsoShare', 0, 1),
    maxRangeM: readNumber(b['maxRangeM'], source, 'ballistics.maxRangeM', 0, 10000),
  };
  return { assignments, fleetAssignment, vehicleRequired, ballistics };
}

/** Officer presets by id; the loadout items are only checked for shape and known ids (policy checks are `validate`'s). */
export function parseOfficerPresets(json: unknown, source: string, items: readonly GearItemDef[] = GEAR_ITEMS): Readonly<Record<string, OfficerLoadout>> {
  const root = readObject(json, source, '');
  readVersion(root, source);
  const gearIds = new Set(items.map((it) => it.id));
  const officer = readObject(root['officer'], source, 'officer');
  const out: Record<string, OfficerLoadout> = {};
  for (const [id, raw] of Object.entries(officer)) {
    const path = `officer.${id}`;
    const o = readObject(raw, source, path);
    const assignment = readOneOf(o['assignment'], ASSIGNMENTS, source, `${path}.assignment`);
    const list = readArray(o['items'], source, `${path}.items`, 1).map((it, i) => {
      const ip = `${path}.items[${String(i)}]`;
      const io = readObject(it, source, ip);
      const itemId = readString(io['id'], source, `${ip}.id`);
      if (!gearIds.has(itemId)) fail(source, `${ip}.id`, `is not a gear item, got ${JSON.stringify(itemId)}`);
      const item: OfficerLoadout['items'][number] = { id: itemId, count: readInt(io['count'], source, `${ip}.count`, 1, 99) };
      if (io['retention'] !== undefined) item.retention = readInt(io['retention'], source, `${ip}.retention`, 1, 3) as 1 | 2 | 3;
      return item;
    });
    out[id] = { assignment, items: list };
  }
  for (const id of REQUIRED_OFFICER_PRESETS) if (out[id] === undefined) fail(source, 'officer', `must include ${JSON.stringify(id)}`);
  return out;
}

/** The 20 officer items in file order. */
export const GEAR_ITEMS: readonly GearItemDef[] = parseGearItems(itemsJson, 'items.json');
/** Assignment policy, fleet mapping, vehicle requirements and ballistics. */
export const GEAR_POLICY: GearPolicy = parsePolicy(policyJson, 'policy.json', GEAR_ITEMS);
/** Officer presets by id (`officerPreset` returns copies). */
export const OFFICER_PRESETS: Readonly<Record<string, OfficerLoadout>> = parseOfficerPresets(loadoutsJson, 'loadouts.json', GEAR_ITEMS);

/** Gear item by id; undefined when unknown. */
export function gearItem(id: string): GearItemDef | undefined {
  return GEAR_ITEMS.find((it) => it.id === id);
}

/** Policy of `assignment`; the patrol policy for an unknown id (old saves). */
export function assignmentPolicy(assignment: string): AssignmentPolicy {
  const found = GEAR_POLICY.assignments.find((a) => a.id === assignment);
  const fallback = GEAR_POLICY.assignments.find((a) => a.id === 'patrol');
  if (found !== undefined) return found;
  if (fallback === undefined) throw new Error('policy.json: patrol assignment missing');
  return fallback;
}
