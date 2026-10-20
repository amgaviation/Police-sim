import { afterAll, describe, expect, it } from 'vitest';
import { isNpcSave } from '../../src/npc/save';
import { ACTOR_STATE, LETHAL_WEAPONS, type ActorSave, type NpcSave } from '../../src/npc/types';
import { DOWNTOWN, DT, cityOf, info, makeRig, spec, spotIn, stateOf, type NpcRig } from './helpers';

const rigs: NpcRig[] = [];
const P = (() => {
  const p = spotIn(cityOf(), DOWNTOWN);
  if (!p) throw new Error('no downtown edge');
  return p;
})();

async function rig(): Promise<NpcRig> {
  const r = await makeRig({ x: P.x, z: P.z, density: 0 });
  rigs.push(r);
  r.run(1);
  return r;
}
afterAll(() => {
  for (const r of rigs) r.traffic.physics.dispose();
});

let nextPerson = 4000;
function add(r: NpcRig, over: Partial<Parameters<typeof spec>[3]> = {}, dx = 8): number {
  nextPerson += 31;
  return r.npc.spawnActor(spec(nextPerson, P.x + dx, P.z, over));
}

/** Seconds of sim time, in steps. */
function seconds(r: NpcRig, s: number): void {
  r.run(Math.round(s / DT));
}

describe('resistance table (design 4.2)', () => {
  it('exports the lethal weapon list', () => {
    expect([...LETHAL_WEAPONS]).toEqual(['handgun', 'rifle', 'shotgun', 'knife']);
  });

  it('is compliant for unknown ids and calm actors', async () => {
    const r = await rig();
    expect(r.npc.resistance(99999)).toBe('compliant');
    const id = add(r);
    expect(r.npc.resistance(id)).toBe('compliant');
    expect(r.npc.actor(id, info())?.resistance).toBe('compliant');
  });

  it.each([...LETHAL_WEAPONS])('lethal: armed with a drawn %s', async (weapon) => {
    const r = await rig();
    const id = add(r, { weapon });
    r.npc.forceState(id, 'armed');
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.armed);
    expect(r.npc.resistance(id)).toBe('lethal');
    expect(r.npc.actor(id, info())?.resistance).toBe('lethal');
  });

  it('assaultive: armed with a non-lethal weapon drawn', async () => {
    const r = await rig();
    const id = add(r, { weapon: 'baton' });
    r.npc.forceState(id, 'armed');
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.armed);
    expect(r.npc.resistance(id)).toBe('assaultive');
  });

  it('assaultive: state fight; active again once the struggle is over', async () => {
    const r = await rig();
    const id = add(r);
    r.npc.forceState(id, 'fight');
    expect(r.npc.resistance(id)).toBe('assaultive');
    // A fight starts a 5 s window: take the actor down and wait it out.
    r.npc.incapacitate(id, 60, 'strike');
    expect(r.npc.resistance(id)).toBe('assaultive');
    seconds(r, 4);
    expect(r.npc.resistance(id)).toBe('assaultive');
    seconds(r, 1.5);
    expect(r.npc.resistance(id)).toBe('compliant');
  });

  it('lethal: a fire attack within the last 5 s, even after the weapon is dropped', async () => {
    const r = await rig();
    for (let i = 0; i < 10; i++) {
      const id = add(r, { weapon: 'handgun', profile: 'suspectArmedHostile' }, 6 + i * 0.5);
      r.npc.forceState(id, 'armed');
    }
    let shooter = 0;
    for (let i = 0; i < 1200 && shooter === 0; i++) {
      r.run(1, 0.1);
      const e = (r.events['npc:attack'] ?? []).find((x) => x.kind === 'fire');
      if (e) shooter = e.actorId as number;
    }
    expect(shooter).toBeGreaterThan(0);
    expect(r.npc.resistance(shooter)).toBe('lethal');
    r.npc.dropWeapon(shooter);
    r.npc.forceState(shooter, 'handsUp');
    expect(r.npc.resistance(shooter)).toBe('lethal');
    r.run(60, 0.1);
    expect(r.npc.resistance(shooter)).toBe('compliant');
  });

  it('lethal via a saved fire attack within 5 s even when the actor is no longer armed', async () => {
    const r = await rig();
    const id = add(r);
    const save = JSON.parse(JSON.stringify(r.npc.serialize())) as NpcSave;
    const s = save.actors.find((a) => a.id === id) as ActorSave;
    s.at = 1;
    s.ak = 1;
    r.npc.restore(save);
    expect(r.npc.resistance(id)).toBe('lethal');
    seconds(r, 4.5);
    expect(r.npc.resistance(id)).toBe('compliant');
  });

  it('active: fleeing', async () => {
    const r = await rig();
    const id = add(r);
    r.npc.forceState(id, 'flee');
    expect(r.npc.resistance(id)).toBe('active');
  });

  it('active: a cuffing struggle within 10 s, then compliant', async () => {
    const r = await rig();
    // Roll until a hostile actor resists the cuffs (a random roll per attempt).
    let id = 0;
    for (let i = 0; i < 200 && id === 0; i++) {
      const cand = add(r, { profile: 'suspectHostile' });
      if (r.npc.cuff(cand) === 'resist') id = cand;
      else r.npc.removeActor(cand);
    }
    expect(id).toBeGreaterThan(0);
    // The struggle is a fight now; take the actor down and let the fight window (5 s) pass: still within 10 s.
    r.npc.incapacitate(id, 60, 'strike');
    seconds(r, 6);
    expect(r.npc.resistance(id)).toBe('active');
    seconds(r, 4.5);
    expect(r.npc.resistance(id)).toBe('compliant');
  });

  it('passive: refused or confused a command within 15 s, then compliant', async () => {
    const r = await rig();
    const a = add(r);
    const b = add(r, {}, 10);
    const c = add(r, {}, 12);
    r.npc.applyCommand(a, 'stop', 'refuse');
    r.npc.applyCommand(b, 'stop', 'confused');
    r.npc.applyCommand(c, 'stop', 'comply');
    expect(r.npc.resistance(a)).toBe('passive');
    expect(r.npc.resistance(b)).toBe('passive');
    expect(r.npc.resistance(c)).toBe('compliant');
    seconds(r, 14);
    expect(r.npc.resistance(a)).toBe('passive');
    seconds(r, 1.5);
    expect(r.npc.resistance(a)).toBe('compliant');
    expect(r.npc.resistance(b)).toBe('compliant');
  });

  it('compliant: cuffed, handsUp, kneel, prone, lying, and a refusal by an unconscious person', async () => {
    const r = await rig();
    for (const st of ['handsUp', 'kneel', 'prone', 'lying'] as const) {
      const id = add(r);
      r.npc.forceState(id, st);
      expect(r.npc.resistance(id)).toBe('compliant');
    }
    const cuffed = add(r);
    r.npc.forceState(cuffed, 'handsUp');
    r.npc.applyCommand(cuffed, 'stop', 'refuse');
    expect(r.npc.resistance(cuffed)).toBe('passive');
    seconds(r, 16);
    expect(r.npc.cuff(cuffed)).toBe('ok');
    expect(r.npc.resistance(cuffed)).toBe('compliant');
    const out = add(r, { profile: 'subjectUnconscious' });
    r.npc.applyCommand(out, 'stop', 'refuse');
    expect(r.npc.resistance(out)).toBe('compliant');
  });

  it('first match wins: a fighting runner is assaultive, a refusing runner is active', async () => {
    const r = await rig();
    const id = add(r);
    r.npc.applyCommand(id, 'stop', 'refuse');
    expect(r.npc.resistance(id)).toBe('passive');
    r.npc.forceState(id, 'flee');
    expect(r.npc.resistance(id)).toBe('active');
    r.npc.applyCommand(id, 'stop', 'fight');
    expect(r.npc.resistance(id)).toBe('assaultive');
  });
});

describe('incapacitate, wound, taserCycle', () => {
  it('incapacitate puts a standing or running actor down with npc:caught by force, then prone', async () => {
    const r = await rig();
    const id = add(r);
    expect(r.npc.incapacitate(id, 2, 'oc')).toBe(true);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.down);
    expect(r.events['npc:caught']?.[0]).toMatchObject({ actorId: id, by: 'force' });
    seconds(r, 3);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.prone);
    const runner = add(r, {}, 12);
    r.npc.forceState(runner, 'flee');
    expect(r.npc.incapacitate(runner, 2, 'baton')).toBe(true);
  });

  it('incapacitate drops a drawn weapon and works on armed actors for oc, taser and shot', async () => {
    const r = await rig();
    for (const by of ['oc', 'taser', 'shot'] as const) {
      const id = add(r, { weapon: 'knife' });
      r.npc.forceState(id, 'armed');
      expect(r.npc.incapacitate(id, 3, by)).toBe(true);
      expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.down);
      expect(r.npc.actor(id, info())?.weaponDrawn).toBe(false);
    }
    expect(r.events['npc:weaponDropped']?.length).toBe(3);
  });

  it('incapacitate is false for unknown, hidden, dog and restrained actors', async () => {
    const r = await rig();
    expect(r.npc.incapacitate(99999, 3, 'oc')).toBe(false);
    const hidden = add(r, { hidden: true });
    expect(r.npc.incapacitate(hidden, 3, 'oc')).toBe(false);
    const dog = add(r, { body: 'dog', personId: -1, profile: 'bystander' });
    expect(r.npc.incapacitate(dog, 3, 'k9')).toBe(false);
    const cuffed = add(r);
    r.npc.forceState(cuffed, 'kneel');
    r.npc.cuff(cuffed);
    expect(r.npc.incapacitate(cuffed, 3, 'strike')).toBe(false);
    const lying = add(r, { profile: 'subjectUnconscious' });
    expect(r.npc.incapacitate(lying, 3, 'strike')).toBe(false);
    expect(r.events['npc:caught']?.length ?? 0).toBe(0);
  });

  it('fatal wound: a body that stays lying, drops its weapon and never wakes or runs', async () => {
    const r = await rig();
    const id = add(r, { weapon: 'handgun' });
    r.npc.forceState(id, 'armed');
    r.npc.wound(id, 1, true);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.lying);
    expect(r.npc.resistance(id)).toBe('compliant');
    expect(r.npc.actor(id, info())?.armed).toBe(false);
    expect(r.events['npc:weaponDropped']?.length).toBe(1);
    // Commands and forced states do not wake it; it cannot be tackled, tased or incapacitated.
    r.npc.applyCommand(id, 'stop', 'flee');
    r.npc.forceState(id, 'flee');
    r.npc.forceState(id, 'fight');
    expect(r.npc.incapacitate(id, 3, 'taser')).toBe(false);
    expect(r.npc.taser(id, 5)).toBe(false);
    seconds(r, 90);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.lying);
    expect(r.npc.resistance(id)).toBe('compliant');
    // Wounding again changes nothing.
    r.npc.wound(id, 0.9, false);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.lying);
  });

  it('fatal wound clears cuffs and a hiding spot', async () => {
    const r = await rig();
    const id = add(r);
    r.npc.forceState(id, 'kneel');
    r.npc.cuff(id);
    r.npc.wound(id, 1, true);
    const a = r.npc.actor(id, info());
    expect(a?.cuffed).toBe(false);
    expect(a?.state).toBe(ACTOR_STATE.lying);
    const hid = add(r, { hidden: true }, 12);
    r.npc.wound(hid, 1, true);
    expect(r.npc.actor(hid, info())?.hidden).toBe(false);
  });

  it('severe wound: down for 60 s, then kneeling; light wound: 3 s shot incapacitation, then prone', async () => {
    const r = await rig();
    const bad = add(r);
    const light = add(r, {}, 12);
    r.npc.wound(bad, 0.5, false);
    r.npc.wound(light, 0.49, false);
    expect(stateOf(r.npc, bad)).toBe(ACTOR_STATE.down);
    expect(stateOf(r.npc, light)).toBe(ACTOR_STATE.down);
    expect(r.events['npc:caught']?.map((e) => e.by)).toEqual(['force', 'force']);
    seconds(r, 3.5);
    expect(stateOf(r.npc, light)).toBe(ACTOR_STATE.prone);
    expect(stateOf(r.npc, bad)).toBe(ACTOR_STATE.down);
    seconds(r, 55);
    expect(stateOf(r.npc, bad)).toBe(ACTOR_STATE.down);
    seconds(r, 3);
    expect(stateOf(r.npc, bad)).toBe(ACTOR_STATE.kneel);
    expect(r.npc.resistance(bad)).toBe('compliant');
  });

  it('wounded flag survives a save and the actor kneels after restore', async () => {
    const r = await rig();
    const id = add(r);
    r.npc.wound(id, 0.8, false);
    seconds(r, 10);
    const save = JSON.parse(JSON.stringify(r.npc.serialize())) as NpcSave;
    r.npc.restore(save);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.down);
    seconds(r, 52);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.kneel);
  });

  it('taserCycle extends a downed actor, incapacitates a standing one, ignores restrained ones', async () => {
    const r = await rig();
    const down = add(r);
    r.npc.incapacitate(down, 2, 'taser');
    r.npc.taserCycle(down, 5);
    seconds(r, 3);
    expect(stateOf(r.npc, down)).toBe(ACTOR_STATE.down);
    seconds(r, 2.5);
    expect(stateOf(r.npc, down)).toBe(ACTOR_STATE.prone);
    // A longer existing timer is kept.
    const long = add(r, {}, 12);
    r.npc.incapacitate(long, 10, 'taser');
    r.npc.taserCycle(long, 5);
    seconds(r, 7);
    expect(stateOf(r.npc, long)).toBe(ACTOR_STATE.down);
    const stand = add(r, {}, 14);
    r.npc.taserCycle(stand, 5);
    expect(stateOf(r.npc, stand)).toBe(ACTOR_STATE.down);
    const cuffed = add(r, {}, 16);
    r.npc.forceState(cuffed, 'kneel');
    r.npc.cuff(cuffed);
    r.npc.taserCycle(cuffed, 5);
    expect(stateOf(r.npc, cuffed)).toBe(ACTOR_STATE.cuffed);
    r.npc.taserCycle(99999, 5);
  });
});

describe('resistance save', () => {
  it('round-trips the timestamps and attack kind', async () => {
    const r = await rig();
    const refused = add(r);
    const fought = add(r, {}, 10);
    r.npc.applyCommand(refused, 'stop', 'refuse');
    r.npc.forceState(fought, 'fight');
    r.npc.incapacitate(fought, 60, 'strike');
    seconds(r, 2);
    const save = JSON.parse(JSON.stringify(r.npc.serialize())) as NpcSave;
    expect(isNpcSave(save)).toBe(true);
    const sr = save.actors.find((a) => a.id === refused) as ActorSave;
    const sf = save.actors.find((a) => a.id === fought) as ActorSave;
    expect(sr.ra).toBeCloseTo(2, 1);
    expect(sr.at).toBeUndefined();
    expect(sf.at).toBeCloseTo(2, 1);
    expect(sf.ak).toBe(0);
    const r2 = await rig();
    r2.npc.restore(save);
    expect(r2.npc.resistance(refused)).toBe('passive');
    expect(r2.npc.resistance(fought)).toBe('assaultive');
    seconds(r2, 4);
    expect(r2.npc.resistance(fought)).toBe('compliant');
    expect(r2.npc.resistance(refused)).toBe('passive');
    seconds(r2, 10);
    expect(r2.npc.resistance(refused)).toBe('compliant');
  });

  it('round-trips a body', async () => {
    const r = await rig();
    const id = add(r);
    r.npc.wound(id, 1, true);
    const save = JSON.parse(JSON.stringify(r.npc.serialize())) as NpcSave;
    expect(((save.actors.find((a) => a.id === id) as ActorSave).flags & 2048) !== 0).toBe(true);
    const r2 = await rig();
    r2.npc.restore(save);
    expect(stateOf(r2.npc, id)).toBe(ACTOR_STATE.lying);
    r2.npc.forceState(id, 'flee');
    expect(stateOf(r2.npc, id)).toBe(ACTOR_STATE.lying);
  });

  it('loads an old actor save without the new fields', async () => {
    const r = await rig();
    const id = add(r);
    const save = JSON.parse(JSON.stringify(r.npc.serialize())) as NpcSave;
    for (const a of save.actors) {
      delete a.ra;
      delete a.rs;
      delete a.at;
      delete a.ak;
    }
    expect(isNpcSave(save)).toBe(true);
    const r2 = await rig();
    r2.npc.restore(save);
    expect(r2.npc.resistance(id)).toBe('compliant');
    expect(isNpcSave({ ...save, actors: save.actors.map((a) => ({ ...a, ra: 'x' })) })).toBe(false);
  });

  it('drops stale timestamps from the save', async () => {
    const r = await rig();
    const id = add(r);
    r.npc.applyCommand(id, 'stop', 'refuse');
    seconds(r, 31);
    const save = r.npc.serialize();
    expect((save.actors.find((a) => a.id === id) as ActorSave).ra).toBeUndefined();
  });
});
