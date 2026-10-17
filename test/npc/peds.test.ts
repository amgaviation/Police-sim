import { afterAll, describe, expect, it } from 'vitest';
import type { PersonPick } from '../../src/npc/types';
import { NPC_CONFIG } from '../../src/npc/data';
import { BODY, POSE } from '../../src/render/people/pose';
import { DISTRICT } from '../../src/world/roadGraph';
import { DOWNTOWN, NIGHT, NOON, cityOf, info, makeRig, spotIn, spec, type NpcRig } from './helpers';

const rigs: NpcRig[] = [];
async function rig(options: Parameters<typeof makeRig>[0] = {}): Promise<NpcRig> {
  const r = await makeRig(options);
  rigs.push(r);
  return r;
}
afterAll(() => {
  for (const r of rigs) r.traffic.physics.dispose();
});

function downtown(): { x: number; z: number } {
  const p = spotIn(cityOf(), DOWNTOWN);
  if (!p) throw new Error('no downtown edge');
  return p;
}

describe('pedestrian determinism', () => {
  it('two systems with the same seed and focus path serialize identically; another seed differs', async () => {
    const p = downtown();
    const run = async (seed: number): Promise<string> => {
      const r = await rig({ seed, x: p.x, z: p.z });
      for (let i = 0; i < 400; i++) {
        r.focus.x = p.x + i * 0.05;
        r.focus.z = p.z;
        r.run(1);
      }
      return JSON.stringify(r.npc.serialize());
    };
    const a = await run(77);
    const b = await run(77);
    expect(a).toBe(b);
    expect(a).toContain('"peds":[{');
    const c = await run(78);
    expect(c).not.toBe(a);
  }, 60000);
});

describe('density', () => {
  it('follows the district and the hour (downtown noon > downtown night > rural)', async () => {
    const city = cityOf();
    const count = async (district: number, start: number): Promise<{ n: number; target: number }> => {
      const p = spotIn(city, district as 0);
      if (!p) throw new Error(`no edge in district ${district}`);
      const r = await rig({ x: p.x, z: p.z, start });
      r.run(600);
      return { n: r.npc.stats.peds, target: r.npc.targetPeds };
    };
    const noon = await count(DOWNTOWN, NOON);
    const night = await count(DOWNTOWN, NIGHT);
    const rural = await count(DISTRICT.rural, NOON);
    expect(noon.n).toBeGreaterThan(40);
    expect(noon.n).toBeLessThanOrEqual(NPC_CONFIG.peds.max);
    expect(noon.target).toBeGreaterThan(night.target);
    expect(noon.n).toBeGreaterThan(night.n);
    expect(night.n).toBeGreaterThan(rural.n);
  }, 60000);

  it('thins out when the density multiplier drops and clears on demand', async () => {
    const p = downtown();
    const r = await rig({ x: p.x, z: p.z });
    r.run(600);
    const full = r.npc.stats.peds;
    expect(full).toBeGreaterThan(40);
    r.npc.setDensityScale(0);
    r.run(900);
    expect(r.npc.stats.peds).toBeLessThan(full / 2);
    r.npc.clearPeds();
    r.run(1);
    expect(r.npc.stats.peds).toBe(0);
    expect(r.npc.view.count).toBe(0);
  }, 60000);
});

describe('pedestrian rules', () => {
  it('spawns outside minSpawnM, never twice the same person, and walks along sidewalks', async () => {
    const p = downtown();
    const r = await rig({ x: p.x, z: p.z });
    r.run(1);
    const v = r.npc.view;
    const n = r.npc.stats.peds;
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      expect(Math.hypot((v.x[i] ?? 0) - p.x, (v.z[i] ?? 0) - p.z)).toBeGreaterThanOrEqual(NPC_CONFIG.peds.minSpawnM - 1);
    }
    r.run(900);
    const persons = new Set<number>();
    let total = 0;
    const pick: PersonPick = { kind: 'ped', id: 0, seat: 0, personId: 0, distance: 0 };
    for (let i = 0; i < r.npc.stats.peds; i++) {
      // Every pedestrian is a distinct, active person (nearestPerson at its own spot finds a ped).
      const q = r.npc.nearestPerson(v.x[i] ?? 0, v.z[i] ?? 0, 0, 0.5, -1, pick);
      expect(q).not.toBeNull();
      expect(r.npc.isActivePerson(pick.personId)).toBe(true);
      persons.add(pick.personId);
      total++;
      expect(v.pose[i]).toBe(POSE.walk);
      expect(v.body[i]).toBe(BODY.human);
    }
    expect(persons.size).toBe(total);
    // Pedestrians moved at walking speed.
    let moving = 0;
    for (let i = 0; i < r.npc.stats.peds; i++) if ((v.speed[i] ?? 0) > 0.9 && (v.speed[i] ?? 0) < 1.7) moving++;
    expect(moving).toBe(r.npc.stats.peds);
  }, 60000);

  it('keeps juveniles off the street at night', async () => {
    const p = downtown();
    const r = await rig({ x: p.x, z: p.z, start: NIGHT });
    r.npc.setDensityScale(8);
    r.run(900);
    expect(r.npc.stats.peds).toBeGreaterThan(5);
    const pick: PersonPick = { kind: 'ped', id: 0, seat: 0, personId: 0, distance: 0 };
    for (let i = 0; i < r.npc.stats.peds; i++) {
      r.npc.nearestPerson(r.npc.view.x[i] ?? 0, r.npc.view.z[i] ?? 0, 0, 0.5, -1, pick);
      expect(r.people.identity(pick.personId).juvenile).toBe(false);
    }
  }, 60000);

  it('LOD: near pedestrians update every step, far ones a tenth of the steps', async () => {
    const p = downtown();
    const r = await rig({ x: p.x, z: p.z });
    r.run(600);
    const v = r.npc.view;
    const n = r.npc.stats.peds;
    let near = 0;
    let far = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot((v.x[i] ?? 0) - p.x, (v.z[i] ?? 0) - p.z);
      if (d < NPC_CONFIG.peds.lod.nearM) near++;
      else if (d >= NPC_CONFIG.peds.lod.midM) far++;
    }
    // Count the updates over 60 steps.
    let updates = 0;
    for (let i = 0; i < 60; i++) {
      r.run(1);
      updates += r.npc.stats.pedUpdates;
    }
    const mid = n - near - far;
    const expected = near * 60 + (mid * 60) / NPC_CONFIG.peds.lod.midEvery + (far * 60) / NPC_CONFIG.peds.lod.farEvery;
    expect(Math.abs(updates - expected)).toBeLessThan(expected * 0.25 + 40);
    expect(updates).toBeLessThan(n * 60);
    expect(near).toBeGreaterThan(0);
  }, 60000);

  it('runs away from a drawn weapon for ten seconds', async () => {
    const p = downtown();
    const r = await rig({ x: p.x, z: p.z });
    r.run(600);
    const v = r.npc.view;
    // Stand next to a pedestrian and draw: everyone within 20 m switches to the run pose and moves away.
    r.focus.x = v.x[0] ?? 0;
    r.focus.z = (v.z[0] ?? 0) + 2;
    r.run(1);
    const near = (): number[] => {
      const out: number[] = [];
      for (let i = 0; i < r.npc.stats.peds; i++) if (Math.hypot((v.x[i] ?? 0) - r.focus.x, (v.z[i] ?? 0) - r.focus.z) < 18) out.push(i);
      return out;
    };
    const before = near();
    expect(before.length).toBeGreaterThan(0);
    r.focus.weapon = 'sidearm';
    r.run(2);
    const dist = new Map<number, number>();
    const persons: number[] = [];
    const pick: PersonPick = { kind: 'ped', id: 0, seat: 0, personId: 0, distance: 0 };
    for (const i of before) {
      expect(v.pose[i]).toBe(POSE.run);
      expect(v.speed[i]).toBeGreaterThan(4);
      r.npc.nearestPerson(v.x[i] ?? 0, v.z[i] ?? 0, 0, 0.5, -1, pick);
      persons.push(pick.personId);
      dist.set(pick.personId, pick.distance);
    }
    // Five seconds later they are farther away (those still around).
    r.run(60 * 5);
    let farther = 0;
    let seen = 0;
    for (let i = 0; i < r.npc.stats.peds; i++) {
      r.npc.nearestPerson(v.x[i] ?? 0, v.z[i] ?? 0, 0, 0.5, -1, pick);
      if (!persons.includes(pick.personId)) continue;
      seen++;
      if (Math.hypot((v.x[i] ?? 0) - r.focus.x, (v.z[i] ?? 0) - r.focus.z) > 18) farther++;
    }
    expect(seen).toBeGreaterThan(0);
    expect(farther / seen).toBeGreaterThan(0.6);
    // Weapon away: after the ten seconds nobody runs.
    r.focus.weapon = 'none';
    r.focus.x += 500;
    r.run(60 * 12);
    let running = 0;
    for (let i = 0; i < r.npc.stats.peds; i++) if (v.pose[i] === POSE.run) running++;
    expect(running).toBe(0);
  }, 60000);
});

describe('promotePedestrian', () => {
  it('turns a pedestrian into a bystander actor at its place and keeps the person unique', async () => {
    const p = downtown();
    const r = await rig({ x: p.x, z: p.z });
    r.run(600);
    const v = r.npc.view;
    const before = r.npc.stats.peds;
    const slot = 3;
    const x = v.x[slot] ?? 0;
    const z = v.z[slot] ?? 0;
    const pick: PersonPick = { kind: 'ped', id: 0, seat: 0, personId: 0, distance: 0 };
    r.npc.nearestPerson(x, z, 0, 0.5, -1, pick);
    expect(pick.kind).toBe('ped');
    const id = r.npc.promotePedestrian(slot);
    expect(id).toBeGreaterThan(0);
    const a = r.npc.actor(id, info());
    expect(a?.profile).toBe('bystander');
    expect(a?.personId).toBe(pick.personId);
    expect(Math.hypot((a?.x ?? 0) - x, (a?.z ?? 0) - z)).toBeLessThan(0.01);
    expect(r.npc.actorOfPerson(pick.personId)).toBe(id);
    expect(r.npc.isActivePerson(pick.personId)).toBe(true);
    r.run(1);
    expect(r.npc.stats.peds).toBeLessThanOrEqual(before);
    expect(r.npc.stats.actors).toBe(1);
    expect(r.npc.promotePedestrian(9999)).toBe(0);
    expect(r.npc.promotePedestrian(-1)).toBe(0);
  }, 60000);

  it('spawnActor of a pedestrian person takes it out of the pedestrian pool', async () => {
    const p = downtown();
    const r = await rig({ x: p.x, z: p.z });
    r.run(600);
    const pick: PersonPick = { kind: 'ped', id: 0, seat: 0, personId: 0, distance: 0 };
    r.npc.nearestPerson(r.npc.view.x[0] ?? 0, r.npc.view.z[0] ?? 0, 0, 0.5, -1, pick);
    const peds = r.npc.stats.peds;
    const id = r.npc.spawnActor(spec(pick.personId, p.x + 3, p.z + 3));
    expect(id).toBeGreaterThan(0);
    r.run(1);
    expect(r.npc.stats.peds).toBeLessThanOrEqual(peds);
    // The same person again returns the same actor.
    expect(r.npc.spawnActor(spec(pick.personId, p.x, p.z))).toBe(id);
    expect(r.npc.stats.actors).toBe(1);
  }, 60000);
});
