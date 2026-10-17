/**
 * CAD data tables (design §4.2, §6.2): call types, statutes, ten-codes, dispositions and the address
 * config, validated at import. Every validation error names the file and the field.
 */
import addressJson from '../data/cad/address.json';
import callTypesJson from '../data/cad/callTypes.json';
import dispositionsJson from '../data/cad/dispositions.json';
import statutesJson from '../data/cad/statutes.json';
import tenCodesJson from '../data/cad/tenCodes.json';
import { CRIME_CATEGORIES } from '../environment/crime';
import {
  fail,
  readArray,
  readBoolean,
  readNumber,
  readObject,
  readOneOf,
  readString,
  readVersion,
  type JsonObject,
} from '../vehicles/json';
import { DISTRICT_NAMES } from '../world/ids';
import { CALLER_KINDS, UNIT_STATUSES, type CallerKind, type UnitStatus } from './types';

// --- Shapes ---------------------------------------------------------------------------------

export interface CallType {
  readonly id: string;
  readonly label: string;
  /** Ten-code key of the nature (tenCodes.json), null when none. */
  readonly codeKey: string | null;
  /** Phase 1 crime time-of-day category. */
  readonly category: string;
  readonly generated: boolean;
  /** Relative share in the generator. */
  readonly weight: number;
  /** Weights of P1..P4. */
  readonly priority: readonly [number, number, number, number];
  /** road | block | intersection | poi:<kind>. */
  readonly location: string;
  /** District multipliers (missing = 1). */
  readonly districts: Readonly<Record<string, number>>;
  /** AI units assigned [min, max]. */
  readonly units: readonly [number, number];
  /** Sim seconds on scene [min, max]. */
  readonly onSceneS: readonly [number, number];
  readonly callers: Readonly<Partial<Record<CallerKind, number>>>;
  readonly narratives: readonly string[];
  readonly fill: Readonly<Record<string, readonly string[]>>;
  readonly dispositions: readonly string[];
}

export const STATUTE_CATEGORIES = ['traffic', 'criminal'] as const;
export const STATUTE_CLASSES = ['infraction', 'misdemeanor', 'felony', 'warrant'] as const;

export interface Statute {
  readonly id: string;
  readonly title: string;
  readonly category: (typeof STATUTE_CATEGORIES)[number];
  readonly cls: (typeof STATUTE_CLASSES)[number];
  readonly fine: number;
  readonly citeable: boolean;
  readonly bookable: boolean;
  /** Speed violations carry a recorded speed on the citation. */
  readonly speed: boolean;
}

export const PLATE_ISSUES = ['expired', 'uninsured', 'cloned', 'stolen'] as const;
export type PlateIssue = (typeof PLATE_ISSUES)[number];

export interface StatuteTable {
  readonly statutes: readonly Statute[];
  /** Traffic violation kind -> statute id. */
  readonly violationMap: Readonly<Record<string, string>>;
  readonly plateMap: Readonly<Record<PlateIssue, string>>;
}

export interface TenCode {
  readonly code: string;
  readonly plain: string;
}

export interface TenCodeTable {
  readonly codes: Readonly<Record<string, TenCode>>;
  /** Unit status -> code key. */
  readonly statusKeys: Readonly<Record<UnitStatus, string>>;
}

export interface Disposition {
  readonly id: string;
  readonly label: string;
}

export interface CadConfig {
  readonly metresPerHundred: number;
  readonly intersectionRadius: number;
  readonly agency: string;
}

/** Code keys every table must define (design §4.2). */
export const REQUIRED_CODE_KEYS = [
  'ack', 'repeat', 'available', 'outOfService', 'busy', 'enRoute', 'onScene', 'transporting', 'location',
  'registration', 'wants', 'emergency', 'assist', 'trafficStop', 'allOk', 'hazard', 'collision',
] as const;

/** Placeholders every call-type narrative may use, besides the type's own `fill` keys. */
export const NARRATIVE_PLACEHOLDERS = [
  'street', 'cross', 'near', 'address', 'district', 'dir', 'plate', 'vehicle', 'caller',
] as const;

export const POI_LOCATION_KINDS = ['station', 'hospital', 'campus', 'airport', 'harbor', 'school', 'fuel', 'park'] as const;

// --- Readers --------------------------------------------------------------------------------

function show(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

function readInt(value: unknown, file: string, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = readNumber(value, file, path, min, max);
  if (!Number.isInteger(n)) fail(file, path, `must be an integer, got ${n}`);
  return n;
}

function readPair(value: unknown, file: string, path: string, read: (v: unknown, p: string) => number): [number, number] {
  const arr = readArray(value, file, path, 2);
  if (arr.length !== 2) fail(file, path, `must have 2 items, got ${arr.length}`);
  const lo = read(arr[0], `${path}[0]`);
  const hi = read(arr[1], `${path}[1]`);
  if (lo > hi) fail(file, path, `must be [min, max] with min <= max, got [${lo}, ${hi}]`);
  return [lo, hi];
}

function readStringList(value: unknown, file: string, path: string, minLength = 1): string[] {
  return readArray(value, file, path, minLength).map((v, i) => readString(v, file, `${path}[${i}]`));
}

function rejectUnknown(obj: JsonObject, allowed: readonly string[], file: string, path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(file, `${path}.${key}`, `is not one of ${allowed.join(', ')}`);
  }
}

/** Placeholder names in a template, in order (`{street}` -> `street`). */
export function placeholdersOf(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(/\{([^{}]*)\}/g)) out.push(m[1] ?? '');
  return out;
}

// --- Validators -----------------------------------------------------------------------------

export function validateDispositions(data: unknown, file = 'dispositions.json'): Disposition[] {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const seen = new Set<string>();
  return readArray(root.dispositions, file, 'dispositions', 1).map((v, i) => {
    const path = `dispositions[${i}]`;
    const o = readObject(v, file, path);
    const id = readString(o.id, file, `${path}.id`);
    if (seen.has(id)) fail(file, `${path}.id`, `duplicates ${show(id)}`);
    seen.add(id);
    return { id, label: readString(o.label, file, `${path}.label`) };
  });
}

export function validateTenCodes(data: unknown, file = 'tenCodes.json'): TenCodeTable {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const codesObj = readObject(root.codes, file, 'codes');
  const codes: Record<string, TenCode> = {};
  for (const [key, v] of Object.entries(codesObj)) {
    const o = readObject(v, file, `codes.${key}`);
    codes[key] = { code: readString(o.code, file, `codes.${key}.code`), plain: readString(o.plain, file, `codes.${key}.plain`) };
  }
  for (const key of REQUIRED_CODE_KEYS) {
    if (codes[key] === undefined) fail(file, `codes.${key}`, 'is missing');
  }
  const statusObj = readObject(root.statusKeys, file, 'statusKeys');
  rejectUnknown(statusObj, UNIT_STATUSES, file, 'statusKeys');
  const statusKeys = {} as Record<UnitStatus, string>;
  for (const status of UNIT_STATUSES) {
    const key = readString(statusObj[status], file, `statusKeys.${status}`);
    if (codes[key] === undefined) fail(file, `statusKeys.${status}`, `references unknown code ${show(key)}`);
    statusKeys[status] = key;
  }
  return { codes, statusKeys };
}

export function validateStatutes(data: unknown, file = 'statutes.json'): StatuteTable {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const ids = new Set<string>();
  const statutes = readArray(root.statutes, file, 'statutes', 1).map((v, i): Statute => {
    const path = `statutes[${i}]`;
    const o = readObject(v, file, path);
    const id = readString(o.id, file, `${path}.id`);
    if (!/^[A-Z]{2}-\d{3}$/.test(id)) fail(file, `${path}.id`, `must look like "TR-301", got ${show(id)}`);
    if (ids.has(id)) fail(file, `${path}.id`, `duplicates ${show(id)}`);
    ids.add(id);
    return {
      id,
      title: readString(o.title, file, `${path}.title`),
      category: readOneOf(o.category, STATUTE_CATEGORIES, file, `${path}.category`),
      cls: readOneOf(o.class, STATUTE_CLASSES, file, `${path}.class`),
      fine: readNumber(o.fine, file, `${path}.fine`, 0, 1e6),
      citeable: readBoolean(o.citeable, file, `${path}.citeable`),
      bookable: readBoolean(o.bookable, file, `${path}.bookable`),
      speed: o.speed === undefined ? false : readBoolean(o.speed, file, `${path}.speed`),
    };
  });
  const readMap = (value: unknown, path: string): Record<string, string> => {
    const obj = readObject(value, file, path);
    const out: Record<string, string> = {};
    for (const [key, v] of Object.entries(obj)) {
      const id = readString(v, file, `${path}.${key}`);
      if (!ids.has(id)) fail(file, `${path}.${key}`, `references unknown statute ${show(id)}`);
      out[key] = id;
    }
    return out;
  };
  const violationMap = readMap(root.violationMap, 'violationMap');
  const plateRaw = readMap(root.plateMap, 'plateMap');
  rejectUnknown(plateRaw, PLATE_ISSUES, file, 'plateMap');
  const plateMap = {} as Record<PlateIssue, string>;
  for (const issue of PLATE_ISSUES) {
    const id = plateRaw[issue];
    if (id === undefined) fail(file, `plateMap.${issue}`, 'is missing');
    plateMap[issue] = id;
  }
  return { statutes, violationMap, plateMap };
}

export interface CallTypeContext {
  readonly dispositions: readonly string[];
  readonly codeKeys: readonly string[];
}

function readLocation(value: unknown, file: string, path: string): string {
  const loc = readString(value, file, path);
  if (loc === 'road' || loc === 'block' || loc === 'intersection') return loc;
  if (loc.startsWith('poi:') && (POI_LOCATION_KINDS as readonly string[]).includes(loc.slice(4))) return loc;
  fail(file, path, `must be road, block, intersection or poi:<${POI_LOCATION_KINDS.join('|')}>, got ${show(loc)}`);
}

function readPriority(value: unknown, file: string, path: string): [number, number, number, number] {
  const obj = readObject(value, file, path);
  rejectUnknown(obj, ['1', '2', '3', '4'], file, path);
  const w: [number, number, number, number] = [0, 0, 0, 0];
  for (let p = 1; p <= 4; p++) {
    const v = obj[String(p)];
    w[p - 1] = v === undefined ? 0 : readNumber(v, file, `${path}.${p}`, 0);
  }
  if (w[0] + w[1] + w[2] + w[3] <= 0) fail(file, path, 'weights must sum to more than 0');
  return w;
}

export function validateCallTypes(data: unknown, ctx: CallTypeContext, file = 'callTypes.json'): CallType[] {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const ids = new Set<string>();
  return readArray(root.types, file, 'types', 1).map((v, i): CallType => {
    const path = `types[${i}]`;
    const o = readObject(v, file, path);
    const id = readString(o.id, file, `${path}.id`);
    if (ids.has(id)) fail(file, `${path}.id`, `duplicates ${show(id)}`);
    ids.add(id);

    let codeKey: string | null = null;
    if (o.codeKey !== null) {
      codeKey = readString(o.codeKey, file, `${path}.codeKey`);
      if (!ctx.codeKeys.includes(codeKey)) fail(file, `${path}.codeKey`, `references unknown ten-code ${show(codeKey)}`);
    }

    const districtsObj = readObject(o.districts, file, `${path}.districts`);
    rejectUnknown(districtsObj, DISTRICT_NAMES, file, `${path}.districts`);
    const districts: Record<string, number> = {};
    for (const [d, m] of Object.entries(districtsObj)) districts[d] = readNumber(m, file, `${path}.districts.${d}`, 0);

    const callersObj = readObject(o.callers, file, `${path}.callers`);
    rejectUnknown(callersObj, CALLER_KINDS, file, `${path}.callers`);
    const callers: Partial<Record<CallerKind, number>> = {};
    let callerSum = 0;
    for (const kind of CALLER_KINDS) {
      if (callersObj[kind] === undefined) continue;
      const w = readNumber(callersObj[kind], file, `${path}.callers.${kind}`, 0);
      callers[kind] = w;
      callerSum += w;
    }
    if (callerSum <= 0) fail(file, `${path}.callers`, 'weights must sum to more than 0');

    const fillObj = readObject(o.fill, file, `${path}.fill`);
    const fill: Record<string, readonly string[]> = {};
    for (const [key, list] of Object.entries(fillObj)) {
      if ((NARRATIVE_PLACEHOLDERS as readonly string[]).includes(key)) {
        fail(file, `${path}.fill.${key}`, 'shadows a built-in placeholder');
      }
      const values = readStringList(list, file, `${path}.fill.${key}`);
      values.forEach((s, k) => {
        if (/[{}]/.test(s)) fail(file, `${path}.fill.${key}[${k}]`, `must not contain placeholders, got ${show(s)}`);
      });
      fill[key] = values;
    }

    const known = new Set<string>([...NARRATIVE_PLACEHOLDERS, ...Object.keys(fill)]);
    const narratives = readStringList(o.narratives, file, `${path}.narratives`, 2);
    narratives.forEach((text, k) => {
      for (const name of placeholdersOf(text)) {
        if (!known.has(name)) fail(file, `${path}.narratives[${k}]`, `uses unknown placeholder {${name}}`);
      }
    });

    const dispositions = readStringList(o.dispositions, file, `${path}.dispositions`);
    dispositions.forEach((d, k) => {
      if (!ctx.dispositions.includes(d)) fail(file, `${path}.dispositions[${k}]`, `references unknown disposition ${show(d)}`);
    });

    const category = readString(o.category, file, `${path}.category`);
    if (!(CRIME_CATEGORIES as readonly string[]).includes(category)) {
      fail(file, `${path}.category`, `must be one of ${CRIME_CATEGORIES.join(', ')}, got ${show(category)}`);
    }

    return {
      id,
      label: readString(o.label, file, `${path}.label`),
      codeKey,
      category,
      generated: readBoolean(o.generated, file, `${path}.generated`),
      weight: readNumber(o.weight, file, `${path}.weight`, 0),
      priority: readPriority(o.priority, file, `${path}.priority`),
      location: readLocation(o.location, file, `${path}.location`),
      districts,
      units: readPair(o.units, file, `${path}.units`, (x, p) => readInt(x, file, p, 1)),
      onSceneS: readPair(o.onSceneS, file, `${path}.onSceneS`, (x, p) => {
        const n = readNumber(x, file, p);
        if (n <= 0) fail(file, p, `must be greater than 0, got ${n}`);
        return n;
      }),
      callers,
      narratives,
      fill,
      dispositions,
    };
  });
}

export function validateAddressConfig(data: unknown, file = 'address.json'): CadConfig {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const metresPerHundred = readNumber(root.metresPerHundred, file, 'metresPerHundred', 1, 10000);
  const intersectionRadius = readNumber(root.intersectionRadius, file, 'intersectionRadius', 0, 1000);
  return { metresPerHundred, intersectionRadius, agency: readString(root.agency, file, 'agency') };
}

// --- Tables ---------------------------------------------------------------------------------

export const DISPOSITIONS: readonly Disposition[] = validateDispositions(dispositionsJson);
export const TEN_CODES: TenCodeTable = validateTenCodes(tenCodesJson);
const STATUTE_TABLE = validateStatutes(statutesJson);
export const STATUTES: readonly Statute[] = STATUTE_TABLE.statutes;
export const VIOLATION_MAP: Readonly<Record<string, string>> = STATUTE_TABLE.violationMap;
export const PLATE_MAP: Readonly<Record<PlateIssue, string>> = STATUTE_TABLE.plateMap;
export const CALL_TYPES: readonly CallType[] = validateCallTypes(callTypesJson, {
  dispositions: DISPOSITIONS.map((d) => d.id),
  codeKeys: Object.keys(TEN_CODES.codes),
});
export const CAD_CONFIG: CadConfig = validateAddressConfig(addressJson);

const CALL_TYPE_BY_ID = new Map(CALL_TYPES.map((t) => [t.id, t]));
const STATUTE_BY_ID = new Map(STATUTES.map((s) => [s.id, s]));

/** Throws on an unknown id. */
export function callType(id: string): CallType {
  const t = CALL_TYPE_BY_ID.get(id);
  if (!t) throw new Error(`Unknown call type ${show(id)}`);
  return t;
}

/** Null on an unknown id (sim paths never throw). */
export function findCallType(id: string): CallType | null {
  return CALL_TYPE_BY_ID.get(id) ?? null;
}

/** Throws on an unknown id. */
export function statute(id: string): Statute {
  const s = STATUTE_BY_ID.get(id);
  if (!s) throw new Error(`Unknown statute ${show(id)}`);
  return s;
}

/** Null on an unknown id. */
export function findStatute(id: string): Statute | null {
  return STATUTE_BY_ID.get(id) ?? null;
}

/** Statute for an observed traffic violation kind (`speeding`, `redLight`...), null when unmapped. */
export function statuteForViolation(kind: string): Statute | null {
  const id = Object.hasOwn(VIOLATION_MAP, kind) ? VIOLATION_MAP[kind] : undefined;
  return id === undefined ? null : findStatute(id);
}

export function statuteForPlateIssue(issue: PlateIssue): Statute | null {
  const id = Object.hasOwn(PLATE_MAP, issue) ? PLATE_MAP[issue] : undefined;
  return id === undefined ? null : findStatute(id);
}

export function dispositionLabel(id: string): string {
  return DISPOSITIONS.find((d) => d.id === id)?.label ?? id;
}
