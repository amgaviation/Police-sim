/* eslint-disable @typescript-eslint/no-unsafe-member-access -- tests patch loosely typed raw JSON */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateModBundle } from '../../src/mods/schema';
import { parseModVehicle } from '../../src/vehicles/model';
import { ROOT, nightShiftPack, realContext } from './helpers';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The example pack with `mutate` applied to its first vehicle. */
function withVehicle(mutate: (v: Json) => void): ReturnType<typeof validateModBundle> {
  const pack = nightShiftPack() as Json;
  mutate((pack['content'] as Json)['vehicles'][0] as Json);
  return validateModBundle(pack, realContext());
}

describe('mod vehicle limits', () => {
  it('accepts the example mod unchanged', () => {
    expect(withVehicle(() => undefined).ok).toBe(true);
  });

  const cases: [string, (v: Json) => void][] = [
    ['mass', (v) => { v['mass'] = 1e300; }],
    ['trafficWeight', (v) => { v['trafficWeight'] = 1e308; }],
    ['tires.radius', (v) => { v['tires'].radius = 1e6; }],
    ['engine.maxSpeedKmh', (v) => { v['engine'].maxSpeedKmh = 1e9; }],
    ['suspension.stiffness', (v) => { v['suspension'].stiffness = 1e12; }],
    ['body.length', (v) => { v['body'].length = 1e9; v['body'].wheelbase = 2.5; }],
    ['engine.maxForce', (v) => { v['engine'].maxForce = 1e12; }],
    ['fuel.capacityL', (v) => { v['fuel'].capacityL = 1e12; }],
    ['brakes.maxForce', (v) => { v['brakes'].maxForce = 1e12; }],
    ['engine.gearRatios[0]', (v) => { v['engine'].gearRatios[0] = 1e6; }],
  ];

  for (const [path, mutate] of cases) {
    it(`rejects an absurd ${path} with a clear error`, () => {
      const r = withVehicle(mutate);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.map((e) => e.path).join(' ')).toContain(path);
    });
  }

  it('every shipped model file is within the limits', () => {
    const dir = join(ROOT, 'src', 'data', 'vehicles');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const json = JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown;
      expect(() => parseModVehicle(json, f), f).not.toThrow();
    }
  });
});

describe('mod call-type weight limits', () => {
  it('rejects a call type with an absurd weight', () => {
    const pack = nightShiftPack() as Json;
    pack['content'].callTypes[0].types[0].weight = 1e308;
    const r = validateModBundle(pack, realContext());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.path).join(' ')).toContain('weight');
  });
});
