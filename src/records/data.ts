import boloJson from '../data/records/bolo.json';
import calendarJson from '../data/records/calendar.json';
import namesJson from '../data/records/names.json';
import personJson from '../data/records/person.json';
import vehicleJson from '../data/records/vehicle.json';
import {
  fail,
  readArray,
  readColor,
  readNumber,
  readObject,
  readString,
  readVersion,
  type JsonObject,
} from '../vehicles/json';

/**
 * Validated records tables (design §4.1). Every parser throws an Error naming the file and the
 * dotted field path, e.g. `person.json: warrants.rate must be in [0, 1], got 2`.
 */

// --- Validated shapes ------------------------------------------------------------

export interface NamesData {
  readonly male: readonly string[];
  readonly female: readonly string[];
  readonly last: readonly string[];
  /** One character per initial. */
  readonly middleInitials: string;
}

export interface CalendarData {
  /** "YYYY-MM-DD", game day 0. */
  readonly startDate: string;
  readonly y: number;
  readonly m: number;
  readonly d: number;
}

export interface WarrantKind {
  readonly kind: string;
  readonly label: string;
  readonly weight: number;
  readonly bail: readonly [number, number];
  /** Only issued to a person under this supervision kind (e.g. a probation violation). */
  readonly requires: 'probation' | 'parole' | null;
}

export interface PriorKind {
  readonly kind: string;
  readonly label: string;
  readonly weight: number;
  /** Summary texts (defaults to `[label]`). */
  readonly summaries: readonly string[];
}

export interface PersonData {
  readonly population: number;
  readonly ageRange: readonly [number, number];
  readonly physical: {
    readonly heightCm: { readonly M: readonly [number, number]; readonly F: readonly [number, number] };
    readonly weightKg: { readonly M: readonly [number, number]; readonly F: readonly [number, number] };
    readonly eyes: readonly string[];
    readonly hair: readonly string[];
  };
  readonly risk: { readonly exponent: number };
  readonly license: {
    readonly none: number;
    readonly suspended: number;
    readonly revoked: number;
    readonly expired: number;
    /** Class letters and weights. */
    readonly classes: readonly { readonly cls: string; readonly weight: number }[];
    /** Minimum age (years on game day 0) per class; younger holders get the most common class. */
    readonly classMinAge: Readonly<Record<string, number>>;
  };
  readonly warrants: { readonly rate: number; readonly max: number; readonly courts: readonly string[]; readonly kinds: readonly WarrantKind[] };
  /** `priorKind`: the prior-contact kind every supervised person has at least once (their conviction arrest). */
  readonly supervision: { readonly probation: number; readonly parole: number; readonly priorKind: string; readonly conditions: readonly string[] };
  readonly gang: { readonly rate: number; readonly names: readonly string[]; readonly associateShare: number };
  readonly mentalHealth: { readonly rate: number; readonly notes: readonly string[] };
  readonly officerSafety: { readonly rate: number; readonly notes: readonly string[] };
  /** No registered firearms below `minAge` (years on game day 0). */
  readonly firearms: { readonly rate: number; readonly max: number; readonly minAge: number; readonly types: readonly string[] };
  readonly protectiveOrders: { readonly rate: number; readonly conditions: readonly string[] };
  readonly priors: { readonly mean: number; readonly max: number; readonly kinds: readonly PriorKind[] };
  readonly phonePrefix: string;
}

export interface NamedColor {
  readonly name: string;
  /** 0xRRGGBB. */
  readonly rgb: number;
}

export interface VehicleData {
  readonly plateAnomalies: { readonly cloned: number; readonly mismatched: number; readonly stolenPlate: number };
  readonly intrinsic: { readonly plateReportedStolen: number; readonly cloneAlert: number };
  readonly flags: { readonly rate: number; readonly reasons: readonly string[] };
  readonly driverIsOwner: number;
  readonly registration: { readonly validMinDays: number; readonly validMaxDays: number; readonly expiredMaxDays: number };
  /** Generic insurer names (optional in the file; a default is used when absent). */
  readonly insurers: readonly string[];
  readonly colors: readonly NamedColor[];
  /** Two VIN-alphabet characters. */
  readonly vinPrefix: string;
}

export interface BoloData {
  readonly perDay: readonly [number, number];
  readonly vehicleShare: number;
  /** Share of person BOLOs that are missing persons (the rest are wanted persons). */
  readonly missingShare: number;
  /** Reasons for a stolen vehicle (a flagged one uses its registration's flag reason). */
  readonly vehicleReasons: { readonly stolen: readonly string[] };
  /** `wanted` texts may hold `{offense}` (the subject's first warrant). */
  readonly personReasons: { readonly wanted: readonly string[]; readonly missing: readonly string[] };
}

/** VIN characters: digits and letters without I, O, Q (33 symbols). */
export const VIN_ALPHABET = '0123456789ABCDEFGHJKLMNPRSTUVWXYZ';

/** Bitmask subsets are drawn with one 32-bit draw, so condition/note lists stay below this. */
const MAX_SUBSET_LIST = 24;

// --- Readers --------------------------------------------------------------------------

function readRequires(value: unknown, file: string, path: string): 'probation' | 'parole' | null {
  if (value === undefined) return null;
  if (value === 'probation' || value === 'parole') return value;
  return fail(file, path, `must be "probation" or "parole", got ${JSON.stringify(value)}`);
}

function readInt(value: unknown, file: string, path: string, min: number, max: number): number {
  const n = readNumber(value, file, path, min, max);
  if (!Number.isInteger(n)) fail(file, path, `must be an integer, got ${n}`);
  return n;
}

function readProb(value: unknown, file: string, path: string): number {
  return readNumber(value, file, path, 0, 1);
}

function readRange(value: unknown, file: string, path: string, min: number, max: number, integer = true): [number, number] {
  const arr = readArray(value, file, path, 2);
  if (arr.length !== 2) fail(file, path, `must have 2 items, got ${arr.length}`);
  const read = integer ? readInt : readNumber;
  const lo = read(arr[0], file, `${path}[0]`, min, max);
  const hi = read(arr[1], file, `${path}[1]`, min, max);
  if (lo > hi) fail(file, path, `must be [min, max] with min <= max, got [${lo}, ${hi}]`);
  return [lo, hi];
}

/** Non-empty list of distinct non-empty strings. */
function readStrings(value: unknown, file: string, path: string, minLength = 1, maxLength = Infinity): string[] {
  const arr = readArray(value, file, path, minLength);
  if (arr.length > maxLength) fail(file, path, `must have at most ${maxLength} items, got ${arr.length}`);
  const out = arr.map((v, i) => readString(v, file, `${path}[${i}]`));
  const seen = new Set<string>();
  out.forEach((s, i) => {
    if (seen.has(s)) fail(file, `${path}[${i}]`, `duplicates ${JSON.stringify(s)}`);
    seen.add(s);
  });
  return out;
}

function readNameList(value: unknown, file: string, path: string, minLength: number): string[] {
  const out = readStrings(value, file, path, minLength);
  out.forEach((s, i) => {
    if (!/^[A-Z][A-Za-z-]*$/.test(s)) fail(file, `${path}[${i}]`, `must be a capitalised name of letters, got ${JSON.stringify(s)}`);
  });
  // Name search compares case-insensitively; two names differing only in case would be ambiguous.
  const upper = new Set<string>();
  out.forEach((s, i) => {
    const u = s.toUpperCase();
    if (upper.has(u)) fail(file, `${path}[${i}]`, `duplicates ${JSON.stringify(s)} ignoring case`);
    upper.add(u);
  });
  return out;
}

function sexRange(value: unknown, file: string, path: string, min: number, max: number): { M: [number, number]; F: [number, number] } {
  const o = readObject(value, file, path);
  return { M: readRange(o.M, file, `${path}.M`, min, max), F: readRange(o.F, file, `${path}.F`, min, max) };
}

function root(json: unknown, file: string): JsonObject {
  const r = readObject(json, file, '');
  readVersion(r, file);
  return r;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

// --- Parsers --------------------------------------------------------------------------

export function parseNames(json: unknown, file = 'names.json'): NamesData {
  const r = root(json, file);
  const middleInitials = readString(r.middleInitials, file, 'middleInitials');
  if (!/^[A-Z]+$/.test(middleInitials)) fail(file, 'middleInitials', `must be upper-case letters, got ${JSON.stringify(middleInitials)}`);
  return {
    male: readNameList(r.male, file, 'male', 150),
    female: readNameList(r.female, file, 'female', 150),
    last: readNameList(r.last, file, 'last', 250),
    middleInitials,
  };
}

export function parseCalendar(json: unknown, file = 'calendar.json'): CalendarData {
  const r = root(json, file);
  const startDate = readString(r.startDate, file, 'startDate');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate);
  if (!m) fail(file, 'startDate', `must be "YYYY-MM-DD", got ${JSON.stringify(startDate)}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1970 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
    fail(file, 'startDate', `must be a valid date from 1970 on, got ${JSON.stringify(startDate)}`);
  }
  return { startDate, y, m: mo, d };
}

export function parsePersonData(json: unknown, file = 'person.json'): PersonData {
  const r = root(json, file);
  const physical = readObject(r.physical, file, 'physical');
  const risk = readObject(r.risk, file, 'risk');
  const lic = readObject(r.license, file, 'license');
  const classesObj = readObject(lic.classes, file, 'license.classes');
  const classes = Object.entries(classesObj).map(([cls, w]) => {
    if (!/^[A-Z]{1,2}$/.test(cls)) fail(file, `license.classes.${cls}`, 'must be a class letter');
    return { cls, weight: readNumber(w, file, `license.classes.${cls}`, 0, 1000) };
  });
  if (classes.length === 0) fail(file, 'license.classes', 'must have at least one class');
  if (!classes.some((c) => c.weight > 0)) fail(file, 'license.classes', 'must have a positive weight');
  const licNone = readProb(lic.none, file, 'license.none');
  const licSusp = readProb(lic.suspended, file, 'license.suspended');
  const licRev = readProb(lic.revoked, file, 'license.revoked');
  const licExp = readProb(lic.expired, file, 'license.expired');
  // Risk scales suspended/revoked by up to 3.25x; the total must stay a probability.
  if (licNone + 3.25 * (licSusp + licRev) + licExp > 1) fail(file, 'license', 'rates (suspended/revoked x 3.25) must sum to <= 1');

  const w = readObject(r.warrants, file, 'warrants');
  const kinds = readArray(w.kinds, file, 'warrants.kinds', 1).map((k, i): WarrantKind => {
    const path = `warrants.kinds[${i}]`;
    const o = readObject(k, file, path);
    return {
      kind: readString(o.kind, file, `${path}.kind`),
      label: readString(o.label, file, `${path}.label`),
      weight: readNumber(o.weight, file, `${path}.weight`, 0, 1000),
      bail: readRange(o.bail, file, `${path}.bail`, 0, 10_000_000),
      requires: readRequires(o.requires, file, `${path}.requires`),
    };
  });
  if (!kinds.some((k) => k.weight > 0 && k.requires === null)) fail(file, 'warrants.kinds', 'must have a positive weight without "requires"');

  const classMinAge: Record<string, number> = {};
  if (lic.classMinAge !== undefined) {
    for (const [cls, a] of Object.entries(readObject(lic.classMinAge, file, 'license.classMinAge'))) {
      if (!classes.some((c) => c.cls === cls)) fail(file, `license.classMinAge.${cls}`, 'must name a class in license.classes');
      classMinAge[cls] = readInt(a, file, `license.classMinAge.${cls}`, 0, 110);
    }
  }
  const sup = readObject(r.supervision, file, 'supervision');
  const probation = readProb(sup.probation, file, 'supervision.probation');
  const parole = readProb(sup.parole, file, 'supervision.parole');
  if (3.25 * (probation + parole) > 1) fail(file, 'supervision', 'probation + parole (x 3.25 risk) must be <= 1');
  const gang = readObject(r.gang, file, 'gang');
  const mh = readObject(r.mentalHealth, file, 'mentalHealth');
  const os = readObject(r.officerSafety, file, 'officerSafety');
  const fa = readObject(r.firearms, file, 'firearms');
  const po = readObject(r.protectiveOrders, file, 'protectiveOrders');
  const pr = readObject(r.priors, file, 'priors');
  const priorKinds = readArray(pr.kinds, file, 'priors.kinds', 1).map((k, i): PriorKind => {
    const path = `priors.kinds[${i}]`;
    const o = readObject(k, file, path);
    const label = readString(o.label, file, `${path}.label`);
    return {
      kind: readString(o.kind, file, `${path}.kind`),
      label,
      weight: readNumber(o.weight, file, `${path}.weight`, 0, 1000),
      summaries: o.summaries === undefined ? [label] : readStrings(o.summaries, file, `${path}.summaries`),
    };
  });
  if (!priorKinds.some((k) => k.weight > 0)) fail(file, 'priors.kinds', 'must have a positive weight');
  const supPriorKind = sup.priorKind === undefined ? 'arrest' : readString(sup.priorKind, file, 'supervision.priorKind');
  if (!priorKinds.some((k) => k.kind === supPriorKind)) fail(file, 'supervision.priorKind', `must name a kind in priors.kinds, got ${JSON.stringify(supPriorKind)}`);
  const phonePrefix = readString(r.phonePrefix, file, 'phonePrefix');
  if (!/^\d{3}$/.test(phonePrefix)) fail(file, 'phonePrefix', `must be 3 digits, got ${JSON.stringify(phonePrefix)}`);

  return {
    population: readInt(r.population, file, 'population', 1000, 10_000_000),
    ageRange: readRange(r.ageRange, file, 'ageRange', 14, 110),
    physical: {
      heightCm: sexRange(physical.heightCm, file, 'physical.heightCm', 100, 250),
      weightKg: sexRange(physical.weightKg, file, 'physical.weightKg', 30, 300),
      eyes: readStrings(physical.eyes, file, 'physical.eyes'),
      hair: readStrings(physical.hair, file, 'physical.hair'),
    },
    risk: { exponent: readNumber(risk.exponent, file, 'risk.exponent', 0.1, 20) },
    license: { none: licNone, suspended: licSusp, revoked: licRev, expired: licExp, classes, classMinAge },
    warrants: {
      rate: readProb(w.rate, file, 'warrants.rate'),
      max: readInt(w.max, file, 'warrants.max', 1, 10),
      courts: readStrings(w.courts, file, 'warrants.courts'),
      kinds,
    },
    supervision: { probation, parole, priorKind: supPriorKind, conditions: readStrings(sup.conditions, file, 'supervision.conditions', 1, MAX_SUBSET_LIST) },
    gang: {
      rate: readProb(gang.rate, file, 'gang.rate'),
      names: readStrings(gang.names, file, 'gang.names'),
      associateShare: readProb(gang.associateShare, file, 'gang.associateShare'),
    },
    mentalHealth: { rate: readProb(mh.rate, file, 'mentalHealth.rate'), notes: readStrings(mh.notes, file, 'mentalHealth.notes') },
    officerSafety: {
      rate: readProb(os.rate, file, 'officerSafety.rate'),
      notes: readStrings(os.notes, file, 'officerSafety.notes', 1, MAX_SUBSET_LIST),
    },
    firearms: {
      rate: readProb(fa.rate, file, 'firearms.rate'),
      max: readInt(fa.max, file, 'firearms.max', 1, 10),
      minAge: fa.minAge === undefined ? 0 : readInt(fa.minAge, file, 'firearms.minAge', 0, 110),
      types: readStrings(fa.types, file, 'firearms.types'),
    },
    protectiveOrders: {
      rate: readProb(po.rate, file, 'protectiveOrders.rate'),
      conditions: readStrings(po.conditions, file, 'protectiveOrders.conditions', 1, MAX_SUBSET_LIST),
    },
    priors: {
      mean: readNumber(pr.mean, file, 'priors.mean', 0, 20),
      max: readInt(pr.max, file, 'priors.max', 0, 20),
      kinds: priorKinds,
    },
    phonePrefix,
  };
}

export function parseVehicleData(json: unknown, file = 'vehicle.json'): VehicleData {
  const r = root(json, file);
  const pa = readObject(r.plateAnomalies, file, 'plateAnomalies');
  const plateAnomalies = {
    cloned: readProb(pa.cloned, file, 'plateAnomalies.cloned'),
    mismatched: readProb(pa.mismatched, file, 'plateAnomalies.mismatched'),
    stolenPlate: readProb(pa.stolenPlate, file, 'plateAnomalies.stolenPlate'),
  };
  if (plateAnomalies.cloned + plateAnomalies.mismatched + plateAnomalies.stolenPlate > 1) {
    fail(file, 'plateAnomalies', 'rates must sum to <= 1');
  }
  const intr = readObject(r.intrinsic, file, 'intrinsic');
  const flags = readObject(r.flags, file, 'flags');
  const reg = readObject(r.registration, file, 'registration');
  const validMinDays = readInt(reg.validMinDays, file, 'registration.validMinDays', 1, 10000);
  const validMaxDays = readInt(reg.validMaxDays, file, 'registration.validMaxDays', 1, 10000);
  if (validMaxDays < validMinDays) fail(file, 'registration.validMaxDays', `must be >= validMinDays (${validMinDays}), got ${validMaxDays}`);
  const colors = readArray(r.colors, file, 'colors', 1).map((c, i): NamedColor => {
    const o = readObject(c, file, `colors[${i}]`);
    return { name: readString(o.name, file, `colors[${i}].name`), rgb: readColor(o.hex, file, `colors[${i}].hex`) };
  });
  const seen = new Set<number>();
  colors.forEach((c, i) => {
    if (seen.has(c.rgb)) fail(file, `colors[${i}].hex`, 'duplicates an earlier colour');
    seen.add(c.rgb);
  });
  const vinPrefix = readString(r.vinPrefix, file, 'vinPrefix');
  if (vinPrefix.length !== 2 || [...vinPrefix].some((ch) => !VIN_ALPHABET.includes(ch))) {
    fail(file, 'vinPrefix', `must be 2 characters of ${VIN_ALPHABET}, got ${JSON.stringify(vinPrefix)}`);
  }
  return {
    plateAnomalies,
    intrinsic: {
      plateReportedStolen: readProb(intr.plateReportedStolen, file, 'intrinsic.plateReportedStolen'),
      cloneAlert: readProb(intr.cloneAlert, file, 'intrinsic.cloneAlert'),
    },
    flags: { rate: readProb(flags.rate, file, 'flags.rate'), reasons: readStrings(flags.reasons, file, 'flags.reasons') },
    driverIsOwner: readProb(r.driverIsOwner, file, 'driverIsOwner'),
    registration: {
      validMinDays,
      validMaxDays,
      expiredMaxDays: readInt(reg.expiredMaxDays, file, 'registration.expiredMaxDays', 1, 10000),
    },
    insurers: r.insurers === undefined ? ['Mutual Auto Insurance'] : readStrings(r.insurers, file, 'insurers'),
    colors,
    vinPrefix,
  };
}

export function parseBoloData(json: unknown, file = 'bolo.json'): BoloData {
  const r = root(json, file);
  const vr = readObject(r.vehicleReasons, file, 'vehicleReasons');
  const pr = readObject(r.personReasons, file, 'personReasons');
  return {
    perDay: readRange(r.perDay, file, 'perDay', 0, 50),
    vehicleShare: readProb(r.vehicleShare, file, 'vehicleShare'),
    missingShare: readProb(r.missingShare, file, 'missingShare'),
    vehicleReasons: { stolen: readStrings(vr.stolen, file, 'vehicleReasons.stolen') },
    personReasons: {
      wanted: readStrings(pr.wanted, file, 'personReasons.wanted'),
      missing: readStrings(pr.missing, file, 'personReasons.missing'),
    },
  };
}

export const NAMES: NamesData = parseNames(namesJson);
export const CALENDAR_DATA: CalendarData = parseCalendar(calendarJson);
export const PERSON_DATA: PersonData = parsePersonData(personJson);
export const VEHICLE_DATA: VehicleData = parseVehicleData(vehicleJson);
export const BOLO_DATA: BoloData = parseBoloData(boloJson);
