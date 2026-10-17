import crimeJson from '../data/crime/timeOfDay.json';
import { fail, readNumber, readNumberArray, readObject, readString, readVersion, rejectUnknownKeys } from './validate';

export const CRIME_CATEGORIES = [
  'traffic',
  'dui',
  'theft',
  'burglary',
  'robbery',
  'assault',
  'domestic',
  'disturbance',
  'vandalism',
  'suspicious',
  'alarm',
  'medical',
  'welfare',
] as const;
export type CrimeCategory = (typeof CRIME_CATEGORIES)[number];

/** Canonical district names (design §3); the world module uses the same strings. */
export const CRIME_DISTRICTS = [
  'downtown',
  'suburbs',
  'industrial',
  'highway',
  'rural',
  'campus',
  'hospital',
  'airport',
  'harbor',
  'park',
  'water',
] as const;

export interface CrimePattern {
  readonly label: string;
  readonly baseRatePerHour: number;
  /** 24 relative weights, index = hour of day. */
  readonly hourly: readonly number[];
  /** 7 multipliers, Monday first. */
  readonly weekday: readonly number[];
  /** Missing districts mean multiplier 1. */
  readonly district: Readonly<Record<string, number>>;
}

export type CrimeTable = Readonly<Record<CrimeCategory, CrimePattern>>;

export function validateCrimeTable(data: unknown, file = 'timeOfDay.json'): CrimeTable {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const categories = readObject(root.categories, file, 'categories');
  rejectUnknownKeys(categories, CRIME_CATEGORIES, file, 'categories');
  const table = {} as Record<CrimeCategory, CrimePattern>;
  for (const name of CRIME_CATEGORIES) {
    const path = `categories.${name}`;
    if (categories[name] === undefined) fail(file, path, 'is missing');
    const c = readObject(categories[name], file, path);
    const districtObj = readObject(c.district ?? {}, file, `${path}.district`);
    rejectUnknownKeys(districtObj, CRIME_DISTRICTS, file, `${path}.district`);
    const district: Record<string, number> = {};
    for (const key of Object.keys(districtObj)) {
      district[key] = readNumber(districtObj[key], file, `${path}.district.${key}`, 0, 1000);
    }
    table[name] = {
      label: readString(c.label, file, `${path}.label`),
      baseRatePerHour: readNumber(c.baseRatePerHour, file, `${path}.baseRatePerHour`, 0, 1000),
      hourly: readNumberArray(c.hourly, file, `${path}.hourly`, 24, 0, 1000),
      weekday: readNumberArray(c.weekday, file, `${path}.weekday`, 7, 0, 1000),
      district,
    };
  }
  return table;
}

export const CRIME_TABLE: CrimeTable = validateCrimeTable(crimeJson);

function isCrimeCategory(value: string): value is CrimeCategory {
  return (CRIME_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Expected calls per game hour for `category` at `hour` (fractional hours use the
 * whole hour), `weekday` (0 = Monday) and `district`:
 * `baseRatePerHour * hourly[hour] * weekday[weekday] * district[district]` (missing district = 1).
 * Throws on an unknown category.
 */
export function crimeWeight(
  category: string,
  hour: number,
  weekday: number,
  district: string,
  table: CrimeTable = CRIME_TABLE,
): number {
  if (!isCrimeCategory(category)) throw new RangeError(`crimeWeight: unknown category '${category}'`);
  const c = table[category];
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  const d = ((Math.floor(weekday) % 7) + 7) % 7;
  const districtFactor = Object.hasOwn(c.district, district) ? (c.district[district] ?? 1) : 1;
  return c.baseRatePerHour * (c.hourly[h] ?? 0) * (c.weekday[d] ?? 0) * districtFactor;
}
