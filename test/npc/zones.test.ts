import { afterAll, describe, expect, it } from 'vitest';
import { pointInPolygon } from '../../src/npc/geometry';
import { ACTOR_STATE, type NoGoZone } from '../../src/npc/types';
import { DOWNTOWN, cityOf, makeRig, spec, spotIn, stateOf, type NpcRig } from './helpers';

const rigs: NpcRig[] = [];
const P = (() => {
  const p = spotIn(cityOf(), DOWNTOWN);
  if (!p) throw new Error('no downtown edge');
  return p;
})();

afterAll(() => {
  for (const r of rigs) r.traffic.physics.dispose();
});

/** A square zone of half-size `h` around (cx, cz). */
function square(id: number, cx: number, cz: number, h: number): NoGoZone {
  return { id, points: new Float32Array([cx - h, cz - h, cx + h, cz - h, cx + h, cz + h, cx - h, cz + h]), minX: cx - h, minZ: cz - h, maxX: cx + h, maxZ: cz + h };
}

describe('pointInPolygon', () => {
  const tri = new Float32Array([0, 0, 10, 0, 0, 10]);
  it('tells inside from outside, convex and concave', () => {
    expect(pointInPolygon(tri, 2, 2)).toBe(true);
    expect(pointInPolygon(tri, 8, 8)).toBe(false);
    expect(pointInPolygon(tri, -1, 5)).toBe(false);
    // An L shape: the notch is outside.
    const ell = new Float32Array([0, 0, 10, 0, 10, 4, 4, 4, 4, 10, 0, 10]);
    expect(pointInPolygon(ell, 2, 8)).toBe(true);
    expect(pointInPolygon(ell, 8, 2)).toBe(true);
    expect(pointInPolygon(ell, 8, 8)).toBe(false);
    expect(pointInPolygon(new Float32Array(0), 1, 1)).toBe(false);
  });
});

describe('no-go zones', () => {
  it('keep pedestrians out over 2000 steps, including ones that were inside when the zone appeared', async () => {
    const r = await makeRig({ x: P.x, z: P.z, density: 3 });
    rigs.push(r);
    r.run(240);
    expect(r.npc.stats.peds).toBeGreaterThan(5);
    const zone = square(1, P.x, P.z, 60);
    // Pedestrians exist inside the future zone.
    let inside = 0;
    for (let i = 0; i < r.npc.stats.peds; i++) if (pointInPolygon(zone.points, r.npc.view.x[i] as number, r.npc.view.z[i] as number)) inside++;
    expect(inside).toBeGreaterThan(0);
    r.npc.setNoGoZones([zone]);
    let seen = 0;
    let violations = 0;
    for (let step = 0; step < 2000; step++) {
      r.run(1);
      const n = r.npc.stats.peds;
      seen += n;
      for (let i = 0; i < n; i++) {
        if (pointInPolygon(zone.points, r.npc.view.x[i] as number, r.npc.view.z[i] as number)) violations++;
      }
    }
    expect(seen).toBeGreaterThan(2000);
    expect(violations).toBe(0);
    // Without the zone they come back in.
    r.npc.setNoGoZones([]);
    let back = 0;
    for (let step = 0; step < 2000 && back === 0; step++) {
      r.run(1);
      for (let i = 0; i < r.npc.stats.peds; i++) if (pointInPolygon(zone.points, r.npc.view.x[i] as number, r.npc.view.z[i] as number)) back++;
    }
    expect(back).toBeGreaterThan(0);
  });

  it('pedestrians turn away at the edge instead of standing still', async () => {
    const r = await makeRig({ x: P.x, z: P.z, density: 3 });
    rigs.push(r);
    r.run(120);
    r.npc.setNoGoZones([square(2, P.x, P.z, 40)]);
    r.run(600);
    expect(r.npc.stats.peds).toBeGreaterThan(5);
    let moving = 0;
    for (let i = 0; i < r.npc.stats.peds; i++) if ((r.npc.view.speed[i] as number) > 0.1) moving++;
    expect(moving).toBeGreaterThan(0);
  });

  it('ambient actors inside a zone leave, scene participants stay', async () => {
    const r = await makeRig({ x: P.x, z: P.z, density: 0 });
    rigs.push(r);
    const ambient = r.npc.spawnActor(spec(5000, P.x + 30, P.z, { profile: 'callerHelpful', callId: 0, role: 'resident' }));
    const scene = r.npc.spawnActor(spec(5001, P.x + 31, P.z, { profile: 'callerHelpful', callId: 9, role: 'witness' }));
    const outside = r.npc.spawnActor(spec(5002, P.x + 200, P.z, { profile: 'callerHelpful', callId: 0 }));
    r.npc.setNoGoZones([square(3, P.x + 30, P.z, 10)]);
    r.run(120);
    expect(stateOf(r.npc, ambient)).toBe(ACTOR_STATE.leave);
    expect(stateOf(r.npc, scene)).toBe(ACTOR_STATE.idle);
    expect(stateOf(r.npc, outside)).toBe(ACTOR_STATE.idle);
    for (let i = 0; i < 4000 && (r.events['npc:left']?.length ?? 0) === 0; i++) r.run(1);
    expect(r.events['npc:left']).toEqual([{ actorId: ambient, personId: 5000, callId: 0 }]);
    expect(r.npc.actorOfPerson(5001)).toBe(scene);
  });

  it('a cuffed ambient actor is not sent away', async () => {
    const r = await makeRig({ x: P.x, z: P.z, density: 0 });
    rigs.push(r);
    const id = r.npc.spawnActor(spec(5010, P.x + 1.5, P.z, { profile: 'suspectCalm', callId: 0 }));
    r.npc.forceState(id, 'handsUp');
    expect(r.npc.cuff(id)).toBe('ok');
    r.npc.setNoGoZones([square(4, P.x, P.z, 20)]);
    r.run(120);
    expect(stateOf(r.npc, id)).toBe(ACTOR_STATE.cuffed);
  });
});
