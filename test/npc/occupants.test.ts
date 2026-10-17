import { afterAll, describe, expect, it } from 'vitest';
import { NPC_CONFIG } from '../../src/npc/data';
import { ACTOR_STATE, type PersonPick } from '../../src/npc/types';
import { BODY, HELD, POSE } from '../../src/render/people/pose';
import { VEHICLE_MODELS } from '../../src/vehicles/model';
import { laneRef } from '../../src/world/roadGraph';
import { DOWNTOWN, cityOf, info, makeRig, spotIn, stateOf, type NpcRig } from './helpers';

const rigs: NpcRig[] = [];
const P = (() => {
  const p = spotIn(cityOf(), DOWNTOWN);
  if (!p) throw new Error('no downtown edge');
  return p;
})();
afterAll(() => {
  for (const r of rigs) r.traffic.physics.dispose();
});

/** Rig with `n` traffic cars placed on the roads around the officer (registry ids 100 ..). */
async function carRig(n: number): Promise<{ r: NpcRig; vids: number[] }> {
  const r = await makeRig({ x: P.x, z: P.z, density: 0 });
  rigs.push(r);
  const near = r.city.graph.edgesNear(P.x, P.z, 40, []);
  const vids: number[] = [];
  let next = 100;
  for (const frac of [0.5, 0.25, 0.75]) {
    for (let k = 0; k < near.length && vids.length < n; k++) {
      const e = r.city.graph.edges[near[k] as number];
      if (!e) continue;
      for (const dir of [0, 1] as const) {
        const slot = vids.length < n ? r.traffic.sys.spawnAt(laneRef(e.id, dir, 0), e.length * frac, { vehicleId: next, speed: 0 }) : -1;
        const view = r.traffic.sys.view;
        if (slot >= 0 && Math.hypot((view.x[slot] ?? 0) - P.x, (view.z[slot] ?? 0) - P.z) < NPC_CONFIG.occupants.renderRadiusM - 5) vids.push(next);
        else if (slot >= 0) r.traffic.sys.removeVehicle(next);
        next++;
      }
    }
  }
  r.run(1);
  return { r, vids };
}

function carSlot(r: NpcRig, vid: number): number {
  return r.traffic.sys.slotOfVehicle(vid);
}

describe('seated occupants', () => {
  it('appear in nearby cars with anchors, vehicle-local seat offsets and a seated pose', async () => {
    const { r, vids } = await carRig(6);
    expect(vids.length).toBeGreaterThan(2);
    const v = r.npc.view;
    const tv = r.traffic.sys.view;
    expect(r.npc.stats.occupants).toBeGreaterThan(vids.length - 1);
    const first = r.npc.stats.peds + r.npc.stats.actors;
    for (let i = first; i < v.count; i++) {
      const anchor = v.anchor[i] ?? 0;
      const slot = Array.from({ length: tv.count }, (_, s) => s).find((s) => tv.eid[s] === anchor);
      expect(slot).toBeDefined();
      const s = slot as number;
      const model = VEHICLE_MODELS[tv.model[s] ?? 0];
      expect(Math.hypot((tv.x[s] ?? 0) - P.x, (tv.z[s] ?? 0) - P.z)).toBeLessThanOrEqual(NPC_CONFIG.occupants.renderRadiusM);
      expect(v.pose[i]).toBe(POSE.seated);
      expect(v.y[i]).toBeCloseTo(NPC_CONFIG.occupants.seatY, 5);
      expect(Math.abs(v.x[i] ?? 0)).toBeLessThanOrEqual((model?.body.width ?? 2) * 0.23);
      expect(Math.abs(v.z[i] ?? 0)).toBeLessThanOrEqual((model?.body.length ?? 5) * 0.29);
      expect(v.prevX[i]).toBe(v.x[i]);
      expect(v.body[i]).toBe(BODY.human);
      expect(v.held[i]).toBe(HELD.none);
      expect(v.speed[i]).toBe(0);
    }
    // Driver first: seat 0 on the left (negative x), forward of the centre (negative z); every car with a driver shows one.
    for (const vid of vids) {
      const slot = carSlot(r, vid);
      const eid = tv.eid[slot] ?? 0;
      let driver = -1;
      for (let i = first; i < v.count; i++) if (v.anchor[i] === eid && (v.x[i] ?? 0) < 0 && (v.z[i] ?? 0) < 0) driver = i;
      expect(driver).toBeGreaterThanOrEqual(first);
    }
  });

  it('use the appearance of the occupants and the people module order (driver, passengers)', async () => {
    const { r, vids } = await carRig(3);
    const vid = vids[0] as number;
    const ids = r.npc.occupantsOf(vid);
    expect(ids).toEqual(r.people.occupantsOf(vid));
    expect(ids.length).toBeGreaterThan(0);
    const tv = r.traffic.sys.view;
    const eid = tv.eid[carSlot(r, vid)] ?? 0;
    const v = r.npc.view;
    const skins: number[] = [];
    for (let i = r.npc.stats.peds + r.npc.stats.actors; i < v.count; i++) if (v.anchor[i] === eid) skins.push(v.skin[i] ?? 0);
    expect(skins).toEqual(ids.map((id) => r.people.appearance(id).skin));
    for (const id of ids) expect(r.npc.isActivePerson(id)).toBe(true);
  });

  it('scenario overrides replace the generated occupants', async () => {
    const { r, vids } = await carRig(3);
    const vid = vids[0] as number;
    r.npc.setOccupants(vid, [7001, 7002]);
    expect(r.npc.occupantsOf(vid)).toEqual([7001, 7002]);
    r.run(1);
    const eid = r.traffic.sys.view.eid[carSlot(r, vid)] ?? 0;
    const v = r.npc.view;
    const skins: number[] = [];
    for (let i = r.npc.stats.peds + r.npc.stats.actors; i < v.count; i++) if (v.anchor[i] === eid) skins.push(v.skin[i] ?? 0);
    expect(skins).toEqual([r.people.appearance(7001).skin, r.people.appearance(7002).skin]);
    expect(r.npc.isActivePerson(7001)).toBe(true);
    // An override with a duplicate and junk is cleaned.
    r.npc.setOccupants(vid, [7001, 7001, -4, 1.5, 200000]);
    expect(r.npc.occupantsOf(vid)).toEqual([7001]);
    // Fleet and unregistered ids have nobody by default.
    expect(r.npc.occupantsOf(1 << 20)).toEqual([]);
  });

  it('cars outside renderRadiusM show nobody', async () => {
    const { r } = await carRig(4);
    r.focus.x += 500;
    r.run(1);
    expect(r.npc.stats.occupants).toBe(0);
    expect(r.npc.view.count).toBe(0);
  });
});

describe('nearestPerson', () => {
  it('finds actors, pedestrians and the occupants of the stop car inside the cone', async () => {
    const { r, vids } = await carRig(3);
    const vid = vids[0] as number;
    expect(r.traffic.sys.forceStop(vid)).toBe(true);
    const tv = r.traffic.sys.view;
    const s = carSlot(r, vid);
    const cx = tv.x[s] ?? 0;
    const cz = tv.z[s] ?? 0;
    const pick: PersonPick = { kind: 'actor', id: 0, seat: 0, personId: 0, distance: 0 };
    const got = r.npc.nearestPerson(cx, cz, 0, 4, -1, pick);
    expect(got).not.toBeNull();
    expect(pick.kind).toBe('occupant');
    expect(pick.id).toBe(vid);
    expect(r.npc.occupantsOf(vid)).toContain(pick.personId);
    // Occupants of cars that are not the stop car are not pickable.
    const other = vids[1] as number;
    const os = carSlot(r, other);
    expect(r.npc.nearestPerson(tv.x[os] ?? 0, tv.z[os] ?? 0, 0, 0.5, -1, pick)).toBeNull();
    // An actor nearer than the occupant wins; the cone excludes people behind.
    const a = r.npc.spawnActor({ personId: 9001, x: cx + 4, z: cz + 3.5, yaw: 0, profile: 'callerHelpful', role: 'caller', callId: 1, hidden: false, body: 'human', weapon: null, vehicleId: -1 });
    expect(r.npc.nearestPerson(cx + 4, cz + 4, 0, 10, 0.9, pick)).not.toBeNull();
    expect(pick.kind === 'actor' ? pick.id : -1).toBe(a);
    expect(pick.personId).toBe(9001);
    expect(pick.distance).toBeCloseTo(0.5, 5);
    // Facing the other way, nobody is inside the cone.
    expect(r.npc.nearestPerson(cx + 4, cz + 4, Math.PI, 6, 0.9, pick)).toBeNull();
    r.traffic.sys.releaseStop();
  });
});

describe('stepOut and returnToVehicle', () => {
  it('spawns a standing actor at the curb-side door and hides the seat', async () => {
    const { r, vids } = await carRig(3);
    const vid = vids[0] as number;
    const before = r.npc.stats.occupants;
    const persons = r.npc.occupantsOf(vid);
    expect(persons.length).toBeGreaterThan(0);
    const id = r.npc.stepOut(vid, 0);
    expect(id).toBeGreaterThan(0);
    expect(r.npc.isOut(vid, 0)).toBe(true);
    expect(r.npc.isOut(vid, 1)).toBe(false);
    const a = r.npc.actor(id, info());
    expect(a).toMatchObject({ personId: persons[0], vehicleId: vid, seat: 0, role: 'driver', state: ACTOR_STATE.idle, profile: 'driverCooperative' });
    // At the right door: right of the car's heading, outside its width.
    const tv = r.traffic.sys.view;
    const s = carSlot(r, vid);
    const yaw = tv.yaw[s] ?? 0;
    const model = VEHICLE_MODELS[tv.model[s] ?? 0];
    const dx = (a?.x ?? 0) - (tv.x[s] ?? 0);
    const dz = (a?.z ?? 0) - (tv.z[s] ?? 0);
    const right = dx * Math.cos(yaw) - dz * Math.sin(yaw);
    expect(right).toBeGreaterThan((model?.body.width ?? 2) / 2 + 0.4);
    expect(right).toBeLessThan((model?.body.width ?? 2) / 2 + 1.2);
    // The actor faces away from the car (to the right).
    expect(Math.cos((a?.yaw ?? 0) - (yaw - Math.PI / 2))).toBeCloseTo(1, 5);
    r.run(1);
    expect(r.npc.stats.occupants).toBe(before - 1);
    expect(r.npc.stats.actors).toBe(1);
    expect(r.npc.actorOfPerson(persons[0] as number)).toBe(id);
    // Not twice, and not for empty seats.
    expect(r.npc.stepOut(vid, 0)).toBe(0);
    expect(r.npc.stepOut(vid, 9)).toBe(0);
    expect(r.npc.stepOut(vid, -1)).toBe(0);
    expect(r.npc.stepOut(999999, 0)).toBe(0);
    if (persons.length > 1) {
      const p2 = r.npc.stepOut(vid, 1);
      expect(r.npc.actor(p2, info())?.profile).toBe('passenger');
    }
  });

  it('returnToVehicle walks back to the door and re-seats the person', async () => {
    const { r, vids } = await carRig(3);
    const vid = vids[0] as number;
    const before = r.npc.stats.occupants;
    const id = r.npc.stepOut(vid, 0);
    r.npc.setStress(id, 0);
    r.npc.applyCommand(id, 'stop', 'comply');
    r.run(60);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.hold);
    // Walk away a few metres first.
    r.npc.walkTo(id, (r.npc.actor(id, info())?.x ?? 0) + 4, (r.npc.actor(id, info())?.z ?? 0));
    r.run(60 * 6);
    r.npc.applyCommand(id, 'returnToVehicle', 'comply');
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.walkTo);
    r.run(60 * 10);
    expect(r.npc.actor(id, info())).toBeNull();
    expect(r.npc.isOut(vid, 0)).toBe(false);
    expect(r.npc.stats.occupants).toBe(before);
    expect(r.npc.stats.actors).toBe(0);
  });

  it('the driver can be ordered out by the stepOut command of a seated actor and stays out when the actor is removed', async () => {
    const { r, vids } = await carRig(2);
    const vid = vids[0] as number;
    const id = r.npc.stepOut(vid, 0);
    r.npc.removeActor(id);
    // Removed (transported): the seat stays empty while the car is there.
    expect(r.npc.isOut(vid, 0)).toBe(true);
    r.run(1);
    expect(r.npc.isActivePerson(r.npc.occupantsOf(vid)[0] as number)).toBe(false);
  });
});
