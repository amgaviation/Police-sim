import { describe, expect, it } from 'vitest';
import { INCIDENT_MAPPING, parseIncidentMapping } from '../../src/incidents/mapping';
import { getRuleset, rulesetIds } from '../../src/legal';
import raw from '../../src/data/incidents/mapping.json';

function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
}

describe('incident mapping data', () => {
  it('parses the shipped file with every row of the design', () => {
    expect(INCIDENT_MAPPING.plateHits.map((r) => r.indicator)).toEqual([
      'stolenVehicle', 'stolenPlate', 'plateMismatch', 'expiredRegistration', 'boloMatch', 'ownerWarrant',
    ]);
    expect(INCIDENT_MAPPING.personHits.map((r) => r.prefix)).toEqual(['WARRANT', 'BOLO', 'LICENSE', 'NO LICENSE']);
    expect(Object.keys(INCIDENT_MAPPING.violations).sort()).toEqual(['redLight', 'rollingStop', 'speeding', 'tailgating', 'weaving']);
    expect(INCIDENT_MAPPING.facts).toHaveLength(8);
    expect(INCIDENT_MAPPING.facts.filter((f) => f.test !== undefined).map((f) => f.test)).toEqual(['pbt', 'sfst']);
    expect(INCIDENT_MAPPING.detainingCommands).toContain('handsUp');
    expect(INCIDENT_MAPPING.attack).toEqual({ fight: 'assaultOnOfficer', fire: 'assaultOnOfficer', brandish: 'weaponSeen' });
    expect(INCIDENT_MAPPING.plainView).toEqual({ weapon: 'weaponSeen', default: 'contrabandPlainView' });
    expect(INCIDENT_MAPPING.forceUsed).toEqual({
      tackle: ['hardHands', 'tackle'], struggle: ['softHands', 'struggle'], cuff: ['softHands', 'cuffResisted'], sidearmDrawn: ['presence', 'firearmDisplay'],
    });
    expect(INCIDENT_MAPPING.forceUsed.taser).toBeUndefined();
  });

  it('every indicator it names exists in every shipped ruleset', () => {
    const names = new Set<string>();
    for (const r of [...INCIDENT_MAPPING.plateHits, ...INCIDENT_MAPPING.personHits, ...INCIDENT_MAPPING.facts]) names.add(r.indicator);
    for (const v of [...Object.values(INCIDENT_MAPPING.violations), ...Object.values(INCIDENT_MAPPING.attack), INCIDENT_MAPPING.plainView.weapon, INCIDENT_MAPPING.plainView.default]) names.add(v);
    for (const id of rulesetIds()) for (const n of names) expect(getRuleset(id).indicators[n], `${id}:${n}`).toBeDefined();
  });

  it('rejects an indicator the ruleset does not define, naming the path', () => {
    const bad = clone();
    (bad.plateHits as { indicator: string }[])[2]!.indicator = 'nope';
    expect(() => parseIncidentMapping(bad, 'm.json')).toThrow(/m\.json: plateHits\[2\]\.indicator must be one of/);
    const bad2 = clone();
    (bad2.facts as { indicator: string }[])[5]!.indicator = 'nope';
    expect(() => parseIncidentMapping(bad2, 'm.json')).toThrow(/facts\[5\]\.indicator/);
    const bad3 = clone();
    (bad3.violations as Record<string, string>).speeding = 'nope';
    expect(() => parseIncidentMapping(bad3, 'm.json')).toThrow(/violations\.speeding/);
  });

  it('rejects malformed structure', () => {
    const noVersion = clone();
    noVersion.version = 2;
    expect(() => parseIncidentMapping(noVersion, 'm.json')).toThrow(/version/);
    const badPair = clone();
    (badPair.forceUsed as Record<string, unknown>).tackle = ['hardHands'];
    expect(() => parseIncidentMapping(badPair, 'm.json')).toThrow(/forceUsed\.tackle/);
    const badLevel = clone();
    (badLevel.forceUsed as Record<string, unknown>).tackle = ['mega', 'tackle'];
    expect(() => parseIncidentMapping(badLevel, 'm.json')).toThrow(/forceUsed\.tackle\[0\]/);
    const badSource = clone();
    (badSource.facts as { source: string }[])[0]!.source = 'rumor';
    expect(() => parseIncidentMapping(badSource, 'm.json')).toThrow(/facts\[0\]\.source/);
    const badTest = clone();
    (badTest.facts as { test: string }[])[2]!.test = 'urine';
    expect(() => parseIncidentMapping(badTest, 'm.json')).toThrow(/facts\[2\]\.test/);
    const empty = clone();
    empty.detainingCommands = [];
    expect(() => parseIncidentMapping(empty, 'm.json')).toThrow(/detainingCommands/);
    expect(() => parseIncidentMapping(null, 'm.json')).toThrow(/m\.json/);
  });
});
