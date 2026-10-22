import { afterAll, describe, expect, it } from 'vitest';
import { NPC_CONFIG } from '../../src/npc/data';
import { ACTOR_STATE, type NpcCommand } from '../../src/npc/types';
import { BODY, FIGURE_FLAG, HELD, POSE } from '../../src/render/people/pose';
import { DOWNTOWN, cityOf, ctx, info, makeRig, spec, spotIn, stateOf, type NpcRig } from './helpers';

const rigs: NpcRig[] = [];
const P = (() => {
  const p = spotIn(cityOf(), DOWNTOWN);
  if (!p) throw new Error('no downtown edge');
  return p;
})();

/** Actors-only rig with the officer at the downtown spot. */
async function rig(): Promise<NpcRig> {
  const r = await makeRig({ x: P.x, z: P.z, density: 0 });
  rigs.push(r);
  // One step so the system knows where the officer is before the first command.
  r.run(1);
  return r;
}
afterAll(() => {
  for (const r of rigs) r.traffic.physics.dispose();
});

/** Person ids for tests: distinct, spread over the registry. */
function person(i: number): number {
  return 2000 + i * 37;
}

const nextPerson = new WeakMap<NpcRig, number>();

/** A ring of `n` actors (new persons each call) at `radius` m around the officer. */
function ring(r: NpcRig, n: number, radius: number, profile: string, over: Partial<Parameters<typeof spec>[3]> = {}): number[] {
  const ids: number[] = [];
  const base = nextPerson.get(r) ?? 200;
  nextPerson.set(r, base + n);
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2;
    ids.push(r.npc.spawnActor(spec(person(base + i), P.x + Math.cos(ang) * radius, P.z + Math.sin(ang) * radius, { profile, ...over })));
  }
  return ids;
}

function count(r: NpcRig, topic: string): number {
  return r.events[topic]?.length ?? 0;
}

describe('actor spawn', () => {
  it('starts in the state of its profile and pose, hidden actors in hide', async () => {
    const r = await rig();
    const calm = r.npc.spawnActor(spec(person(1), P.x + 30, P.z));
    const wander = r.npc.spawnActor(spec(person(2), P.x + 30, P.z + 4, { profile: 'bystander' }));
    const crowd = r.npc.spawnActor(spec(person(3), P.x + 30, P.z + 8, { profile: 'crowdMember' }));
    const lying = r.npc.spawnActor(spec(person(4), P.x + 30, P.z + 12, { profile: 'subjectUnconscious' }));
    const sit = r.npc.spawnActor(spec(person(5), P.x + 30, P.z + 16, { profile: 'victimInjured' }));
    const hidden = r.npc.spawnActor(spec(person(6), P.x + 30, P.z + 20, { hidden: true }));
    const kneel = r.npc.spawnActor(spec(person(7), P.x + 30, P.z + 24, { pose: 'kneel' }));
    expect(stateOf(r.npc, calm)).toBe(ACTOR_STATE.idle);
    expect(stateOf(r.npc, wander)).toBe(ACTOR_STATE.wander);
    expect(stateOf(r.npc, crowd)).toBe(ACTOR_STATE.crowd);
    expect(stateOf(r.npc, lying)).toBe(ACTOR_STATE.lying);
    expect(stateOf(r.npc, sit)).toBe(ACTOR_STATE.sit);
    expect(stateOf(r.npc, hidden)).toBe(ACTOR_STATE.hide);
    expect(stateOf(r.npc, kneel)).toBe(ACTOR_STATE.kneel);
    const a = r.npc.actor(hidden, info());
    expect(a?.hidden).toBe(true);
    expect(a?.role).toBe('suspect');
    expect(a?.callId).toBe(7);
    expect(a?.profile).toBe('suspectCalm');
    r.run(1);
    const v = r.npc.view;
    expect(v.count).toBe(7);
    // Hidden actors carry the hidden flag in the view.
    let flagged = 0;
    for (let i = 0; i < v.count; i++) if (((v.flags[i] ?? 0) & FIGURE_FLAG.hidden) !== 0) flagged++;
    expect(flagged).toBe(1);
    expect(v.pose[3]).toBe(POSE.lying);
    expect(v.pose[4]).toBe(POSE.sit);
    expect(v.pose[6]).toBe(POSE.kneel);
  });

  it('rejects bad input, fills the pool and returns 0 when full', async () => {
    const r = await rig();
    expect(() => r.npc.spawnActor(spec(person(1), 0, 0, { profile: 'nope' }))).toThrow(/unknown profile/);
    expect(() => r.npc.spawnActor(spec(100000, 0, 0))).toThrow(/invalid person/);
    expect(() => r.npc.spawnActor(spec(-2, 0, 0))).toThrow(/invalid person/);
    for (let i = 0; i < NPC_CONFIG.actors.max; i++) expect(r.npc.spawnActor(spec(person(i), P.x + 40, P.z + i))).toBeGreaterThan(0);
    expect(r.npc.spawnActor(spec(person(500), P.x, P.z))).toBe(0);
    r.npc.removeActor(1);
    expect(r.npc.spawnActor(spec(person(500), P.x, P.z))).toBeGreaterThan(0);
    // Ids are never reused.
    expect(r.npc.actor(1, info())).toBeNull();
  });

  it('animals have no person, a dog body and fur', async () => {
    const r = await rig();
    const id = r.npc.spawnActor(spec(-1, P.x + 20, P.z, { profile: 'animalDog', body: 'dog', role: 'dog' }));
    expect(r.npc.actor(id, info())?.body).toBe(BODY.dog);
    expect(r.npc.actorOfPerson(-1)).toBe(0);
    r.run(30);
    const v = r.npc.view;
    expect(v.body[0]).toBe(BODY.dog);
    expect(v.height[0]).toBeCloseTo(0.6, 5);
    expect(v.hair[0]).toBe(0xffffffff);
    // A second animal is allowed.
    expect(r.npc.spawnActor(spec(-1, P.x + 22, P.z, { profile: 'animalDog', body: 'dog' }))).toBeGreaterThan(0);
  });

  it('queries: actorOfPerson, actorsOfCall, setRole, setStress, setProfile, removeActor', async () => {
    const r = await rig();
    const a = r.npc.spawnActor(spec(person(1), P.x + 30, P.z, { callId: 5 }));
    const b = r.npc.spawnActor(spec(person(2), P.x + 31, P.z, { callId: 5 }));
    const c = r.npc.spawnActor(spec(person(3), P.x + 32, P.z, { callId: 6 }));
    expect(r.npc.actorOfPerson(person(2))).toBe(b);
    expect(r.npc.actorOfPerson(person(99))).toBe(0);
    const out: number[] = [99];
    expect(r.npc.actorsOfCall(5, out)).toEqual([a, b]);
    r.npc.setRole(c, 'witness', 5);
    expect(r.npc.actorsOfCall(5, out)).toEqual([a, b, c]);
    expect(r.npc.actor(c, info())?.role).toBe('witness');
    r.npc.setStress(c, 5);
    expect(r.npc.actor(c, info())?.stress).toBe(1);
    r.npc.setStress(c, -1);
    expect(r.npc.actor(c, info())?.stress).toBe(0);
    r.npc.setProfile(c, 'suspectHostile');
    expect(r.npc.actor(c, info())?.profile).toBe('suspectHostile');
    expect(() => r.npc.setProfile(c, 'nope')).toThrow(/Unknown behaviour profile/);
    r.npc.removeActor(b);
    expect(r.npc.actorOfPerson(person(2))).toBe(0);
    expect(r.npc.isActivePerson(person(2))).toBe(false);
    expect(r.npc.isActivePerson(person(1))).toBe(true);
    r.npc.removeActor(12345);
  });
});

describe('approach roll (flee / weapon draw)', () => {
  it('rolls fleeChance once when the officer first comes within the trigger distance', async () => {
    const r = await rig();
    const ids: number[] = [];
    for (let i = 0; i < 60; i++) ids.push(r.npc.spawnActor(spec(person(200 + i), P.x + 40 + (i % 8), P.z + Math.floor(i / 8) - 4, { profile: 'suspectFleeRisk' })));
    r.run(120);
    // Nobody is close enough yet.
    expect(count(r, 'npc:fled')).toBe(0);
    for (const id of ids) expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.idle);
    // The officer steps in: everyone is now within 15 m of him.
    r.focus.x = P.x + 44;
    r.run(60);
    const fled = count(r, 'npc:fled');
    expect(fled).toBeGreaterThan(10);
    expect(fled).toBeLessThan(55);
    for (const e of r.events['npc:fled'] ?? []) {
      expect(e.callId).toBe(7);
      expect(typeof e.personId).toBe('number');
    }
    // Rolled once: the others stay and no more flee later.
    r.run(600);
    expect(count(r, 'npc:fled')).toBe(fled);
  });

  it('is repeatable: the same seed gives the same flee set', async () => {
    const run = async (): Promise<number[]> => {
      const r = await rig();
      ring(r, 40, 8, 'suspectFleeRisk');
      r.run(60);
      return (r.events['npc:fled'] ?? []).map((e) => e.actorId as number);
    };
    const a = await run();
    const b = await run();
    expect(a.length).toBeGreaterThan(5);
    expect(a).toEqual(b);
  });

  it('never makes lying or zero-chance profiles flee, and rolls only once', async () => {
    const r = await rig();
    ring(r, 20, 6, 'subjectUnconscious');
    r.run(120);
    expect(count(r, 'npc:fled')).toBe(0);
    const calm = await rig();
    const ids = ring(calm, 40, 6, 'callerHelpful');
    calm.run(60);
    const first = count(calm, 'npc:fled');
    expect(first).toBeLessThan(15);
    calm.run(600);
    // No further roll: the count stays.
    expect(count(calm, 'npc:fled')).toBe(first);
    expect(ids.length).toBe(40);
  });

  it('draws a carried weapon when it does not run (weaponDrawChance)', async () => {
    const r = await rig();
    const ids = ring(r, 50, 8, 'ambusher', { weapon: 'handgun' });
    r.run(60);
    let armed = 0;
    for (const id of ids) {
      const a = r.npc.actor(id, info());
      if (a?.state === ACTOR_STATE.armed) {
        armed++;
        expect(a.weaponDrawn).toBe(true);
        expect(a.armed).toBe(true);
      }
    }
    expect(armed).toBeGreaterThan(25);
    const brandish = (r.events['npc:attack'] ?? []).filter((e) => e.kind === 'brandish');
    expect(brandish.length).toBe(armed);
    // The drawn handgun is shown in the view; armed actors aim.
    const v = r.npc.view;
    let shown = 0;
    for (let i = 0; i < v.count; i++) if (v.held[i] === HELD.handgun) {
      shown++;
      expect(v.pose[i]).toBe(POSE.aim);
    }
    expect(shown).toBe(armed);
  });
});

describe('hidden actors', () => {
  it('stay unseen and unpickable until the officer is within revealDistanceM', async () => {
    const r = await rig();
    const id = r.npc.spawnActor(spec(person(1), P.x + 20, P.z, { hidden: true }));
    r.run(120);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.hide);
    const pick = { kind: 'actor' as const, id: 0, seat: 0, personId: 0, distance: 0 };
    expect(r.npc.nearestPerson(P.x + 20, P.z, 0, 5, -1, pick)).toBeNull();
    expect(count(r, 'npc:revealed')).toBe(0);
    // Walk up to 4 m.
    r.focus.x = P.x + 16;
    r.run(30);
    expect(stateOf(r.npc, id)).not.toBe(ACTOR_STATE.hide);
    expect(r.npc.actor(id, info())?.hidden).toBe(false);
    expect(count(r, 'npc:revealed')).toBe(1);
    expect(r.npc.nearestPerson(P.x + 20, P.z, 0, 5, -1, pick)?.id).toBe(id);
  });

  it('reveal() shows the actor at once and rolls the approach reaction once', async () => {
    const r = await rig();
    const ids = ring(r, 40, 50, 'suspectFleeRisk', { hidden: true });
    for (const id of ids) r.npc.reveal(id);
    expect(count(r, 'npc:revealed')).toBe(40);
    r.run(1);
    // The reveal roll fled some of them (before the first step finished).
    const fled = count(r, 'npc:fled');
    expect(fled).toBeGreaterThan(5);
    for (const id of ids) expect(r.npc.actor(id, info())?.hidden).toBe(false);
    r.npc.reveal(ids[0] as number);
    expect(count(r, 'npc:revealed')).toBe(40);
  });

  it('a hidden body stays lying when revealed, however much its person would run', async () => {
    const r = await rig();
    const ids = ring(r, 20, 50, 'subjectDeceased', { hidden: true });
    for (const id of ids) r.npc.reveal(id);
    r.run(60);
    for (const id of ids) expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.lying);
    expect(count(r, 'npc:fled')).toBe(0);
  });
});

describe('flee', () => {
  it('runs away from the officer and keeps going', async () => {
    const r = await rig();
    const ids = ring(r, 12, 10, 'callerHelpful');
    for (const id of ids) r.npc.forceState(id, 'flee');
    expect(count(r, 'npc:fled')).toBe(12);
    const start = new Map<number, number>();
    for (const id of ids) {
      const a = r.npc.actor(id, info());
      start.set(id, Math.hypot((a?.x ?? 0) - P.x, (a?.z ?? 0) - P.z));
    }
    r.run(60 * 8);
    for (const id of ids) {
      const a = r.npc.actor(id, info());
      expect(a?.state).toBe(ACTOR_STATE.flee);
      const d = Math.hypot((a?.x ?? 0) - P.x, (a?.z ?? 0) - P.z);
      expect(d).toBeGreaterThan((start.get(id) ?? 0) + 15);
    }
    const v = r.npc.view;
    for (let i = 0; i < v.count; i++) {
      expect(v.speed[i]).toBeGreaterThan(3);
      expect(v.pose[i]).toBe(POSE.run);
    }
  });

  it('escapes once far enough for long enough ("npc:escaped") and is removed', async () => {
    const r = await rig();
    const ids = ring(r, 6, 10, 'callerHelpful');
    for (const id of ids) r.npc.forceState(id, 'flee');
    r.run(10 * 120, 0.1);
    expect(count(r, 'npc:escaped')).toBe(6);
    for (const id of ids) expect(r.npc.actor(id, info())).toBeNull();
    expect(r.npc.stats.actors).toBe(0);
    for (const e of r.events['npc:escaped'] ?? []) expect(e.callId).toBe(7);
  });

  it('tires: the speed drops by tiredFactor after the stamina is used up', async () => {
    const r = await rig();
    const id = r.npc.spawnActor(spec(person(1), P.x + 10, P.z, { profile: 'callerHelpful' }));
    r.npc.forceState(id, 'flee');
    r.run(60 * 2);
    const fresh = r.npc.view.speed[0] ?? 0;
    r.run(60 * 45);
    const tired = r.npc.view.speed[0] ?? 0;
    expect(r.npc.actor(id, info())?.state).toBe(ACTOR_STATE.flee);
    expect(tired).toBeLessThan(fresh * (NPC_CONFIG.actors.tiredFactor + 0.1));
    expect(tired).toBeGreaterThan(1);
  });

  it('surrenders to kneel at the profile rate ("npc:surrendered")', async () => {
    const r = await rig();
    const ids = ring(r, 40, 10, 'suspectCalm');
    for (const id of ids) r.npc.forceState(id, 'flee');
    // surrenderPerMin 0.8 for 60 s: most give up (they also may escape first, so keep them in view).
    r.run(10 * 90, 0.1);
    const s = count(r, 'npc:surrendered');
    expect(s).toBeGreaterThan(8);
    for (const id of ids) {
      const st = stateOf(r.npc, id);
      expect([ACTOR_STATE.flee, ACTOR_STATE.kneel, -1]).toContain(st);
    }
    const knees = ids.filter((id) => stateOf(r.npc, id) === ACTOR_STATE.kneel).length;
    expect(knees).toBeLessThanOrEqual(s);
    // Zero rate never surrenders.
    const z = await rig();
    const zi = ring(z, 10, 10, 'callerHelpful');
    for (const id of zi) z.npc.forceState(id, 'flee');
    z.run(10 * 60, 0.1);
    expect(count(z, 'npc:surrendered')).toBe(0);
  });
});

describe('armed', () => {
  it('surrenders at the profile rate: weapon dropped, hands up', async () => {
    const r = await rig();
    r.focus.weapon = 'sidearm';
    const ids = ring(r, 30, 20, 'suspectArmedHostile', { weapon: 'handgun' });
    for (const id of ids) r.npc.forceState(id, 'armed');
    expect(count(r, 'npc:attack')).toBe(30);
    r.run(10 * 400, 0.1);
    const s = count(r, 'npc:surrendered');
    expect(s).toBeGreaterThan(20);
    const dropped = r.events['npc:weaponDropped'] ?? [];
    expect(dropped.length).toBe(s);
    for (const e of dropped) {
      expect(e.item).toBe('handgun');
      expect(typeof e.x).toBe('number');
    }
    const up = ids.filter((id) => stateOf(r.npc, id) === ACTOR_STATE.handsUp);
    expect(up.length).toBe(s);
    for (const id of up) {
      const a = r.npc.actor(id, info());
      expect(a?.armed).toBe(false);
      expect(a?.weaponDrawn).toBe(false);
    }
    // Hostile people within 12 m fired (events only; no damage here).
    expect((r.events['npc:attack'] ?? []).filter((e) => e.kind === 'fire').length).toBe(0);
  });

  it('hostile armed actors within 12 m fire; melee attackers advance and fight', async () => {
    const r = await rig();
    const guns = ring(r, 10, 8, 'suspectArmedHostile', { weapon: 'handgun' });
    for (const id of guns) r.npc.forceState(id, 'armed');
    r.run(10 * 120, 0.1);
    expect((r.events['npc:attack'] ?? []).filter((e) => e.kind === 'fire').length).toBeGreaterThan(3);

    const m = await rig();
    const knives = ring(m, 20, 8, 'suspectArmedHostile', { weapon: 'knife' });
    for (const id of knives) m.npc.forceState(id, 'armed');
    m.run(10 * 200, 0.1);
    const fights = (m.events['npc:attack'] ?? []).filter((e) => e.kind === 'fight');
    expect(fights.length).toBeGreaterThan(3);
    expect((m.events['npc:attack'] ?? []).filter((e) => e.kind === 'fire').length).toBe(0);
  });

  it('a CED hit drops the weapon and brings the actor down', async () => {
    const r = await rig();
    const id = r.npc.spawnActor(spec(person(1), P.x + 5, P.z, { profile: 'suspectArmedHostile', weapon: 'knife' }));
    r.npc.forceState(id, 'armed');
    let hit = false;
    for (let i = 0; i < 30 && !hit; i++) hit = r.npc.taser(id, 5);
    expect(hit).toBe(true);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.down);
    expect(r.events['npc:weaponDropped']?.length).toBe(1);
    expect(r.events['npc:caught']?.[0]?.by).toBe('taser');
    expect(r.npc.actor(id, info())?.armed).toBe(false);
  });
});

describe('fight', () => {
  it('ends after struggleS: officers with enough backup always win (down), otherwise the actor may flee', async () => {
    const run = async (backup: number): Promise<{ caught: number; fled: number; attacks: number }> => {
      const r = await rig();
      r.focus.backup = backup;
      const ids = ring(r, 50, 3, 'suspectHostile');
      for (const id of ids) r.npc.forceState(id, 'fight');
      r.run(10 * 2, 0.1);
      for (const id of ids) expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.fight);
      const attacks = (r.events['npc:attack'] ?? []).filter((e) => e.kind === 'fight').length;
      r.run(10 * 3, 0.1);
      return { caught: (r.events['npc:caught'] ?? []).filter((e) => e.by === 'fight').length, fled: count(r, 'npc:fled'), attacks };
    };
    const strong = await run(4);
    expect(strong.attacks).toBe(50);
    expect(strong.caught).toBe(50);
    expect(strong.fled).toBe(0);
    const alone = await run(0);
    expect(alone.caught + alone.fled).toBe(50);
    expect(alone.caught).toBeGreaterThan(12);
    expect(alone.fled).toBeGreaterThan(5);
  });

  it('samples the resistance before the tackle takes the actor down', async () => {
    const r = await rig();
    r.focus.yaw = 0;
    const calm = r.npc.spawnActor(spec(person(1), P.x, P.z - 1.2));
    expect(r.npc.tackle(P.x, P.z, 0)).toBe(calm);
    expect(r.npc.lastTackleResistance).toBe('compliant');
    const runner = r.npc.spawnActor(spec(person(2), P.x + 10, P.z - 1.2));
    r.npc.forceState(runner, 'flee');
    expect(r.npc.tackle(P.x + 10, P.z, 0)).toBe(runner);
    expect(r.npc.lastTackleResistance).toBe('active');
  });

  it('down becomes prone after the down time and stays prone until cuffed', async () => {
    const r = await rig();
    r.focus.yaw = 0;
    const id = r.npc.spawnActor(spec(person(1), P.x, P.z - 1.2));
    r.npc.forceState(id, 'flee');
    expect(r.npc.tackle(P.x, P.z, 0)).toBe(id);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.down);
    expect(r.events['npc:caught']?.[0]).toMatchObject({ actorId: id, by: 'tackle', callId: 7 });
    r.run(35, 0.1);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.down);
    r.run(10, 0.1);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.prone);
    r.run(10 * 60, 0.1);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.prone);
    expect(r.npc.view.pose[0]).toBe(POSE.prone);
    expect(r.npc.cuff(id)).toBe('ok');
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.cuffed);
  });
});

describe('tackle and CED range', () => {
  it('tackle takes down only an actor within range and inside the cone in front', async () => {
    const r = await rig();
    const front = r.npc.spawnActor(spec(person(1), P.x, P.z - 1.2));
    const far = r.npc.spawnActor(spec(person(2), P.x + 8, P.z - 8));
    const behind = r.npc.spawnActor(spec(person(3), P.x, P.z + 1.0));
    const side = r.npc.spawnActor(spec(person(4), P.x + 1.2, P.z));
    expect(r.npc.tackle(P.x, P.z, 0)).toBe(front);
    expect(r.npc.tackle(P.x, P.z, 0)).toBe(0);
    expect(stateOf(r.npc, far)).toBe(ACTOR_STATE.idle);
    expect(stateOf(r.npc, behind)).toBe(ACTOR_STATE.idle);
    expect(stateOf(r.npc, side)).toBe(ACTOR_STATE.idle);
    // Turning towards the actor on the side makes it reachable (yaw -90 degrees faces +x).
    expect(r.npc.tackle(P.x, P.z, -Math.PI / 2)).toBe(side);
    // Out of range by a hair.
    const edge = r.npc.spawnActor(spec(person(5), P.x - NPC_CONFIG.actors.tackleRangeM - 0.1, P.z));
    expect(r.npc.tackle(P.x, P.z, Math.PI / 2)).toBe(0);
    expect(stateOf(r.npc, edge)).toBe(ACTOR_STATE.idle);
    // Hidden and animal actors cannot be tackled.
    const dog = r.npc.spawnActor(spec(-1, P.x, P.z - 1, { profile: 'animalDog', body: 'dog' }));
    expect(r.npc.tackle(P.x, P.z, 0)).toBe(0);
    expect(stateOf(r.npc, dog)).not.toBe(ACTOR_STATE.down);
  });

  it('taser needs the target within taserRangeM; a miss changes nothing', async () => {
    const r = await rig();
    const id = r.npc.spawnActor(spec(person(1), P.x, P.z - 3));
    expect(r.npc.taser(id, NPC_CONFIG.actors.taserRangeM + 0.1)).toBe(false);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.idle);
    let hits = 0;
    for (let i = 0; i < 40; i++) {
      const t = r.npc.spawnActor(spec(person(100 + i), P.x + 20 + i, P.z));
      if (r.npc.taser(t, 6)) {
        hits++;
        expect(stateOf(r.npc, t)).toBe(ACTOR_STATE.down);
      } else expect(stateOf(r.npc, t)).toBe(ACTOR_STATE.idle);
    }
    expect(hits).toBeGreaterThan(22);
    expect(hits).toBeLessThan(40);
    // A hit actor is down for taserDownS, then prone.
    const down = r.npc.spawnActor(spec(person(300), P.x - 20, P.z));
    while (!r.npc.taser(down, 4)) {
      /* retry until a hit */
    }
    r.run(10 * 5, 0.1);
    expect(stateOf(r.npc, down)).toBe(ACTOR_STATE.down);
    r.run(10 * 2, 0.1);
    expect(stateOf(r.npc, down)).toBe(ACTOR_STATE.prone);
  });
});

describe('cuffs and follow', () => {
  it('cuff: ok for compliant poses, otherwise a fight roll', async () => {
    const r = await rig();
    for (const s of ['handsUp', 'kneel', 'prone', 'hold'] as const) {
      const id = r.npc.spawnActor(spec(person(s.length), P.x + 30, P.z + s.length));
      r.npc.forceState(id, s);
      expect(r.npc.cuff(id)).toBe('ok');
      const a = r.npc.actor(id, info());
      expect(a?.cuffed).toBe(true);
      expect(a?.state).toBe(ACTOR_STATE.cuffed);
      expect(r.npc.uncuff(id)).toBe(true);
      expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.hold);
      expect(r.npc.actor(id, info())?.cuffed).toBe(false);
      expect(r.npc.uncuff(id)).toBe(false);
    }
    const fleeing = r.npc.spawnActor(spec(person(80), P.x + 40, P.z));
    r.npc.forceState(fleeing, 'flee');
    expect(r.npc.cuff(fleeing)).toBe('notReady');
    const lying = r.npc.spawnActor(spec(person(81), P.x + 41, P.z, { profile: 'subjectUnconscious' }));
    expect(r.npc.cuff(lying)).toBe('notReady');
    // Standing hostile people resist sometimes: the fight state starts.
    const ids = ring(r, 50, 20, 'suspectHostile');
    const results = ids.map((id) => r.npc.cuff(id));
    const resisted = results.filter((x) => x === 'resist').length;
    expect(resisted).toBeGreaterThan(5);
    expect(resisted).toBeLessThan(30);
    expect(results.filter((x) => x === 'notReady').length).toBe(50 - resisted);
    ids.forEach((id, i) => expect(stateOf(r.npc, id)).toBe(results[i] === 'resist' ? ACTOR_STATE.fight : ACTOR_STATE.idle));
    expect((r.events['npc:attack'] ?? []).filter((e) => e.kind === 'fight').length).toBe(resisted);
  });

  it('cuffing keeps a concealed weapon (nothing is dropped unless it was drawn)', async () => {
    const r = await rig();
    const hidden = r.npc.spawnActor(spec(person(1), P.x + 6, P.z, { weapon: 'knife' }));
    r.npc.forceState(hidden, 'handsUp');
    expect(r.npc.cuff(hidden)).toBe('ok');
    expect(r.events['npc:weaponDropped']).toEqual([]);
    expect(r.npc.actor(hidden, info())?.armed).toBe(true);
    const drawn = r.npc.spawnActor(spec(person(2), P.x + 8, P.z, { weapon: 'knife' }));
    r.npc.forceState(drawn, 'armed');
    expect(r.npc.cuff(drawn)).toBe('notReady');
    r.npc.forceState(drawn, 'handsUp');
    expect(r.events['npc:weaponDropped']).toEqual([]);
    r.npc.drawWeapon(drawn);
    expect(r.npc.cuff(drawn)).toBe('ok');
    expect(r.events['npc:weaponDropped']?.length).toBe(1);
  });

  it('a cuffed actor follows the officer at followDistance behind; stops when told to', async () => {
    const r = await rig();
    r.focus.yaw = 0;
    const id = r.npc.spawnActor(spec(person(1), P.x + 3, P.z));
    r.npc.forceState(id, 'handsUp');
    expect(r.npc.follow(id, true)).toBe(true);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.follow);
    expect(r.npc.follow(id, false)).toBe(true);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.hold);
    expect(r.npc.cuff(id)).toBe('ok');
    r.run(60);
    expect(r.npc.follow(id, true)).toBe(true);
    expect(r.npc.actor(id, info())).toMatchObject({ cuffed: true, following: true, state: ACTOR_STATE.cuffed });
    // The officer walks north (towards -z) at 1.5 m/s for 20 s.
    const behind: number[] = [];
    for (let i = 0; i < 20 * 60; i++) {
      r.focus.z -= 1.5 / 60;
      r.focus.speed = 1.5;
      r.run(1);
      if (i > 600 && i % 60 === 0) {
        const a = r.npc.actor(id, info());
        behind.push(Math.hypot((a?.x ?? 0) - r.focus.x, (a?.z ?? 0) - r.focus.z));
      }
    }
    for (const d of behind) {
      expect(d).toBeGreaterThan(NPC_CONFIG.actors.followDistance - 0.6);
      expect(d).toBeLessThan(NPC_CONFIG.actors.followDistance + 1.2);
    }
    expect(r.npc.view.pose[0]).toBe(POSE.cuffed);
    expect(r.npc.view.speed[0]).toBeGreaterThan(1);
    // Stop: it stays cuffed and holds.
    expect(r.npc.follow(id, false)).toBe(true);
    r.focus.speed = 0;
    r.run(120);
    const before = r.npc.actor(id, info());
    r.focus.z -= 10;
    r.run(120);
    const after = r.npc.actor(id, info());
    expect(after?.z).toBeCloseTo(before?.z ?? 0, 3);
    expect(after?.state).toBe(ACTOR_STATE.cuffed);
    // Cannot follow when not compliant or restrained.
    const runner = r.npc.spawnActor(spec(person(2), P.x + 40, P.z));
    r.npc.forceState(runner, 'flee');
    expect(r.npc.follow(runner, true)).toBe(false);
  });

  it('catches up when left behind (runs) and does not move when the officer is in a car', async () => {
    const r = await rig();
    const id = r.npc.spawnActor(spec(person(1), P.x, P.z));
    r.npc.forceState(id, 'handsUp');
    r.npc.cuff(id);
    r.npc.follow(id, true);
    r.focus.x = P.x + 30;
    r.focus.z = P.z;
    r.run(60 * 4);
    const a = r.npc.actor(id, info());
    expect(Math.hypot((a?.x ?? 0) - r.focus.x, (a?.z ?? 0) - r.focus.z)).toBeLessThan(25);
    r.focus.onFoot = false;
    const x0 = a?.x ?? 0;
    r.run(120);
    expect(r.npc.actor(id, info())?.x).toBeCloseTo(x0, 4);
  });
});

describe('crowd, disperse and leave', () => {
  it('crowd members mill around their spawn point', async () => {
    const r = await rig();
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) ids.push(r.npc.spawnActor(spec(person(i), P.x + 50 + i, P.z + 50, { profile: 'crowdMember' })));
    let maxR = 0;
    let moved = 0;
    for (let k = 0; k < 90; k++) {
      r.run(60);
      for (let i = 0; i < ids.length; i++) {
        const a = r.npc.actor(ids[i] as number, info());
        expect(a?.state).toBe(ACTOR_STATE.crowd);
        maxR = Math.max(maxR, Math.hypot((a?.x ?? 0) - (P.x + 50 + i), (a?.z ?? 0) - (P.z + 50)));
        if (k === 89 && maxR > 0.5) moved++;
      }
    }
    expect(maxR).toBeLessThanOrEqual(NPC_CONFIG.actors.crowdRadiusM + 0.5);
    expect(maxR).toBeGreaterThan(1);
    expect(moved).toBeGreaterThan(0);
  });

  it('disperse sends the members that comply away; they are removed after leaving', async () => {
    const r = await rig();
    const ids: number[] = [];
    for (let i = 0; i < 24; i++) ids.push(r.npc.spawnActor(spec(person(i), P.x + 30 + (i % 6) * 2, P.z + 30 + Math.floor(i / 6) * 2, { profile: 'crowdMember' })));
    let comply = 0;
    for (const id of ids) {
      const out = r.npc.evaluateCommand(id, 'disperse', ctx({ tone: 'commanding', weapon: 'sidearm', backup: 2 }));
      r.npc.applyCommand(id, 'disperse', out);
      if (out === 'comply') {
        comply++;
        expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.leave);
      }
    }
    expect(comply).toBeGreaterThan(12);
    r.run(10 * 180, 0.1);
    expect(count(r, 'npc:left')).toBe(comply);
    expect(r.npc.stats.actors).toBe(24 - comply);
  });

  it('leave walks leaveDistanceM and removes the actor ("npc:left")', async () => {
    const r = await rig();
    const id = r.npc.spawnActor(spec(person(1), P.x + 20, P.z));
    r.npc.forceState(id, 'leave');
    const a0 = r.npc.actor(id, info());
    r.run(10 * 20, 0.1);
    const a1 = r.npc.actor(id, info());
    expect(Math.hypot((a1?.x ?? 0) - (a0?.x ?? 0), (a1?.z ?? 0) - (a0?.z ?? 0))).toBeGreaterThan(10);
    expect(r.npc.view.speed[0]).toBeLessThan(2);
    r.run(10 * 100, 0.1);
    expect(r.npc.actor(id, info())).toBeNull();
    expect(r.events['npc:left']).toEqual([{ actorId: id, personId: person(1), callId: 7 }]);
    expect(r.npc.isActivePerson(person(1))).toBe(false);
  });
});

describe('lying actors', () => {
  it('stay put with no transitions and ignore commands', async () => {
    const r = await rig();
    const id = r.npc.spawnActor(spec(person(1), P.x + 5, P.z, { profile: 'subjectUnconscious' }));
    r.run(60 * 30);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.lying);
    for (const cmd of ['stop', 'getDown', 'followMe', 'leaveArea'] as const) {
      expect(r.npc.evaluateCommand(id, cmd, ctx())).toBe('refuse');
      r.npc.applyCommand(id, cmd, 'comply');
    }
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.lying);
    expect(r.npc.actor(id, info())?.stress).toBe(0);
    expect(r.npc.cuff(id)).toBe('notReady');
    r.npc.removeActor(id);
    expect(r.npc.actor(id, info())).toBeNull();
  });
});

describe('applyCommand', () => {
  const expectState: [NpcCommand, number][] = [
    ['stop', ACTOR_STATE.hold],
    ['handsUp', ACTOR_STATE.handsUp],
    ['getDown', ACTOR_STATE.kneel],
    ['comeHere', ACTOR_STATE.walkTo],
    ['stayBack', ACTOR_STATE.hold],
    ['followMe', ACTOR_STATE.follow],
    ['sitDown', ACTOR_STATE.sit],
    ['dropWeapon', ACTOR_STATE.handsUp],
    ['showHands', ACTOR_STATE.handsUp],
    ['leaveArea', ACTOR_STATE.leave],
    ['disperse', ACTOR_STATE.leave],
    ['release', ACTOR_STATE.leave],
    ['walkBackward', ACTOR_STATE.walkTo],
  ];

  it.each(expectState)('comply with %s -> state %i', async (cmd, state) => {
    const r = await rig();
    const id = r.npc.spawnActor(spec(person(1), P.x + 6, P.z, { weapon: cmd === 'dropWeapon' ? 'knife' : null }));
    r.npc.applyCommand(id, cmd, 'comply');
    expect(stateOf(r.npc, id)).toBe(state);
    if (cmd === 'dropWeapon') {
      expect(r.events['npc:weaponDropped']?.length).toBe(1);
      expect(r.events['npc:weaponDropped']?.[0]?.item).toBe('knife');
    }
  });

  it('getDown twice goes prone; comeHere ends 1.5 m in front of the officer and holds', async () => {
    const r = await rig();
    r.focus.yaw = 0;
    const id = r.npc.spawnActor(spec(person(1), P.x + 6, P.z + 4));
    r.npc.applyCommand(id, 'getDown', 'comply');
    r.npc.applyCommand(id, 'getDown', 'comply');
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.prone);
    r.npc.applyCommand(id, 'handsUp', 'comply');
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.handsUp);
    r.npc.applyCommand(id, 'comeHere', 'comply');
    r.run(60 * 8);
    const a = r.npc.actor(id, info());
    expect(a?.state).toBe(ACTOR_STATE.hold);
    expect(Math.hypot((a?.x ?? 0) - P.x, (a?.z ?? 0) - (P.z - 1.5))).toBeLessThan(0.05);
  });

  it('turnAround faces away from the officer and keeps it that way; walkBackward walks 6 m towards him backwards', async () => {
    const r = await rig();
    const id = r.npc.spawnActor(spec(person(1), P.x + 10, P.z));
    r.npc.applyCommand(id, 'stop', 'comply');
    r.run(60);
    r.npc.applyCommand(id, 'turnAround', 'comply');
    const a = r.npc.actor(id, info());
    // Away from the officer (who is at -x) is +x: yaw such that heading = (-sin, -cos) = (1, 0) -> yaw = -pi/2.
    expect(Math.sin(a?.yaw ?? 0)).toBeCloseTo(-1, 3);
    r.run(120);
    expect(Math.sin(r.npc.actor(id, info())?.yaw ?? 0)).toBeCloseTo(-1, 3);
    r.npc.applyCommand(id, 'walkBackward', 'comply');
    r.run(60 * 10);
    const b = r.npc.actor(id, info());
    expect(b?.state).toBe(ACTOR_STATE.hold);
    expect(b?.x).toBeCloseTo(P.x + 4, 1);
    // Still facing away (+x).
    expect(Math.sin(b?.yaw ?? 0)).toBeCloseTo(-1, 3);
  });

  it('calmDown lowers stress, refusal raises it, confused does nothing, flee / fight outcomes change the state', async () => {
    const r = await rig();
    const id = r.npc.spawnActor(spec(person(1), P.x + 6, P.z));
    r.npc.setStress(id, 0.5);
    r.npc.applyCommand(id, 'calmDown', 'comply');
    expect(r.npc.actor(id, info())?.stress).toBeCloseTo(0.3, 5);
    r.npc.applyCommand(id, 'stop', 'refuse');
    expect(r.npc.actor(id, info())?.stress).toBeCloseTo(0.4, 5);
    r.npc.applyCommand(id, 'stop', 'confused');
    expect(r.npc.actor(id, info())?.stress).toBeCloseTo(0.4, 5);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.idle);
    r.npc.applyCommand(id, 'turnOffEngine', 'comply');
    r.npc.applyCommand(id, 'tossKeys', 'comply');
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.idle);
    r.npc.applyCommand(id, 'stop', 'fight');
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.fight);
    r.npc.applyCommand(id, 'stop', 'flee');
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.flee);
    const id2 = r.npc.spawnActor(spec(person(2), P.x + 6, P.z + 2));
    r.npc.applyCommand(id2, 'stop', 'flee');
    expect(stateOf(r.npc, id2)).toBe(ACTOR_STATE.flee);
    // Stress is clamped.
    r.npc.setStress(id2, 0.95);
    r.npc.applyCommand(id2, 'stop', 'refuse');
    expect(r.npc.actor(id2, info())?.stress).toBe(1);
    r.npc.applyCommand(999, 'stop', 'comply');
  });

  it('a restrained (cuffed) actor keeps its cuffs: stop and stayBack only end following', async () => {
    const r = await rig();
    const id = r.npc.spawnActor(spec(person(1), P.x + 6, P.z));
    r.npc.forceState(id, 'kneel');
    r.npc.cuff(id);
    r.npc.follow(id, true);
    r.npc.applyCommand(id, 'stop', 'comply');
    expect(r.npc.actor(id, info())).toMatchObject({ cuffed: true, following: false, state: ACTOR_STATE.cuffed });
    r.npc.applyCommand(id, 'handsUp', 'comply');
    r.npc.applyCommand(id, 'sitDown', 'comply');
    r.npc.applyCommand(id, 'getDown', 'comply');
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.cuffed);
    r.npc.applyCommand(id, 'followMe', 'comply');
    expect(r.npc.actor(id, info())?.following).toBe(true);
    r.npc.applyCommand(id, 'release', 'comply');
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.leave);
  });
});

describe('evaluateCommand', () => {
  it('rolls compliance with the profile: cooperative people obey, hostile ones mostly do not', async () => {
    const r = await rig();
    const coop = ring(r, 50, 5, 'driverCooperative');
    const hostile = ring(r, 50, 5, 'suspectHostile').slice(0, 14);
    const tally = (ids: number[]): Record<string, number> => {
      const t: Record<string, number> = {};
      for (const id of ids) {
        const o = r.npc.evaluateCommand(id, 'stop', ctx());
        t[o] = (t[o] ?? 0) + 1;
      }
      return t;
    };
    const a = tally(coop.slice(0, 50));
    expect(a.comply ?? 0).toBeGreaterThan(35);
    const b = tally(hostile);
    expect((b.comply ?? 0) + (b.refuse ?? 0) + (b.flee ?? 0) + (b.fight ?? 0) + (b.confused ?? 0)).toBe(14);
    expect(b.comply ?? 0).toBeLessThan(10);
  });

  it('is deterministic for the same seed, and gives flee / fight outcomes to the right people', async () => {
    const run = async (): Promise<string[]> => {
      const r = await rig();
      const ids = ring(r, 30, 1.5, 'suspectHostile');
      return ids.map((id) => r.npc.evaluateCommand(id, 'getDown', ctx()));
    };
    const a = await run();
    expect(a).toEqual(await run());
    expect(a).toContain('fight');
    expect(a).toContain('refuse');
    // Far away hostile people do not start a fight.
    const r = await rig();
    const far = ring(r, 30, 10, 'suspectHostile').map((id) => r.npc.evaluateCommand(id, 'getDown', ctx()));
    expect(far).not.toContain('fight');
    // Restrained people never flee or fight.
    const cuffed = ring(r, 20, 1.5, 'suspectFleeRisk');
    for (const id of cuffed) {
      r.npc.forceState(id, 'handsUp');
      r.npc.cuff(id);
    }
    for (const id of cuffed) expect(['comply', 'refuse', 'confused']).toContain(r.npc.evaluateCommand(id, 'followMe', ctx()));
  });

  it('release and returnToVehicle always comply; unknown actors refuse', async () => {
    const r = await rig();
    const id = r.npc.spawnActor(spec(person(1), P.x + 6, P.z, { profile: 'suspectHostile' }));
    for (let i = 0; i < 10; i++) {
      expect(r.npc.evaluateCommand(id, 'release', ctx())).toBe('comply');
      expect(r.npc.evaluateCommand(id, 'returnToVehicle', ctx())).toBe('comply');
    }
    expect(r.npc.evaluateCommand(4242, 'stop', ctx())).toBe('refuse');
  });
});

describe('events and queue', () => {
  it('step-time events are delivered after the step so handlers may call back into the system', async () => {
    const r = await rig();
    const id = r.npc.spawnActor(spec(person(1), P.x + 5, P.z));
    const seen: number[] = [];
    r.bus.on('npc:left', (e) => {
      seen.push(e.actorId);
      // Re-entrant calls are safe.
      r.npc.removeActor(e.actorId);
      r.npc.spawnActor(spec(person(50), P.x + 40, P.z));
    });
    r.npc.forceState(id, 'leave');
    r.run(10 * 120, 0.1);
    expect(seen).toEqual([id]);
    expect(r.npc.stats.actors).toBe(1);
    expect(r.npc.actorOfPerson(person(50))).toBeGreaterThan(0);
  });
});
