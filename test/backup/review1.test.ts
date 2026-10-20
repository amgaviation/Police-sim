import { describe, expect, it } from 'vitest';
import { ACTOR_STATE } from '../../src/npc/types';
import { Rig, SEED, START_FATIGUE, START_STRESS, NO_MISTAKES, findCallsigns } from './helpers';

const CLEAN = findCallsigns(4, SEED, START_STRESS, START_FATIGUE, NO_MISTAKES);

function scene(rig: Rig): void {
  rig.openCall();
  rig.ctx.x = 0;
  rig.ctx.z = 0;
  rig.ctx.yaw = 0;
  rig.ctx.contactPersonId = 101;
  rig.npc.add({ id: 1, personId: 101, role: 'subject', x: 0, z: -3, state: ACTOR_STATE.idle });
}

describe('detain that cuffed nobody', () => {
  it('a give-up radios no custody line, emits no custody event and leaves the subject uncuffed', () => {
    const rig = new Rig();
    scene(rig);
    rig.npc.add({ id: 2, personId: 102, role: 'passenger', x: 5, z: -1, state: ACTOR_STATE.handsUp });
    rig.npc.cuffAfter = 1e9;
    rig.unitOnScene(CLEAN[0] as string, 12, 6, 0);
    rig.unitOnScene(CLEAN[1] as string, 14, 6, 0);
    rig.step(60 * 60);
    const callouts = rig.of<{ kind: string }>('backup:callout').map((c) => c.kind);
    expect(callouts).not.toContain('inCustody');
    expect(rig.of('backup:custody').length).toBe(0);
    expect(rig.npc.actors.get(2)?.cuffed).toBe(false);
  });

  it('after a give-up the officer does not try again at once, and a cuffed subject still counts as custody', () => {
    const rig = new Rig();
    scene(rig);
    const sub = rig.npc.add({ id: 2, personId: 102, role: 'passenger', x: 5, z: -1, state: ACTOR_STATE.handsUp });
    rig.npc.cuffAfter = 1e9;
    rig.unitOnScene(CLEAN[0] as string, 12, 6, 0);
    rig.unitOnScene(CLEAN[1] as string, 14, 6, 0);
    // The first attempt runs out (20 s); the pause (30 s) keeps the officer in its role meanwhile.
    expect(rig.until(() => rig.sys.officers().some((o) => o.state === 'detain'), 40)).toBe(true);
    expect(rig.until(() => !rig.sys.officers().some((o) => o.state === 'detain'), 30)).toBe(true);
    rig.step(60 * 10);
    expect(rig.sys.officers().some((o) => o.state === 'detain')).toBe(false);
    // Somebody else cuffs the subject: that is custody.
    sub.cuffed = true;
    expect(rig.of('backup:custody').length).toBe(0);
  });
});

describe('unit leaving the call', () => {
  it('a release pending sends the officer back to the car before the unit goes', () => {
    const rig = new Rig();
    scene(rig);
    const cs = CLEAN[0] as string;
    rig.unitOnScene(cs, 12, 6, 0);
    expect(rig.until(() => rig.sys.officers()[0]?.state === 'cover', 20)).toBe(true);
    rig.leaving.add(cs);
    rig.step(60);
    expect(rig.sys.officers()[0]?.state).toBe('returning');
    expect(rig.until(() => !rig.sys.onFoot(cs), 30)).toBe(true);
    // Back in the car: it does not get out again while the unit is still on the call.
    rig.step(60 * 5);
    expect(rig.sys.onFoot(cs)).toBe(false);
  });

  it('a car that drives off leaves the officer behind instead of being chased', () => {
    const rig = new Rig();
    scene(rig);
    const cs = CLEAN[0] as string;
    rig.unitOnScene(cs, 12, 6, 0);
    expect(rig.until(() => rig.sys.officers()[0]?.state === 'cover', 20)).toBe(true);
    // The unit is released and the car pulls away at 10 m/s.
    rig.release(cs);
    const car = rig.cars.get(cs)!;
    let gone = false;
    for (let i = 0; i < 60 * 8 && !gone; i++) {
      car.z += 10 / 60;
      rig.step();
      gone = !rig.sys.onFoot(cs);
    }
    expect(gone).toBe(true);
    const o = rig.sys.serialize().officers.find((x) => x.callsign === cs);
    // Not caught up with the car: the officer vanished where the safety net fired, well before the car was reached.
    expect(o === undefined || Math.hypot(o.x - car.x, o.z - car.z) > 4).toBe(true);
  });

  it('a unit that leaves and comes back on the same call puts its officer out again', () => {
    const rig = new Rig();
    scene(rig);
    const cs = CLEAN[0] as string;
    rig.unitOnScene(cs, 12, 6, 0);
    expect(rig.until(() => rig.sys.officers()[0]?.state === 'cover', 20)).toBe(true);
    // The player walks 50 m away; the officer follows, far from its car.
    rig.ctx.x = 50;
    rig.npc.actors.get(1)!.x = 50;
    rig.step(60 * 20);
    // The unit is recalled for a second, the officer starts back to the car and the unit is on scene again before it got there.
    rig.cad.setUnitStatus(cs, 'enRoute', { sim: rig.sim, game: 0 }, 'auto');
    rig.step(60);
    expect(rig.sys.officers()[0]?.state).toBe('returning');
    rig.cad.setUnitStatus(cs, 'onScene', { sim: rig.sim, game: 0 }, 'auto');
    rig.step(60 * 40);
    const o = rig.sys.officers().find((x) => x.callsign === cs);
    expect(o).toBeDefined();
    expect(o?.state).toBe('cover');
  });
});

describe('posts and command staff', () => {
  it('a lieutenant or chief on scene never staffs a post', () => {
    const rig = new Rig();
    scene(rig);
    rig.unitOnScene('LT-1', 12, 6, 0, 'resource');
    rig.unitOnScene('CHIEF-1', 14, 6, 0, 'resource');
    rig.unitOnScene('SGT-1', 16, 6, 0, 'resource');
    rig.step(60 * 8);
    expect(rig.sys.onFoot('LT-1')).toBe(true);
    expect(rig.sys.staffPost({ id: 'tcp1', x: 20, z: 20, yaw: 0, kind: 'tcp' })).toBeNull();
    // A patrol officer standing by takes the post instead.
    const cs = CLEAN[2] as string;
    rig.unitOnScene(CLEAN[0] as string, 18, 6, 0);
    rig.unitOnScene(CLEAN[1] as string, 20, 6, 0);
    rig.unitOnScene(cs, 22, 6, 0);
    rig.step(60 * 8);
    expect(rig.sys.staffPost({ id: 'tcp2', x: 25, z: 20, yaw: 0, kind: 'tcp' })).toBe(cs);
  });
});
