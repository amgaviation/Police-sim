import { afterAll, describe, expect, it } from 'vitest';
import { isNpcSave } from '../../src/npc/save';
import { ACTOR_STATE, type NpcSave } from '../../src/npc/types';
import { laneRef } from '../../src/world/roadGraph';
import { DOWNTOWN, cityOf, info, makeRig, spec, spotIn, stateOf, type NpcRig } from './helpers';

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

/** The same officer path for every rig: a slow walk in a circle, one position per step index. */
function drive(r: NpcRig, i: number): void {
  r.focus.x = P.x + Math.cos(i / 200) * 6;
  r.focus.z = P.z + Math.sin(i / 200) * 6;
  r.focus.yaw = i / 300;
  r.focus.speed = 0.6;
  r.run(1);
}

/** Sets up a busy scene: runners, an armed man, a cuffed follower, a hidden person, a crowd and a leaver. */
function scene(r: NpcRig): { runA: number; runB: number; armed: number; cuffed: number; hidden: number; crowd: number; leaver: number; dog: number } {
  const ids = {
    runA: r.npc.spawnActor(spec(4001, P.x + 8, P.z, { profile: 'callerHelpful' })),
    runB: r.npc.spawnActor(spec(4002, P.x - 8, P.z + 3, { profile: 'suspectCalm' })),
    armed: r.npc.spawnActor(spec(4003, P.x, P.z + 9, { profile: 'suspectArmedHostile', weapon: 'handgun' })),
    cuffed: r.npc.spawnActor(spec(4004, P.x + 2, P.z + 2, { profile: 'callerHelpful' })),
    hidden: r.npc.spawnActor(spec(4005, P.x + 40, P.z, { hidden: true })),
    crowd: r.npc.spawnActor(spec(4006, P.x + 30, P.z + 30, { profile: 'crowdMember' })),
    leaver: r.npc.spawnActor(spec(4007, P.x - 20, P.z, { profile: 'callerHelpful' })),
    dog: r.npc.spawnActor(spec(-1, P.x + 12, P.z + 12, { profile: 'animalDog', body: 'dog', role: 'dog' })),
  };
  r.npc.forceState(ids.runA, 'flee');
  r.npc.forceState(ids.runB, 'flee');
  r.npc.forceState(ids.armed, 'armed');
  r.npc.forceState(ids.cuffed, 'handsUp');
  r.npc.cuff(ids.cuffed);
  r.npc.follow(ids.cuffed, true);
  r.npc.forceState(ids.leaver, 'leave');
  return ids;
}

describe('NpcSave', () => {
  it('round trips through JSON and validates', async () => {
    const r = await rig();
    scene(r);
    for (let i = 0; i < 300; i++) drive(r, i);
    const save = r.npc.serialize();
    expect(isNpcSave(save)).toBe(true);
    const copy = JSON.parse(JSON.stringify(save)) as NpcSave;
    expect(copy).toEqual(save);
    expect(isNpcSave(copy)).toBe(true);
    expect(save.version).toBe(1);
    expect(save.peds.length).toBe(r.npc.stats.peds);
    expect(save.actors.length).toBe(8);
    expect(save.step).toBe(300 + 0);
    const a = save.actors.find((x) => x.id === 1);
    expect(a).toMatchObject({ personId: 4001, role: 'suspect', callId: 7, profile: 'callerHelpful', state: ACTOR_STATE.flee });
    expect(a?.route.length).toBeGreaterThanOrEqual(0);
    // Fresh and mid-run saves of a restored system are identical.
    const r2 = await rig();
    r2.npc.restore(copy);
    expect(r2.npc.serialize()).toEqual(save);
  });

  it('rejects malformed saves structurally', async () => {
    const r = await rig();
    scene(r);
    r.run(60);
    const good = JSON.parse(JSON.stringify(r.npc.serialize())) as Record<string, unknown>;
    expect(isNpcSave(good)).toBe(true);
    const bad = (mutate: (s: Record<string, unknown>) => void): boolean => {
      const s = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
      mutate(s);
      return isNpcSave(s);
    };
    expect(isNpcSave(null)).toBe(false);
    expect(isNpcSave([])).toBe(false);
    expect(isNpcSave({})).toBe(false);
    expect(bad((s) => (s.version = 2))).toBe(false);
    expect(bad((s) => delete s.rng)).toBe(false);
    expect(bad((s) => (s.rng = { seed: 1, s: [1, 2, 3] }))).toBe(false);
    expect(bad((s) => (s.pedsRng = { seed: 1, s: [1, 2, 3, -4] }))).toBe(false);
    expect(bad((s) => (s.step = 1.5))).toBe(false);
    expect(bad((s) => (s.peds = {}))).toBe(false);
    expect(bad((s) => ((s.peds as Record<string, unknown>[])[0]!.edge = 'x'))).toBe(false);
    expect(bad((s) => ((s.peds as Record<string, unknown>[])[0]!.speed = 0))).toBe(false);
    expect(bad((s) => ((s.actors as Record<string, unknown>[])[0]!.state = 99))).toBe(false);
    expect(bad((s) => ((s.actors as Record<string, unknown>[])[0]!.route = ['a']))).toBe(false);
    expect(bad((s) => ((s.actors as Record<string, unknown>[])[0]!.route = Array.from({ length: 66 }, () => 0)))).toBe(false);
    expect(bad((s) => ((s.actors as Record<string, unknown>[])[0]!.role = 4))).toBe(false);
    expect(bad((s) => (s.occupants = [[1, 'x']]))).toBe(false);
    expect(bad((s) => (s.out = [[1.5, [1]]]))).toBe(false);
    // The optional accumulators may be absent.
    expect(
      bad((s) => {
        for (const p of s.peds as Record<string, unknown>[]) delete p.acc;
        for (const a of s.actors as Record<string, unknown>[]) delete a.acc;
      }),
    ).toBe(true);
  });

  it('restore ignores an invalid save and drops entries that no longer fit', async () => {
    const r = await rig(0);
    scene(r);
    r.run(30);
    const before = JSON.stringify(r.npc.serialize());
    r.npc.restore({ version: 2 } as unknown as NpcSave);
    expect(JSON.stringify(r.npc.serialize())).toBe(before);
    const save = JSON.parse(before) as NpcSave;
    save.actors[0]!.profile = 'nope';
    save.actors[1]!.personId = 100000;
    save.actors[2]!.id = save.actors[3]!.id;
    save.actors[4]!.personId = save.actors[5]!.personId;
    save.peds.push({ personId: 12, edge: 999999, s: 0, side: 1, dir: 1, speed: 1.2, gait: 0, flee: 0 });
    const r2 = await rig(0);
    r2.npc.restore(save);
    expect(r2.npc.stats.actors).toBe(8 - 4);
    expect(r2.npc.actor(save.actors[0]!.id, info())).toBeNull();
    expect(r2.npc.stats.peds).toBe(0);
    // Ids continue after the highest restored one.
    const fresh = r2.npc.spawnActor(spec(9100, P.x, P.z));
    expect(fresh).toBeGreaterThanOrEqual(save.nextActorId);
  });

  it('keeps scenario occupants and stepped-out seats', async () => {
    const r = await rig(0);
    r.traffic.focus.x = P.x;
    r.traffic.focus.z = P.z;
    const near = r.city.graph.edgesNear(P.x, P.z, 30, []);
    const e = r.city.graph.edges[near[0] as number];
    expect(e).toBeDefined();
    r.traffic.sys.spawnAt(laneRef(e?.id ?? 0, 0, 0), (e?.length ?? 20) / 2, { vehicleId: 321, speed: 0 });
    r.npc.setOccupants(321, [7101, 7102, 7103]);
    r.run(1);
    const out = r.npc.stepOut(321, 1);
    expect(out).toBeGreaterThan(0);
    const save = JSON.parse(JSON.stringify(r.npc.serialize())) as NpcSave;
    expect(save.occupants).toEqual([[321, [7101, 7102, 7103]]]);
    expect(save.out).toEqual([[321, [1]]]);
    const r2 = await rig(0);
    r2.traffic.sys.spawnAt(laneRef(e?.id ?? 0, 0, 0), (e?.length ?? 20) / 2, { vehicleId: 321, speed: 0 });
    r2.npc.restore(save);
    expect(r2.npc.occupantsOf(321)).toEqual([7101, 7102, 7103]);
    expect(r2.npc.isOut(321, 1)).toBe(true);
    expect(r2.npc.isOut(321, 0)).toBe(false);
    expect(r2.npc.actorOfPerson(7102)).toBe(out);
    expect(r2.npc.actor(out, info())).toMatchObject({ vehicleId: 321, seat: 1 });
    r2.run(1);
    expect(r2.npc.stats.occupants).toBe(2);
  });
});

describe('save and restore mid-flee', () => {
  it('continues identically: pedestrians, runners, armed, cuffed follower, hidden, crowd, leaver', async () => {
    const a = await rig();
    const ids = scene(a);
    for (let i = 0; i < 420; i++) drive(a, i);
    // The scene is in motion: runners are on the way, nobody has been removed yet.
    expect(stateOf(a.npc, ids.runA)).toBe(ACTOR_STATE.flee);
    expect(a.npc.stats.actors).toBeGreaterThanOrEqual(7);
    const mid = JSON.parse(JSON.stringify(a.npc.serialize())) as NpcSave;
    expect(mid.actors.some((x) => x.state === ACTOR_STATE.flee && x.route.length > 0)).toBe(true);
    expect(mid.peds.length).toBeGreaterThan(40);

    const b = await rig();
    b.npc.restore(mid);
    expect(b.npc.serialize()).toEqual(mid);
    for (let i = 420; i < 1200; i++) {
      drive(a, i);
      drive(b, i);
      if (i % 97 === 0) {
        expect(b.npc.view.count).toBe(a.npc.view.count);
        for (let k = 0; k < a.npc.view.count; k++) {
          expect(b.npc.view.x[k]).toBe(a.npc.view.x[k]);
          expect(b.npc.view.z[k]).toBe(a.npc.view.z[k]);
          expect(b.npc.view.yaw[k]).toBe(a.npc.view.yaw[k]);
        }
      }
    }
    expect(JSON.stringify(b.npc.serialize())).toBe(JSON.stringify(a.npc.serialize()));
    // Different from a system that did not get the restore (the scene is not part of a fresh system).
    const c = await rig();
    expect(JSON.stringify(c.npc.serialize())).not.toBe(JSON.stringify(a.npc.serialize()));
  }, 120000);

  it('replays the same events after the restore', async () => {
    const a = await rig(0);
    scene(a);
    for (let i = 0; i < 300; i++) drive(a, i);
    const mid = JSON.parse(JSON.stringify(a.npc.serialize())) as NpcSave;
    const mark = Object.fromEntries(Object.entries(a.events).map(([k, v]) => [k, v.length]));
    const b = await rig(0);
    b.npc.restore(mid);
    for (let i = 300; i < 3000; i++) {
      drive(a, i);
      drive(b, i);
    }
    for (const topic of Object.keys(a.events)) {
      expect(b.events[topic]).toEqual((a.events[topic] ?? []).slice(mark[topic] ?? 0));
    }
    expect((a.events['npc:left'] ?? []).length + (a.events['npc:escaped'] ?? []).length).toBeGreaterThan(0);
  }, 120000);
});
