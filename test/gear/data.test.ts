import { describe, expect, it } from 'vitest';
import itemsJson from '../../src/data/gear/items.json';
import loadoutsJson from '../../src/data/gear/loadouts.json';
import policyJson from '../../src/data/gear/policy.json';
import { GEAR_ITEMS, GEAR_POLICY, assignmentPolicy, gearItem, parseGearItems, parseOfficerPresets, parsePolicy } from '../../src/gear/data';
import { ASSIGNMENTS, GEAR_SLOTS } from '../../src/gear/types';

type Json = Record<string, unknown>;
const clone = (x: unknown): Json => structuredClone(x) as Json;
const at = (o: unknown, ...path: (string | number)[]): Json => {
  let cur = o;
  for (const p of path) cur = (cur as Record<string | number, unknown>)[p];
  return cur as Json;
};

describe('gear items', () => {
  it('ships the 20 catalog items in order', () => {
    expect(GEAR_ITEMS.map((i) => i.id)).toEqual([
      'radio', 'dutyBelt', 'holster', 'sidearm', 'taser', 'ocSpray', 'baton', 'cuffs', 'flashlight', 'medKit', 'naloxone', 'tourniquet',
      'ballisticVest', 'rifle', 'shotgun', 'lessLethalLauncher', 'ram', 'halligan', 'k9Treats', 'evidenceKit',
    ]);
    expect(GEAR_SLOTS).toEqual(['belt', 'vest', 'body', 'longGun', 'carry']);
  });

  it('applies defaults and reads the optional fields', () => {
    expect(gearItem('radio')).toMatchObject({ slot: 'belt', size: 1, weightKg: 0.5, max: 1, provides: {}, retention: false, armory: null, requires: [], kit: {}, protection: 0 });
    expect(gearItem('cuffs')?.max).toBe(2);
    expect(gearItem('dutyBelt')?.provides).toEqual({ belt: 12 });
    expect(gearItem('ballisticVest')).toMatchObject({ provides: { vest: 4 }, protection: 0.85 });
    expect(gearItem('holster')?.retention).toBe(true);
    expect(gearItem('sidearm')).toMatchObject({ armory: 'sidearm', requires: ['holster'], size: 0 });
    expect(gearItem('lessLethalLauncher')?.armory).toBe('beanbag');
    expect(gearItem('ram')?.kit).toEqual({ ram: 1 });
    expect(gearItem('evidenceKit')?.kit).toMatchObject({ evidenceBags: 8, camera: 1 });
    expect(gearItem('ghost')).toBeUndefined();
  });

  it('errors name the file and path', () => {
    const cases: [(j: Json) => void, RegExp][] = [
      [(j) => (j.version = 2), /^g\.json: version must be 1, got 2$/],
      [(j) => (at(j, 'items', 0).slot = 'pocket'), /^g\.json: items\[0\]\.slot must be one of belt, vest, body, longGun, carry, got "pocket"$/],
      [(j) => (at(j, 'items', 0).size = -1), /^g\.json: items\[0\]\.size must be in \[0, 999\], got -1$/],
      [(j) => (at(j, 'items', 0).size = 1.5), /^g\.json: items\[0\]\.size must be an integer, got 1\.5$/],
      [(j) => (at(j, 'items', 0).weightKg = -0.1), /^g\.json: items\[0\]\.weightKg must be in \[0, 1000\], got -0\.1$/],
      [(j) => delete at(j, 'items', 0).weightKg, /^g\.json: items\[0\]\.weightKg must be a finite number/],
      [(j) => (at(j, 'items', 7).max = 0), /^g\.json: items\[7\]\.max must be in \[1, 99\], got 0$/],
      [(j) => (at(j, 'items', 1).provides = { pocket: 3 }), /^g\.json: items\[1\]\.provides\.pocket must be one of/],
      [(j) => (at(j, 'items', 3).armory = 'bazooka'), /^g\.json: items\[3\]\.armory is not an armory item, got "bazooka"$/],
      [(j) => (at(j, 'items', 3).requires = ['ghost']), /^g\.json: items\[3\]\.requires\[0\] is not a gear item id, got "ghost"$/],
      [(j) => (at(j, 'items', 9).kit = { jetpack: 1 }), /^g\.json: items\[9\]\.kit\.jetpack is not an item in the police items\.json$/],
      [(j) => (at(j, 'items', 12).protection = 1.5), /^g\.json: items\[12\]\.protection must be in \[0, 1\], got 1\.5$/],
      [(j) => (at(j, 'items', 2).retention = 'yes'), /^g\.json: items\[2\]\.retention must be true or false/],
      [(j) => (at(j, 'items', 1).id = 'radio'), /^g\.json: items\[1\]\.id duplicates "radio"$/],
    ];
    for (const [mutate, message] of cases) {
      const json = clone(itemsJson);
      mutate(json);
      expect(() => parseGearItems(json, 'g.json'), message.source).toThrow(message);
    }
  });

  it('accepts extra items so content scales without code changes', () => {
    const more = clone(itemsJson);
    (more.items as unknown[]).push({ id: 'riotShield', label: 'Riot shield', slot: 'carry', size: 2, weightKg: 6 });
    expect(parseGearItems(more, 'g.json')).toHaveLength(GEAR_ITEMS.length + 1);
  });
});

describe('gear policy', () => {
  it('ships the ten assignments, the fleet mapping and the ballistics', () => {
    expect(GEAR_POLICY.assignments.map((a) => a.id)).toEqual([...ASSIGNMENTS]);
    expect(assignmentPolicy('swat')).toMatchObject({ maxKg: 24, minRetention: 3, maxLongGuns: 1 });
    expect(assignmentPolicy('detective')).toMatchObject({ maxKg: 6, minRetention: 1, maxLongGuns: 0 });
    expect(assignmentPolicy('k9').required).toContain('k9Treats');
    expect(assignmentPolicy('nope').id).toBe('patrol');
    expect(Object.keys(GEAR_POLICY.fleetAssignment)).toHaveLength(16);
    expect(GEAR_POLICY.fleetAssignment).toMatchObject({ unmarked: 'detective', armored: 'swat', atv: 'patrol', drone: 'patrol', command: 'supervisor' });
    expect(GEAR_POLICY.vehicleRequired.patrol).toEqual(['firstAid', 'aed', 'cones', 'flares']);
    expect(GEAR_POLICY.vehicleRequired.swat).toEqual(['firstAid', 'ram']);
  });

  it('errors name the file and path', () => {
    const cases: [(j: Json) => void, RegExp][] = [
      [(j) => (at(j, 'assignments', 0).id = 'janitor'), /^p\.json: assignments\[0\]\.id must be one of patrol, traffic/],
      [(j) => (at(j, 'assignments', 1).id = 'patrol'), /^p\.json: assignments\[1\]\.id duplicates "patrol"$/],
      [(j) => (j.assignments = (j.assignments as unknown[]).slice(0, 9)), /^p\.json: assignments must include "air"$/],
      [(j) => (at(j, 'assignments', 0).required = ['ghost']), /^p\.json: assignments\[0\]\.required\[0\] is not a gear item id, got "ghost"$/],
      [(j) => (at(j, 'assignments', 0).minRetention = 4), /^p\.json: assignments\[0\]\.minRetention must be in \[1, 3\], got 4$/],
      [(j) => (at(j, 'assignments', 0).maxKg = -1), /^p\.json: assignments\[0\]\.maxKg must be in/],
      [(j) => (at(j, 'fleetAssignment').patrol = 'janitor'), /^p\.json: fleetAssignment\.patrol must be one of/],
      [(j) => delete at(j, 'fleetAssignment').drone, /^p\.json: fleetAssignment\.drone must be one of/],
      [(j) => (at(j, 'fleetAssignment').tank = 'swat'), /^p\.json: fleetAssignment\.tank is not a fleet class$/],
      [(j) => (at(j, 'vehicleRequired').tank = ['firstAid']), /^p\.json: vehicleRequired\.tank is not a fleet class$/],
      [(j) => (at(j, 'vehicleRequired').patrol = ['ghost']), /^p\.json: vehicleRequired\.patrol\[0\] is not a trunk item id, got "ghost"$/],
      [(j) => (at(j, 'ballistics').hitChance = 1.5), /^p\.json: ballistics\.hitChance must be in \[0, 1\], got 1\.5$/],
    ];
    for (const [mutate, message] of cases) {
      const json = clone(policyJson);
      mutate(json);
      expect(() => parsePolicy(json, 'p.json'), message.source).toThrow(message);
    }
  });
});

describe('officer presets file', () => {
  it('errors name the file and path', () => {
    const cases: [(j: Json) => void, RegExp][] = [
      [(j) => (at(j, 'officer', 'patrolStandard').assignment = 'janitor'), /^l\.json: officer\.patrolStandard\.assignment must be one of/],
      [(j) => (at(j, 'officer', 'patrolStandard', 'items', 0).id = 'ghost'), /^l\.json: officer\.patrolStandard\.items\[0\]\.id is not a gear item, got "ghost"$/],
      [(j) => (at(j, 'officer', 'patrolStandard', 'items', 0).count = 0), /^l\.json: officer\.patrolStandard\.items\[0\]\.count must be in \[1, 99\], got 0$/],
      [(j) => (at(j, 'officer', 'patrolStandard', 'items', 2).retention = 4), /^l\.json: officer\.patrolStandard\.items\[2\]\.retention must be in \[1, 3\], got 4$/],
      [(j) => delete at(j, 'officer').airCrew, /^l\.json: officer must include "airCrew"$/],
    ];
    for (const [mutate, message] of cases) {
      const json = clone(loadoutsJson);
      mutate(json);
      expect(() => parseOfficerPresets(json, 'l.json'), message.source).toThrow(message);
    }
  });
});
