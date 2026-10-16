import { hasComponent } from 'bitecs';
import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { EntityKind, KIND, PhysicsBody, Player, Transform } from '../../src/ecs/components';
import { createGameWorld, entityCount } from '../../src/ecs/world';
import { copyPrevTransform, SystemRegistry } from '../../src/ecs/systems';
import { PhysicsWorld } from '../../src/physics/physics';
import { MeshRegistry } from '../../src/render/meshSync';
import { CURRENT_SAVE_VERSION, isSaveGameV1, type SaveEnvelope, type SaveGameV1 } from '../../src/save/schema';
import { pyramidCount, PYRAMID_BASE, SCATTER_COUNT } from '../../src/game/sceneLayout';
import { GameSession, loadGame, serializeGame, startNewGame, type GameContext } from '../../src/game/testScene';

const DT = 1 / 60;

interface Harness {
  ctx: GameContext;
  registry: SystemRegistry;
  step(n: number, session: GameSession, input?: { forward: number; strafe: number; sprint: boolean }): void;
  dispose(): void;
}

async function harness(): Promise<Harness> {
  const world = createGameWorld();
  const physics = await PhysicsWorld.create({ x: 0, y: -9.81, z: 0 }, DT);
  physics.addGround(100, 0);
  const meshes = new MeshRegistry(new THREE.Scene(), { world, shadows: false });
  const registry = new SystemRegistry();
  registry.register(copyPrevTransform, -1000);
  registry.register({ name: 'physics', run: () => { physics.step(); physics.syncToEcs(Transform); } }, 100);
  const ctx = { world, physics, meshes };
  return {
    ctx,
    registry,
    step(n, session, input = { forward: 0, strafe: 0, sprint: false }) {
      for (let i = 0; i < n; i++) {
        session.fixedUpdate(input);
        registry.runAll(world, DT);
      }
    },
    dispose() {
      meshes.dispose();
      physics.dispose();
    },
  };
}

function snapshot(session: GameSession): number[] {
  const out: number[] = [];
  for (const eid of [session.player, ...session.boxes]) {
    out.push(Transform.x[eid] ?? 0, Transform.y[eid] ?? 0, Transform.z[eid] ?? 0, Transform.qw[eid] ?? 1);
  }
  return out;
}

function envelope(data: SaveGameV1): SaveEnvelope<SaveGameV1> {
  return { version: CURRENT_SAVE_VERSION, createdAt: 1, updatedAt: 1, slot: 't', data };
}

describe('testScene', () => {
  const live: Harness[] = [];
  beforeAll(async () => {
    await PhysicsWorld.create();
  });
  afterEach(() => {
    for (const h of live.splice(0)) h.dispose();
  });

  async function fresh(): Promise<Harness> {
    const h = await harness();
    live.push(h);
    return h;
  }

  it('startNewGame builds the player plus ~150 physics-backed, rendered boxes', async () => {
    const h = await fresh();
    const session = startNewGame(h.ctx, 42);
    const expected = pyramidCount(PYRAMID_BASE) + SCATTER_COUNT;
    expect(session.boxes).toHaveLength(expected);
    expect(session.entityCount).toBe(expected + 1);
    expect(entityCount(h.ctx.world)).toBe(expected + 1);
    expect(h.ctx.physics.bodyCount).toBe(expected + 1);
    expect(h.ctx.meshes.boxCount).toBe(expected + 1);
    expect(hasComponent(h.ctx.world, session.player, Player)).toBe(true);
    expect(hasComponent(h.ctx.world, session.player, PhysicsBody)).toBe(true);
    expect(EntityKind.kind[session.player]).toBe(KIND.Player);
    expect(EntityKind.kind[session.boxes[0] ?? 0]).toBe(KIND.Prop);
  });

  it('is deterministic: two sessions with the same seed match after 120 steps', async () => {
    const a = await fresh();
    const b = await fresh();
    const sa = startNewGame(a.ctx, 'patrol');
    const sb = startNewGame(b.ctx, 'patrol');
    expect(sa.seed).toBe(sb.seed);
    const initial = snapshot(sa);
    expect(initial).toEqual(snapshot(sb));
    a.step(120, sa);
    b.step(120, sb);
    expect(snapshot(sa)).toEqual(snapshot(sb));
    expect(snapshot(sa)).not.toEqual(initial); // the pile is actually simulating
  });

  it('moves the player with the kinematic body and keeps it on the ground plane', async () => {
    const h = await fresh();
    const session = startNewGame(h.ctx, 1);
    const z0 = Transform.z[session.player] ?? 0;
    const y0 = Transform.y[session.player] ?? 0;
    h.step(60, session, { forward: 1, strafe: 0, sprint: false });
    expect(Transform.z[session.player] ?? 0).toBeLessThan(z0 - 3);
    expect(Transform.y[session.player] ?? 0).toBeCloseTo(y0, 3);
  });

  it('serializes to a valid SaveGameV1 and reloads to the same transforms', async () => {
    const a = await fresh();
    const session = startNewGame(a.ctx, 42);
    a.step(90, session);
    session.spawnRandomBoxes(3);
    a.step(10, session);
    const data = serializeGame(session);
    expect(isSaveGameV1(data)).toBe(true);
    expect(data.seed).toBe(42);
    expect(data.world.entities).toHaveLength(session.entityCount);
    expect(data.world.entities[0]?.kind).toBe(KIND.Player);

    const b = await fresh();
    const loaded = loadGame(b.ctx, envelope(JSON.parse(JSON.stringify(data)) as SaveGameV1));
    expect(loaded.entityCount).toBe(session.entityCount);
    expect(loaded.seed).toBe(42);
    expect(loaded.clock.simTime).toBe(session.clock.simTime);
    const original = snapshot(session);
    const restored = snapshot(loaded);
    for (let i = 0; i < original.length; i++) expect(restored[i]).toBeCloseTo(original[i] ?? 0, 4);
    // The root generator continues where the saved one left off.
    expect(loaded.rng.next()).toBe(session.rng.next());
  });

  it('dispose removes every entity, body and mesh so a new game starts clean', async () => {
    const h = await fresh();
    const first = startNewGame(h.ctx, 5);
    first.dispose();
    expect(entityCount(h.ctx.world)).toBe(0);
    expect(h.ctx.physics.bodyCount).toBe(0);
    expect(h.ctx.meshes.count).toBe(0);
    expect(() => first.spawnBox({ x: 0, y: 1, z: 0 })).toThrow();
    const second = startNewGame(h.ctx, 5);
    expect(second.entityCount).toBe(pyramidCount(PYRAMID_BASE) + SCATTER_COUNT + 1);
  });

  it('seeds are normalized the same way as createRng', async () => {
    const h = await fresh();
    const session = startNewGame(h.ctx, 'alpha');
    expect(session.seed).toBe(createRng('alpha').seed);
  });
});
