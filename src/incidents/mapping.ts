import mappingJson from '../data/incidents/mapping.json';
import { getRuleset } from '../legal/ruleset';
import { FORCE_LEVELS, type ForceLevel } from '../legal/types';
import { fail, readArray, readObject, readOneOf, readString, readVersion, type JsonObject } from '../vehicles/json';

/** A hit text prefix (records readbacks are upper case) and the indicator it produces. */
export interface HitRow {
  prefix: string;
  indicator: string;
}

/** A contact fact that produces an indicator (design 9.3). Every optional field narrows the match. */
export interface FactRow {
  topic: string;
  /** The `contact:fact` source: `evidence` or `claim`. */
  source: 'evidence' | 'claim';
  detail?: string;
  displayPrefix?: string;
  valueIn?: string[];
  roles?: string[];
  indicator: string;
  /** The indicator belongs to the result of this test (`pbt`, `sfst`). */
  test?: 'pbt' | 'sfst';
}

export interface IncidentMapping {
  plateHits: HitRow[];
  personHits: HitRow[];
  /** Traffic violation kind -> indicator. */
  violations: Record<string, string>;
  facts: FactRow[];
  detainingCommands: string[];
  /** `npc:attack` kind -> indicator. */
  attack: Record<string, string>;
  plainView: { weapon: string; default: string };
  /** `force:used` kind -> [force level, tool]. */
  forceUsed: Record<string, [ForceLevel, string]>;
}

const FILE = 'incidents/mapping.json';

/** Validates the mapping data; every indicator name must be an indicator of the default ruleset. */
export function parseIncidentMapping(raw: unknown, file: string = FILE): IncidentMapping {
  const root = readObject(raw, file, '');
  readVersion(root, file);
  const known = Object.keys(getRuleset('generic').indicators);
  const indicator = (v: unknown, path: string): string => readOneOf(v, known, file, path);
  const strings = (v: unknown, path: string, min = 0): string[] => readArray(v, file, path, min).map((s, i) => readString(s, file, `${path}[${i}]`));
  const hits = (v: unknown, path: string): HitRow[] =>
    readArray(v, file, path, 1).map((row, i) => {
      const o = readObject(row, file, `${path}[${i}]`);
      return { prefix: readString(o.prefix, file, `${path}[${i}].prefix`), indicator: indicator(o.indicator, `${path}[${i}].indicator`) };
    });
  const table = (v: unknown, path: string): Record<string, string> => {
    const o = readObject(v, file, path);
    const out: Record<string, string> = {};
    for (const k of Object.keys(o)) out[k] = indicator(o[k], `${path}.${k}`);
    return out;
  };

  const facts = readArray(root.facts, file, 'facts', 1).map((row, i): FactRow => {
    const path = `facts[${i}]`;
    const o: JsonObject = readObject(row, file, path);
    const fact: FactRow = {
      topic: readString(o.topic, file, `${path}.topic`),
      source: readOneOf(o.source, ['evidence', 'claim'] as const, file, `${path}.source`),
      indicator: indicator(o.indicator, `${path}.indicator`),
    };
    if (o.detail !== undefined) fact.detail = readString(o.detail, file, `${path}.detail`);
    if (o.displayPrefix !== undefined) fact.displayPrefix = readString(o.displayPrefix, file, `${path}.displayPrefix`);
    if (o.valueIn !== undefined) fact.valueIn = strings(o.valueIn, `${path}.valueIn`, 1);
    if (o.roles !== undefined) fact.roles = strings(o.roles, `${path}.roles`, 1);
    if (o.test !== undefined) fact.test = readOneOf(o.test, ['pbt', 'sfst'] as const, file, `${path}.test`);
    return fact;
  });

  const plain = readObject(root.plainView, file, 'plainView');
  const forceRaw = readObject(root.forceUsed, file, 'forceUsed');
  const forceUsed: Record<string, [ForceLevel, string]> = {};
  for (const kind of Object.keys(forceRaw)) {
    const pair = readArray(forceRaw[kind], file, `forceUsed.${kind}`);
    if (pair.length !== 2) fail(file, `forceUsed.${kind}`, `must be [level, tool], got ${pair.length} items`);
    forceUsed[kind] = [readOneOf(pair[0], FORCE_LEVELS, file, `forceUsed.${kind}[0]`), readString(pair[1], file, `forceUsed.${kind}[1]`)];
  }

  return {
    plateHits: hits(root.plateHits, 'plateHits'),
    personHits: hits(root.personHits, 'personHits'),
    violations: table(root.violations, 'violations'),
    facts,
    detainingCommands: strings(root.detainingCommands, 'detainingCommands', 1),
    attack: table(root.attack, 'attack'),
    plainView: { weapon: indicator(plain.weapon, 'plainView.weapon'), default: indicator(plain.default, 'plainView.default') },
    forceUsed,
  };
}

/** The shipped mapping (`src/data/incidents/mapping.json`). */
export const INCIDENT_MAPPING: IncidentMapping = parseIncidentMapping(mappingJson);
