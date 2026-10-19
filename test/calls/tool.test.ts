/* The fixtures break the shipped JSON files on purpose, so they are mutated as untyped objects. */
import { describe, expect, it } from 'vitest';
import { CALL_CATALOG, TOOL_KINDS, actionDef, producibleFlags } from '../../src/calls';
import { rawInput, validateRaw, type Json, type Raw } from './helpers';

const fixtures = (mutate: (raw: Raw) => void, pattern: RegExp): void => {
  const raw = rawInput();
  mutate(raw);
  expect(() => validateRaw(raw)).toThrow(pattern);
};

const TOOL_ROWS: Record<string, string> = { photograph: 'camera', collectEvidence: 'evidence', canvass: 'canvass', perimeter: 'tape', preserveScene: 'tape' };

describe('action tool field (Phase 4)', () => {
  it('the catalog lists the tool kinds and the five tool actions', () => {
    expect([...TOOL_KINDS]).toEqual(['camera', 'evidence', 'canvass', 'tape']);
    for (const a of CALL_CATALOG.actions) expect(a.tool, a.id).toBe(TOOL_ROWS[a.id] ?? null);
    expect(actionDef('photograph').tool).toBe('camera');
  });

  it('tool actions still produce their flags (producible flags use `sets`)', () => {
    const domestic = CALL_CATALOG.families.find((f) => f.id === 'domestic')!;
    const flags = producibleFlags(domestic, domestic.branches[0]!);
    for (const f of ['photographed', 'evidenceCollected', 'canvassed']) expect(flags.has(f), f).toBe(true);
    const barricade = CALL_CATALOG.families.find((f) => f.id === 'barricade')!;
    expect(producibleFlags(barricade, barricade.branches[0]!).has('perimeter')).toBe(true);
    const inv = CALL_CATALOG.families.find((f) => f.id === 'investigation')!;
    expect(producibleFlags(inv, inv.branches[0]!).has('scenePreserved')).toBe(true);
  });

  it('the validator accepts every tool kind and a missing or null tool', () => {
    for (const tool of [...TOOL_KINDS, null]) {
      const raw = rawInput();
      (raw.actions.actions as Json[]).find((a) => a.id === 'knock')!.tool = tool;
      expect(() => validateRaw(raw)).not.toThrow();
    }
  });

  it('the validator rejects an unknown tool, naming the file and path', () => {
    fixtures((r) => { (r.actions.actions as Json[]).find((a) => a.id === 'photograph')!.tool = 'drone'; }, /actions\.json: actions\[\d+\]\.tool must be one of camera, evidence, canvass, tape/);
    fixtures((r) => { (r.actions.actions as Json[]).find((a) => a.id === 'photograph')!.tool = 3; }, /actions\[\d+\]\.tool/);
  });
});
