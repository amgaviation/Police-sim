import { afterAll, describe, expect, it } from 'vitest';
import { INTERIOR_FLOOR_Y } from '../../src/interior/constants';
import { ACTOR_STATE, type PersonPick } from '../../src/npc/types';
import { DOWNTOWN, StubNav, cityOf, info, makeRig, spec, spotIn, stateOf, type NpcRig } from './helpers';

const rigs: NpcRig[] = [];
const P = (() => {
  const p = spotIn(cityOf(), DOWNTOWN);
  if (!p) throw new Error('no downtown edge');
  return p;
})();
const B = 5;

afterAll(() => {
  for (const r of rigs) r.traffic.physics.dispose();
});

/** Actors-only rig with the officer at the downtown spot and a stub nav port. */
async function rig(): Promise<{ r: NpcRig; nav: StubNav }> {
  const r = await makeRig({ x: P.x, z: P.z, density: 0 });
  rigs.push(r);
  const nav = new StubNav();
  r.npc.setIndoorNav(nav);
  r.run(1);
  return { r, nav };
}

function pick(): PersonPick {
  return { kind: 'actor', id: 0, seat: -1, personId: -1, distance: 0 };
}

function infoOf(r: NpcRig, id: number): ReturnType<typeof info> {
  const out = info();
  r.npc.actor(id, out);
  return out;
}

describe('levels', () => {
  it('an actor spawned in a building publishes y = the interior floor and keeps its building', async () => {
    const { r } = await rig();
    const out = r.npc.spawnActor(spec(2100, P.x + 20, P.z));
    const inn = r.npc.spawnActor(spec(2101, P.x + 22, P.z, { building: B }));
    r.run(2);
    const v = r.npc.view;
    expect(v.count).toBe(2);
    expect(v.y[0]).toBe(0);
    expect(v.y[1]).toBe(INTERIOR_FLOOR_Y);
    expect(v.prevY[1]).toBe(INTERIOR_FLOOR_Y);
    expect(infoOf(r, inn).building).toBe(B);
    expect(infoOf(r, out).building).toBe(-1);
    const ids: number[] = [];
    expect(r.npc.actorsInBuilding(B, ids)).toEqual([inn]);
    expect(r.npc.actorsInBuilding(-1, ids)).toEqual([out]);
  });

  it('rejects an invalid building id', async () => {
    const { r } = await rig();
    expect(() => r.npc.spawnActor(spec(2102, P.x, P.z, { building: -3 }))).toThrow(RangeError);
    expect(() => r.npc.spawnActor(spec(2103, P.x, P.z, { building: 1.5 }))).toThrow(RangeError);
  });

  it('nearestPerson and tackle only see the requested level', async () => {
    const { r } = await rig();
    const out = r.npc.spawnActor(spec(2110, P.x, P.z - 1.5));
    const inn = r.npc.spawnActor(spec(2111, P.x, P.z - 1.2, { building: B }));
    const p = pick();
    // The indoor actor is nearer, but outdoors only the outdoor one counts.
    expect(r.npc.nearestPerson(P.x, P.z, 0, 10, -1, p)?.id).toBe(out);
    expect(r.npc.nearestPerson(P.x, P.z, 0, 10, -1, p, B)?.id).toBe(inn);
    expect(r.npc.nearestPerson(P.x, P.z, 0, 10, -1, p, 9)).toBeNull();
    expect(r.npc.tackle(P.x, P.z, 0, B)).toBe(inn);
    expect(stateOf(r.npc, out)).not.toBe(ACTOR_STATE.down);
    expect(r.npc.tackle(P.x, P.z, 0)).toBe(out);
  });

  it('an actor on another level does not take the officer\'s approach roll', async () => {
    const { r } = await rig();
    // suspectFleeRisk flees when the officer comes close, but not through the floor.
    const inn = r.npc.spawnActor(spec(2115, P.x + 3, P.z, { profile: 'suspectFleeRisk', building: B }));
    r.run(120);
    expect(stateOf(r.npc, inn)).toBe(ACTOR_STATE.idle);
  });

  it('setActorPosition moves an actor to a level and clears its route', async () => {
    const { r } = await rig();
    const id = r.npc.spawnActor(spec(2120, P.x + 30, P.z));
    r.npc.walkTo(id, P.x + 40, P.z);
    r.npc.setActorPosition(id, B, P.x + 31, P.z + 2, 1);
    const a = infoOf(r, id);
    expect(a.building).toBe(B);
    expect(a.x).toBe(P.x + 31);
    expect(a.z).toBe(P.z + 2);
    r.run(2);
    expect(r.npc.view.y[0]).toBe(INTERIOR_FLOOR_Y);
    expect(r.npc.view.prevY[0]).toBe(INTERIOR_FLOOR_Y);
    r.npc.setActorPosition(id, -1, P.x + 31, P.z + 2, 1);
    r.run(2);
    expect(r.npc.view.y[0]).toBe(0);
  });
});

describe('indoor movement', () => {
  it('without a nav port an indoor actor only holds', async () => {
    const { r } = await rig();
    r.npc.setIndoorNav(null);
    const id = r.npc.spawnActor(spec(2130, P.x + 6, P.z, { building: B }));
    r.npc.walkTo(id, P.x + 10, P.z);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.hold);
    r.npc.forceState(id, 'flee');
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.hold);
    expect(r.events['npc:fled']).toHaveLength(0);
  });

  it('walkTo indoors follows the path from the nav port and stops at the target', async () => {
    const { r, nav } = await rig();
    const id = r.npc.spawnActor(spec(2131, P.x + 6, P.z, { building: B }));
    r.npc.walkTo(id, P.x + 9, P.z);
    expect(nav.paths).toEqual([{ building: B, x: P.x + 6, z: P.z, tx: P.x + 9, tz: P.z }]);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.walkTo);
    r.run(240);
    const a = infoOf(r, id);
    expect(a.state).toBe(ACTOR_STATE.hold);
    expect(a.x).toBeCloseTo(P.x + 9, 1);
    expect(a.building).toBe(B);
  });

  it('wander and crowd profiles idle indoors', async () => {
    const { r } = await rig();
    const id = r.npc.spawnActor(spec(2132, P.x + 6, P.z, { building: B, profile: 'bystander' }));
    const id2 = r.npc.spawnActor(spec(2133, P.x + 8, P.z, { building: B, profile: 'crowdMember' }));
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.idle);
    expect(stateOf(r.npc, id2)).toBe(ACTOR_STATE.idle);
    r.npc.forceState(id2, 'crowd');
    expect(stateOf(r.npc, id2)).toBe(ACTOR_STATE.hold);
  });

  it('flees along the nav exit route, steps outdoors at the exit pose and carries on like an outdoor actor', async () => {
    const { r, nav } = await rig();
    const door = { x: P.x + 30, z: P.z + 5 };
    nav.exitRoute = [P.x + 30, P.z + 2, door.x, door.z];
    nav.exitPose = { x: door.x, z: door.z + 1.5, yaw: 3 };
    const id = r.npc.spawnActor(spec(2140, P.x + 30, P.z, { building: B, profile: 'suspectCalm' }));
    r.npc.forceState(id, 'flee');
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.flee);
    expect(nav.exits).toEqual([B]);
    expect(r.events['npc:fled']).toHaveLength(1);
    let outAt = -1;
    for (let i = 0; i < 600 && outAt < 0; i++) {
      r.run(1);
      if (infoOf(r, id).building === -1) outAt = i;
    }
    expect(outAt).toBeGreaterThan(0);
    // It left through the door pose and is still fleeing, now outdoors with a Phase 3 flee route.
    const a = infoOf(r, id);
    expect(a.state).toBe(ACTOR_STATE.flee);
    expect(Math.hypot(a.x - door.x, a.z - (door.z + 1.5))).toBeLessThan(2);
    expect(r.npc.view.y[0]).toBe(0);
    expect(r.events['npc:fled']).toHaveLength(1);
    r.run(180);
    const b = infoOf(r, id);
    expect(Math.hypot(b.x - door.x, b.z - door.z)).toBeGreaterThan(6);
  });

  it('a fleeing actor with no way out hides at the nav hiding spot, and leaves it when revealed', async () => {
    const { r, nav } = await rig();
    nav.hideIndex = 3;
    nav.hidePose = { x: P.x + 31, z: P.z + 1, yaw: 2 };
    const id = r.npc.spawnActor(spec(2150, P.x + 30, P.z, { building: B }));
    r.npc.forceState(id, 'flee');
    const a = infoOf(r, id);
    expect(a.state).toBe(ACTOR_STATE.hide);
    expect(a.hidden).toBe(true);
    expect(a.x).toBe(P.x + 31);
    expect(a.z).toBe(P.z + 1);
    expect(nav.hides).toHaveLength(1);
    expect(nav.hides[0]?.building).toBe(B);
    r.npc.reveal(id);
    expect(nav.released).toEqual([{ building: B, index: 3 }]);
    expect(infoOf(r, id).hidden).toBe(false);
  });

  it('with no way out and no hiding spot the actor holds', async () => {
    const { r } = await rig();
    const id = r.npc.spawnActor(spec(2160, P.x + 30, P.z, { building: B }));
    r.npc.forceState(id, 'flee');
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.hold);
    expect(r.events['npc:fled']).toHaveLength(0);
  });

  it('leave goes out through the exit and then walks away until it is gone', async () => {
    const { r, nav } = await rig();
    nav.exitRoute = [P.x + 30, P.z + 3];
    nav.exitPose = { x: P.x + 30, z: P.z + 4, yaw: 0 };
    const id = r.npc.spawnActor(spec(2170, P.x + 30, P.z, { building: B, profile: 'callerHelpful', callId: 0 }));
    r.npc.forceState(id, 'leave');
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.leave);
    for (let i = 0; i < 4000 && (r.events['npc:left']?.length ?? 0) === 0; i++) r.run(1);
    expect(r.events['npc:left']).toHaveLength(1);
    expect(r.npc.actorOfPerson(2170)).toBe(0);
  });

  it('the destroyed exit of a leaving actor makes it hold instead of vanishing', async () => {
    const { r, nav } = await rig();
    nav.exitRoute = [P.x + 30, P.z + 3];
    nav.exitPose = { x: P.x + 30, z: P.z + 4, yaw: 0 };
    const id = r.npc.spawnActor(spec(2171, P.x + 30, P.z, { building: B, profile: 'callerHelpful' }));
    r.npc.forceState(id, 'leave');
    nav.exitRoute = [];
    r.run(300);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.hold);
    expect(infoOf(r, id).building).toBe(B);
  });
});

describe('following indoors', () => {
  it('uses nav.path to the officer about once a second', async () => {
    const { r, nav } = await rig();
    r.focus.building = B;
    r.focus.x = P.x + 12;
    r.focus.z = P.z;
    const id = r.npc.spawnActor(spec(2180, P.x, P.z, { building: B, profile: 'callerHelpful' }));
    expect(r.npc.follow(id, true)).toBe(true);
    nav.paths.length = 0;
    r.run(180);
    // 3 s of following: a path on the first step and then one per second.
    expect(nav.paths.length).toBeGreaterThanOrEqual(3);
    expect(nav.paths.length).toBeLessThanOrEqual(4);
    for (const p of nav.paths) {
      expect(p.building).toBe(B);
      expect(p.tx).toBeCloseTo(P.x + 12, 3);
    }
    const a = infoOf(r, id);
    expect(Math.hypot(a.x - (P.x + 12), a.z - P.z)).toBeLessThan(2);
    // Stopping in reach of the officer: no more paths.
    const before = nav.paths.length;
    r.run(120);
    expect(nav.paths.length).toBe(before);
  });

  it('a follower waits while the officer is on another level', async () => {
    const { r, nav } = await rig();
    const id = r.npc.spawnActor(spec(2181, P.x + 10, P.z, { building: B, profile: 'callerHelpful' }));
    r.npc.follow(id, true);
    r.focus.building = -1;
    r.run(120);
    expect(nav.paths).toHaveLength(0);
    expect(infoOf(r, id).x).toBe(P.x + 10);
  });

  it('transferFollowers moves an escorted prisoner 1 m behind the officer and leaves the others', async () => {
    const { r } = await rig();
    const prisoner = r.npc.spawnActor(spec(2190, P.x + 1.5, P.z, { profile: 'suspectCalm' }));
    const bystander = r.npc.spawnActor(spec(2191, P.x + 20, P.z, { profile: 'callerHelpful' }));
    r.npc.forceState(prisoner, 'handsUp');
    expect(r.npc.cuff(prisoner)).toBe('ok');
    expect(r.npc.follow(prisoner, true)).toBe(true);
    const yaw = Math.PI / 2;
    r.npc.transferFollowers(B, P.x + 50, P.z + 60, yaw);
    const a = infoOf(r, prisoner);
    expect(a.building).toBe(B);
    expect(a.cuffed).toBe(true);
    expect(a.following).toBe(true);
    // Behind a officer facing yaw pi/2 (towards -x) is +x.
    expect(a.x).toBeCloseTo(P.x + 51, 5);
    expect(a.z).toBeCloseTo(P.z + 60, 5);
    expect(infoOf(r, bystander).building).toBe(-1);
    r.run(2);
    expect(r.npc.view.y[0]).toBe(INTERIOR_FLOOR_Y);
    r.npc.transferFollowers(-1, P.x, P.z, 0);
    expect(infoOf(r, prisoner).building).toBe(-1);
  });
});
