/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- tests mutate loosely typed raw JSON */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRuleset } from '../../src/legal/ruleset';
import { validateModBundle } from '../../src/mods/schema';
import { MOD_CONTENT_KINDS } from '../../src/mods/types';
import { parseDispatchScript } from '../../src/training/script';
import { SAMPLE_SCENARIOS, parseSandboxScenario } from '../../src/training/scenario';
import { parseVehicleModel } from '../../src/vehicles/model';
import { ROOT, nightShiftPack, readJson, realContext } from './helpers';

type Json = Record<string, any>;

const DIR = join(ROOT, 'docs', 'schemas');
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.schema.json')).sort();
const schema = (name: string): Json => JSON.parse(readFileSync(join(DIR, `${name}.schema.json`), 'utf8')) as Json;

/** Removing a key must be rejected exactly when the schema lists it as required. */
function expectRequiredMatches(name: string, doc: Json, accepts: (doc: Json) => boolean): void {
  const required: string[] = schema(name).required;
  expect(accepts(doc), `${name}: the sample document must be valid`).toBe(true);
  for (const key of required) expect(key in doc, `${name}: required key ${key} is missing from the sample`).toBe(true);
  for (const key of Object.keys(doc)) {
    const copy = { ...doc };
    delete copy[key];
    expect(accepts(copy), `${name}: removing ${key} should be ${required.includes(key) ? 'rejected' : 'accepted'}`).toBe(!required.includes(key));
  }
}

function throwsNot(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

/** Wraps `content` in the example manifest. */
function accepted(content: Json): boolean {
  const pack = nightShiftPack() as Json;
  pack.content = content;
  return validateModBundle(pack, realContext()).ok;
}

describe('docs/schemas files', () => {
  it('lists all ten schemas', () => {
    expect(FILES).toEqual([
      'call-types.schema.json', 'dispatch-script.schema.json', 'districts.schema.json', 'patrol-mod.schema.json', 'ruleset.schema.json',
      'scenario.schema.json', 'statute.schema.json', 'uniforms.schema.json', 'vehicle.schema.json', 'voice-pack.schema.json',
    ]);
  });

  it.each(FILES)('%s parses and declares $schema and $id', (file) => {
    const s = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Json;
    expect(s.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(s.$id).toBe(`https://patrol.invalid/schemas/${file}`);
    expect(typeof s.title).toBe('string');
    expect(typeof s.description).toBe('string');
  });

  it('every $ref of the bundle schema points at a schema file', () => {
    const refs = Object.values(schema('patrol-mod').properties.content.properties).flatMap((p) => {
      const node = p as Json;
      return [node.$ref ?? node.items?.$ref].filter((r): r is string => typeof r === 'string');
    });
    expect(refs.length).toBe(MOD_CONTENT_KINDS.length);
    for (const ref of refs) expect(FILES).toContain(ref);
  });

  it('content properties are exactly MOD_CONTENT_KINDS', () => {
    expect(Object.keys(schema('patrol-mod').properties.content.properties).sort()).toEqual([...MOD_CONTENT_KINDS].sort());
  });
});

describe('required top-level properties equal the validators', () => {
  it('patrol-mod (manifest keys)', () => {
    const doc = nightShiftPack() as Json;
    expectRequiredMatches('patrol-mod', doc, (d) => validateModBundle(d, realContext()).ok);
    expect(Object.keys(schema('patrol-mod').properties).sort()).toEqual(Object.keys(doc).sort());
  });

  it('call-types (file level and type row)', () => {
    const entry = (nightShiftPack() as Json).content.callTypes[0] as Json;
    expectRequiredMatches('call-types', entry, (d) => accepted({ callTypes: [d] }));
    const base = readJson('src', 'data', 'calls', 'types', 'parking.json') as Json;
    const row = { ...(base.types[1] as Json), id: 'schemaProbeType' };
    const rowSchema = schema('call-types').properties.types.items as Json;
    const rowDoc: Json = { ...row };
    expect(Object.keys(rowSchema.properties)).toEqual(expect.arrayContaining(Object.keys(rowDoc)));
    const accepts = (r: Json): boolean => accepted({ callTypes: [{ family: 'parking', types: [r] }] });
    expect(accepts(rowDoc)).toBe(true);
    for (const key of Object.keys(rowDoc)) {
      const copy = { ...rowDoc };
      delete copy[key];
      expect(accepts(copy), `row key ${key}`).toBe(!(rowSchema.required as string[]).includes(key));
    }
  });

  it('statute', () => {
    const row = { ...((nightShiftPack() as Json).content.statutes[0] as Json), speed: false };
    expectRequiredMatches('statute', row, (d) => accepted({ statutes: [d] }));
  });

  it('ruleset', () => {
    const doc = readJson('src', 'data', 'legal', 'rulesets', 'generic.json') as Json;
    expectRequiredMatches('ruleset', doc, (d) => throwsNot(() => parseRuleset(d, 'x.json')));
    expect(Object.keys(schema('ruleset').properties).sort()).toEqual(Object.keys(doc).sort());
  });

  it('vehicle', () => {
    const doc = readJson('src', 'data', 'vehicles', 'patrol_sedan.json') as Json;
    expectRequiredMatches('vehicle', doc, (d) => throwsNot(() => parseVehicleModel(d, 'x.json')));
    for (const key of Object.keys(doc)) expect(schema('vehicle').properties).toHaveProperty(key);
  });

  it('dispatch-script', () => {
    const doc = readJson('src', 'data', 'training', 'scripts', 'quiet-weekday.json') as Json;
    expectRequiredMatches('dispatch-script', doc, (d) => parseDispatchScript(d).ok);
    const step = schema('dispatch-script').properties.steps.items as Json;
    expect(Object.keys(step.properties).sort()).toEqual(['atS', 'narrative', 'near', 'priority', 'radio', 'typeId']);
    expect(step.required).toEqual(['atS', 'typeId', 'near']);
    // priority / narrative / radio are optional, atS / typeId / near are not
    const first = (doc.steps as Json[])[0] as Json;
    for (const key of Object.keys(first)) {
      const copy = { ...doc, steps: [{ ...first }] };
      delete (copy.steps[0] as Json)[key];
      expect(parseDispatchScript(copy).ok, `step key ${key}`).toBe(!(step.required as string[]).includes(key));
    }
  });

  it('scenario', () => {
    const doc = JSON.parse(JSON.stringify(SAMPLE_SCENARIOS[0])) as Json;
    expectRequiredMatches('scenario', doc, (d) => parseSandboxScenario(d).ok);
  });

  it('voice-pack', () => {
    const pack = (nightShiftPack() as Json).content.voicePacks[0] as Json;
    expectRequiredMatches('voice-pack', pack, (d) => accepted({ voicePacks: [d] }));
    const voice = schema('voice-pack').properties.voices.properties.dispatcher as Json;
    expect(voice.required).toEqual(['pitch', 'rate', 'prefer']);
    const v = pack.voices.dispatcher as Json;
    for (const key of voice.required as string[]) {
      const copy = JSON.parse(JSON.stringify(pack)) as Json;
      delete copy.voices.dispatcher[key];
      expect(accepted({ voicePacks: [copy] }), `voice key ${key}`).toBe(false);
    }
    expect(Object.keys(v).sort()).toEqual([...(voice.required as string[])].sort());
  });

  it('uniforms and districts list the keys the validator accepts', () => {
    const u = schema('uniforms');
    expect(Object.keys(u.properties).sort()).toEqual(['classes', 'department']);
    expect(accepted({ uniforms: { classes: [{ id: 'classB', top: '#010101' }] } })).toBe(true);
    expect(accepted({ uniforms: { other: 1 } })).toBe(false);
    const d = schema('districts');
    expect(d.propertyNames.enum).toEqual(realContext().districts);
    const props = d.additionalProperties.properties as Json;
    expect(Object.keys(props).sort()).toEqual(['crimeFactor', 'label', 'trustBaseline']);
    expect(props.crimeFactor).toMatchObject({ minimum: 0.2, maximum: 3 });
    expect(props.trustBaseline).toMatchObject({ minimum: 0.05, maximum: 0.95 });
    expect(props.label).toMatchObject({ minLength: 1, maxLength: 40 });
    expect(accepted({ districts: { harbor: { crimeFactor: 3, trustBaseline: 0.05 } } })).toBe(true);
    expect(accepted({ districts: { harbor: { crimeFactor: 3.01 } } })).toBe(false);
  });
});
