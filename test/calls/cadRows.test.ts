import { describe, expect, it } from 'vitest';
import { catalogCadRows, mergeCadRows } from '../../src/calls/cadRows';
import { validateCallTypes } from '../../src/cad/data';
import { CTX } from './helpers';

const families = {
  version: 1,
  families: [
    {
      id: 'alpha',
      defaults: { priority: { 3: 1 }, location: 'block', units: [2, 3], districts: { downtown: 2 }, codeKey: null },
      outcomes: [
        { id: 'x', when: 'a', disposition: 'arrestMade', grade: 'good' },
        { id: 'y', when: 'b', disposition: 'reportTaken', grade: 'ok' },
        { id: 'z', when: 'c', disposition: 'arrestMade', grade: 'ok' },
        { id: 'default', when: 'true', disposition: 'handled', grade: 'ok' },
      ],
    },
    { id: 'beta', defaults: { priority: { 4: 1 }, location: 'road' }, outcomes: [{ id: 'default', when: 'true', disposition: 'handled', grade: 'ok' }] },
  ],
};

function row(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, label: id, category: 'traffic', generated: true, weight: 1, narratives: ['One {street}.', 'Two {near}.'], ...extra };
}

describe('mergeCadRows', () => {
  it('merges rows over family defaults with the design fallbacks, in file then row order', () => {
    const rows = mergeCadRows(families, [
      { file: 'a.json', json: { version: 1, family: 'alpha', types: [row('r1'), row('r2', { location: 'road', units: [1, 1], codeKey: 'hazard' })] } },
      { file: 'b.json', json: { version: 1, family: 'beta', types: [row('r3')] } },
    ]) as Record<string, unknown>[];
    expect(rows.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(rows[0]).toEqual({
      id: 'r1', label: 'r1', codeKey: null, category: 'traffic', generated: true, weight: 1, priority: { 3: 1 }, location: 'block',
      districts: { downtown: 2 }, units: [2, 3], onSceneS: [180, 420], callers: { citizen: 0.8, anonymous: 0.2 },
      narratives: ['One {street}.', 'Two {near}.'], fill: {}, dispositions: ['arrestMade', 'reportTaken', 'handled'],
    });
    expect(rows[1]).toMatchObject({ location: 'road', units: [1, 1], codeKey: 'hazard', districts: { downtown: 2 } });
    expect(rows[2]).toMatchObject({ codeKey: null, units: [1, 1], districts: { water: 0 }, dispositions: ['handled'], priority: { 4: 1 } });
  });

  it('keeps only Phase 2 CAD keys and lets an explicit null win', () => {
    const rows = mergeCadRows(families, [
      { file: 'a.json', json: { version: 1, family: 'alpha', types: [row('r1', { branchWeights: { a: 1 }, variants: { false: 1 }, codeKey: null })] } },
    ]) as Record<string, unknown>[];
    expect(rows[0]).not.toHaveProperty('branchWeights');
    expect(rows[0]).not.toHaveProperty('variants');
    expect(rows[0]?.codeKey).toBeNull();
  });

  it('throws naming the file for an unknown family', () => {
    expect(() => mergeCadRows(families, [{ file: 'z.json', json: { version: 1, family: 'nope', types: [] } }])).toThrow(/types\/z\.json: family references unknown family "nope"/);
    expect(() => mergeCadRows(families, [{ file: 'z.json', json: { version: 1, types: [] } }])).toThrow(/types\/z\.json: family must be a family id/);
  });

  it('produces rows that pass the CAD validator for the shipped catalog', () => {
    const rows = catalogCadRows();
    expect(rows).toHaveLength(166);
    const ctx = { dispositions: CTX.dispositions, codeKeys: ['hazard', 'pursuit', 'shotsFired', 'ems', 'collision', 'trafficStop'] };
    expect(() => validateCallTypes({ version: 1, types: rows }, ctx, 'calls/types/*.json')).not.toThrow();
  });
});
