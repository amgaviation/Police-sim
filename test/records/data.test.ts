import { describe, expect, it } from 'vitest';
import boloJson from '../../src/data/records/bolo.json';
import calendarJson from '../../src/data/records/calendar.json';
import namesJson from '../../src/data/records/names.json';
import personJson from '../../src/data/records/person.json';
import vehicleJson from '../../src/data/records/vehicle.json';
import {
  NAMES,
  PERSON_DATA,
  VEHICLE_DATA,
  parseBoloData,
  parseCalendar,
  parseNames,
  parsePersonData,
  parseVehicleData,
} from '../../src/records/data';

/** Deep copy of `json` with the value at a dotted path (array indices allowed) replaced, or removed when `value` is omitted. */
function edit(json: unknown, path: string, ...value: [unknown?]): unknown {
  const copy = JSON.parse(JSON.stringify(json)) as Record<string, unknown>;
  const keys = path.split('.');
  let obj = copy;
  for (const k of keys.slice(0, -1)) obj = obj[k] as Record<string, unknown>;
  const last = keys[keys.length - 1] ?? '';
  if (value.length === 0) delete obj[last];
  else obj[last] = value[0];
  return copy;
}

describe('records data', () => {
  it('ships generic name lists of the required sizes', () => {
    expect(NAMES.male.length).toBeGreaterThanOrEqual(150);
    expect(NAMES.female.length).toBeGreaterThanOrEqual(150);
    expect(NAMES.last.length).toBeGreaterThanOrEqual(250);
    expect(NAMES.middleInitials).toBe('ABCDEFGHJKLMNPRSTW');
    expect(PERSON_DATA.population).toBe(100000);
    expect(VEHICLE_DATA.vinPrefix).toBe('PT');
  });

  it('parses the shipped files', () => {
    expect(parseCalendar(calendarJson)).toEqual({ startDate: '2026-06-01', y: 2026, m: 6, d: 1 });
    expect(parseBoloData(boloJson).perDay).toEqual([3, 6]);
    expect(parseVehicleData(vehicleJson).colors.length).toBeGreaterThan(0);
    // `summaries` and `insurers` are optional.
    const noSummaries = parsePersonData(edit(personJson, 'priors.kinds.0.summaries'));
    expect(noSummaries.priors.kinds[0]?.summaries).toEqual([noSummaries.priors.kinds[0]?.label]);
    expect(parseVehicleData(edit(vehicleJson, 'insurers')).insurers.length).toBe(1);
  });

  it.each([
    ['names.json: version must be 1', () => parseNames(edit(namesJson, 'version', 2))],
    ['names.json: male must have at least 150 items', () => parseNames(edit(namesJson, 'male', namesJson.male.slice(0, 10)))],
    ['names.json: last[3] duplicates', () => parseNames(edit(namesJson, 'last.3', namesJson.last[0]))],
    ['names.json: female[0] must be a capitalised name', () => parseNames(edit(namesJson, 'female.0', 'mary'))],
    ['names.json: middleInitials must be upper-case letters', () => parseNames(edit(namesJson, 'middleInitials', 'ab'))],
    ['calendar.json: startDate must be "YYYY-MM-DD"', () => parseCalendar({ version: 1, startDate: '06/01/2026' })],
    ['calendar.json: startDate must be a valid date', () => parseCalendar({ version: 1, startDate: '2026-02-30' })],
    ['person.json: population must be in', () => parsePersonData(edit(personJson, 'population', 10))],
    ['person.json: warrants.rate must be in [0, 1]', () => parsePersonData(edit(personJson, 'warrants.rate', 2))],
    ['person.json: warrants.kinds[0].bail must be [min, max]', () => parsePersonData(edit(personJson, 'warrants.kinds.0.bail', [900, 100]))],
    ['person.json: physical.heightCm.F must be an array', () => parsePersonData(edit(personJson, 'physical.heightCm.F', 170))],
    ['person.json: license.classes.c must be a class letter', () => parsePersonData(edit(personJson, 'license.classes.c', 1))],
    ['person.json: gang.names must have at least 1 items', () => parsePersonData(edit(personJson, 'gang.names', []))],
    ['person.json: priors.kinds[1].kind must be a non-empty string', () => parsePersonData(edit(personJson, 'priors.kinds.1.kind', ''))],
    ['person.json: warrants.kinds[2].requires must be "probation" or "parole"', () => parsePersonData(edit(personJson, 'warrants.kinds.2.requires', 'jail'))],
    ['person.json: license.classMinAge.Z must name a class', () => parsePersonData(edit(personJson, 'license.classMinAge.Z', 18))],
    ['person.json: phonePrefix must be 3 digits', () => parsePersonData(edit(personJson, 'phonePrefix', '55'))],
    ['person.json: supervision.conditions must have at most 24 items', () => parsePersonData(edit(personJson, 'supervision.conditions', Array.from({ length: 30 }, (_, i) => `c${i}`)))],
    ['vehicle.json: plateAnomalies.cloned must be in [0, 1]', () => parseVehicleData(edit(vehicleJson, 'plateAnomalies.cloned', -1))],
    ['vehicle.json: colors[2].hex must be a "#rrggbb" colour', () => parseVehicleData(edit(vehicleJson, 'colors.2.hex', 'red'))],
    ['vehicle.json: colors[3].hex duplicates', () => parseVehicleData(edit(vehicleJson, 'colors.3.hex', vehicleJson.colors[0]?.hex))],
    ['vehicle.json: registration.validMaxDays must be >= validMinDays', () => parseVehicleData(edit(vehicleJson, 'registration.validMaxDays', 10))],
    ['vehicle.json: vinPrefix must be 2 characters', () => parseVehicleData(edit(vehicleJson, 'vinPrefix', 'IO'))],
    ['vehicle.json: driverIsOwner must be a finite number', () => parseVehicleData(edit(vehicleJson, 'driverIsOwner', 'yes'))],
    ['bolo.json: perDay must be [min, max]', () => parseBoloData(edit(boloJson, 'perDay', [6, 3]))],
    ['bolo.json: vehicleShare must be in [0, 1]', () => parseBoloData(edit(boloJson, 'vehicleShare', 3))],
    ['bolo.json: personReasons.wanted must be an array', () => parseBoloData(edit(boloJson, 'personReasons.wanted'))],
    ['bolo.json: missingShare must be in [0, 1]', () => parseBoloData(edit(boloJson, 'missingShare', 2))],
  ])('rejects bad data naming the file and field: %s', (message, run) => {
    expect(run).toThrow(message);
  });
});
