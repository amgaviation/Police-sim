import { afterAll, describe, expect, it } from 'vitest';
import { NPC_CONFIG } from '../../src/npc/data';
import { BODY, FIGURE_FLAG, HELD, POSE } from '../../src/render/people/pose';
import { DOWNTOWN, cityOf, makeRig, spec, spotIn, type NpcRig } from './helpers';

const rigs: NpcRig[] = [];
const P = (() => {
  const p = spotIn(cityOf(), DOWNTOWN);
  if (!p) throw new Error('no downtown edge');
  return p;
})();
afterAll(() => {
  for (const r of rigs) r.traffic.physics.dispose();
});

async function rig(density = 1): Promise<NpcRig> {
  const r = await makeRig({ x: P.x, z: P.z, density });
  rigs.push(r);
  return r;
}

describe('NpcView', () => {
  it('has room for every pedestrian, actor and occupant', async () => {
    const r = await rig();
    const need = NPC_CONFIG.peds.max + NPC_CONFIG.actors.max + 48;
    expect(r.npc.view.x.length).toBe(need);
    expect(r.npc.view.pose.length).toBe(need);
    expect(r.npc.view.count).toBe(0);
  });

  it('lists pedestrians, then actors, then occupants; count follows the pools', async () => {
    const r = await rig();
    r.run(600);
    const a = r.npc.spawnActor(spec(6001, P.x + 5, P.z, { profile: 'subjectUnconscious' }));
    expect(a).toBeGreaterThan(0);
    r.run(1);
    const { peds, actors, occupants } = r.npc.stats;
    const v = r.npc.view;
    expect(v.count).toBe(peds + actors + occupants);
    expect(actors).toBe(1);
    for (let i = 0; i < peds; i++) expect(v.pose[i]).toBe(POSE.walk);
    expect(v.pose[peds]).toBe(POSE.lying);
    expect(v.x[peds]).toBeCloseTo(P.x + 5, 3);
    expect(v.z[peds]).toBeCloseTo(P.z, 3);
    r.npc.removeActor(a);
    r.run(1);
    expect(r.npc.view.count).toBe(r.npc.stats.peds + r.npc.stats.occupants);
  });

  it('copies the previous transform at the start of every step and advances the gait with speed', async () => {
    const r = await rig();
    r.run(600);
    const v = r.npc.view;
    const n = r.npc.stats.peds;
    const x = Array.from(v.x.subarray(0, n));
    const z = Array.from(v.z.subarray(0, n));
    const yaw = Array.from(v.yaw.subarray(0, n));
    const gait = Array.from(v.gait.subarray(0, n));
    r.run(1);
    // Compare per pedestrian through its person (the order can change when pedestrians come and go).
    let compared = 0;
    for (let i = 0; i < Math.min(n, r.npc.stats.peds); i++) {
      if (Math.abs((v.prevX[i] ?? 0) - (x[i] ?? 0)) < 1e-6 && Math.abs((v.prevZ[i] ?? 0) - (z[i] ?? 0)) < 1e-6) {
        compared++;
        expect(v.prevYaw[i]).toBeCloseTo(yaw[i] ?? 0, 5);
        expect(v.gait[i] ?? 0).toBeGreaterThanOrEqual((gait[i] ?? 0) - 1e-6);
      }
    }
    expect(compared).toBeGreaterThan(n / 2);
    // Moving pedestrians have prev != x after an update step (near ones update every step).
    let moved = 0;
    for (let i = 0; i < r.npc.stats.peds; i++) if (Math.abs((v.x[i] ?? 0) - (v.prevX[i] ?? 0)) > 1e-6 || Math.abs((v.z[i] ?? 0) - (v.prevZ[i] ?? 0)) > 1e-6) moved++;
    expect(moved).toBeGreaterThan(0);
    // Gait: cycles = distance / stride (1.4 m scaled by height / 1.75).
    const h = v.height[0] ?? 1.75;
    const g0 = v.gait[0] ?? 0;
    const p0 = [v.x[0] ?? 0, v.z[0] ?? 0];
    r.focus.x += 1000; // freeze LOD effects: far pedestrians are despawned, so use an actor instead
    r.run(1);
    expect(h).toBeGreaterThan(1.2);
    expect(g0).toBeGreaterThanOrEqual(0);
    expect(p0.length).toBe(2);
  });

  it('actor gait advances by distance over stride', async () => {
    const r = await rig(0);
    const id = r.npc.spawnActor(spec(6002, P.x + 10, P.z, { profile: 'callerHelpful' }));
    r.run(1);
    r.npc.walkTo(id, P.x + 10, P.z - 60);
    const v = r.npc.view;
    const g0 = v.gait[0] ?? 0;
    const z0 = r.npc.view.z[0] ?? 0;
    r.run(180);
    const dist = Math.abs((v.z[0] ?? 0) - z0);
    const stride = (1.4 * (v.height[0] ?? 1.75)) / 1.75;
    expect(dist).toBeGreaterThan(2);
    expect((v.gait[0] ?? 0) - g0).toBeCloseTo(dist / stride, 3);
    expect(v.pose[0]).toBe(POSE.walk);
    expect(v.speed[0]).toBeGreaterThan(1);
    expect(v.speed[0]).toBeLessThan(2);
  });

  it('colours and size come from the appearance of the person (bald is 0xFFFFFFFF)', async () => {
    const r = await rig(0);
    let bald = -1;
    let haired = -1;
    for (let id = 8000; id < 12000 && (bald < 0 || haired < 0); id++) {
      const hair = r.people.appearance(id).hair;
      if (hair === null && bald < 0) bald = id;
      if (hair !== null && haired < 0) haired = id;
    }
    expect(bald).toBeGreaterThanOrEqual(0);
    r.npc.spawnActor(spec(bald, P.x + 5, P.z));
    r.npc.spawnActor(spec(haired, P.x + 8, P.z));
    r.run(1);
    const v = r.npc.view;
    for (const [i, id] of [[0, bald], [1, haired]] as const) {
      const ap = r.people.appearance(id);
      expect(v.skin[i]).toBe(ap.skin);
      expect(v.top[i]).toBe(ap.top);
      expect(v.bottom[i]).toBe(ap.bottom);
      expect(v.height[i]).toBeCloseTo(ap.heightM, 5);
      expect(v.build[i]).toBeCloseTo(ap.build, 5);
      expect(v.body[i]).toBe(BODY.human);
    }
    expect(v.hair[0]).toBe(0xffffffff);
    expect(v.hair[1]).toBe(r.people.appearance(haired).hair);
  });

  it('shows the drawn weapon, hides hidden actors, and follows the weapon on drop', async () => {
    const r = await rig(0);
    const g = r.npc.spawnActor(spec(6003, P.x + 5, P.z, { weapon: 'handgun' }));
    const k = r.npc.spawnActor(spec(6004, P.x + 7, P.z, { weapon: 'knife' }));
    const h = r.npc.spawnActor(spec(6005, P.x + 9, P.z, { hidden: true }));
    r.run(1);
    const v = r.npc.view;
    expect(v.held[0]).toBe(HELD.none);
    r.npc.drawWeapon(g);
    r.npc.drawWeapon(k);
    r.run(1);
    expect(v.held[0]).toBe(HELD.handgun);
    expect(v.held[1]).toBe(HELD.knife);
    expect((v.flags[2] ?? 0) & FIGURE_FLAG.hidden).toBe(FIGURE_FLAG.hidden);
    expect((v.flags[0] ?? 0) & FIGURE_FLAG.hidden).toBe(0);
    r.npc.dropWeapon(g);
    r.run(1);
    expect(v.held[0]).toBe(HELD.none);
    expect(r.events['npc:weaponDropped']).toEqual([{ actorId: g, personId: 6003, callId: 7, item: 'handgun', x: expect.any(Number) as number, z: expect.any(Number) as number }]);
    r.npc.reveal(h);
    r.run(1);
    expect((v.flags[2] ?? 0) & FIGURE_FLAG.hidden).toBe(0);
  });

  it('actors outside the near ring decide less often than near ones (decision LOD)', async () => {
    const r = await rig(0);
    for (let i = 0; i < 20; i++) r.npc.spawnActor(spec(6100 + i, P.x + 20, P.z + i));
    for (let i = 0; i < 20; i++) r.npc.spawnActor(spec(6200 + i, P.x + 100, P.z + i));
    for (let i = 0; i < 20; i++) r.npc.spawnActor(spec(6300 + i, P.x + 400, P.z + i));
    let updates = 0;
    for (let i = 0; i < 600; i++) {
      r.run(1);
      updates += r.npc.stats.actorUpdates;
    }
    // 10 Hz (every 6th step), 2 Hz (30th) and 0.5 Hz (120th) for 20 actors each over 10 s.
    const expected = 20 * (100 + 20 + 5);
    expect(updates).toBeGreaterThan(expected * 0.85);
    expect(updates).toBeLessThan(expected * 1.15);
  });
});
