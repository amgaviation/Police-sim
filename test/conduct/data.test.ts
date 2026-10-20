import { describe, expect, it } from 'vitest';
import {
  COMMENDATION_CONFIG, DISCIPLINE_CONFIG, IA_CONFIG, TRUST_CONFIG, parseCommendationConfig, parseDisciplineConfig, parseIaConfig,
  parseTrustConfig,
} from '../../src/conduct/data';
import commendationsJson from '../../src/data/conduct/commendations.json';
import disciplineJson from '../../src/data/conduct/discipline.json';
import iaJson from '../../src/data/conduct/ia.json';
import trustJson from '../../src/data/conduct/trust.json';

function clone<T>(v: T): Record<string, unknown> {
  return structuredClone(v) as Record<string, unknown>;
}

describe('conduct data', () => {
  it('loads the shipped files', () => {
    expect(TRUST_CONFIG.spill).toBe(0.25);
    expect(TRUST_CONFIG.deltas.excessiveForce).toBe(-0.06);
    expect(TRUST_CONFIG.effects.errorScale).toEqual([1.6, 0.4]);
    expect(IA_CONFIG.rules).toHaveLength(9);
    expect(IA_CONFIG.autoResolveH).toBe(12);
    expect(IA_CONFIG.rules.find((r) => r.id === 'questionableForce')?.minCount).toBe(2);
    expect(IA_CONFIG.rules.find((r) => r.id === 'excessiveForce')?.minCount).toBe(1);
    expect(DISCIPLINE_CONFIG.ladder.minor.map((s) => s.action)).toEqual(['counseling', 'writtenReprimand', 'suspension']);
    expect(DISCIPLINE_CONFIG.ladder.minor[2]?.hours).toBe(8);
    expect(DISCIPLINE_CONFIG.ladder.major[1]?.hours).toBe(40);
    expect(COMMENDATION_CONFIG.rules.map((r) => r.id)).toContain('lifesaving');
    expect(COMMENDATION_CONFIG.rules.find((r) => r.id === 'lifesaving')?.withinS).toBe(120);
  });

  it('names file and path on errors', () => {
    const t = clone(trustJson);
    (t.deltas as Record<string, unknown>).lawfulArrest = 'x';
    expect(() => parseTrustConfig(t, 'trust.json')).toThrow(/trust\.json: deltas\.lawfulArrest: must be a finite number/);
    const t2 = clone(trustJson);
    delete (t2.deltas as Record<string, unknown>).civilSuit;
    expect(() => parseTrustConfig(t2)).toThrow(/deltas\.civilSuit/);
    const t3 = clone(trustJson);
    (t3.deltas as Record<string, unknown>).bogus = 1;
    expect(() => parseTrustConfig(t3)).toThrow(/deltas\.bogus: is not a known delta/);
    const t4 = clone(trustJson);
    t4.min = 0.99;
    expect(() => parseTrustConfig(t4)).toThrow(/max: must be greater than min/);
    expect(() => parseTrustConfig({ version: 2 })).toThrow(/version/);

    const ia = clone(iaJson);
    (ia.rules as Record<string, unknown>[])[1] = { id: 'x', when: 'forceTool', level: 'nuke', severity: 'minor' };
    expect(() => parseIaConfig(ia)).toThrow(/ia\.json: rules\[1\]\.level: must be one of/);
    const ia2 = clone(iaJson);
    (ia2.rules as Record<string, unknown>[])[1] = { id: 'excessiveForce', when: 'complaint', severity: 'minor' };
    expect(() => parseIaConfig(ia2)).toThrow(/rules\[1\]\.id: duplicates/);
    const ia3 = clone(iaJson);
    (ia3.rules as Record<string, unknown>[])[0] = { id: 'a', when: 'bogus', severity: 'minor' };
    expect(() => parseIaConfig(ia3)).toThrow(/rules\[0\]\.when/);

    const d = clone(disciplineJson);
    ((d.ladder as Record<string, unknown>).minor as string[])[2] = 'suspension';
    expect(() => parseDisciplineConfig(d)).toThrow(/ladder\.minor\[2\]: suspension needs hours/);
    const d2 = clone(disciplineJson);
    ((d2.ladder as Record<string, unknown>).minor as string[])[0] = 'fine:5';
    expect(() => parseDisciplineConfig(d2)).toThrow(/ladder\.minor\[0\]: must be one of/);
    const d3 = clone(disciplineJson);
    ((d3.ladder as Record<string, unknown>).major as string[]) = [];
    expect(() => parseDisciplineConfig(d3)).toThrow(/ladder\.major: must have at least 1/);

    const c = clone(commendationsJson);
    (c.rules as Record<string, unknown>[])[0] = { id: 'a', label: '', points: 1 };
    expect(() => parseCommendationConfig(c)).toThrow(/commendations\.json: rules\[0\]\.label/);
  });
});
