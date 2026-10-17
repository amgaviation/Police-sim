import { describe, expect, it } from 'vitest';
import { at, makeRig } from './helpers';

describe('RadioSystem step cost', () => {
  it('idle steps stay under 0.02 ms', () => {
    const rig = makeRig();
    const player = { x: 0, z: -30 };
    for (let i = 0; i < 600; i++) rig.radio.step(1 / 60, at(i / 60), player);
    const n = 20000;
    const t0 = performance.now();
    for (let i = 600; i < 600 + n; i++) rig.radio.step(1 / 60, at(i / 60), player);
    expect((performance.now() - t0) / n).toBeLessThan(0.02);
  });

  it('with ambient chatter the average step stays under 0.02 ms', () => {
    const rig = makeRig({ quiet: false });
    const player = { x: 0, z: -30 };
    const n = 36000; // 10 sim minutes
    const t0 = performance.now();
    for (let i = 1; i <= n; i++) rig.radio.step(1 / 60, at(i / 60), player);
    expect((performance.now() - t0) / n).toBeLessThan(0.02);
    expect(rig.radio.log.length).toBeGreaterThan(10);
  });
});
