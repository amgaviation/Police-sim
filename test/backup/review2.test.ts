import { describe, expect, it } from 'vitest';
import { ACTOR_STATE } from '../../src/npc/types';
import { DT, Rig, START_FATIGUE, START_STRESS, NO_MISTAKES, SEED, findCallsigns } from './helpers';

const CLEAN = findCallsigns(4, SEED, START_STRESS, START_FATIGUE, NO_MISTAKES);

describe('the player drives off', () => {
  it('officers walk back to their own cars instead of sprinting after the moving patrol car', () => {
    const rig = new Rig();
    rig.openCall();
    rig.ctx.contactPersonId = 101;
    rig.npc.add({ id: 1, personId: 101, role: 'subject', x: 0, z: -3, state: ACTOR_STATE.idle });
    const a = CLEAN[0] as string;
    const b = CLEAN[1] as string;
    rig.unitOnScene(a, 12, 6, 0);
    rig.unitOnScene(b, 14, 6, 0);
    rig.step(60 * 10);
    expect(rig.sys.officers().length).toBe(2);
    rig.ctx.onFoot = false;
    for (let i = 0; i < 60 * 60; i++) {
      rig.ctx.z -= 20 * DT;
      rig.step();
    }
    // Back at their cars (gone from the view), not chasing a car 1 km away.
    expect(rig.sys.officers().every((o) => o.state === 'gone' || o.state === 'returning')).toBe(true);
    expect(rig.sys.onFoot(a)).toBe(false);
    expect(rig.sys.onFoot(b)).toBe(false);
    // No new officers for units whose car is far behind a driving player.
    rig.step(60 * 5);
    expect(rig.sys.officers().filter((o) => o.state !== 'gone' && o.state !== 'returning')).toHaveLength(0);
  });
});
