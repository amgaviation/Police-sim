import { hasComponent } from 'bitecs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EntityKind,
  KIND,
  Player,
  PrevTransform,
  Transform,
  Velocity,
} from '../../src/ecs/components';
import {
  NULL_ENTITY,
  advanceTime,
  clearWorld,
  createGameWorld,
  despawn,
  entityCount,
  spawn,
  type GameWorld,
} from '../../src/ecs/world';

describe('world', () => {
  let world: GameWorld;

  beforeEach(() => {
    world = createGameWorld();
  });

  it('creates a world with a zeroed clock', () => {
    expect(world.time).toEqual({ dt: 0, elapsed: 0, step: 0 });
  });

  it('spawn attaches the given components and never returns the null entity', () => {
    const eid = spawn(world, Transform, Velocity, Player);
    expect(eid).not.toBe(NULL_ENTITY);
    expect(hasComponent(world, eid, Transform)).toBe(true);
    expect(hasComponent(world, eid, Velocity)).toBe(true);
    expect(hasComponent(world, eid, Player)).toBe(true);
    expect(hasComponent(world, eid, PrevTransform)).toBe(false);
  });

  it('despawn recycles the id and the recycled slot carries no stale data', () => {
    const a = spawn(world, Transform, Velocity, EntityKind);
    Transform.x[a] = 12;
    Transform.qw[a] = 0.5;
    PrevTransform.z[a] = -3;
    Velocity.y[a] = 9;
    EntityKind.kind[a] = KIND.Vehicle;

    despawn(world, a);
    const b = spawn(world, Transform);

    expect(b).toBe(a);
    expect(hasComponent(world, b, Velocity)).toBe(false);
    expect(Transform.x[b]).toBe(0);
    expect(Transform.qw[b]).toBe(1);
    expect(PrevTransform.z[b]).toBe(0);
    expect(PrevTransform.qw[b]).toBe(1);
    expect(Velocity.y[b]).toBe(0);
    expect(EntityKind.kind[b]).toBe(KIND.None);
  });

  it('despawn of a dead id is a no-op', () => {
    const eid = spawn(world);
    despawn(world, eid);
    expect(() => {
      despawn(world, eid);
    }).not.toThrow();
    expect(entityCount(world)).toBe(0);
  });

  it('entityCount tracks spawns and despawns', () => {
    expect(entityCount(world)).toBe(0);
    const ids = [spawn(world), spawn(world), spawn(world)];
    expect(entityCount(world)).toBe(3);
    despawn(world, ids[1] ?? NULL_ENTITY);
    expect(entityCount(world)).toBe(2);
    spawn(world);
    expect(entityCount(world)).toBe(3);
  });

  it('clearWorld removes all entities, resets slots and the clock', () => {
    const eid = spawn(world, Transform);
    Transform.x[eid] = 5;
    advanceTime(world, 0.5);
    advanceTime(world, 0.5);
    expect(world.time).toEqual({ dt: 0.5, elapsed: 1, step: 2 });

    clearWorld(world);

    expect(entityCount(world)).toBe(0);
    expect(world.time).toEqual({ dt: 0, elapsed: 0, step: 0 });
    expect(Transform.x[eid]).toBe(0);
    const fresh = spawn(world, Transform);
    expect(hasComponent(world, fresh, Transform)).toBe(true);
    expect(entityCount(world)).toBe(1);
  });

  it('advanceTime accumulates elapsed time and steps', () => {
    advanceTime(world, 1 / 60);
    advanceTime(world, 1 / 60);
    expect(world.time.dt).toBeCloseTo(1 / 60);
    expect(world.time.elapsed).toBeCloseTo(2 / 60);
    expect(world.time.step).toBe(2);
  });
});
