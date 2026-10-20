import { describe, expect, it } from 'vitest';
import { COMMAND_CONFIG, NEGOTIATION_DATA, parseCommandConfig, parseNegotiationData } from '../../src/command/data';
import commandJson from '../../src/data/command/command.json';
import negotiationJson from '../../src/data/command/negotiation.json';

/** A deep copy of `raw` with the value at `path` replaced (or removed when `value` is undefined). */
function edit(raw: unknown, path: (string | number)[], value: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(raw)) as unknown;
  let node = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = path[path.length - 1] as string | number;
  if (value === undefined) delete node[last];
  else node[last] = value;
  return copy;
}

describe('command.json', () => {
  it('parses the shipped file with the contract values', () => {
    expect(COMMAND_CONFIG.levels.families.massCasualty).toBe('disaster');
    expect(COMMAND_CONFIG.levels.majorUnitsOnScene).toBe(5);
    expect(COMMAND_CONFIG.post).toEqual({ standoffM: 60, autoOnArrival: true });
    expect(COMMAND_CONFIG.triage).toMatchObject({ assessS: 6, rangeM: 2.2, aiAssessS: 20, aiErrorRate: 0.05 });
    expect(COMMAND_CONFIG.transport.perUnit).toEqual({ immediate: 1, delayed: 2, minor: 3 });
    expect(COMMAND_CONFIG.tcp).toEqual({ radiusM: 140, max: 4, blockadeRadiusM: 8 });
    expect(COMMAND_CONFIG.evac.radiusM).toEqual({ hazmat: 220, package: 160, barricade: 70, default: 120 });
    expect(COMMAND_CONFIG.negotiation.surrenderTurns).toBe(2);
  });

  it('names the file and the dotted path of a bad value', () => {
    expect(() => parseCommandConfig(edit(commandJson, ['tcp', 'max'], 0), 'x.json')).toThrow(/x\.json: tcp\.max/);
    expect(() => parseCommandConfig(edit(commandJson, ['levels', 'families', 'barricade'], 'huge'), 'x.json')).toThrow(/levels\.families\.barricade/);
    expect(() => parseCommandConfig(edit(commandJson, ['mystery'], 1), 'x.json')).toThrow(/mystery/);
    expect(() => parseCommandConfig(edit(commandJson, ['version'], 2), 'x.json')).toThrow(/version/);
    expect(() => parseCommandConfig(edit(commandJson, ['triage', 'aiErrorRate'], 2), 'x.json')).toThrow(/triage\.aiErrorRate/);
  });
});

describe('negotiation.json', () => {
  it('parses the shipped file', () => {
    expect(NEGOTIATION_DATA.categories.map((c) => c.id)).toEqual(['listen', 'problem', 'pressure']);
    expect(NEGOTIATION_DATA.categories.flatMap((c) => c.options)).toHaveLength(11);
    expect(NEGOTIATION_DATA.toneFactor.aggressive).toBe(0.5);
    expect(NEGOTIATION_DATA.stageTrust.resolution).toBe(0.65);
    expect(NEGOTIATION_DATA.subject.temperament.volatile).toBe(0.15);
  });

  it('every shipped option is valid, unique and appropriate in some stage', () => {
    const ids = new Set<string>();
    for (const c of NEGOTIATION_DATA.categories) {
      for (const o of c.options) {
        expect(ids.has(o.id)).toBe(false);
        ids.add(o.id);
        expect(o.stages.length).toBeGreaterThan(0);
        expect(o.text.length).toBeGreaterThan(0);
      }
    }
  });

  it('rejects duplicates, unknown stages and missing reply lists', () => {
    const dup = edit(negotiationJson, ['categories', 1, 'options', 0, 'id'], 'minimal');
    expect(() => parseNegotiationData(dup, 'n.json')).toThrow(/duplicate option id minimal/);
    const stage = edit(negotiationJson, ['categories', 0, 'options', 0, 'stages'], ['nowhere']);
    expect(() => parseNegotiationData(stage, 'n.json')).toThrow(/n\.json: categories\[0\]\.options\[0\]\.stages\[0\]/);
    expect(() => parseNegotiationData(edit(negotiationJson, ['replies', 'calm'], []), 'n.json')).toThrow(/replies\.calm/);
    expect(() => parseNegotiationData(edit(negotiationJson, ['toneFactor', 'polite'], undefined), 'n.json')).toThrow(/toneFactor\.polite/);
  });
});
