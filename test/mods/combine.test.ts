import { describe, expect, it } from 'vitest';
import {
  applyUniformPatches,
  buildOverlay,
  canonicalJson,
  checkError,
  formatModErrors,
  mergePhrases,
  mergeStatutes,
  modRef,
  resolveActiveMods,
  validateCombination,
} from '../../src/mods/combine';
import { emptyOverlay } from '../../src/mods/registry';
import { validateModBundle } from '../../src/mods/schema';
import type { ModBundle } from '../../src/mods/types';
import { bundle, fakeContext, nightShiftPack, readJson, realContext } from './helpers';

const type = (id: string): unknown => ({ id, label: id, category: 'traffic', generated: true, weight: 1, narratives: ['a', 'b'] });
const vehicle = (id: string): unknown => ({ version: 1, id });

describe('modRef', () => {
  it('hashes the canonical JSON: key order does not matter, content does', () => {
    const a = bundle('alpha', { districts: { harbor: { crimeFactor: 1.1, label: 'H' } } });
    const b = bundle('alpha', { districts: { harbor: { label: 'H', crimeFactor: 1.1 } } });
    const c = bundle('alpha', { districts: { harbor: { label: 'H', crimeFactor: 1.2 } } });
    expect(modRef(a)).toEqual(modRef(b));
    expect(modRef(a).hash).toMatch(/^[0-9a-f]{8}$/);
    expect(modRef(c).hash).not.toBe(modRef(a).hash);
    expect(modRef(a)).toMatchObject({ id: 'alpha', modVersion: '1.0.0' });
  });

  it('canonicalJson sorts keys and skips undefined', () => {
    expect(canonicalJson({ b: 1, a: [{ d: undefined, c: 2 }] })).toBe('{"a":[{"c":2}],"b":1}');
  });
});

describe('resolveActiveMods: load order', () => {
  const a = bundle('mod-a', { districts: { harbor: { label: 'A' } } });
  const b = bundle('mod-b', { districts: { harbor: { label: 'B' } } });
  const c = bundle('mod-c', { districts: { downtown: { label: 'C' } } });

  it('follows the order list, ignores unknown ids and repeats, drops mods that are not listed', () => {
    const r = resolveActiveMods([a, b, c], ['mod-c', 'ghost', 'mod-a', 'mod-c']);
    expect(r.active.map((m) => m.id)).toEqual(['mod-c', 'mod-a']);
    expect(r.errors).toEqual([]);
  });

  it('later mods win per district key in the overlay', () => {
    expect(buildOverlay(resolveActiveMods([a, b], ['mod-a', 'mod-b']).active).districts.harbor).toEqual({ label: 'B' });
    expect(buildOverlay(resolveActiveMods([a, b], ['mod-b', 'mod-a']).active).districts.harbor).toEqual({ label: 'A' });
  });

  it('excludes the later mod when both define the same content id and names both', () => {
    const x = bundle('first-mod', { callTypes: [{ family: 'parking', types: [type('sameType')] }], vehicles: [vehicle('same_car')] });
    const y = bundle('second-mod', { callTypes: [{ family: 'parking', types: [type('otherType'), type('sameType')] }] });
    const z = bundle('third-mod', { vehicles: [vehicle('same_car')] });
    const r = resolveActiveMods([x, y, z], ['first-mod', 'second-mod', 'third-mod']);
    expect(r.active.map((m) => m.id)).toEqual(['first-mod']);
    expect(r.errors).toEqual([
      { mod: 'second-mod', path: 'callTypes[0].types[1].id', message: '"sameType" is already defined by mod "first-mod"; "second-mod" was not loaded' },
      { mod: 'third-mod', path: 'vehicles[0].id', message: '"same_car" is already defined by mod "first-mod"; "third-mod" was not loaded' },
    ]);
    // the exclusion depends on the order
    expect(resolveActiveMods([x, y], ['second-mod', 'first-mod']).active.map((m) => m.id)).toEqual(['second-mod']);
  });

  it('a mod does not collide with itself and patches never collide', () => {
    const u1 = bundle('uni-one', { uniforms: { classes: [{ id: 'classB', top: '#111111' }] }, districts: { harbor: { label: 'one' } } });
    const u2 = bundle('uni-two', { uniforms: { classes: [{ id: 'classB', top: '#222222' }] }, districts: { harbor: { label: 'two' } } });
    expect(resolveActiveMods([u1, u2], ['uni-one', 'uni-two'])).toEqual({ active: [u1, u2], errors: [] });
  });
});

describe('buildOverlay', () => {
  it('is empty for no mods', () => {
    expect(buildOverlay([])).toEqual(emptyOverlay());
  });

  it('merges the example bundle', () => {
    const r = validateModBundle(nightShiftPack(), realContext());
    if (!r.ok) throw new Error('example invalid');
    const o = buildOverlay([r.mod]);
    expect(o.refs).toEqual([modRef(r.mod)]);
    expect(o.callTypes).toHaveLength(1);
    expect(o.callTypes[0]?.file).toBe('mod:night-shift-pack:0.json');
    expect(o.callTypes[0]?.json).toMatchObject({ version: 1, family: 'parking' });
    expect(o.statutes).toHaveLength(1);
    expect(o.vehicles.map((v) => v.file)).toEqual(['night_courier.json']);
    expect(o.uniforms).toEqual([{ classes: [{ id: 'classB', label: 'Class B (night duty)', top: '#1f3d4d' }], department: null }]);
    expect(o.districts.harbor?.label).toBe('Harbor Row');
    expect(o.voicePack?.id).toBe('night-desk');
    expect(o.dispatchScripts).toHaveLength(1);
  });

  it('numbers call type files per mod, keeps mod order and takes the last voice pack', () => {
    const pack = (id: string): { id: string; name: string; voices: Record<string, never> } => ({ id, name: id, voices: {} });
    const a = bundle('mod-a', {
      callTypes: [{ family: 'parking', types: [type('a1')] }, { family: 'parking', types: [type('a2')] }],
      statutes: [{ id: 'TR-901' }],
      rulesets: [{ id: 'law-a' }],
      voicePacks: [pack('pack-1'), pack('pack-2')],
      dispatchScripts: [{ id: 's-a' }],
    });
    const b = bundle('mod-b', { callTypes: [{ family: 'parking', types: [type('b1')] }], statutes: [{ id: 'TR-902' }], voicePacks: [pack('pack-3')], dispatchScripts: [{ id: 's-b' }] });
    const o = buildOverlay([a, b]);
    expect(o.callTypes.map((f) => f.file)).toEqual(['mod:mod-a:0.json', 'mod:mod-a:1.json', 'mod:mod-b:0.json']);
    expect(o.statutes).toEqual([{ id: 'TR-901' }, { id: 'TR-902' }]);
    expect(o.rulesets.map((r) => r.file)).toEqual(['law-a.json']);
    expect(o.voicePack?.id).toBe('pack-3');
    expect(buildOverlay([b, a]).voicePack?.id).toBe('pack-2');
    expect(o.dispatchScripts).toEqual([{ id: 's-a' }, { id: 's-b' }]);
    expect(o.refs.map((r) => r.id)).toEqual(['mod-a', 'mod-b']);
  });

  it('merges uniform patches per mod in order', () => {
    const a = bundle('mod-a', { uniforms: { department: { name: 'A' } } });
    const b = bundle('mod-b', { uniforms: { classes: [{ id: 'classA', top: '#010101' }] } });
    expect(buildOverlay([a, b]).uniforms).toEqual([
      { classes: [], department: { name: 'A' } },
      { classes: [{ id: 'classA', top: '#010101' }], department: null },
    ]);
  });
});

describe('validateCombination', () => {
  it('accepts the two example mods together (real context)', () => {
    const r = validateModBundle(nightShiftPack(), realContext());
    if (!r.ok) throw new Error('example invalid');
    expect(validateCombination([r.mod], realContext())).toEqual([]);
  });

  it('catches the same id in two mods', () => {
    const a = bundle('mod-a', { statutes: [{ id: 'TR-900' }], dispatchScripts: [{ id: 'script-x' }] });
    const b = bundle('mod-b', { statutes: [{ id: 'TR-900' }], dispatchScripts: [{ id: 'script-x' }] });
    const errors = validateCombination([a, b], fakeContext());
    expect(errors).toEqual([
      { mod: 'mod-b', path: 'statutes[0].id', message: '"TR-900" is already defined by mod "mod-a"' },
      { mod: 'mod-b', path: 'dispatchScripts[0].id', message: '"script-x" is already defined by mod "mod-a"' },
    ]);
  });

  it('runs the merged checks over all mods', () => {
    let seenStatutes = 0;
    let seenFiles = 0;
    const ctx = fakeContext({
      checkStatutes: (rows) => {
        seenStatutes = rows.length;
        return ['statutes.json: statutes[1].id duplicates "TR-900"'];
      },
      checkCallTypes: (files) => {
        seenFiles = files.length;
        return [];
      },
    });
    const a = bundle('mod-a', { statutes: [{ id: 'TR-900' }], callTypes: [{ family: 'parking', types: [type('a1')] }] });
    const b = bundle('mod-b', { statutes: [{ id: 'TR-901' }], callTypes: [{ family: 'parking', types: [type('b1')] }] });
    const errors = validateCombination([a, b], ctx);
    expect(seenStatutes).toBe(2);
    expect(seenFiles).toBe(2);
    expect(errors).toEqual([{ mod: '(combination)', path: 'statutes[1].id', message: 'duplicates "TR-900"' }]);
  });

  it('checks scripts with the call types of all active mods', () => {
    const seen: string[][] = [];
    const ctx = fakeContext({ checkScript: (_s, extra) => (seen.push([...(extra ?? [])]), []) });
    const a = bundle('mod-a', { callTypes: [{ family: 'parking', types: [type('a1')] }] });
    const b = bundle('mod-b', { dispatchScripts: [{ id: 's' }] });
    expect(validateCombination([a, b], ctx)).toEqual([]);
    expect(seen).toEqual([['a1']]);
  });

  it('limits the vehicle table to 255 models', () => {
    const base = new Set(Array.from({ length: 254 }, (_, i) => `base_${i}`));
    const ctx = fakeContext({ baseVehicleIds: base });
    const a = bundle('mod-a', { vehicles: [vehicle('car_a'), vehicle('car_b')] });
    expect(validateCombination([a], ctx)).toEqual([{ mod: '(combination)', path: 'vehicles', message: '256 vehicle models in total; the limit is 255' }]);
    expect(validateCombination([bundle('mod-a', { vehicles: [vehicle('car_a')] })], ctx)).toEqual([]);
  });
});

describe('merge helpers', () => {
  const uniforms = readJson('src', 'data', 'uniform', 'uniforms.json') as { classes: { id: string; top: string; label: string }[]; department: { patch: { base: string; border: string }; name: string } };

  it('applyUniformPatches: returns base itself without patches, patches classes shallowly, merges department one level deeper', () => {
    expect(applyUniformPatches(uniforms, [])).toBe(uniforms);
    const out = applyUniformPatches(uniforms, [
      { classes: [{ id: 'classB', top: '#010203' }], department: { name: 'Night City Police', patch: { base: '#000000' } } },
      { classes: [{ id: 'classB', label: 'Night duty' }, { id: 'ghost', top: '#ffffff' }], department: null },
    ]) as typeof uniforms;
    const b = out.classes.find((c) => c.id === 'classB');
    expect(b).toMatchObject({ top: '#010203', label: 'Night duty', bottom: '#18202e' });
    expect(out.classes.find((c) => c.id === 'classA')).toEqual(uniforms.classes.find((c) => c.id === 'classA'));
    expect(out.classes.some((c) => c.id === 'ghost')).toBe(false);
    expect(out.department.name).toBe('Night City Police');
    expect(out.department.patch).toEqual({ ...uniforms.department.patch, base: '#000000' });
    // the base is untouched
    expect(uniforms.classes.find((c) => c.id === 'classB')?.top).not.toBe('#010203');
    expect(uniforms.department.name).toBe('City Police');
  });

  it('mergePhrases replaces the listed arrays only', () => {
    const phrases = readJson('src', 'data', 'radio', 'phrases.json') as { kinds: Record<string, { tenCode: string[]; plain: string[] }> };
    expect(mergePhrases(phrases, undefined)).toBe(phrases);
    expect(mergePhrases(phrases, {})).toMatchObject({ kinds: phrases.kinds });
    const out = mergePhrases(phrases, { accept: { plain: ['{unit}, on it.'] }, ghost: { plain: ['x'] } }) as typeof phrases;
    expect(out.kinds.accept).toEqual({ tenCode: phrases.kinds.accept?.tenCode, plain: ['{unit}, on it.'] });
    expect(out.kinds.code4).toEqual(phrases.kinds.code4);
    expect(out.kinds.ghost).toBeUndefined();
    expect(phrases.kinds.accept?.plain).not.toEqual(['{unit}, on it.']);
  });

  it('mergeStatutes appends rows', () => {
    const doc = { version: 1, statutes: [{ id: 'A' }], violationMap: {} };
    expect(mergeStatutes(doc, [])).toBe(doc);
    expect(mergeStatutes(doc, [{ id: 'B' }])).toEqual({ version: 1, statutes: [{ id: 'A' }, { id: 'B' }], violationMap: {} });
    expect(doc.statutes).toHaveLength(1);
  });
});

describe('checkError', () => {
  it('splits "<file>: <path> <problem>" and "<file>: <path>: <problem>"', () => {
    expect(checkError('m', 'vehicles[0]', 'night.json: body.length must be in [0, 9], got -3')).toEqual({
      mod: 'm', path: 'vehicles[0].body.length', message: 'must be in [0, 9], got -3',
    });
    expect(checkError('m', 'rulesets[2]', 'x.json: rules[0].id: duplicates "a"')).toEqual({ mod: 'm', path: 'rulesets[2].rules[0].id', message: 'duplicates "a"' });
    expect(checkError('m', 'dispatchScripts[1]', 'steps[3].typeId: unknown call type "x"')).toEqual({
      mod: 'm', path: 'dispatchScripts[1].steps[3].typeId', message: 'unknown call type "x"',
    });
    expect(checkError('m', 'p', 'x.json: (root): must be an object')).toEqual({ mod: 'm', path: 'p', message: 'must be an object' });
  });

  it('keeps the prefix for messages without a path', () => {
    expect(checkError('m', 'callTypes[0]', 'calls/types/*.json: call type id "x" duplicates a callTypes.json row')).toEqual({
      mod: 'm', path: 'callTypes[0]', message: 'call type id "x" duplicates a callTypes.json row',
    });
    expect(formatModErrors([{ mod: 'm', path: 'p', message: 'q' }])).toEqual(['m: p: q']);
  });
});

describe('type of ModBundle', () => {
  it('bundle() builds a manifest-complete object', () => {
    const b: ModBundle = bundle('mod-a', { districts: {} });
    expect(Object.keys(b)).toEqual(['format', 'version', 'id', 'name', 'author', 'description', 'modVersion', 'content']);
  });
});
