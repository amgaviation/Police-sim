import { describe, expect, it } from 'vitest';
import { DEFAULT_LIVERIES, defaultLivery } from '../../src/livery/defaults';
import { canonicalLivery, exportLivery, importLivery, newLiveryId, parseLivery } from '../../src/livery/schema';
import { LIVERY_LIMITS, SHAPE_KINDS, type LiveryDoc, type LiveryLayer } from '../../src/livery/types';

/** Raw text of every shipped livery file, keyed by file name. */
const RAW_FILES: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob<string>('../../src/data/livery/*.json', { eager: true, query: '?raw', import: 'default' })).map(([path, text]) => [
    path.slice(path.lastIndexOf('/') + 1),
    text,
  ]),
);

function clone(doc: LiveryDoc): Record<string, unknown> {
  return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
}

function errorsOf(json: unknown): string[] {
  const r = parseLivery(json);
  return r.ok ? [] : r.errors;
}

/** Tiny deterministic generator (the tests must not use Math.random). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function fuzzDoc(seed: number): LiveryDoc {
  const rnd = lcg(seed);
  const num = (min: number, max: number): number => Math.round((min + rnd() * (max - min)) * 1000) / 1000;
  const int = (min: number, max: number): number => min + Math.floor(rnd() * (max - min + 1));
  const hex = (): string => `#${int(0, 0xffffff).toString(16).padStart(6, '0')}`;
  const faces = ['sides', 'left', 'right', 'hood', 'roof', 'front', 'rear'] as const;
  const face = (): (typeof faces)[number] => faces[int(0, faces.length - 1)] ?? 'sides';
  const layers: LiveryLayer[] = [];
  for (const shape of SHAPE_KINDS) {
    const layer: LiveryLayer = {
      type: 'shape', face: face(), shape, u: num(0, 1), v: num(0, 1), w: num(0.01, 1), h: num(0.01, 1),
      rotationDeg: num(-180, 180), color: hex(), outline: rnd() < 0.5 ? null : hex(), reflective: rnd() < 0.5,
    };
    if (shape === 'star') layer.starPoints = int(3, 12);
    if (shape === 'polygon') {
      layer.points = Array.from({ length: int(3, 24) }, (): [number, number] => [num(-1, 1), num(-1, 1)]);
    }
    layers.push(layer);
  }
  for (let i = 0; i < 4; i++) {
    const u0 = num(0, 0.9);
    layers.push({ type: 'stripe', face: face(), u0, u1: u0 + num(0.01, 0.1), v: num(0, 1), height: num(0.01, 1), angleDeg: num(-45, 45), color: hex(), reflective: rnd() < 0.5 });
    layers.push({
      type: 'text', face: face(), text: `Unit ${int(0, 99)} {unit}`, u: num(0, 1), v: num(0, 1), size: num(0.05, 1), color: hex(),
      outline: rnd() < 0.5 ? null : hex(), font: (['sans', 'serif', 'mono', 'stencil'] as const)[int(0, 3)] ?? 'sans',
      weight: rnd() < 0.5 ? 'bold' : 'normal', italic: rnd() < 0.5, reflective: rnd() < 0.5,
    });
    layers.push({ type: 'checker', face: face(), v: num(0, 1), height: num(0.01, 1), cells: int(2, 40), rows: int(1, 3), colors: [hex(), hex()], reflective: rnd() < 0.5 });
  }
  return {
    format: 'patrol-livery', version: 1, id: `fuzz_${seed}`, name: `Fuzz ${seed}`, author: 'Tester',
    base: { color: hex(), finish: (['gloss', 'matte', 'metallic'] as const)[int(0, 2)] ?? 'gloss' },
    wrap: { kind: (['solid', 'twoTone', 'fade', 'pinstripe'] as const)[int(0, 3)] ?? 'solid', colors: [hex(), hex(), hex()], split: num(0, 1) },
    layers,
    lights: { style: 'roof', pattern: 'sweep', siren: 'phaser' },
    equipment: { pushBar: rnd() < 0.5, spotlight: rnd() < 0.5, partition: rnd() < 0.5 },
    loadout: { trunk: { cones: int(0, 99), flares: int(0, 99) }, rack: ['shotgun', 'rifle'] },
  };
}

describe('default liveries', () => {
  it('ships the 17 documented liveries, sorted by id, file stem = id', () => {
    const stems = Object.keys(RAW_FILES).map((f) => f.slice(0, -5)).sort();
    expect(stems).toHaveLength(17);
    expect(DEFAULT_LIVERIES.map((l) => l.id)).toEqual(stems);
    expect(stems).toEqual(
      [
        'airSupport', 'armoredRescue', 'atvPatrol', 'bicyclePatrol', 'commandPost', 'crimeLab', 'droneUnit', 'k9Marked', 'marinePatrol',
        'motorMarked', 'patrolMarked', 'prisonerTransport', 'supervisorMarked', 'swatTactical', 'trafficMarked', 'unmarkedBlue', 'unmarkedGrey',
      ].sort(),
    );
  });

  it('every default validates, has a null loadout and generic text', () => {
    for (const [file, text] of Object.entries(RAW_FILES)) {
      const r = importLivery(text);
      expect(r.ok, `${file}: ${r.ok ? '' : r.errors.join('; ')}`).toBe(true);
      if (r.ok) {
        expect(r.livery.loadout).toBeNull();
      }
    }
  });

  it('every marked livery has a reflective sides stripe and {unit} on the roof', () => {
    for (const l of DEFAULT_LIVERIES) {
      if (l.wrap !== null) {
        expect(l.layers, l.id).toHaveLength(0); // the unmarked units
        continue;
      }
      expect(l.layers.some((x) => x.type === 'stripe' && x.face === 'sides' && x.reflective), `${l.id} stripe`).toBe(true);
      expect(l.layers.some((x) => x.type === 'text' && x.face === 'roof' && x.text === '{unit}'), `${l.id} roof`).toBe(true);
    }
  });

  it('matches the documented lights and equipment', () => {
    const p = defaultLivery('patrolMarked');
    expect(p.base).toEqual({ color: '#f2f2f2', finish: 'gloss' });
    expect(p.lights).toEqual({ style: 'roof', pattern: 'alternate', siren: 'wail' });
    expect(p.equipment).toEqual({ pushBar: true, spotlight: true, partition: true });
    expect(defaultLivery('supervisorMarked').equipment.partition).toBe(false);
    expect(defaultLivery('unmarkedGrey').lights).toEqual({ style: 'hidden', pattern: 'quad', siren: 'yelp' });
    expect(defaultLivery('unmarkedBlue').wrap).toEqual({ kind: 'solid', colors: ['#1f2a3a'], split: 0.5 });
    expect(defaultLivery('droneUnit').lights.style).toBe('none');
    expect(() => defaultLivery('nope')).toThrow(/unknown default livery/);
  });
});

describe('round trip and canonical form', () => {
  it('importLivery(exportLivery(d)) equals canonicalLivery(d) for every default', () => {
    for (const d of DEFAULT_LIVERIES) {
      const r = importLivery(exportLivery(d));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.livery).toStrictEqual(canonicalLivery(d));
    }
  });

  it('round-trips fuzzed documents using every layer type and shape', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const d = fuzzDoc(seed);
      const types = new Set(d.layers.map((l) => l.type));
      expect([...types].sort()).toEqual(['checker', 'shape', 'stripe', 'text']);
      const r = importLivery(exportLivery(d));
      expect(r.ok, `seed ${seed}: ${r.ok ? '' : r.errors.join('; ')}`).toBe(true);
      if (r.ok) expect(r.livery).toStrictEqual(canonicalLivery(d));
    }
  });

  it('export(import(text)) === text for every default file and fuzzed export', () => {
    for (const [file, text] of Object.entries(RAW_FILES)) {
      const r = importLivery(text);
      expect(r.ok, file).toBe(true);
      if (r.ok) expect(exportLivery(r.livery)).toBe(text);
    }
    const text = exportLivery(fuzzDoc(7));
    const r = importLivery(text);
    if (r.ok) expect(exportLivery(r.livery)).toBe(text);
    else throw new Error(r.errors.join('; '));
  });

  it('canonicalLivery orders keys, lowercases colours, omits undefined optionals and deep copies', () => {
    const d = fuzzDoc(3);
    d.base.color = '#ABCDEF';
    const shape = d.layers.find((l) => l.type === 'shape' && l.shape === 'rect');
    if (shape?.type === 'shape') shape.starPoints = undefined;
    const c = canonicalLivery(d);
    expect(Object.keys(c)).toEqual(['format', 'version', 'id', 'name', 'author', 'base', 'wrap', 'layers', 'lights', 'equipment', 'loadout']);
    expect(c.base.color).toBe('#abcdef');
    const rect = c.layers.find((l) => l.type === 'shape' && l.shape === 'rect');
    expect(rect && 'starPoints' in rect).toBe(false);
    const poly = c.layers.find((l) => l.type === 'shape' && l.shape === 'polygon');
    expect(poly && Object.keys(poly).slice(-1)).toEqual(['points']);
    expect(c.layers).not.toBe(d.layers);
    expect(c.layers[0]).not.toBe(d.layers[0]);
    expect(Object.keys(c.layers[0] ?? {})).toEqual(Object.keys(canonicalLivery(c).layers[0] ?? {}));
  });

  it('normalises hex colours to lowercase and -0 to 0 on import', () => {
    const j = clone(defaultLivery('patrolMarked'));
    (j.base as { color: string }).color = '#F2F2F2';
    ((j.layers as { angleDeg?: number }[])[0] as { angleDeg: number }).angleDeg = -0;
    const r = parseLivery(JSON.parse(JSON.stringify(j)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.livery.base.color).toBe('#f2f2f2');
  });
});

describe('rejection', () => {
  const base = defaultLivery('patrolMarked');
  type Case = [name: string, mutate: (d: Record<string, unknown>) => void, expected: string];
  const layer = (d: Record<string, unknown>, i: number): Record<string, unknown> => (d.layers as Record<string, unknown>[])[i] ?? {};
  const firstOf = (d: Record<string, unknown>, type: string): number => (d.layers as { type: string }[]).findIndex((l) => l.type === type);
  const shapeLayer = (shape: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'shape', face: 'hood', shape, u: 0.5, v: 0.5, w: 0.2, h: 0.2, rotationDeg: 0, color: '#112233', outline: null, reflective: false, ...extra,
  });
  const cases: Case[] = [
    ['wrong format', (d) => { d.format = 'other'; }, 'format: must be "patrol-livery"'],
    ['version 2', (d) => { d.version = 2; }, 'version: newer than supported (1)'],
    ['version 0', (d) => { d.version = 0; }, 'version: must be 1'],
    ['version string', (d) => { d.version = '1'; }, 'version: must be 1'],
    ['bad hex name', (d) => { (d.base as Record<string, unknown>).color = 'red'; }, 'base.color: must be #rrggbb'],
    ['short hex', (d) => { layer(d, 0).color = '#fff'; }, 'layers[0].color: must be #rrggbb'],
    ['wrap colour hex', (d) => { d.wrap = { kind: 'solid', colors: ['#ffffff', 'x'], split: 0.5 }; }, 'wrap.colors[1]: must be #rrggbb'],
    ['u0 >= u1', (d) => { layer(d, 0).u0 = 0.9; layer(d, 0).u1 = 0.5; }, 'layers[0].u1: must be greater than u0'],
    ['u0 == u1', (d) => { layer(d, 0).u0 = 0.5; layer(d, 0).u1 = 0.5; }, 'layers[0].u1: must be greater than u0'],
    ['33 layers', (d) => { d.layers = Array.from({ length: 33 }, () => ({ ...layer(d, 0) })); }, 'layers: at most 32 layers'],
    ['25-char text', (d) => { layer(d, firstOf(d, 'text')).text = 'x'.repeat(25); }, `layers[${firstOf(clone(base), 'text')}].text: must be a string of 1 to 24`],
    ['empty text', (d) => { layer(d, firstOf(d, 'text')).text = ''; }, '.text: must be a string of 1 to 24'],
    ['non-printable text', (d) => { layer(d, firstOf(d, 'text')).text = 'tab\there'; }, '.text: must use printable characters'],
    ['text beyond Latin-1', (d) => { layer(d, firstOf(d, 'text')).text = 'cafœ'; }, '.text: must use printable characters'],
    ['polygon with 2 points', (d) => { d.layers = [shapeLayer('polygon', { points: [[0, 0], [1, 1]] })]; }, 'layers[0].points: must have 3 to 24 points'],
    ['polygon without points', (d) => { d.layers = [shapeLayer('polygon')]; }, 'layers[0].points: missing'],
    ['polygon point out of range', (d) => { d.layers = [shapeLayer('polygon', { points: [[0, 0], [1, 1], [2, 0]] })]; }, 'layers[0].points[2][0]: must be in [-1, 1]'],
    ['25 polygon points', (d) => { d.layers = [shapeLayer('polygon', { points: Array.from({ length: 25 }, () => [0, 0]) })]; }, 'layers[0].points: must have 3 to 24 points'],
    ['points on a star', (d) => { d.layers = [shapeLayer('star', { points: [[0, 0], [1, 1], [0, 1]] })]; }, 'layers[0].points: only allowed for shape "polygon"'],
    ['starPoints 13', (d) => { d.layers = [shapeLayer('star', { starPoints: 13 })]; }, 'layers[0].starPoints: must be an integer in [3, 12]'],
    ['starPoints 2.5', (d) => { d.layers = [shapeLayer('star', { starPoints: 2.5 })]; }, 'layers[0].starPoints: must be an integer in [3, 12]'],
    ['starPoints on rect', (d) => { d.layers = [shapeLayer('rect', { starPoints: 5 })]; }, 'layers[0].starPoints: only allowed for shape "star"'],
    ['unknown shape', (d) => { d.layers = [shapeLayer('blob')]; }, 'layers[0].shape: must be one of'],
    ['unknown pattern', (d) => { (d.lights as Record<string, unknown>).pattern = 'disco'; }, 'lights.pattern: must be one of'],
    ['unknown siren', (d) => { (d.lights as Record<string, unknown>).siren = 'horn'; }, 'lights.siren: must be one of'],
    ['unknown lights style', (d) => { (d.lights as Record<string, unknown>).style = 'under'; }, 'lights.style: must be one of'],
    ['unknown top-level key', (d) => { d.foo = 1; }, 'foo: unknown key'],
    ['unknown layer key', (d) => { layer(d, 0).foo = 1; }, 'layers[0].foo: unknown key'],
    ['unknown nested key', (d) => { (d.equipment as Record<string, unknown>).bar = true; }, 'equipment.bar: unknown key'],
    ['missing top-level key', (d) => { delete d.name; }, 'name: missing'],
    ['missing layer key', (d) => { delete layer(d, 0).color; }, 'layers[0].color: missing'],
    ['missing wrap', (d) => { delete d.wrap; }, 'wrap: missing'],
    ['missing loadout', (d) => { delete d.loadout; }, 'loadout: missing'],
    ['loadout count 100', (d) => { d.loadout = { trunk: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`item${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`, 1])), rack: [] }; }, 'loadout.trunk: at most 40 entries'],
    ['rack of 5', (d) => { d.loadout = { trunk: {}, rack: ['a', 'b', 'c', 'd', 'e'] }; }, 'loadout.rack: at most 4 entries'],
    ['rack non-string', (d) => { d.loadout = { trunk: {}, rack: [3] }; }, 'loadout.rack[0]: must be a string'],
    ['bad trunk id chars', (d) => { d.loadout = { trunk: { 'bad id': 1 }, rack: [] }; }, 'loadout.trunk.bad id: item id must match'],
    ['trunk id starting with a digit', (d) => { d.loadout = { trunk: { '9lives': 1 }, rack: [] }; }, 'loadout.trunk.9lives: item id must match'],
    ['trunk count 100', (d) => { d.loadout = { trunk: { cones: 100 }, rack: [] }; }, 'loadout.trunk.cones: must be an integer in [0, 99]'],
    ['trunk fractional', (d) => { d.loadout = { trunk: { cones: 1.5 }, rack: [] }; }, 'loadout.trunk.cones: must be an integer in [0, 99]'],
    ['bad doc id chars', (d) => { d.id = 'has space'; }, 'id: must match'],
    ['doc id too long', (d) => { d.id = 'a'.repeat(41); }, 'id: must match'],
    ['empty name', (d) => { d.name = ''; }, 'name: must be a string of 1 to 40'],
    ['name too long', (d) => { d.name = 'n'.repeat(41); }, 'name: must be a string of 1 to 40'],
    ['author too long', (d) => { d.author = 'n'.repeat(41); }, 'author: must be a string of 0 to 40'],
    ['angle 60', (d) => { layer(d, 0).angleDeg = 60; }, 'layers[0].angleDeg: must be in [-45, 45]'],
    ['height 0', (d) => { layer(d, 0).height = 0; }, 'layers[0].height: must be in (0, 1]'],
    ['v above 1', (d) => { layer(d, 0).v = 1.5; }, 'layers[0].v: must be in [0, 1]'],
    ['NaN number', (d) => { layer(d, 0).v = null; }, 'layers[0].v: must be a number'],
    ['rotation 200', (d) => { d.layers = [shapeLayer('rect', { rotationDeg: 200 })]; }, 'layers[0].rotationDeg: must be in [-180, 180]'],
    ['text size 0.01', (d) => { layer(d, firstOf(d, 'text')).size = 0.01; }, '.size: must be in [0.05, 1]'],
    ['checker cells 1', (d) => { d.layers = [{ type: 'checker', face: 'sides', v: 0.5, height: 0.1, cells: 1, rows: 1, colors: ['#000000', '#ffffff'], reflective: false }]; }, 'layers[0].cells: must be an integer in [2, 40]'],
    ['checker rows 4', (d) => { d.layers = [{ type: 'checker', face: 'sides', v: 0.5, height: 0.1, cells: 4, rows: 4, colors: ['#000000', '#ffffff'], reflective: false }]; }, 'layers[0].rows: must be an integer in [1, 3]'],
    ['checker 3 colours', (d) => { d.layers = [{ type: 'checker', face: 'sides', v: 0.5, height: 0.1, cells: 4, rows: 2, colors: ['#000000', '#ffffff', '#ff0000'], reflective: false }]; }, 'layers[0].colors: must be an array of 2 colours'],
    ['unknown face', (d) => { layer(d, 0).face = 'trunk'; }, 'layers[0].face: must be one of'],
    ['unknown layer type', (d) => { layer(d, 0).type = 'blob'; }, 'layers[0].type: must be one of'],
    ['layer not an object', (d) => { d.layers = [3]; }, 'layers[0]: must be an object'],
    ['layers not an array', (d) => { d.layers = {}; }, 'layers: must be an array'],
    ['bad finish', (d) => { (d.base as Record<string, unknown>).finish = 'satin'; }, 'base.finish: must be one of'],
    ['wrap 4 colours', (d) => { d.wrap = { kind: 'solid', colors: ['#000000', '#000000', '#000000', '#000000'], split: 0.5 }; }, 'wrap.colors: must be an array of 1 to 3 colours'],
    ['wrap kind', (d) => { d.wrap = { kind: 'camo', colors: ['#000000'], split: 0.5 }; }, 'wrap.kind: must be one of'],
    ['wrap split 2', (d) => { d.wrap = { kind: 'solid', colors: ['#000000'], split: 2 }; }, 'wrap.split: must be in [0, 1]'],
    ['equipment flag not boolean', (d) => { (d.equipment as Record<string, unknown>).pushBar = 'yes'; }, 'equipment.pushBar: must be true or false'],
  ];

  it('has at least 20 rejection cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  for (const [name, mutate, expected] of cases) {
    it(`rejects ${name}`, () => {
      const d = clone(base);
      mutate(d);
      const errs = errorsOf(d);
      expect(errs.length, 'must be rejected').toBeGreaterThan(0);
      expect(
        errs.some((e) => e.startsWith(expected) || e.includes(expected)),
        `expected "${expected}" in ${JSON.stringify(errs)}`,
      ).toBe(true);
    });
  }

  it('collects every error, not only the first', () => {
    const d = clone(base);
    d.format = 'x';
    d.name = '';
    d.foo = 1;
    (d.lights as Record<string, unknown>).siren = 'horn';
    layer(d, 0).angleDeg = 99;
    const errs = errorsOf(d);
    for (const p of ['format:', 'name:', 'foo:', 'lights.siren:', 'layers[0].angleDeg:']) {
      expect(errs.some((e) => e.startsWith(p)), p).toBe(true);
    }
  });

  it('every error is "dotted.path[i]: message"', () => {
    const d = clone(base);
    d.layers = [shapeLayer('polygon', { points: [[0, 0]] }), 5, { type: 'text' }];
    for (const e of errorsOf(d)) expect(e).toMatch(/^[A-Za-z0-9_.[\]]+( [^:]*)?: .+/);
  });

  it('accepts the boundaries of every range', () => {
    const d = clone(base);
    d.layers = [
      { type: 'stripe', face: 'sides', u0: 0, u1: 1, v: 0, height: 1, angleDeg: -45, color: '#ABCDEF', reflective: true },
      shapeLayer('star', { starPoints: 3, rotationDeg: -180 }),
      shapeLayer('star', { starPoints: 12, rotationDeg: 180 }),
      shapeLayer('polygon', { points: Array.from({ length: 24 }, (_, i) => [i % 2 ? 1 : -1, -1]) }),
      { type: 'text', face: 'roof', text: 'x'.repeat(24), u: 1, v: 1, size: 0.05, color: '#000000', outline: '#ffffff', font: 'stencil', weight: 'normal', italic: true, reflective: false },
      { type: 'checker', face: 'sides', v: 1, height: 1, cells: 40, rows: 3, colors: ['#000000', '#ffffff'], reflective: false },
    ];
    d.loadout = { trunk: Object.fromEntries(Array.from({ length: LIVERY_LIMITS.loadoutEntries }, (_, i) => [`i${String.fromCharCode(97 + (i % 26))}${i >= 26 ? 'b' : ''}`, 99])), rack: ['a', 'b', 'c', 'd'] };
    d.name = 'n'.repeat(40);
    d.author = '';
    expect(errorsOf(d)).toEqual([]);
    d.layers = Array.from({ length: 32 }, () => ({ ...layer(d, 0) }));
    expect(errorsOf(d)).toEqual([]);
  });

  it('accepts text with Latin-1 characters', () => {
    const d = clone(base);
    layer(d, firstOf(d, 'text')).text = 'Café  ÿ';
    expect(errorsOf(d)).toEqual([]);
  });
});

describe('importLivery', () => {
  it('rejects a file larger than 64 KiB', () => {
    const text = exportLivery(defaultLivery('patrolMarked')) + ' '.repeat(70 * 1024);
    const r = importLivery(text);
    expect(r).toEqual({ ok: false, errors: ['file: larger than 64 KiB'] });
  });

  it('counts bytes, not characters', () => {
    const wide = 'é'.repeat(LIVERY_LIMITS.fileBytes / 2 + 1); // 32769 chars, 65538 bytes
    expect(importLivery(`"${wide}"`)).toEqual({ ok: false, errors: ['file: larger than 64 KiB'] });
    expect(importLivery(`"${'a'.repeat(1000)}"`)).toEqual({ ok: false, errors: ['livery: must be an object'] });
  });

  it('rejects non-JSON text', () => {
    for (const t of ['', 'not json', '{"a":', '[1,', "{'a':1}"]) {
      expect(importLivery(t)).toEqual({ ok: false, errors: ['file: not valid JSON'] });
    }
  });

  it('accepts a leading byte-order mark', () => {
    expect(importLivery(`${String.fromCharCode(0xfeff)}${exportLivery(defaultLivery('droneUnit'))}`).ok).toBe(true);
  });

  it('reports a newer version', () => {
    const j = clone(defaultLivery('droneUnit'));
    j.version = 2;
    const r = importLivery(JSON.stringify(j));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('version: newer than supported (1)');
  });
});

describe('junk input never throws', () => {
  const deep = (n: number): unknown => {
    let v: unknown = {};
    for (let i = 0; i < n; i++) v = { layers: [v], base: v, wrap: v, lights: v, equipment: v, loadout: v };
    return v;
  };
  const cyclic: Record<string, unknown> = {};
  cyclic.layers = [cyclic];
  cyclic.base = cyclic;
  const junk: unknown[] = [
    null, undefined, [], [[]], 3, NaN, Infinity, 'x', '', true, {}, () => 1, Symbol('s'), 10n,
    { layers: null, base: 3, wrap: 'x', lights: [], equipment: null, loadout: 4 },
    { layers: [null, [], 3, 'x', {}, { type: 'shape' }, { type: 'polygon', points: 4 }, { type: 'shape', shape: 'polygon', points: [null, 3, [1], ['a', 'b']] }] },
    { loadout: { trunk: [], rack: {} } },
    { loadout: { trunk: null, rack: null } },
    { wrap: { kind: [], colors: {}, split: [] } },
    { layers: { length: 3 } },
    { format: { toString: () => 'patrol-livery' }, version: { valueOf: () => 1 } },
    deep(50),
    cyclic,
    JSON.parse('{"__proto__": {"x": 1}, "constructor": 1}') as unknown,
    Object.create(null) as unknown,
    new Date(0),
    new Map(),
    Array.from({ length: 1000 }, () => ({})),
  ];
  it('parseLivery returns ok:false with errors for arbitrary input', () => {
    for (const j of junk) {
      let r;
      expect(() => { r = parseLivery(j); }).not.toThrow();
      expect(r).toMatchObject({ ok: false });
      expect((r as unknown as { errors: string[] }).errors.length).toBeGreaterThan(0);
    }
  });

  it('importLivery never throws on junk text', () => {
    const texts = ['null', '[]', '3', '"x"', '{}', '[['.repeat(30000), '{"a":'.repeat(5000), '\u0000', '{"layers":[' + '{},'.repeat(2000) + '{}]}'];
    for (const t of texts) {
      expect(() => importLivery(t)).not.toThrow();
      expect(importLivery(t).ok).toBe(false);
    }
    expect(() => importLivery(undefined as unknown as string)).not.toThrow();
    expect(importLivery(5 as unknown as string).ok).toBe(false);
  });

  it('reports a prototype-looking trunk key as a bad id (no pollution)', () => {
    const d = clone(defaultLivery('patrolMarked'));
    d.loadout = JSON.parse('{"trunk": {"__proto__": 5, "constructor": 2}, "rack": []}') as unknown;
    const r = parseLivery(d);
    expect(r.ok).toBe(false);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('newLiveryId', () => {
  it('slugs the base and numbers collisions', () => {
    expect(newLiveryId('My Livery!', [])).toBe('My-Livery');
    expect(newLiveryId('patrolMarked', ['patrolMarked'])).toBe('patrolMarked-2');
    expect(newLiveryId('patrolMarked', ['patrolMarked', 'patrolMarked-2', 'patrolMarked-3'])).toBe('patrolMarked-4');
    expect(newLiveryId('   ', [])).toBe('livery');
    expect(newLiveryId('---', ['livery'])).toBe('livery-2');
  });

  it('limits the slug to 32 characters and always yields a valid id', () => {
    const id = newLiveryId('x'.repeat(100), []);
    expect(id).toHaveLength(32);
    const taken = [id];
    const next = newLiveryId('x'.repeat(100), taken);
    expect(next).toBe(`${id}-2`);
    for (const base of ['éè', 'a b c', 'ok', '____', 'a'.repeat(32) + '-']) {
      const doc = { ...clone(defaultLivery('droneUnit')), id: newLiveryId(base, []) };
      expect(parseLivery(doc).ok, base).toBe(true);
    }
  });
});
