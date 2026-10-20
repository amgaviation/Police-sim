/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- tests mutate loosely typed raw JSON */
import { describe, expect, it } from 'vitest';
import statutesJson from '../../src/data/cad/statutes.json';
import {
  DEFAULT_RULESET_ID,
  RULESETS,
  citation,
  getRuleset,
  parseRuleset,
  ruleOf,
  rulesetIds,
} from '../../src/legal/ruleset';
import { DOCTRINES, FORCE_LEVELS, INCIDENT_EVENT_KINDS, INDICATORS, OFFENSES } from '../../src/legal/types';

const generic = getRuleset('generic');
const strict = getRuleset('strict');

function raw(id: 'generic' | 'strict'): Record<string, any> {
  return structuredClone(getRuleset(id));
}

describe('id lists', () => {
  it('has the contracted sizes', () => {
    expect(DOCTRINES).toHaveLength(15);
    expect(INCIDENT_EVENT_KINDS).toHaveLength(29);
    expect(OFFENSES).toHaveLength(9);
    expect(INDICATORS).toHaveLength(26);
    expect(FORCE_LEVELS).toHaveLength(10);
  });
});

describe('registry', () => {
  it('parses both shipped files', () => {
    expect(rulesetIds()).toEqual(['generic', 'strict']);
    expect(RULESETS.size).toBe(2);
    expect(DEFAULT_RULESET_ID).toBe('generic');
  });

  it('falls back to the default for an unknown id', () => {
    expect(getRuleset('nope')).toBe(generic);
    expect(getRuleset('strict')).toBe(strict);
  });

  it('cites rules', () => {
    expect(ruleOf(generic, 'GS-4.1').doctrine).toBe('search');
    expect(citation(generic, 'GS-4.1')).toBe('GS-4.1 Gen. Crim. Proc. § 4.1 — Search incident to arrest');
    expect(citation(strict, 'SS-4.1')).toContain('Model Strict Code § 4.1');
    expect(() => ruleOf(generic, 'XX-1')).toThrow(/unknown rule id/);
  });

  it('ships 34 rules with prefixes and generic names only', () => {
    expect(generic.rules).toHaveLength(34);
    expect(strict.rules).toHaveLength(34);
    expect(generic.rules.every((r) => r.id.startsWith('GS-'))).toBe(true);
    expect(strict.rules.every((r) => r.id.startsWith('SS-'))).toBe(true);
    expect(new Set(generic.rules.map((r) => r.id.slice(3)))).toEqual(new Set(strict.rules.map((r) => r.id.slice(3))));
  });
});

describe('shipped content', () => {
  it('maps every CAD statute to an offense', () => {
    const ids = (statutesJson as { statutes: { id: string }[] }).statutes.map((s) => s.id);
    expect(ids).toHaveLength(47);
    for (const rs of [generic, strict]) {
      for (const id of ids) expect(OFFENSES).toContain(rs.statuteOffense[id]);
      expect(Object.keys(rs.statuteOffense).sort()).toEqual([...ids].sort());
    }
  });

  it('has all indicators and offenses with the table weights', () => {
    for (const rs of [generic, strict]) {
      expect(Object.keys(rs.indicators).sort()).toEqual([...INDICATORS].sort());
      expect(Object.keys(rs.offenses).sort()).toEqual([...OFFENSES].sort());
    }
    expect(generic.indicators.bacOver).toMatchObject({ offense: 'dui', rs: 1, pc: 1.5, armed: 0 });
    expect(generic.indicators.weaponCall).toMatchObject({ rs: 0.5, pc: 0, armed: 1 });
    expect(strict.indicators.weaponCall?.armed).toBe(0.8);
    expect(generic.offenses.violent.severity).toBe(6);
    expect(generic.offenses.traffic.severity).toBe(1);
    expect(generic.offenses.dui.vehicleEvidence).toBe(true);
    expect(generic.offenses.warrant.vehicleEvidence).toBe(false);
    expect(generic.familyOffense.vehicleWanted).toBe('felonyVehicle');
    expect(generic.statuteOffense['TR-371']).toBe('violent');
  });

  it('holds every difference of the design table', () => {
    expect(generic.offenses.traffic.arrestable).toBe(true);
    expect(strict.offenses.traffic.arrestable).toBe(false);
    expect(generic.detention.attenuating).toEqual(['warrantHit']);
    expect(strict.detention.attenuating).toEqual([]);
    expect(generic.frisk.plainFeel).toBe(true);
    expect(generic.frisk.plainFeelCategories).toEqual(['drugs']);
    expect(strict.frisk.plainFeel).toBe(false);
    expect(generic.sita.vehicle).toBe('broad');
    expect(strict.sita.vehicle).toBe('gant');
    expect([generic.sita.windowS, generic.sita.preArrestS]).toEqual([600, 60]);
    expect([strict.sita.windowS, strict.sita.preArrestS]).toEqual([300, 0]);
    expect(generic.automobile.enabled && strict.automobile.enabled).toBe(true);
    expect([generic.consent.coercedByWeaponDrawn, generic.consent.maxAggressiveLines]).toEqual([true, 3]);
    expect([strict.consent.coercedByWeaponDrawn, strict.consent.maxAggressiveLines]).toEqual([true, 1]);
    expect(generic.test.impliedAfterArrest).toBe(true);
    expect(strict.test.impliedAfterArrest).toBe(false);
    expect(generic.miranda.custodyIncludesGunpoint).toBe(false);
    expect(strict.miranda.custodyIncludesGunpoint).toBe(true);
    expect(generic.force.maxByResistance).toEqual({ compliant: 2, passive: 2, active: 4, assaultive: 5, lethal: 6 });
    expect(strict.force.maxByResistance).toEqual({ compliant: 2, passive: 2, active: 3, assaultive: 4, lethal: 6 });
    expect(generic.force.displayFirearmMin).toBe('compliant');
    expect(strict.force.displayFirearmMin).toBe('active');
    expect([generic.force.taser.maxCycles, generic.force.taser.riskAllowedAt]).toEqual([3, 'lethal']);
    expect([strict.force.taser.maxCycles, strict.force.taser.riskAllowedAt]).toEqual([2, 'lethal']);
    expect(generic.pursuit.allowedOffenses).toEqual(['violent', 'felonyVehicle', 'dui', 'warrant', 'weapons']);
    expect(strict.pursuit.allowedOffenses).toEqual(['violent', 'weapons']);
    expect(generic.pursuit.maxOverLimitMph).toEqual({ default: 40, downtown: 25, suburbs: 25, campus: 20, hospital: 20, park: 20 });
    expect(strict.pursuit.maxOverLimitMph).toEqual({ default: 30, downtown: 15, suburbs: 15, campus: 10, hospital: 10, park: 10 });
    expect([generic.pursuit.maxOverS, generic.pursuit.maxDurationS, generic.pursuit.terminateGraceS]).toEqual([20, 600, 15]);
    expect([strict.pursuit.maxOverS, strict.pursuit.maxDurationS, strict.pursuit.terminateGraceS]).toEqual([10, 300, 10]);
    expect(generic.recording.activationGraceS).toBe(10);
    expect(strict.recording.activationGraceS).toBe(5);
    expect(generic.evidence.inevitableDiscovery).toBe(true);
    expect(strict.evidence.inevitableDiscovery).toBe(false);
    expect(generic.indicators.odorCannabis).toMatchObject({ rs: 0.6, pc: 1 });
    expect(strict.indicators.odorCannabis).toMatchObject({ rs: 0.3, pc: 0 });
    expect(strict.indicators.ownerWarrant?.rs).toBe(0.4);
    expect(strict.indicators.callSuspect).toMatchObject({ rs: 0.8, pc: 0.6 });
    expect(strict.indicators.flight?.pc).toBe(0.3);
  });

  it('shares the common values', () => {
    for (const rs of [generic, strict]) {
      expect(rs.thresholds).toEqual({ rs: 1, pc: 2, armed: 1 });
      expect(rs.force.levels).toEqual({ presence: 0, verbal: 1, softHands: 2, hardHands: 3, ocSpray: 3, baton: 4, taser: 4, k9: 4, lessLethal: 5, firearm: 6 });
      expect(rs.force.taser.riskFactors).toEqual(['elderly', 'pregnant', 'elevated', 'running', 'restrained', 'juvenile']);
      expect(rs.intervene).toMatchObject({ windowS: 5, radiusM: 15 });
      expect(rs.pursuit.wetFactor).toBe(0.75);
      expect(rs.pursuit.nightFactor).toBe(0.9);
      expect(rs.miranda.responseWindowS).toBe(30);
      expect(rs.miranda.incriminatingFacts).toHaveLength(9);
      expect(rs.recording.requiredFor).toHaveLength(7);
      expect(rs.recording.dashCounts).toEqual(['detention', 'pursuitSample']);
    }
  });
});

describe('parseRuleset validation', () => {
  it('accepts an unchanged copy', () => {
    expect(parseRuleset(raw('generic'), 'generic.json').id).toBe('generic');
  });

  it('rejects a non-object and a bad version', () => {
    expect(() => parseRuleset(5, 'x.json')).toThrow(/^x\.json: \(root\): must be an object/);
    const r = raw('generic');
    r.version = 2;
    expect(() => parseRuleset(r, 'x.json')).toThrow('x.json: version:');
  });

  it('names the path of a missing indicator', () => {
    const r = raw('generic');
    delete r.indicators.speeding;
    expect(() => parseRuleset(r, 'g.json')).toThrow('g.json: indicators.speeding: is missing');
  });

  it('rejects an unknown indicator key', () => {
    const r = raw('generic');
    r.indicators.bogus = { label: 'x', offense: 'traffic', rs: 1, pc: 1, armed: 0 };
    expect(() => parseRuleset(r, 'g.json')).toThrow('g.json: indicators.bogus:');
  });

  it('rejects a negative weight', () => {
    const r = raw('generic');
    r.indicators.speeding.rs = -1;
    expect(() => parseRuleset(r, 'g.json')).toThrow(/g\.json: indicators\.speeding\.rs: must be in \[0, Infinity\]/);
  });

  it('rejects an unknown offense on an indicator', () => {
    const r = raw('generic');
    r.indicators.speeding.offense = 'jaywalking';
    expect(() => parseRuleset(r, 'g.json')).toThrow('g.json: indicators.speeding.offense:');
  });

  it('rejects force levels out of order', () => {
    const r = raw('generic');
    r.force.levels.verbal = 5;
    expect(() => parseRuleset(r, 'g.json')).toThrow('g.json: force.levels.softHands:');
  });

  it('allows equal hardHands and ocSpray', () => {
    const r = raw('generic');
    expect(r.force.levels.hardHands).toBe(r.force.levels.ocSpray);
    expect(() => parseRuleset(r, 'g.json')).not.toThrow();
  });

  it('rejects a missing force level and a missing resistance max', () => {
    const r = raw('generic');
    delete r.force.levels.k9;
    expect(() => parseRuleset(r, 'g.json')).toThrow('g.json: force.levels.k9:');
    const r2 = raw('generic');
    delete r2.force.maxByResistance.lethal;
    expect(() => parseRuleset(r2, 'g.json')).toThrow('g.json: force.maxByResistance.lethal:');
  });

  it('rejects an unknown rule id reference', () => {
    const r = raw('generic');
    r.sita.ruleId = 'GS-99.9';
    expect(() => parseRuleset(r, 'g.json')).toThrow('g.json: sita.ruleId: references unknown rule id "GS-99.9"');
  });

  it('rejects a duplicate rule id', () => {
    const r = raw('generic');
    r.rules[1].id = r.rules[0].id;
    expect(() => parseRuleset(r, 'g.json')).toThrow('g.json: rules[1].id: duplicates');
  });

  it('rejects a bad doctrine and a missing offense', () => {
    const r = raw('generic');
    r.rules[0].doctrine = 'vibes';
    expect(() => parseRuleset(r, 'g.json')).toThrow('g.json: rules[0].doctrine:');
    const r2 = raw('generic');
    delete r2.offenses.violent;
    expect(() => parseRuleset(r2, 'g.json')).toThrow('g.json: offenses.violent: is missing');
  });

  it('rejects bad thresholds and a missing pursuit default', () => {
    const r = raw('generic');
    r.thresholds.pc = 0;
    expect(() => parseRuleset(r, 'g.json')).toThrow('g.json: thresholds.pc:');
    const r2 = raw('generic');
    delete r2.pursuit.maxOverLimitMph.default;
    expect(() => parseRuleset(r2, 'g.json')).toThrow('g.json: pursuit.maxOverLimitMph.default: is missing');
  });

  it('rejects an unknown event kind in recording lists', () => {
    const r = raw('generic');
    r.recording.requiredFor = ['detention', 'banana'];
    expect(() => parseRuleset(r, 'g.json')).toThrow('g.json: recording.requiredFor[1]:');
  });
});
