import { afterEach, describe, expect, it } from 'vitest';
import { Transform } from '../../src/ecs/components';
import { PhysicsWorld, type CollisionEvent } from '../../src/physics/physics';

const HALF = 0.5;
const worlds: PhysicsWorld[] = [];

async function makeWorld(): Promise<PhysicsWorld> {
  const world = await PhysicsWorld.create();
  worlds.push(world);
  return world;
}

function stepN(world: PhysicsWorld, n: number): void {
  for (let i = 0; i < n; i++) world.step();
}

afterEach(() => {
  for (const world of worlds.splice(0)) world.dispose();
});

describe('PhysicsWorld', () => {
  it('uses the fixed timestep and exposes the raw world', async () => {
    const world = await makeWorld();
    expect(world.fixedDt).toBe(1 / 60);
    // Rapier stores the timestep as f32.
    expect(world.raw.timestep).toBeCloseTo(1 / 60, 6);
    expect(world.raw.gravity.y).toBeCloseTo(-9.81, 6);
  });

  it('drops a box onto the ground and brings it to rest at y ~= halfExtent', async () => {
    const world = await makeWorld();
    world.addGround(50);
    const eid = 7;
    const body = world.addBox(eid, { x: 0, y: 5, z: 0 }, { x: HALF, y: HALF, z: HALF });

    stepN(world, 600);

    const pos = body.translation();
    expect(pos.y).toBeCloseTo(HALF, 1);
    expect(Math.abs(pos.y - HALF)).toBeLessThan(0.02);
    // Face-on-face landing may slide a hair during settling.
    expect(Math.abs(pos.x)).toBeLessThan(0.05);
    expect(Math.abs(pos.z)).toBeLessThan(0.05);
    expect(Math.abs(body.linvel().y)).toBeLessThan(1e-3);

    world.syncToEcs();
    expect(Transform.y[eid]).toBeCloseTo(HALF, 1);
    expect(Transform.qw[eid]).toBeCloseTo(1, 3);
  });

  it('syncToEcs writes into a caller-supplied store', async () => {
    const world = await makeWorld();
    const eid = 3;
    world.addSphere(eid, { x: 1, y: 2, z: 3 }, 0.25, { dynamic: false });
    const store = {
      x: new Float32Array(8),
      y: new Float32Array(8),
      z: new Float32Array(8),
      qx: new Float32Array(8),
      qy: new Float32Array(8),
      qz: new Float32Array(8),
      qw: new Float32Array(8),
    };
    world.step();
    world.syncToEcs(store);
    expect(store.x[eid]).toBeCloseTo(1, 5);
    expect(store.y[eid]).toBeCloseTo(2, 5);
    expect(store.z[eid]).toBeCloseTo(3, 5);
    expect(store.qw[eid]).toBeCloseTo(1, 5);
  });

  it('is deterministic: identical worlds produce identical positions', async () => {
    const build = async (): Promise<PhysicsWorld> => {
      const world = await makeWorld();
      world.addGround(50);
      world.addBox(1, { x: 0.3, y: 4, z: -0.2 }, { x: HALF, y: HALF, z: HALF });
      world.addSphere(2, { x: 0.1, y: 6, z: 0.1 }, 0.4, { mass: 2, restitution: 0.3 });
      world.getBody(1)?.setAngvel({ x: 1, y: 0.5, z: 0.25 }, true);
      return world;
    };
    const a = await build();
    const b = await build();

    stepN(a, 240);
    stepN(b, 240);

    for (const eid of [1, 2]) {
      const pa = a.getBody(eid)?.translation();
      const pb = b.getBody(eid)?.translation();
      const ra = a.getBody(eid)?.rotation();
      const rb = b.getBody(eid)?.rotation();
      expect(pa).toBeDefined();
      expect(pb).toBeDefined();
      expect([pa?.x, pa?.y, pa?.z]).toEqual([pb?.x, pb?.y, pb?.z]);
      expect([ra?.x, ra?.y, ra?.z, ra?.w]).toEqual([rb?.x, rb?.y, rb?.z, rb?.w]);
    }
  });

  it('removeBody stops tracking and stops syncing', async () => {
    const world = await makeWorld();
    const eid = 11;
    world.addBox(eid, { x: 0, y: 10, z: 0 }, { x: HALF, y: HALF, z: HALF });
    expect(world.has(eid)).toBe(true);
    expect(world.bodyCount).toBe(1);

    world.removeBody(eid);
    expect(world.has(eid)).toBe(false);
    expect(world.getBody(eid)).toBeUndefined();
    expect(world.bodyCount).toBe(0);

    Transform.y[eid] = -123;
    stepN(world, 10);
    world.syncToEcs();
    expect(Transform.y[eid]).toBe(-123);

    expect(() => {
      world.removeBody(eid);
    }).not.toThrow();
    expect(() => world.addBox(eid, { x: 0, y: 1, z: 0 }, { x: HALF, y: HALF, z: HALF })).not.toThrow();
  });

  it('rejects a second body for the same entity', async () => {
    const world = await makeWorld();
    world.addSphere(5, { x: 0, y: 1, z: 0 }, 0.5);
    expect(() => world.addSphere(5, { x: 0, y: 1, z: 0 }, 0.5)).toThrow(/already/);
  });

  it('castRay sees nothing before the first step, then hits the ground', async () => {
    const world = await makeWorld();
    world.addGround(50);
    expect(world.castRay({ x: 2, y: 10, z: -3 }, { x: 0, y: -1, z: 0 })).toBeNull();

    world.step();
    const hit = world.castRay({ x: 2, y: 10, z: -3 }, { x: 0, y: -1, z: 0 }, 100, true);
    expect(hit).not.toBeNull();
    expect(hit?.eid).toBeUndefined();
    expect(hit?.toi).toBeCloseTo(10, 4);
    expect(hit?.point.y).toBeCloseTo(0, 4);
    expect(hit?.point.x).toBeCloseTo(2, 4);
    expect(hit?.normal.y).toBeCloseTo(1, 4);
  });

  it('castRay reports the entity it hits and honours excludeEid', async () => {
    const world = await makeWorld();
    world.addGround(50);
    const eid = 9;
    world.addBox(eid, { x: 0, y: 2, z: 0 }, { x: HALF, y: HALF, z: HALF }, { dynamic: false });
    world.step();

    const hit = world.castRay({ x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 0 });
    expect(hit?.eid).toBe(eid);
    expect(hit?.toi).toBeCloseTo(7.5, 4);

    const behind = world.castRay({ x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, 100, true, eid);
    expect(behind?.eid).toBeUndefined();
    expect(behind?.toi).toBeCloseTo(10, 4);

    expect(world.castRay({ x: 0, y: 10, z: 0 }, { x: 0, y: 1, z: 0 })).toBeNull();
  });

  it('emits collision start events with entity ids', async () => {
    const world = await makeWorld();
    world.addGround(50);
    const eid = 4;
    world.addBox(eid, { x: 0, y: 1.5, z: 0 }, { x: HALF, y: HALF, z: HALF });
    const events: CollisionEvent[] = [];
    const off = world.onCollision((e) => events.push(e));

    stepN(world, 120);
    const started = events.find((e) => e.started);
    expect(started).toBeDefined();
    expect([started?.a, started?.b]).toContain(eid);
    expect([started?.a, started?.b]).toContain(undefined);

    off();
    const count = events.length;
    world.getBody(eid)?.applyImpulse({ x: 0, y: 50, z: 0 }, true);
    stepN(world, 60);
    expect(events.length).toBe(count);
  });

  it('throws after dispose', async () => {
    const world = await PhysicsWorld.create();
    world.dispose();
    world.dispose();
    expect(() => {
      world.step();
    }).toThrow(/disposed/);
  });
});
