import RAPIER from '@dimforge/rapier3d-compat';
import { afterEach, describe, expect, it } from 'vitest';
import { Transform } from '../../src/ecs/components';
import { PhysicsWorld, type CollisionEvent } from '../../src/physics/physics';

const worlds: PhysicsWorld[] = [];

async function makeWorld(): Promise<PhysicsWorld> {
  const world = await PhysicsWorld.create();
  worlds.push(world);
  return world;
}

afterEach(() => {
  for (const world of worlds.splice(0)) world.dispose();
});

describe('PhysicsWorld.registerBody', () => {
  it('maps an externally created body and all its colliders to the entity', async () => {
    const physics = await makeWorld();
    physics.addGround(50);
    const raw = physics.raw;
    const body = raw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(1, 3, -2));
    const a = raw.createCollider(
      RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      body,
    );
    const b = raw.createCollider(RAPIER.ColliderDesc.ball(0.3).setTranslation(0, 0.8, 0), body);
    const eid = 17;
    physics.registerBody(eid, body);

    expect(physics.has(eid)).toBe(true);
    expect(physics.getBody(eid)).toBe(body);
    expect(physics.bodyCount).toBe(1);
    expect(physics.eidOfBody(body.handle)).toBe(eid);
    expect(physics.eidOfCollider(a.handle)).toBe(eid);
    expect(physics.eidOfCollider(b.handle)).toBe(eid);
    expect(() => {
      physics.registerBody(eid, body);
    }).toThrow(/already/);

    const events: CollisionEvent[] = [];
    physics.onCollision((e) => events.push(e));
    for (let i = 0; i < 120; i++) physics.step();
    expect(events.some((e) => e.started && (e.a === eid || e.b === eid))).toBe(true);

    physics.syncToEcs();
    expect(Transform.x[eid]).toBeCloseTo(body.translation().x, 5);
    expect(Transform.y[eid]).toBeCloseTo(body.translation().y, 5);

    physics.removeBody(eid);
    expect(physics.bodyCount).toBe(0);
    expect(physics.eidOfCollider(a.handle)).toBeUndefined();
    expect(physics.eidOfBody(body.handle)).toBeUndefined();
    expect(raw.bodies.len()).toBe(0);
  });

  it('reports disposal', async () => {
    const physics = await PhysicsWorld.create();
    expect(physics.isDisposed).toBe(false);
    physics.dispose();
    expect(physics.isDisposed).toBe(true);
  });
});
