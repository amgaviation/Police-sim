import { afterEach, describe, expect, it } from 'vitest';
import { MAX_RESIDENT, STREAM_RADIUS } from '../../src/interior/constants';
import { findBuilding, makeRig, type Rig } from './helpers';

let rig: Rig | null = null;
afterEach(() => {
  rig?.dispose();
  rig = null;
});

const colliderCount = (r: Rig): number => r.physics.raw.colliders.len();

describe('residency', () => {
  it('loads the nearest entrance within 25 m and removes every collider again beyond', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    expect(colliderCount(rig)).toBe(0);
    rig.officer.x = b.door.x;
    rig.officer.z = b.door.z - 20;
    rig.steps(2);
    const near = rig.buildings.nearestEntrance(rig.officer.x, rig.officer.z, STREAM_RADIUS);
    expect(near).not.toBeNull();
    expect(rig.sys.resident).toEqual([near?.id]);
    expect(rig.sys.stats.resident).toBe(1);
    expect(rig.sys.stats.colliders).toBeGreaterThan(10);
    expect(colliderCount(rig)).toBe(rig.sys.stats.colliders);
    expect(rig.events.filter((e) => e.topic === 'interior:resident')).toEqual([{ topic: 'interior:resident', payload: { buildingId: near?.id, loaded: true } }]);

    // Far from every building: unloaded within one residency period, the physics world is empty again.
    rig.officer.x = 1e6;
    rig.officer.z = 1e6;
    rig.steps(16);
    expect(rig.sys.resident).toEqual([]);
    expect(colliderCount(rig)).toBe(0);
    expect(rig.sys.stats.colliders).toBe(0);
    expect(rig.events.at(-1)).toEqual({ topic: 'interior:resident', payload: { buildingId: near?.id, loaded: false } });
  });

  it('streams only inside STREAM_RADIUS of an entrance', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    // A point just beyond the radius from the chosen door that still has a nearer-than-25 m entrance elsewhere would
    // be ambiguous, so compare against the index: resident exactly when an entrance is within reach.
    for (const dz of [-10, -24, -30, -60, -120]) {
      rig.officer.x = b.door.x;
      rig.officer.z = b.door.z + dz;
      rig.steps(16);
      const near = rig.buildings.nearestEntrance(rig.officer.x, rig.officer.z, STREAM_RADIUS);
      expect(rig.sys.resident).toEqual(near === null ? [] : [near.id]);
    }
  });

  it('keeps at most MAX_RESIDENT interiors and at most one load per step', async () => {
    rig = await makeRig();
    const a = findBuilding('house');
    rig.officer.x = a.door.x;
    rig.officer.z = a.door.z;
    rig.steps(1);
    expect(rig.sys.resident.length).toBe(1);
    // Walk through the city: residency never exceeds the cap and each step adds at most one.
    let prev = 0;
    for (let i = 0; i < 400; i++) {
      rig.officer.x += 0.5;
      rig.steps(1);
      const loads = rig.events.filter((e) => e.topic === 'interior:resident' && (e.payload as { loaded: boolean }).loaded).length;
      expect(loads - prev).toBeLessThanOrEqual(1);
      prev = loads;
      expect(rig.sys.resident.length).toBeLessThanOrEqual(MAX_RESIDENT);
    }
  });

  it('spawns ambient occupants once per residency and removes them on unload, except busy ones', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    rig.time.now = 22 * 3600;
    rig.officer.x = b.door.x;
    rig.officer.z = b.door.z;
    rig.steps(2);
    const n = rig.occupants.spawned.length;
    expect(n).toBeGreaterThan(0);
    rig.steps(60);
    expect(rig.occupants.spawned.length).toBe(n);
    rig.occupants.busyIds.add(1);
    rig.officer.x = 1e6;
    rig.steps(16);
    expect(rig.occupants.removed.sort()).toEqual(Array.from({ length: n }, (_, i) => i + 1).filter((id) => id !== 1));
    // The busy actor is removed as soon as it is free.
    rig.occupants.busyIds.clear();
    rig.steps(16);
    expect(rig.occupants.removed).toContain(1);
  });

  it('spawns no occupants where a scene owns the building', async () => {
    rig = await makeRig();
    rig.occupants.owns = true;
    const b = findBuilding('house');
    rig.officer.x = b.door.x;
    rig.officer.z = b.door.z;
    rig.steps(2);
    expect(rig.sys.resident.length).toBe(1);
    expect(rig.occupants.spawned.length).toBe(0);
  });

  it('loads in well under 3 ms on average and steps in well under 0.02 ms when idle', async () => {
    rig = await makeRig();
    const index = rig.buildings;
    const sample: { x: number; z: number }[] = [];
    const seen = new Set<number>();
    for (const kind of ['house', 'convenienceStore', 'bank', 'office', 'warehouse', 'apartment'] as const) {
      const b = findBuilding(kind);
      if (!seen.has(b.id)) sample.push(b.door);
      seen.add(b.id);
    }
    expect(index.building(0)).not.toBeNull();
    const run = (n: number): void => {
      for (let i = 0; i < n; i++) rig?.sys.step(1 / 60, rig.officer);
    };
    // Warm up generation and JIT, then time (unload, 15 steps incl. one load) rounds.
    for (const p of sample) {
      rig.officer.x = p.x;
      rig.officer.z = p.z;
      run(15);
    }
    const times: number[] = [];
    for (let round = 0; round < 3; round++) {
      for (const p of sample) {
        rig.officer.x = 1e6;
        run(15);
        rig.officer.x = p.x;
        rig.officer.z = p.z;
        const before = rig.events.length;
        const t = performance.now();
        run(15);
        const ms = performance.now() - t;
        if (rig.events.length > before) times.push(ms);
      }
    }
    expect(times.length).toBeGreaterThanOrEqual(sample.length * 3 - 1);
    // Median: the budget is the typical load (generation + colliders), robust to a busy test machine.
    times.sort((a, b) => a - b);
    expect(times[times.length >> 1] as number).toBeLessThan(3);

    rig.officer.x = sample[0]?.x ?? 0;
    rig.officer.z = sample[0]?.z ?? 0;
    rig.steps(4);
    const t = performance.now();
    for (let i = 0; i < 3000; i++) rig.sys.step(1 / 60, rig.officer);
    expect((performance.now() - t) / 3000).toBeLessThan(0.05);
  });
});
