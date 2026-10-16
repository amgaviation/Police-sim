import { beforeEach, describe, expect, it } from 'vitest';
import { PhysicsBody, PrevTransform, Transform, Velocity } from '../../src/ecs/components';
import {
  SystemRegistry,
  builtinSystems,
  copyPrevTransform,
  integrateVelocity,
  type System,
} from '../../src/ecs/systems';
import { createGameWorld, spawn, type GameWorld } from '../../src/ecs/world';

describe('built-in systems', () => {
  let world: GameWorld;

  beforeEach(() => {
    world = createGameWorld();
  });

  it('integrateVelocity moves entities by velocity * dt', () => {
    const eid = spawn(world, Transform, Velocity);
    Transform.x[eid] = 1;
    Velocity.x[eid] = 10;
    Velocity.y[eid] = -2;
    Velocity.z[eid] = 4;

    integrateVelocity.run(world, 0.5);

    expect(Transform.x[eid]).toBeCloseTo(6);
    expect(Transform.y[eid]).toBeCloseTo(-1);
    expect(Transform.z[eid]).toBeCloseTo(2);
  });

  it('integrateVelocity skips entities tagged PhysicsBody or lacking Velocity', () => {
    const body = spawn(world, Transform, Velocity, PhysicsBody);
    const still = spawn(world, Transform);
    Velocity.x[body] = 10;

    integrateVelocity.run(world, 1);

    expect(Transform.x[body]).toBe(0);
    expect(Transform.x[still]).toBe(0);
  });

  it('copyPrevTransform snapshots Transform into PrevTransform', () => {
    const eid = spawn(world, Transform);
    Transform.x[eid] = 3;
    Transform.y[eid] = 4;
    Transform.qx[eid] = 0.7;
    Transform.qw[eid] = 0.2;

    copyPrevTransform.run(world, 1 / 60);

    expect(PrevTransform.x[eid]).toBeCloseTo(3);
    expect(PrevTransform.y[eid]).toBeCloseTo(4);
    expect(PrevTransform.qx[eid]).toBeCloseTo(0.7);
    expect(PrevTransform.qw[eid]).toBeCloseTo(0.2);
  });

  it('builtinSystems lists copyPrevTransform before integrateVelocity', () => {
    expect(builtinSystems.map((s) => s.name)).toEqual(['copyPrevTransform', 'integrateVelocity']);
  });
});

describe('SystemRegistry', () => {
  const log: string[] = [];
  const named = (name: string): System => ({
    name,
    run: () => {
      log.push(name);
    },
  });
  let registry: SystemRegistry;
  let world: GameWorld;

  beforeEach(() => {
    log.length = 0;
    registry = new SystemRegistry();
    world = createGameWorld();
  });

  it('runs systems in registration order by default', () => {
    registry.register(named('a'));
    registry.register(named('b'));
    registry.register(named('c'));
    registry.runAll(world, 0.016);
    expect(log).toEqual(['a', 'b', 'c']);
  });

  it('honours explicit order, with ties in registration order', () => {
    registry.register(named('late'), 100);
    registry.register(named('early'), -1);
    registry.register(named('mid1'), 5);
    registry.register(named('mid2'), 5);
    registry.runAll(world, 0.016);
    expect(log).toEqual(['early', 'mid1', 'mid2', 'late']);
    expect(registry.systems.map((s) => s.name)).toEqual(['early', 'mid1', 'mid2', 'late']);
  });

  it('disable skips a system and enable restores it', () => {
    registry.register(named('a'));
    registry.register(named('b'));
    registry.disable('a');
    expect(registry.isEnabled('a')).toBe(false);
    registry.runAll(world, 0.016);
    expect(log).toEqual(['b']);

    registry.enable('a');
    registry.runAll(world, 0.016);
    expect(log).toEqual(['b', 'a', 'b']);
  });

  it('throws when toggling an unknown system', () => {
    expect(() => {
      registry.disable('nope');
    }).toThrow(/Unknown system/);
    expect(registry.isEnabled('nope')).toBe(false);
  });

  it('records a timing per system that ran and zero for disabled ones', () => {
    registry.register(named('a'));
    registry.register(named('b'));
    registry.disable('b');
    registry.runAll(world, 0.016);
    expect(registry.timings.get('a')).toBeGreaterThanOrEqual(0);
    expect(registry.timings.get('b')).toBe(0);
  });

  it('re-registering by name replaces the system but keeps its slot', () => {
    registry.register(named('a'), 1);
    registry.register(named('b'), 2);
    registry.register(named('a'));
    registry.runAll(world, 0.016);
    expect(log).toEqual(['a', 'b']);
  });

  it('unregister removes a system and its timing', () => {
    registry.register(named('a'));
    registry.runAll(world, 0.016);
    expect(registry.unregister('a')).toBe(true);
    expect(registry.unregister('a')).toBe(false);
    expect(registry.has('a')).toBe(false);
    expect(registry.timings.has('a')).toBe(false);
  });

  it('passes world and dt through to systems', () => {
    let seen: { world: GameWorld; dt: number } | undefined;
    registry.register({
      name: 'probe',
      run(w, dt) {
        seen = { world: w, dt };
      },
    });
    registry.runAll(world, 0.25);
    expect(seen?.world).toBe(world);
    expect(seen?.dt).toBe(0.25);
  });
});
