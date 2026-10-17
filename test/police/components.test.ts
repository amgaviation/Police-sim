import { describe, expect, it } from 'vitest';
import { createGameWorld, despawn, spawn } from '../../src/ecs/world';
import { PoliceLights, SIREN_FLAG, attachPoliceLights, hasPoliceLights } from '../../src/police/components';

describe('PoliceLights', () => {
  it('attach adds the component and resets a recycled slot', () => {
    const world = createGameWorld();
    const eid = spawn(world);
    expect(hasPoliceLights(world, eid)).toBe(false);
    attachPoliceLights(world, eid, 0.4);
    expect(hasPoliceLights(world, eid)).toBe(true);
    PoliceLights.pattern[eid] = 3;
    PoliceLights.siren[eid] = 2;
    PoliceLights.sirenFlags[eid] = SIREN_FLAG.horn | SIREN_FLAG.manual;
    PoliceLights.spot[eid] = 1;
    PoliceLights.spotYaw[eid] = 1.5;
    PoliceLights.spotPitch[eid] = -0.2;
    despawn(world, eid);

    const again = spawn(world);
    expect(again).toBe(eid);
    expect(hasPoliceLights(world, again)).toBe(false);
    attachPoliceLights(world, again, 0.25);
    expect([
      PoliceLights.pattern[again],
      PoliceLights.siren[again],
      PoliceLights.sirenFlags[again],
      PoliceLights.spot[again],
      PoliceLights.spotYaw[again],
      PoliceLights.spotPitch[again],
      PoliceLights.phase[again],
    ]).toEqual([0, 0, 0, 0, 0, 0, 0.25]);
  });
});
