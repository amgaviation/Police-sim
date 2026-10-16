import { hasComponent } from 'bitecs';
import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { EntityKind, KIND, PhysicsBody, Player, Transform } from '../../src/ecs/components';
import { clearWorld, createGameWorld, entityCount, type GameWorld } from '../../src/ecs/world';
import { copyPrevTransform, SystemRegistry } from '../../src/ecs/systems';
import { PhysicsWorld, initRapier } from '../../src/physics/physics';
import { MeshRegistry } from '../../src/render/meshSync';
import { CURRENT_SAVE_VERSION, isSaveGame, type SaveEnvelope, type SaveGame } from '../../src/save/schema';
import { BOX_SIZE, pyramidCount, PYRAMID_BASE, SCATTER_COUNT } from '../../src/game/sceneLayout';
import {
  GameSession,
  createScenePhysics,
  loadGame,
  serializeGame,
  startNewGame,
  type GameContext,
} from '../../src/game/testScene';
import type { MoveInput } from '../../src/game/playerController';

const DT = 1 / 60;
const IDLE: MoveInput = { forward: 0, strafe: 0, sprint: false };
const SCENE_SIZE = pyramidCount(PYRAMID_BASE) + SCATTER_COUNT + 1;
const STEPS_AFTER_LOAD = 10;

/**
 * Mirrors the app: one ECS world and mesh registry for the page, and a fresh
 * physics world for every session (`reset()`), stepped by the same systems.
 */
class Harness {
  readonly world: GameWorld = createGameWorld();
  readonly meshes: MeshRegistry;
  readonly registry = new SystemRegistry();
  physics: PhysicsWorld = createScenePhysics(DT);

  constructor(boxPoolSize?: number) {
    this.meshes = new MeshRegistry(new THREE.Scene(), { world: this.world, shadows: false, boxPoolSize });
    this.registry.register(copyPrevTransform, -1000);
    this.registry.register(
      {
        name: 'physics',
        run: () => {
          this.physics.step();
          this.physics.syncToEcs(Transform);
        },
      },
      100,
    );
  }

  get ctx(): GameContext {
    return { world: this.world, physics: this.physics, meshes: this.meshes };
  }

  /** What App does between sessions: new physics world, cleared ECS world. */
  reset(): void {
    this.physics.dispose();
    this.physics = createScenePhysics(DT);
    clearWorld(this.world);
  }

  step(n: number, session: GameSession, input: MoveInput = IDLE): void {
    for (let i = 0; i < n; i++) {
      session.fixedUpdate(input);
      this.registry.runAll(this.world, DT);
    }
  }

  dispose(): void {
    this.meshes.dispose();
    this.physics.dispose();
  }
}

/**
 * Translation, rotation and velocities read from the session's own rigid
 * bodies (not the shared, module-level Transform store), copied out.
 */
function snapshot(session: GameSession): number[] {
  const out: number[] = [];
  for (const eid of [session.player, ...session.boxes]) {
    const body = session.physics.getBody(eid);
    if (!body) throw new Error(`no body for ${String(eid)}`);
    const t = body.translation();
    const r = body.rotation();
    const v = body.linvel();
    const w = body.angvel();
    out.push(t.x, t.y, t.z, r.x, r.y, r.z, r.w, v.x, v.y, v.z, w.x, w.y, w.z);
  }
  return out;
}

/** Only the translations from a `snapshot`. */
function positions(s: readonly number[]): number[] {
  return s.filter((_, i) => i % 13 < 3);
}

function maxDiff(a: readonly number[], b: readonly number[]): number {
  expect(a).toHaveLength(b.length);
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return max;
}

function envelope(data: SaveGame): SaveEnvelope<SaveGame> {
  return { version: CURRENT_SAVE_VERSION, createdAt: 1, updatedAt: 1, slot: 't', data };
}

/** JSON round trip, as IndexedDB structured clone would preserve (f32 values survive exactly). */
function roundTrip(data: SaveGame): SaveGame {
  return JSON.parse(JSON.stringify(data)) as SaveGame;
}

describe('testScene', () => {
  const live: Harness[] = [];
  beforeAll(async () => {
    await initRapier();
  });
  afterEach(() => {
    for (const h of live.splice(0)) h.dispose();
  });

  function fresh(boxPoolSize?: number): Harness {
    const h = new Harness(boxPoolSize);
    live.push(h);
    return h;
  }

  it('startNewGame builds the player plus ~150 physics-backed, rendered boxes', () => {
    const h = fresh();
    const session = startNewGame(h.ctx, 42);
    expect(session.boxes).toHaveLength(SCENE_SIZE - 1);
    expect(session.entityCount).toBe(SCENE_SIZE);
    expect(entityCount(h.world)).toBe(SCENE_SIZE);
    expect(h.physics.bodyCount).toBe(SCENE_SIZE);
    expect(h.meshes.boxCount).toBe(SCENE_SIZE);
    expect(hasComponent(h.world, session.player, Player)).toBe(true);
    expect(hasComponent(h.world, session.player, PhysicsBody)).toBe(true);
    expect(EntityKind.kind[session.player]).toBe(KIND.Player);
    expect(EntityKind.kind[session.boxes[0] ?? 0]).toBe(KIND.Prop);
  });

  it('replays the same seed and inputs exactly in a later session of the same page', () => {
    const h = fresh();
    const input: MoveInput = { forward: 1, strafe: 0, sprint: true };
    const first = startNewGame(h.ctx, 42);
    const initial = snapshot(first);
    h.step(600, first, input);
    const run1 = snapshot(first);
    expect(maxDiff(run1, initial)).toBeGreaterThan(1); // the pile was actually pushed around
    first.dispose();

    h.reset();
    const second = startNewGame(h.ctx, 42);
    expect(snapshot(second)).toEqual(initial);
    h.step(600, second, input);
    expect(snapshot(second)).toEqual(run1);
  });

  it('a different seed produces a different run', () => {
    const h = fresh();
    const a = startNewGame(h.ctx, 1);
    h.step(60, a);
    const runA = snapshot(a);
    a.dispose();
    h.reset();
    const b = startNewGame(h.ctx, 2);
    h.step(60, b);
    expect(snapshot(b)).not.toEqual(runA);
  });

  it('resets world time for each session and restores it on load', () => {
    const h = fresh();
    const first = startNewGame(h.ctx, 1);
    h.step(500, first);
    expect(h.world.time.step).toBe(500);
    expect(first.clock.simTime).toBeCloseTo(500 * DT, 9);
    expect(h.world.time.elapsed).toBe(first.clock.simTime);
    const data = serializeGame(first);
    first.dispose();

    h.reset();
    const second = startNewGame(h.ctx, 1);
    expect(h.world.time).toEqual({ dt: 0, elapsed: 0, step: 0 });
    second.dispose();

    h.reset();
    loadGame(h.ctx, envelope(roundTrip(data)));
    expect(h.world.time.step).toBe(500);
    expect(h.world.time.elapsed).toBe(data.clock.simTime);
  });

  it('moves the player with the kinematic body and keeps it on the ground plane', () => {
    const h = fresh();
    const session = startNewGame(h.ctx, 1);
    const z0 = Transform.z[session.player] ?? 0;
    const y0 = Transform.y[session.player] ?? 0;
    h.step(60, session, { forward: 1, strafe: 0, sprint: false });
    expect(Transform.z[session.player] ?? 0).toBeLessThan(z0 - 3);
    expect(Transform.y[session.player] ?? 0).toBeCloseTo(y0, 3);
  });

  it('serializes to a valid save and reloads every body with its transform and motion', () => {
    const h = fresh();
    const session = startNewGame(h.ctx, 42);
    h.step(90, session);
    session.spawnRandomBoxes(3);
    session.controller.pitch = 0.7;
    h.step(10, session);
    const original = snapshot(session); // taken before anything else touches the shared stores
    const data = serializeGame(session);
    expect(isSaveGame(data)).toBe(true);
    expect(data.seed).toBe(42);
    expect(data.world.entities).toHaveLength(session.entityCount);
    expect(data.world.entities[0]?.kind).toBe(KIND.Player);
    expect(data.world.entities.some((e) => Math.abs(e.vy) > 0.1)).toBe(true); // the new boxes are falling

    const other = fresh();
    const loaded = loadGame(other.ctx, envelope(roundTrip(data)));
    expect(loaded.entityCount).toBe(session.entityCount);
    expect(loaded.seed).toBe(42);
    expect(loaded.clock.simTime).toBe(session.clock.simTime);
    expect(loaded.controller.pitch).toBe(0.7);
    expect(snapshot(loaded)).toEqual(original);
    // The root generator continues where the saved one left off.
    expect(loaded.rng.next()).toBe(session.rng.next());
  });

  it('a game loaded mid-motion continues far closer to the original than one loaded at rest', () => {
    const h = fresh();
    const session = startNewGame(h.ctx, 42);
    const push: MoveInput = { forward: 1, strafe: 0, sprint: true };
    h.step(400, session, push); // the player ploughs into the pile
    const data = roundTrip(serializeGame(session));
    h.step(STEPS_AFTER_LOAD, session, push);
    const continued = positions(snapshot(session));

    const resume = (save: SaveGame): number => {
      const other = fresh();
      const loaded = loadGame(other.ctx, envelope(save));
      other.step(STEPS_AFTER_LOAD, loaded, push);
      return maxDiff(positions(snapshot(loaded)), continued);
    };
    const atRest: SaveGame = {
      ...data,
      world: { entities: data.world.entities.map((e) => ({ ...e, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, sleeping: false })) },
    };
    // Solver warm-start caches are not part of a save, so a pile under load does
    // not continue bit-identically; restoring the motion state still keeps it far closer.
    expect(resume(data)).toBeLessThan(resume(atRest) / 2);
  });

  it('a pile saved asleep stays asleep and in place after loading', () => {
    const h = fresh();
    const session = startNewGame(h.ctx, 42);
    h.step(900, session);
    const sleeping = (s: GameSession): number => s.boxes.filter((eid) => s.physics.getBody(eid)?.isSleeping()).length;
    expect(sleeping(session)).toBe(session.boxes.length);
    const data = roundTrip(serializeGame(session));

    const other = fresh();
    const loaded = loadGame(other.ctx, envelope(data));
    expect(loaded.clock.simTime).toBe(session.clock.simTime);
    expect(other.world.time.step).toBe(h.world.time.step);
    other.step(1, loaded);
    h.step(1, session);
    expect(sleeping(loaded)).toBe(loaded.boxes.length);
    other.step(120, loaded);
    h.step(120, session);
    expect(sleeping(loaded)).toBe(loaded.boxes.length);
    // The sleeping pile does not move at all; allow 1 mm for platform float noise.
    expect(maxDiff(positions(snapshot(loaded)), positions(snapshot(session)))).toBeLessThan(1e-3);
  });

  it('loading while the player is about to hit a sleeping pile restores the saved state unchanged', () => {
    const h = fresh();
    const session = startNewGame(h.ctx, 42);
    h.step(900, session); // the pile falls asleep
    const push: MoveInput = { forward: 1, strafe: 0, sprint: true };
    let worst = 0;
    for (let k = 0; k < 100; k++) {
      h.step(1, session, push);
      const data = roundTrip(serializeGame(session));
      const other = fresh();
      const reloaded = roundTrip(serializeGame(loadGame(other.ctx, envelope(data))));
      data.world.entities.forEach((e, i) => {
        const f = reloaded.world.entities[i];
        if (!f) throw new Error(`missing entity ${String(i)}`);
        expect(f.sleeping).toBe(e.sleeping);
        for (const key of ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw'] as const) worst = Math.max(worst, Math.abs(e[key] - f[key]));
      });
      other.dispose();
      live.splice(live.indexOf(other), 1);
    }
    expect(worst).toBeLessThan(1e-3);
  });

  it('saves the camera yaw even when it turned without a fixed step', () => {
    const h = fresh();
    const session = startNewGame(h.ctx, 42);
    session.controller.lookByMouse(500, -40); // what App.update does under `timescale 0` or console pause
    const yaw = session.controller.yaw;
    const pitch = session.controller.pitch;
    expect(Math.abs(yaw)).toBeGreaterThan(0.5);
    const loaded = loadGame(fresh().ctx, envelope(roundTrip(serializeGame(session))));
    expect(loaded.controller.yaw).toBeCloseTo(yaw, 6);
    expect(loaded.controller.pitch).toBe(pitch);
  });

  it('a save taken mid-fall reproduces the fall', () => {
    const h = fresh();
    const session = startNewGame(h.ctx, 9);
    session.spawnRandomBoxes(5);
    h.step(20, session);
    const data = roundTrip(serializeGame(session));
    h.step(30, session);
    const continued = snapshot(session);
    const other = fresh();
    const loaded = loadGame(other.ctx, envelope(data));
    other.step(30, loaded);
    expect(maxDiff(positions(snapshot(loaded)), positions(continued))).toBeLessThan(0.01);
  });

  it('dispose removes every entity, body and mesh so a new game starts clean', () => {
    const h = fresh();
    const first = startNewGame(h.ctx, 5);
    first.dispose();
    expect(entityCount(h.world)).toBe(0);
    expect(h.physics.bodyCount).toBe(0);
    expect(h.meshes.count).toBe(0);
    expect(() => first.spawnBox({ x: 0, y: 1, z: 0 })).toThrow();
    const second = startNewGame(h.ctx, 5);
    expect(second.entityCount).toBe(SCENE_SIZE);
  });

  it('a full box pool fails a spawn cleanly without leaking an entity or body', () => {
    const h = fresh(3);
    const session = new GameSession(h.ctx, 1);
    session.spawnPlayer();
    session.spawnBox({ x: 0, y: 1, z: 0 });
    session.spawnBox({ x: 2, y: 1, z: 0 });
    expect(() => session.spawnBox({ x: 4, y: 1, z: 0 })).toThrow(RangeError);
    expect(entityCount(h.world)).toBe(3);
    expect(h.physics.bodyCount).toBe(3);
    session.dispose();
    expect(entityCount(h.world)).toBe(0);
    expect(h.physics.bodyCount).toBe(0);
    expect(h.meshes.count).toBe(0);
  });

  it('spawnRandomBoxes stops at the pool capacity', () => {
    const h = fresh(10);
    const session = new GameSession(h.ctx, 1);
    session.spawnPlayer();
    expect(session.spawnRandomBoxes(50)).toHaveLength(9);
    expect(session.boxCapacityLeft).toBe(0);
    expect(session.spawnRandomBoxes(1)).toHaveLength(0);
    expect(h.physics.bodyCount).toBe(10);
  });

  it('spawnRandomBoxes never drops a box into another one, even on repeated calls', () => {
    const h = fresh(600);
    const session = startNewGame(h.ctx, 42);
    const first = session.spawnRandomBoxes(200);
    const second = session.spawnRandomBoxes(200);
    expect(first).toHaveLength(200);
    expect(second).toHaveLength(200);
    const fresh400 = [...first, ...second];
    const centre = (eid: number) => {
      const t = session.physics.getBody(eid)?.translation();
      if (!t) throw new Error('no body');
      return t;
    };
    for (const eid of fresh400) {
      const a = centre(eid);
      for (const other of session.boxes) {
        if (other === eid) continue;
        const b = centre(other);
        expect(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z))).toBeGreaterThanOrEqual(BOX_SIZE);
      }
    }
    // The lattice starts above the scene and is centred on the player.
    const player = centre(session.player);
    const xs = first.map((eid) => centre(eid).x);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(player.x, 0);
  });

  it('a scene too big for the pool is rolled back entirely', () => {
    const h = fresh(20);
    expect(() => startNewGame(h.ctx, 1)).toThrow(RangeError);
    expect(entityCount(h.world)).toBe(0);
    expect(h.physics.bodyCount).toBe(0);
    expect(h.meshes.count).toBe(0);
  });

  it('seeds are normalized the same way as createRng', () => {
    const h = fresh();
    const session = startNewGame(h.ctx, 'alpha');
    expect(session.seed).toBe(createRng('alpha').seed);
  });
});
