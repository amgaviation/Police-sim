import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildOverlay } from '../../src/mods/combine';
import { readModFiles } from '../../src/mods/loader';
import { validateModBundle } from '../../src/mods/schema';
import type { ModBundle, ModOverlay } from '../../src/mods/types';
import { EXAMPLES, folderFiles, nightShiftPack, readJson, realContext } from './helpers';

/** Every table the loaders build, imported from a fresh module graph. */
async function loadAll(overlay: ModOverlay | null): Promise<{
  cad: typeof import('../../src/cad/data');
  catalog: typeof import('../../src/calls/catalog');
  cadRows: typeof import('../../src/calls/cadRows');
  ruleset: typeof import('../../src/legal/ruleset');
  vehicles: typeof import('../../src/vehicles/model');
  uniform: typeof import('../../src/uniform/data');
  dialogue: typeof import('../../src/dialogue/data');
  profile: typeof import('../../src/speech/profile');
  synthesis: typeof import('../../src/speech/synthesis');
  radio: typeof import('../../src/radio/data');
  registry: typeof import('../../src/mods/registry');
}> {
  vi.resetModules();
  const registry = await import('../../src/mods/registry');
  registry.setActiveOverlay(overlay);
  return {
    registry,
    cad: await import('../../src/cad/data'),
    catalog: await import('../../src/calls/catalog'),
    cadRows: await import('../../src/calls/cadRows'),
    ruleset: await import('../../src/legal/ruleset'),
    vehicles: await import('../../src/vehicles/model'),
    uniform: await import('../../src/uniform/data'),
    dialogue: await import('../../src/dialogue/data'),
    profile: await import('../../src/speech/profile'),
    synthesis: await import('../../src/speech/synthesis'),
    radio: await import('../../src/radio/data'),
  };
}

type Loaded = Awaited<ReturnType<typeof loadAll>>;

async function exampleOverlay(): Promise<ModOverlay> {
  const folder = await readModFiles(folderFiles(join(EXAMPLES, 'example-folder')));
  if (!folder.ok) throw new Error(folder.errors.join('; '));
  const a = validateModBundle(nightShiftPack(), realContext());
  const b = validateModBundle(folder.json, realContext());
  if (!a.ok || !b.ok) throw new Error('example mods invalid');
  const active: ModBundle[] = [b.mod, a.mod]; // the night shift pack loads last
  return buildOverlay(active);
}

let base: Loaded;
let modded: Loaded;

beforeAll(async () => {
  base = await loadAll(null);
  modded = await loadAll(await exampleOverlay());
}, 60000);

afterAll(() => {
  vi.resetModules();
});

describe('with an empty overlay every table is unchanged', () => {
  it('statutes, call types and the catalog equal what the plain files give', () => {
    const statutes = readJson('src', 'data', 'cad', 'statutes.json') as { statutes: unknown[] };
    expect(base.cad.STATUTES).toHaveLength(statutes.statutes.length);
    expect(base.cad.findStatute('TR-399')).toBeNull();
    expect(base.cad.findCallType('loadingZoneBlocked')).toBeNull();
    expect(base.catalog.callTypeDef('loadingZoneBlocked')).toBeNull();
    expect(base.cadRows.catalogCadRows()).toHaveLength(base.catalog.CALL_CATALOG.types.length);
  });

  it('vehicles, rulesets, uniforms, trust, phrases and voices equal the plain parse', () => {
    expect(base.vehicles.VEHICLE_MODELS.map((m) => m.index)).toEqual(base.vehicles.VEHICLE_MODELS.map((_, i) => i));
    expect(base.vehicles.VEHICLE_MODELS.some((m) => m.id === 'night_courier')).toBe(false);
    expect([...base.ruleset.RULESETS.keys()]).toEqual(['generic', 'strict']);
    expect(base.uniform.UNIFORM_DATA).toEqual(base.uniform.parseUniformData(readJson('src', 'data', 'uniform', 'uniforms.json'), 'uniforms.json'));
    expect(base.dialogue.TRUST).toEqual(base.dialogue.parseTrust(readJson('src', 'data', 'dialogue', 'trust.json')));
    expect(base.radio.PHRASES).toEqual(base.radio.validatePhrases(readJson('src', 'data', 'radio', 'phrases.json')));
    expect(base.profile.preferredVoices('dispatcher')).toEqual([]);
    expect(base.profile.voiceProfileFor('P-101', 'dispatcher').pitch).toBeGreaterThanOrEqual(0.95);
  });
});

describe('with the example mods active', () => {
  it('VEHICLE_MODELS ends with the mod vehicle and base indices never change', () => {
    const b = base.vehicles.VEHICLE_MODELS;
    const m = modded.vehicles.VEHICLE_MODELS;
    expect(m).toHaveLength(b.length + 1);
    expect(m.slice(0, b.length).map((x) => [x.id, x.index])).toEqual(b.map((x) => [x.id, x.index]));
    const last = m[m.length - 1];
    expect(last?.id).toBe('night_courier');
    expect(last?.index).toBe(b.length);
    expect(modded.vehicles.vehicleModel('night_courier').name).toBe('Night Courier');
    expect(modded.vehicles.TRAFFIC_MODELS.some((x) => x.id === 'night_courier')).toBe(true);
    expect(m.length).toBeLessThanOrEqual(255);
  });

  it('CALL_TYPES and the catalog contain the mod call types', () => {
    expect(modded.cad.findCallType('loadingZoneBlocked')).toMatchObject({ label: 'Loading zone blocked', category: 'traffic', generated: true });
    expect(modded.cad.findCallType('loudGeneratorComplaint')?.category).toBe('disturbance');
    expect(modded.cad.CALL_TYPES).toHaveLength(base.cad.CALL_TYPES.length + 2);
    expect(modded.cad.CALL_TYPES.slice(0, base.cad.CALL_TYPES.length).map((t) => t.id)).toEqual(base.cad.CALL_TYPES.map((t) => t.id));
    expect(modded.catalog.callTypeDef('loadingZoneBlocked')?.family).toBe('parking');
    expect(modded.catalog.familyForType('loudGeneratorComplaint')?.id).toBe('disturbance');
    // the mod row inherits the family defaults (priority 4, road location)
    expect(modded.cad.callType('loadingZoneBlocked').location).toBe('road');
  });

  it('STATUTES contains the mod statute', () => {
    expect(modded.cad.STATUTES).toHaveLength(base.cad.STATUTES.length + 1);
    expect(modded.cad.statute('TR-399')).toMatchObject({ title: 'Blocking a loading zone', fine: 90, citeable: true });
  });

  it('RULESETS contains the mod ruleset', () => {
    expect([...modded.ruleset.RULESETS.keys()]).toEqual(['generic', 'strict', 'example-city']);
    expect(modded.ruleset.getRuleset('example-city').pursuit.maxDurationS).toBe(300);
    expect(modded.ruleset.getRuleset('generic').pursuit.maxDurationS).toBe(base.ruleset.getRuleset('generic').pursuit.maxDurationS);
  });

  it('UNIFORM_DATA is patched', () => {
    const c = modded.uniform.uniformClass('classB');
    expect(c.top).toBe(0x1f3d4d);
    expect(c.label).toBe('Class B (night duty)');
    expect(c.bottom).toBe(base.uniform.uniformClass('classB').bottom);
    expect(modded.uniform.uniformClass('tactical').accent).toBe(0xa3a8ad);
    expect(modded.uniform.UNIFORM_DATA.department.badge.enamel).toBe(0x1b4d2e);
    expect(modded.uniform.UNIFORM_DATA.department.badge.metal).toBe(base.uniform.UNIFORM_DATA.department.badge.metal);
    expect(modded.uniform.UNIFORM_DATA.department.name).toBe('City Police');
  });

  it('TRUST takes the patched baselines', () => {
    expect(modded.dialogue.TRUST.get('harbor')).toBe(0.5);
    expect(modded.dialogue.TRUST.get('suburbs')).toBe(0.7);
    expect(modded.dialogue.TRUST.get('downtown')).toBe(base.dialogue.TRUST.get('downtown'));
    expect(base.dialogue.TRUST.get('harbor')).toBe(0.45);
  });

  it('PHRASES has the replaced lines and nothing else changed', () => {
    expect(modded.radio.PHRASES.kinds.accept.plain).toEqual(['{unit}, copy, taking it, on my way.']);
    expect(modded.radio.PHRASES.kinds.accept.tenCode).toEqual(["{unit}, {code:ack}, I'll take it, {code:enRoute}."]);
    expect(modded.radio.PHRASES.kinds.code4).toEqual(base.radio.PHRASES.kinds.code4);
    expect(modded.radio.PHRASES.timing).toEqual(base.radio.PHRASES.timing);
  });

  it('voiceProfileFor uses the pack ranges and preferredVoices the pack preferences', () => {
    for (let i = 0; i < 40; i++) {
      const d = modded.profile.voiceProfileFor(`D-${i}`, 'dispatcher');
      expect(d.pitch).toBeGreaterThanOrEqual(0.9);
      expect(d.pitch).toBeLessThanOrEqual(1.0);
      expect(d.rate).toBeGreaterThanOrEqual(1.0);
      expect(d.rate).toBeLessThanOrEqual(1.08);
      const o = modded.profile.voiceProfileFor(`U-${i}`, 'officer');
      expect(o.pitch).toBeGreaterThanOrEqual(0.85);
      expect(o.pitch).toBeLessThanOrEqual(1.15);
    }
    // kinds the pack does not mention keep their ranges (and the hash stays the same)
    expect(modded.profile.voiceProfileFor('A-1', 'agency')).toEqual(base.profile.voiceProfileFor('A-1', 'agency'));
    expect(modded.profile.preferredVoices('dispatcher')).toEqual(['en-GB']);
    expect(modded.profile.preferredVoices('officer')).toEqual([]);
    expect(modded.profile.preferredVoices('player')).toEqual([]);
  });

  it('districtLabel reads the overlay', () => {
    expect(modded.registry.districtLabel('harbor')).toBe('Harbor Row');
    expect(modded.registry.districtLabel('downtown')).toBe('Old Town');
    expect(modded.registry.activeModRefs().map((r) => r.id)).toEqual(['example-folder', 'night-shift-pack']);
  });
});

describe('the speech pool follows the voice pack', () => {
  const voices = [
    { name: 'Alpha', lang: 'en-US', localService: true },
    { name: 'Bravo', lang: 'en-GB', localService: true },
    { name: 'Charlie', lang: 'en-AU', localService: false },
  ];
  const fakeSynth = (): import('../../src/speech/synthesis').SpeechSynthesisLike & { spoken: { voice: { name: string } | null }[] } => {
    const spoken: { voice: { name: string } | null }[] = [];
    return {
      spoken,
      speak: (u) => { spoken.push(u); },
      cancel: () => undefined, pause: () => undefined, resume: () => undefined,
      getVoices: () => voices,
    };
  };
  const utterance = (text: string): import('../../src/speech/synthesis').UtteranceLike => ({ text, voice: null, lang: '', pitch: 1, rate: 1, volume: 1, onend: null, onerror: null });

  it('narrowPool matches name or language case-insensitively and falls back to the whole pool', () => {
    const { narrowPool } = base.synthesis;
    expect(narrowPool(voices, []).map((v) => v.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(narrowPool(voices, ['en-gb']).map((v) => v.name)).toEqual(['Bravo']);
    expect(narrowPool(voices, ['CHAR', 'alpha']).map((v) => v.name)).toEqual(['Alpha', 'Charlie']);
    expect(narrowPool(voices, ['xx-yy']).map((v) => v.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('without a pack nothing is narrowed', () => {
    const out = new base.synthesis.SpeechOut({ synth: fakeSynth(), utteranceFactory: utterance });
    expect(out.voicePool()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('with the pack the dispatcher uses en-GB voices and speakers keep the whole pool', () => {
    const synth = fakeSynth();
    const out = new modded.synthesis.SpeechOut({ synth, utteranceFactory: utterance });
    expect(out.voicePool()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    const profile = { pitch: 1, rate: 1, voiceIndex: 2 };
    out.speak('hello', profile, { dispatcher: true });
    out.speak('hello', profile);
    expect(synth.spoken.map((u) => u.voice?.name)).toEqual(['Bravo', 'Charlie']);
  });
});

describe('a clash with the base game throws while loading', () => {
  it('a mod ruleset with an existing id', async () => {
    const o = await exampleOverlay();
    o.rulesets.push({ file: 'generic.json', json: readJson('src', 'data', 'legal', 'rulesets', 'generic.json') });
    await expect(loadAll(o)).rejects.toThrow('duplicates the ruleset "generic"');
  });

  it('a mod vehicle with an existing id', async () => {
    const o = await exampleOverlay();
    o.vehicles.push({ file: 'hatchback.json', json: readJson('src', 'data', 'vehicles', 'hatchback.json') });
    await expect(loadAll(o)).rejects.toThrow('hatchback.json: id duplicates the vehicle model "hatchback"');
  });

  it('a mod call type with an existing id', async () => {
    const o = await exampleOverlay();
    o.callTypes.push({ file: 'mod:clash:0.json', json: { version: 1, family: 'parking', types: [{ id: 'parkingComplaint', label: 'x', category: 'traffic', generated: true, weight: 1, narratives: ['a', 'b'] }] } });
    await expect(loadAll(o)).rejects.toThrow(/parkingComplaint/);
  });

  it('a mod statute with an existing id', async () => {
    const o = await exampleOverlay();
    o.statutes.push({ id: 'TR-301', title: 'Dup', category: 'traffic', class: 'infraction', fine: 1, citeable: true, bookable: false });
    await expect(loadAll(o)).rejects.toThrow('statutes[');
  });

  it('a patched colour that is not a colour', async () => {
    const o = await exampleOverlay();
    o.uniforms.push({ classes: [{ id: 'classA', top: 'blue' }], department: null });
    await expect(loadAll(o)).rejects.toThrow('uniforms.json');
  });
});
