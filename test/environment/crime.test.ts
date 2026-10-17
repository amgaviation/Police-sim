import { describe, expect, it } from 'vitest';
import crimeJson from '../../src/data/crime/timeOfDay.json';
import { CRIME_CATEGORIES, CRIME_TABLE, crimeWeight, validateCrimeTable } from '../../src/environment/crime';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('crime table', () => {
  it('has every category with 24 hourly weights and 7 weekday multipliers', () => {
    expect(CRIME_CATEGORIES).toHaveLength(13);
    for (const name of CRIME_CATEGORIES) {
      expect(CRIME_TABLE[name].hourly).toHaveLength(24);
      expect(CRIME_TABLE[name].weekday).toHaveLength(7);
      expect(CRIME_TABLE[name].label.length).toBeGreaterThan(0);
    }
  });

  it('multiplies base rate, hour, weekday and district', () => {
    // traffic: base 0.8, hour 8 = 1.6, Monday = 1, highway = 1.6
    expect(crimeWeight('traffic', 8, 0, 'highway')).toBeCloseTo(0.8 * 1.6 * 1 * 1.6, 12);
    // fractional hour uses the whole hour; Sunday = 0.75
    expect(crimeWeight('traffic', 8.9, 6, 'highway')).toBeCloseTo(0.8 * 1.6 * 0.75 * 1.6, 12);
    // dui at 01:00 on Saturday downtown
    expect(crimeWeight('dui', 1, 5, 'downtown')).toBeCloseTo(0.15 * 3 * 1.6 * 1.5, 12);
  });

  it('treats a missing district as multiplier 1 and water as 0', () => {
    expect(crimeWeight('traffic', 8, 0, 'campus')).toBeCloseTo(0.8 * 1.6, 12);
    expect(crimeWeight('traffic', 8, 0, 'nowhere')).toBeCloseTo(0.8 * 1.6, 12);
    expect(crimeWeight('theft', 12, 2, 'water')).toBe(0);
  });

  it('throws on an unknown category', () => {
    expect(() => crimeWeight('jaywalking', 8, 0, 'downtown')).toThrow(/unknown category 'jaywalking'/);
  });
});

describe('validateCrimeTable', () => {
  it('rejects malformed data with readable errors', () => {
    const missing = clone(crimeJson) as { version: number; categories: Partial<typeof crimeJson.categories> };
    delete missing.categories.welfare;
    expect(() => validateCrimeTable(missing)).toThrow(/timeOfDay\.json: categories\.welfare is missing/);
    const shortHourly = clone(crimeJson);
    shortHourly.categories.theft.hourly.pop();
    expect(() => validateCrimeTable(shortHourly)).toThrow(/categories\.theft\.hourly must have 24 items, got 23/);
    const badDistrict = clone(crimeJson) as unknown as { categories: { theft: { district: Record<string, number> } } };
    badDistrict.categories.theft.district.moon = 2;
    expect(() => validateCrimeTable(badDistrict)).toThrow(/categories\.theft\.district\.moon is not one of/);
    const negative = clone(crimeJson);
    negative.categories.dui.weekday[3] = -1;
    expect(() => validateCrimeTable(negative)).toThrow(/categories\.dui\.weekday\[3\] must be in \[0, 1000\]/);
    const extra = clone(crimeJson) as unknown as { categories: Record<string, unknown> };
    extra.categories.arson = extra.categories.theft;
    expect(() => validateCrimeTable(extra)).toThrow(/categories\.arson is not one of/);
  });
});
