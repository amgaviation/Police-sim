import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { sigmaDeg } from '../../src/force/models';
import { FORCE_CONFIG } from '../../src/force/data';
import { makeActor, Rig } from './helpers';

type Tool = 'firearm' | 'lessLethal' | 'taser';

interface Trial {
  hit: boolean;
  injury: number;
  fatal: boolean;
}

/** One shot of `tool` at an actor `distance` m away, on a fresh rig seeded by `seed`. */
function shot(tool: Tool, distance: number, seed: number, factor: (() => number) | null | undefined): Trial {
  const rig = new Rig(createRng(seed).stream('force'));
  if (factor !== undefined) rig.sys.setAccuracyFactor(factor);
  rig.add(makeActor(1, { x: 0, z: -distance }), 'lethal');
  rig.select(tool);
  rig.applied.length = 0;
  rig.apply(0, -1);
  const e = rig.applied[0];
  return { hit: e?.hit ?? false, injury: e?.injury ?? 0, fatal: e?.fatal ?? false };
}

function hits(tool: Tool, distance: number, factor: (() => number) | null | undefined, trials = 200): number {
  let n = 0;
  for (let i = 0; i < trials; i++) if (shot(tool, distance, 9000 + i, factor).hit) n++;
  return n;
}

describe('accuracy factor', () => {
  it('sigmaDeg multiplies the aim error by aimFactor and ignores its absence', () => {
    const c = { distance: 10, officerMoving: false, officerCrouched: false, targetRunning: false };
    const mods = FORCE_CONFIG.modifiers;
    const plain = sigmaDeg(2, c, mods);
    expect(sigmaDeg(2, { ...c, aimFactor: 1 }, mods)).toBe(plain);
    expect(sigmaDeg(2, { ...c, aimFactor: 3 }, mods)).toBeCloseTo(plain * 3, 12);
  });

  it('factor 1 gives exactly the results of no factor, shot for shot', () => {
    for (const tool of ['firearm', 'lessLethal', 'taser'] as const) {
      for (let i = 0; i < 40; i++) {
        expect(shot(tool, 8, 500 + i, () => 1)).toEqual(shot(tool, 8, 500 + i, undefined));
      }
    }
  });

  it('factor 3 lowers the firearm hit rate at 15 m over 200 seeded trials', () => {
    const plain = hits('firearm', 15, undefined);
    const tired = hits('firearm', 15, () => 3);
    expect(plain).toBeGreaterThan(40);
    expect(tired).toBeLessThan(plain);
    expect(plain - tired).toBeGreaterThan(30);
  });

  it('factor 3 lowers the less-lethal and TASER hit rates too', () => {
    for (const tool of ['lessLethal', 'taser'] as const) {
      const plain = hits(tool, 6, undefined);
      const tired = hits(tool, 6, () => 3);
      expect(tired).toBeLessThan(plain);
    }
  });

  it('is read on every shot and null removes it', () => {
    const rig = new Rig(createRng(77).stream('force'));
    let calls = 0;
    rig.sys.setAccuracyFactor(() => {
      calls++;
      return 1;
    });
    rig.add(makeActor(1, { x: 0, z: -10 }), 'lethal');
    rig.select('firearm');
    rig.apply(0, -1);
    rig.apply(0, -1);
    expect(calls).toBe(2);
    rig.sys.setAccuracyFactor(null);
    rig.apply(0, -1);
    expect(calls).toBe(2);
  });

  it('a factor that is not a positive finite number counts as 1', () => {
    for (const bad of [Number.NaN, 0, -2, Number.POSITIVE_INFINITY]) {
      for (let i = 0; i < 20; i++) expect(shot('firearm', 15, 300 + i, () => bad)).toEqual(shot('firearm', 15, 300 + i, undefined));
    }
  });
});
