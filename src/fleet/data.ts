import fleetJson from '../data/fleet/fleet.json';
import inspectionJson from '../data/fleet/inspection.json';
import maintenanceJson from '../data/fleet/maintenance.json';
import { DEFAULT_LIVERIES } from '../livery/defaults';
import { EQUIPMENT_DATA } from '../police/data';
import { VEHICLE_MODELS } from '../vehicles/model';
import { fail, readArray, readNumber, readObject, readOneOf, readString, readVersion, type JsonObject } from '../vehicles/json';
import {
  FLEET_CLASSES, FLEET_HOMES, FLEET_SERVICES, INSPECTION_CHECKS,
  type FleetClass, type FleetData, type FleetUnitDef, type InspectionItem, type MaintenanceConfig,
} from './types';

/**
 * Fleet data (Phase 7 design §9.1): `src/data/fleet/*.json` validated at import. Every failure throws
 * `Error('<file>: <dotted.path> <problem>')`.
 */

const UNIT_ID = /^[A-Z]{1,3}-[0-9]{1,3}$/;
/** The first six yard slots always exist (`STATION_SLOTS`), so the garage slot is one of them. */
const MAX_GARAGE_SLOT = 5;
const MIN_CHECKS = ['fuelMin', 'oilMin', 'treadMin', 'engineMin'];

function readInt(value: unknown, source: string, path: string, min: number, max: number): number {
  const n = readNumber(value, source, path, min, max);
  if (!Number.isInteger(n)) fail(source, path, `must be an integer, got ${n}`);
  return n;
}

/** The display unit number painted for `{unit}`: the part of the id after the dash ("P-101" -> "101"). */
export function unitNumber(id: string): string {
  const i = id.indexOf('-');
  return i < 0 ? id : id.slice(i + 1);
}

function readIdList(value: unknown, ids: ReadonlySet<string>, source: string, path: string): string[] {
  const out: string[] = [];
  readArray(value, source, path).forEach((v, i) => {
    const id = readString(v, source, `${path}[${i}]`);
    if (!ids.has(id)) fail(source, `${path}[${i}]`, `references unknown unit "${id}"`);
    if (out.includes(id)) fail(source, `${path}[${i}]`, `lists "${id}" twice`);
    out.push(id);
  });
  return out;
}

/** Validates `fleet.json`; models, liveries and trunk loadouts must exist in their tables. */
export function parseFleet(json: unknown, file: string): FleetData {
  const root = readObject(json, file, '');
  readVersion(root, file);
  const unitsJson = readArray(root.units, file, 'units', 1);
  const seen = new Set<string>();
  const units: FleetUnitDef[] = unitsJson.map((u, i) => {
    const path = `units[${i}]`;
    const o = readObject(u, file, path);
    const id = readString(o.id, file, `${path}.id`);
    if (!UNIT_ID.test(id)) fail(file, `${path}.id`, `must match ${String(UNIT_ID)}, got "${id}"`);
    if (seen.has(id)) fail(file, `${path}.id`, `duplicates "${id}"`);
    seen.add(id);
    const model = readString(o.model, file, `${path}.model`);
    if (!VEHICLE_MODELS.some((m) => m.id === model)) fail(file, `${path}.model`, `is not a vehicle model: "${model}"`);
    const cls = readOneOf<FleetClass>(o.class, FLEET_CLASSES, file, `${path}.class`);
    const livery = readString(o.livery, file, `${path}.livery`);
    if (!DEFAULT_LIVERIES.some((l) => l.id === livery)) fail(file, `${path}.livery`, `is not a default livery: "${livery}"`);
    let trunk: string | null = null;
    if (o.trunk !== null && o.trunk !== undefined) {
      trunk = readString(o.trunk, file, `${path}.trunk`);
      if (EQUIPMENT_DATA.trunkLoadouts[trunk] === undefined) fail(file, `${path}.trunk`, `is not a trunk loadout: "${trunk}"`);
    } else if (o.trunk === undefined) {
      fail(file, `${path}.trunk`, 'must be a loadout id or null');
    }
    const home = o.home === undefined ? 'lot' : readOneOf(o.home, FLEET_HOMES, file, `${path}.home`);
    return { id, model, cls, livery, trunk, home };
  });
  const startParked = readIdList(root.startParked, seen, file, 'startParked');
  const startHome = readIdList(root.startHome, seen, file, 'startHome');
  const garageSlot = readInt(root.garageSlot, file, 'garageSlot', 0, MAX_GARAGE_SLOT);
  return { units, startParked, startHome, garageSlot };
}

function readPrice(o: JsonObject, key: string, source: string, path: string): number {
  return readNumber(o[key], source, `${path}.${key}`, 0);
}

/** Validates `maintenance.json`; every fleet class needs a multiplier. */
export function parseMaintenance(json: unknown, file: string): MaintenanceConfig {
  const root = readObject(json, file, '');
  readVersion(root, file);
  const p = readObject(root.prices, file, 'prices');
  const prices = {
    fuelPerL: readPrice(p, 'fuelPerL', file, 'prices'),
    oilChange: readPrice(p, 'oilChange', file, 'prices'),
    tire: readPrice(p, 'tire', file, 'prices'),
    bodyPerZone: readPrice(p, 'bodyPerZone', file, 'prices'),
    enginePerHealth: readPrice(p, 'enginePerHealth', file, 'prices'),
    engineReplace: readPrice(p, 'engineReplace', file, 'prices'),
  };
  const m = readObject(root.classMultiplier, file, 'classMultiplier');
  const classMultiplier = {} as Record<FleetClass, number>;
  for (const cls of FLEET_CLASSES) classMultiplier[cls] = readNumber(m[cls], file, `classMultiplier.${cls}`, 0);
  for (const key of Object.keys(m)) {
    if (!(FLEET_CLASSES as readonly string[]).includes(key)) fail(file, `classMultiplier.${key}`, 'is not a fleet class');
  }
  const c = readObject(root.charges, file, 'charges');
  const charges = {
    pointsPer1000: readNumber(c.pointsPer1000, file, 'charges.pointsPer1000', 0),
    wreckPoints: readNumber(c.wreckPoints, file, 'charges.wreckPoints', 0),
    pursuitFactor: readNumber(c.pursuitFactor, file, 'charges.pursuitFactor', 0, 1),
    emergencyFactor: readNumber(c.emergencyFactor, file, 'charges.emergencyFactor', 0, 1),
    unreportedFactor: readNumber(c.unreportedFactor, file, 'charges.unreportedFactor', 1),
    maxPointsPerIncident: readNumber(c.maxPointsPerIncident, file, 'charges.maxPointsPerIncident', 0),
  };
  const w = readObject(root.wreck, file, 'wreck');
  if (typeof w.engineFailed !== 'boolean') fail(file, 'wreck.engineFailed', 'must be true or false');
  const wreck = { zoneSum: readNumber(w.zoneSum, file, 'wreck.zoneSum', 0, 4), engineFailed: w.engineFailed };
  const incidentMergeS = readNumber(root.incidentMergeS, file, 'incidentMergeS', 0, 600);
  const l = readObject(root.limits, file, 'limits');
  const limits = {
    incidents: readInt(l.incidents, file, 'limits.incidents', 1, 100000),
    reports: readInt(l.reports, file, 'limits.reports', 1, 100000),
    ledger: readInt(l.ledger, file, 'limits.ledger', 1, 100000),
  };
  return { prices, classMultiplier, charges, wreck, incidentMergeS, limits };
}

/** Validates `inspection.json`; the min checks need a `value` in [0, 1]. */
export function parseInspection(json: unknown, file: string): InspectionItem[] {
  const root = readObject(json, file, '');
  readVersion(root, file);
  const seen = new Set<string>();
  return readArray(root.items, file, 'items', 1).map((raw, i) => {
    const path = `items[${i}]`;
    const o = readObject(raw, file, path);
    const id = readString(o.id, file, `${path}.id`);
    if (seen.has(id)) fail(file, `${path}.id`, `duplicates "${id}"`);
    seen.add(id);
    const label = readString(o.label, file, `${path}.label`);
    const check = readOneOf(o.check, INSPECTION_CHECKS, file, `${path}.check`);
    const item: { id: string; label: string; check: typeof check; value?: number; fix?: (typeof FLEET_SERVICES)[number] } = { id, label, check };
    if (MIN_CHECKS.includes(check)) item.value = readNumber(o.value, file, `${path}.value`, 0, 1);
    else if (o.value !== undefined) fail(file, `${path}.value`, `is not used by the "${check}" check`);
    if (o.fix !== undefined) item.fix = readOneOf(o.fix, FLEET_SERVICES, file, `${path}.fix`);
    return item;
  });
}

export const FLEET_DATA: FleetData = parseFleet(fleetJson, 'fleet.json');
export const MAINTENANCE: MaintenanceConfig = parseMaintenance(maintenanceJson, 'maintenance.json');
export const INSPECTION_ITEMS: readonly InspectionItem[] = parseInspection(inspectionJson, 'inspection.json');
