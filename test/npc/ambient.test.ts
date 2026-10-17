import { afterAll, describe, expect, it } from 'vitest';
import { ambientProfile } from '../../src/npc/ambient';
import { findBehavior } from '../../src/npc/data';
import { ACTOR_STATE } from '../../src/npc/types';
import type { NpcIdentity } from '../../src/people/types';
import { makeRig as makePeople } from '../people/helpers';
import { DOWNTOWN, cityOf, info, makeRig, spec, spotIn, type NpcRig } from './helpers';

const people = makePeople().pop;

function find(pred: (i: NpcIdentity) => boolean, from = 0): NpcIdentity {
  for (let id = from; id < 60000; id++) {
    const i = people.identity(id);
    if (pred(i)) return i;
  }
  throw new Error('no matching person');
}

describe('ambientProfile', () => {
  const calm = find((i) => i.temperament === 'calm' && !i.wanted && i.mental === 'none' && !i.dementia && i.risk < 0.3);

  it('leaves an ordinary person and every scenario profile alone', () => {
    for (const base of ['bystander', 'driverCooperative', 'driverNervous', 'passenger']) expect(ambientProfile(calm, 0, base)).toBe(base);
    const volatile = find((i) => i.temperament === 'volatile' && i.mental !== 'none');
    expect(ambientProfile(volatile, 0.2, 'suspectCalm')).toBe('suspectCalm');
    expect(ambientProfile(null, 0.2, 'bystander')).toBe('bystander');
  });

  it('turns drunk, volatile, wanted, confused and timid people into the matching behaviour', () => {
    expect(ambientProfile(calm, 0.1, 'bystander')).toBe('subjectIntoxicated');
    const crisis = find((i) => (i.temperament === 'volatile' || i.temperament === 'irritable') && i.mental !== 'none');
    expect(ambientProfile(crisis, 0, 'driverCooperative')).toBe('subjectCrisis');
    const agitated = find((i) => i.temperament === 'volatile' && i.mental === 'none' && (i.wanted || i.risk >= 0.5));
    expect(ambientProfile(agitated, 0, 'bystander')).toBe('suspectAgitated');
    const wanted = find((i) => i.wanted && i.temperament !== 'volatile' && !(i.temperament === 'irritable' && i.mental !== 'none') && i.mental === 'none');
    expect(ambientProfile(wanted, 0, 'passenger')).toBe('suspectEvasive');
    const timid = find((i) => i.temperament === 'timid' && !i.wanted && i.mental === 'none' && !i.dementia);
    expect(ambientProfile(timid, 0, 'bystander')).toBe('witnessReluctant');
    expect(ambientProfile(timid, 0, 'driverCooperative')).toBe('driverNervous');
    const demented = find((i) => i.dementia && !i.wanted && i.mental === 'none' && i.temperament === 'calm');
    expect(ambientProfile(demented, 0, 'bystander')).toBe('subjectConfused');
  });

  it('only returns profiles that exist', () => {
    for (let id = 0; id < 3000; id++) {
      const p = ambientProfile(people.identity(id), id % 3 === 0 ? 0.1 : 0, ['bystander', 'driverCooperative', 'passenger'][id % 3] as string);
      expect(findBehavior(p), p).toBeDefined();
    }
  });
});

const rigs: NpcRig[] = [];
afterAll(() => {
  for (const r of rigs) r.traffic.physics.dispose();
});
const P = spotIn(cityOf(), DOWNTOWN) ?? { x: 0, z: 0 };

describe('promoted pedestrians and bystander culling', () => {
  it('a loose bystander far from the officer goes away; a cuffed or called one stays', async () => {
    const r = await makeRig({ x: P.x, z: P.z, density: 0 });
    rigs.push(r);
    r.run(1);
    const far = 300;
    const loose = r.npc.spawnActor(spec(4001, P.x + far, P.z, { profile: 'bystander', role: 'bystander', callId: 0 }));
    const called = r.npc.spawnActor(spec(4002, P.x + far, P.z + 5, { profile: 'bystander', role: 'bystander', callId: 7 }));
    const prisoner = r.npc.spawnActor(spec(4003, P.x + far, P.z + 10, { profile: 'suspectCalm', role: 'suspect', callId: 0 }));
    r.npc.forceState(prisoner, 'handsUp');
    expect(r.npc.cuff(prisoner)).toBe('ok');
    r.run(600);
    expect(r.npc.actor(loose, info())).toBeNull();
    expect(r.npc.actor(called, info())).not.toBeNull();
    expect(r.npc.actor(prisoner, info())?.state).toBe(ACTOR_STATE.cuffed);
    expect(r.npc.isActivePerson(4001)).toBe(false);
  });

  it('a pool of promoted bystanders does not fill up forever', async () => {
    const r = await makeRig({ x: P.x, z: P.z, density: 0 });
    rigs.push(r);
    r.run(1);
    for (let i = 0; i < 20; i++) r.npc.spawnActor(spec(5000 + i, P.x + 80 + i, P.z, { profile: 'bystander', role: 'bystander', callId: 0 }));
    r.run(1);
    expect(r.npc.stats.actors).toBe(20);
    r.run(60 * 400);
    expect(r.npc.stats.actors).toBe(0);
  });
});
