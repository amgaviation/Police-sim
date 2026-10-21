/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- tests mutate loosely typed raw JSON */
import { describe, expect, it } from 'vitest';
import { formatModErrors } from '../../src/mods/combine';
import { validateModBundle } from '../../src/mods/schema';
import type { ModError } from '../../src/mods/types';
import { fakeContext, nightShiftPack, readJson, realContext } from './helpers';

type Json = Record<string, any>;

/** Validates the example bundle after `mutate`; returns the errors ([] when valid). */
function errorsOf(mutate: (pack: Json) => void): ModError[] {
  const pack = nightShiftPack() as Json;
  mutate(pack);
  const r = validateModBundle(pack, realContext());
  return r.ok ? [] : r.errors;
}

function expectError(errors: ModError[], path: string, message: string | RegExp): void {
  const hit = errors.find((e) => e.path === path);
  expect(hit, `no error at ${path}; got ${JSON.stringify(errors)}`).toBeDefined();
  if (typeof message === 'string') expect(hit?.message).toContain(message);
  else expect(hit?.message).toMatch(message);
}

describe('validateModBundle: the example bundle', () => {
  it('validates and returns a typed copy', () => {
    const pack = nightShiftPack();
    const r = validateModBundle(pack, realContext());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mod.id).toBe('night-shift-pack');
    expect(Object.keys(r.mod.content).sort()).toEqual(
      ['callTypes', 'dispatchScripts', 'districts', 'statutes', 'uniforms', 'vehicles', 'voicePacks'],
    );
    // a copy: mutating the result never touches the input
    (r.mod.content.statutes as { title?: string }[])[0]!.title = 'changed';
    expect((pack as Json).content.statutes[0].title).toBe('Blocking a loading zone');
  });

  it('is valid under a permissive fake context too', () => {
    expect(validateModBundle(nightShiftPack(), fakeContext({ baseVehicleIds: new Set() })).ok).toBe(true);
  });
});

describe('validateModBundle: manifest', () => {
  it('rejects a document that is not an object', () => {
    for (const v of [null, 4, 'x', [], undefined]) {
      const r = validateModBundle(v, fakeContext());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]?.message).toContain('must be a JSON object');
    }
  });

  it('rejects a wrong format', () => {
    expectError(errorsOf((p) => (p.format = 'other-mod')), 'format', 'must be "patrol-mod", got "other-mod"');
  });

  it('rejects a wrong format version', () => {
    expectError(errorsOf((p) => (p.version = 2)), 'version', 'must be 1, got 2');
  });

  it('rejects a bad id', () => {
    const errors = errorsOf((p) => (p.id = 'Bad Id!'));
    expectError(errors, 'id', 'must match /^[a-z0-9][a-z0-9-]{1,39}$/');
    expect(errors.every((e) => e.mod === 'Bad Id!')).toBe(true);
  });

  it('rejects a missing name and an over-long one', () => {
    expectError(errorsOf((p) => delete p.name), 'name', 'is required');
    expectError(errorsOf((p) => (p.name = 'x'.repeat(61))), 'name', 'must be 1..60 characters long, got 61');
    expectError(errorsOf((p) => (p.name = '')), 'name', 'must be 1..60 characters long, got 0');
  });

  it('limits author and description', () => {
    expectError(errorsOf((p) => (p.author = 'a'.repeat(61))), 'author', '0..60');
    expectError(errorsOf((p) => (p.description = 'd'.repeat(401))), 'description', '0..400');
  });

  it('rejects a bad modVersion', () => {
    expectError(errorsOf((p) => (p.modVersion = '1.0')), 'modVersion', 'major.minor.patch');
  });

  it('rejects unknown manifest keys', () => {
    expectError(errorsOf((p) => (p.homepage = 'x')), 'homepage', 'unknown field');
  });

  it('requires content to be an object', () => {
    expectError(errorsOf((p) => delete p.content), 'content', 'is required');
    expectError(errorsOf((p) => (p.content = [])), 'content', 'must be an object');
  });

  it('rejects an unknown content kind', () => {
    const errors = errorsOf((p) => (p.content.maps = {}));
    expectError(errors, 'content.maps', 'unknown content kind (expected one of callTypes, statutes');
  });

  it('rejects empty content', () => {
    expectError(errorsOf((p) => (p.content = {})), 'content', 'must contain at least one of callTypes');
  });

  it('collects several errors at once', () => {
    const errors = errorsOf((p) => {
      p.format = 'x';
      delete p.name;
      p.content.districts.harbor.crimeFactor = 9;
    });
    expect(errors.map((e) => e.path).sort()).toEqual(['districts.harbor.crimeFactor', 'format', 'name']);
  });
});

describe('validateModBundle: call types', () => {
  it('rejects a call type of an unknown family', () => {
    const errors = errorsOf((p) => (p.content.callTypes[0].family = 'noSuchFamily'));
    expectError(errors, 'callTypes[0].family', 'unknown call family "noSuchFamily" (known: ');
  });

  it('rejects an id of the base game', () => {
    const errors = errorsOf((p) => (p.content.callTypes[0].types[0].id = 'noiseComplaint'));
    expectError(errors, 'callTypes[0].types[0].id', '"noiseComplaint" already exists in the base game');
  });

  it('rejects a duplicate id inside the mod', () => {
    const errors = errorsOf((p) => {
      const t = p.content.callTypes[0].types;
      t.push({ ...t[0] });
    });
    expectError(errors, 'callTypes[0].types[1].id', 'duplicates "loadingZoneBlocked" (also at callTypes[0].types[0].id)');
  });

  it('names the failing field of the catalog validator', () => {
    const errors = errorsOf((p) => (p.content.callTypes[0].types[0].category = 'nonsense'));
    expectError(errors, 'callTypes[0].types[0].category', /must be one of/);
    const errors2 = errorsOf((p) => (p.content.callTypes[0].types[0].narratives = ['only one']));
    expectError(errors2, 'callTypes[0].types[0].narratives', /at least 2 items/);
  });

  it('rejects unknown keys of a type row and an empty list', () => {
    expectError(errorsOf((p) => (p.content.callTypes[0].types[0].colour = 1)), 'callTypes[0].types[0].colour', /is not one of id, label/);
    expectError(errorsOf((p) => (p.content.callTypes[0].types = [])), 'callTypes[0].types', 'must not be empty');
  });
});

describe('validateModBundle: statutes', () => {
  it('rejects a base statute id', () => {
    const errors = errorsOf((p) => (p.content.statutes[0].id = 'TR-301'));
    expectError(errors, 'statutes[0].id', '"TR-301" already exists in the base game');
  });

  it('rejects a duplicate inside the mod and a bad field', () => {
    expectError(
      errorsOf((p) => p.content.statutes.push({ ...p.content.statutes[0] })),
      'statutes[1].id',
      'duplicates "TR-399" (also at statutes[0].id)',
    );
    expectError(errorsOf((p) => (p.content.statutes[0].fine = -5)), 'statutes[0].fine', /must be in/);
    expectError(errorsOf((p) => (p.content.statutes[0].id = 'x1')), 'statutes[0].id', /must look like/);
  });
});

describe('validateModBundle: rulesets', () => {
  const ruleset = (id: string): Json => ({ ...(readJson('src', 'data', 'legal', 'rulesets', 'generic.json') as Json), id });

  it('accepts a full ruleset document', () => {
    const errors = errorsOf((p) => {
      delete p.content.callTypes;
      delete p.content.dispatchScripts;
      p.content.rulesets = [ruleset('my-city')];
    });
    expect(errors).toEqual([]);
  });

  it('rejects a base ruleset id', () => {
    const errors = errorsOf((p) => (p.content.rulesets = [ruleset('generic')]));
    expectError(errors, 'rulesets[0].id', '"generic" already exists in the base game');
  });

  it('rejects an id that cannot be the file name of the ruleset', () => {
    const errors = errorsOf((p) => (p.content.rulesets = [ruleset('My City')]));
    expectError(errors, 'rulesets[0].id', 'a ruleset id usable as a file name');
  });

  it('names the broken field of the ruleset', () => {
    const errors = errorsOf((p) => {
      const r = ruleset('my-city');
      r.pursuit.maxDurationS = 0;
      p.content.rulesets = [r];
    });
    expectError(errors, 'rulesets[0].pursuit.maxDurationS', /must be in \[1, Infinity\]/);
  });
});

describe('validateModBundle: vehicles', () => {
  it('rejects a base vehicle id', () => {
    const errors = errorsOf((p) => (p.content.vehicles[0].id = 'patrol_sedan'));
    expectError(errors, 'vehicles[0].id', '"patrol_sedan" already exists in the base game');
  });

  it('names the bad field', () => {
    const errors = errorsOf((p) => (p.content.vehicles[0].body.length = -3));
    expectError(errors, 'vehicles[0].body.length', /must be/);
    const errors2 = errorsOf((p) => delete p.content.vehicles[0].engine);
    expect(errors2.some((e) => e.path.startsWith('vehicles[0]'))).toBe(true);
  });

  it('rejects an id that is not a file name', () => {
    expectError(errorsOf((p) => (p.content.vehicles[0].id = 'Night Courier')), 'vehicles[0].id', 'a vehicle id usable as a file name');
  });
});

describe('validateModBundle: uniforms', () => {
  it('rejects an unknown class', () => {
    const errors = errorsOf((p) => (p.content.uniforms.classes[0].id = 'dressWhites'));
    expectError(errors, 'uniforms.classes[0].id', 'unknown uniform class "dressWhites" (patches can change: classA, classB');
  });

  it('rejects a bad colour through the uniform parser', () => {
    const errors = errorsOf((p) => (p.content.uniforms.classes[0].top = 'blue'));
    expectError(errors, 'uniforms.classes[1].top', /colour/);
  });

  it('rejects an empty patch', () => {
    expectError(errorsOf((p) => (p.content.uniforms = {})), 'uniforms', 'must set classes or department');
  });
});

describe('validateModBundle: districts', () => {
  it('rejects an unknown district', () => {
    const errors = errorsOf((p) => (p.content.districts.moonbase = { crimeFactor: 1 }));
    expectError(errors, 'districts.moonbase', 'unknown district "moonbase" (known: downtown');
  });

  it('enforces the ranges', () => {
    expectError(errorsOf((p) => (p.content.districts.harbor.crimeFactor = 3.5)), 'districts.harbor.crimeFactor', 'must be in [0.2, 3], got 3.5');
    expectError(errorsOf((p) => (p.content.districts.harbor.crimeFactor = 0.1)), 'districts.harbor.crimeFactor', 'must be in [0.2, 3], got 0.1');
    expectError(errorsOf((p) => (p.content.districts.harbor.trustBaseline = 0.99)), 'districts.harbor.trustBaseline', 'must be in [0.05, 0.95]');
    expectError(errorsOf((p) => (p.content.districts.harbor.label = 'L'.repeat(41))), 'districts.harbor.label', '1..40');
    expectError(errorsOf((p) => (p.content.districts.harbor.crimeFactor = '2')), 'districts.harbor.crimeFactor', 'must be a number');
  });

  it('accepts the edges of the ranges', () => {
    expect(errorsOf((p) => (p.content.districts.harbor = { crimeFactor: 0.2, trustBaseline: 0.95, label: 'L' }))).toEqual([]);
    expect(errorsOf((p) => (p.content.districts.harbor = { crimeFactor: 3, trustBaseline: 0.05 }))).toEqual([]);
  });

  it('rejects unknown fields and empty patches', () => {
    expectError(errorsOf((p) => (p.content.districts.harbor.safe = true)), 'districts.harbor.safe', 'unknown field');
    expectError(errorsOf((p) => (p.content.districts.harbor = {})), 'districts.harbor', 'must set label, crimeFactor or trustBaseline');
  });
});

describe('validateModBundle: voice packs', () => {
  it('enforces pitch and rate ranges and order', () => {
    expectError(errorsOf((p) => (p.content.voicePacks[0].voices.dispatcher.pitch = [0.4, 1])), 'voicePacks[0].voices.dispatcher.pitch[0]', 'must be in [0.5, 2], got 0.4');
    expectError(errorsOf((p) => (p.content.voicePacks[0].voices.dispatcher.rate = [1, 2.5])), 'voicePacks[0].voices.dispatcher.rate[1]', 'must be in [0.5, 2], got 2.5');
    expectError(errorsOf((p) => (p.content.voicePacks[0].voices.dispatcher.rate = [1.5, 1])), 'voicePacks[0].voices.dispatcher.rate', 'min 1.5 must not exceed max 1');
    expectError(errorsOf((p) => (p.content.voicePacks[0].voices.dispatcher.pitch = [1])), 'voicePacks[0].voices.dispatcher.pitch', 'must be a [min, max] pair');
  });

  it('allows at most 8 preferred voices', () => {
    expectError(
      errorsOf((p) => (p.content.voicePacks[0].voices.officer.prefer = Array.from({ length: 9 }, (_, i) => `v${i}`))),
      'voicePacks[0].voices.officer.prefer',
      'must have at most 8 entries, got 9',
    );
    expect(errorsOf((p) => (p.content.voicePacks[0].voices.officer.prefer = Array.from({ length: 8 }, (_, i) => `v${i}`)))).toEqual([]);
  });

  it('rejects an unknown voice kind and an unknown phrase kind', () => {
    expectError(errorsOf((p) => (p.content.voicePacks[0].voices.narrator = { pitch: [1, 1], rate: [1, 1], prefer: [] })), 'voicePacks[0].voices.narrator', 'unknown voice kind');
    const errors = errorsOf((p) => (p.content.voicePacks[0].phrases.shoutOut = { plain: ['hi'] }));
    expectError(errors, 'voicePacks[0].phrases.shoutOut', 'unknown phrase kind (expected one of assign, unitAck');
  });

  it('checks phrase templates through the radio validator', () => {
    const errors = errorsOf((p) => (p.content.voicePacks[0].phrases.accept.plain = ['{unit} {bogus}']));
    expectError(errors, 'voicePacks[0].phrases.accept.plain[0]', 'uses unknown placeholder {bogus}');
  });

  it('rejects a bad pack id and a duplicate pack id', () => {
    expectError(errorsOf((p) => (p.content.voicePacks[0].id = 'Night Desk')), 'voicePacks[0].id', 'a pack id');
    expectError(errorsOf((p) => p.content.voicePacks.push({ ...p.content.voicePacks[0] })), 'voicePacks[1].id', 'duplicates "night-desk"');
  });
});

describe('validateModBundle: dispatch scripts', () => {
  it('rejects an invalid script step with the script validator path', () => {
    const errors = errorsOf((p) => (p.content.dispatchScripts[0].steps[2].typeId = 'barFightt'));
    expectError(errors, 'dispatchScripts[0].steps[2].typeId', 'unknown call type "barFightt"');
  });

  it('accepts the mod\'s own call type in its scripts but not in a foreign context', () => {
    // loadingZoneBlocked exists only in this mod: the example validates, the same script alone does not.
    const script = (nightShiftPack() as Json).content.dispatchScripts[0];
    const r = validateModBundle(
      { format: 'patrol-mod', version: 1, id: 'only-script', name: 'x', author: '', description: '', modVersion: '1.0.0', content: { dispatchScripts: [script] } },
      realContext(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expectError(r.errors, 'dispatchScripts[0].steps[0].typeId', 'unknown call type "loadingZoneBlocked"');
  });

  it('rejects duplicate script ids', () => {
    expectError(errorsOf((p) => p.content.dispatchScripts.push({ ...p.content.dispatchScripts[0] })), 'dispatchScripts[1].id', 'duplicates "night-courier-run"');
  });
});

describe('validateModBundle: nothing is partially accepted', () => {
  it('returns errors only and never the bundle', () => {
    const pack = nightShiftPack() as Json;
    pack.content.districts.harbor.crimeFactor = 99;
    const r = validateModBundle(pack, realContext());
    expect(r.ok).toBe(false);
    expect(Object.keys(r)).toEqual(['ok', 'errors']);
  });

  it('never throws on arbitrary junk', () => {
    const junk: unknown[] = [
      { format: 'patrol-mod', version: 1, id: 'junk-mod', name: 'n', author: '', description: '', modVersion: '1.0.0', content: { callTypes: [null, 3, { family: 4, types: 'x' }] } },
      { format: 'patrol-mod', version: 1, id: 'junk-mod', name: 'n', author: '', description: '', modVersion: '1.0.0', content: { statutes: [1], rulesets: ['a'], vehicles: [[]], uniforms: 4, districts: [], voicePacks: [3], dispatchScripts: [null] } },
      { content: { voicePacks: [{ voices: { dispatcher: { pitch: 'x', rate: null, prefer: 4 } }, phrases: { accept: 3 } }] } },
    ];
    for (const j of junk) {
      expect(() => validateModBundle(j, realContext())).not.toThrow();
      expect(validateModBundle(j, realContext()).ok).toBe(false);
    }
  });

  it('formats errors as "<mod>: <path>: <message>"', () => {
    const errors = errorsOf((p) => (p.content.districts.harbor.crimeFactor = 9));
    expect(formatModErrors(errors)).toEqual(['night-shift-pack: districts.harbor.crimeFactor: must be in [0.2, 3], got 9']);
  });
});
