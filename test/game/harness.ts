import * as THREE from 'three';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { Transform } from '../../src/ecs/components';
import { SystemRegistry, copyPrevTransform, integrateVelocity } from '../../src/ecs/systems';
import { clearWorld, createGameWorld, type GameWorld } from '../../src/ecs/world';
import type { MoveInput } from '../../src/game/playerController';
import { GameSession, createScenePhysics, loadGame, startNewGame, type GameContext } from '../../src/game/session';
import type { PhysicsWorld } from '../../src/physics/physics';
import { MeshRegistry } from '../../src/render/meshSync';
import { CURRENT_SAVE_VERSION, type SaveEnvelope, type SaveGame } from '../../src/save/schema';
import type { City } from '../../src/world/city';

export const DT = 1 / 60;
export const IDLE: MoveInput = { forward: 0, strafe: 0, sprint: false };

/**
 * Mirrors the app: one ECS world, mesh registry and system registry for the page, a fresh
 * physics world for every session (`reset()`), and the session's systems registered
 * next to copyPrevTransform, integrateVelocity and the physics step.
 */
export class Harness {
  readonly world: GameWorld = createGameWorld();
  readonly meshes: MeshRegistry;
  readonly registry = new SystemRegistry();
  readonly bus = new EventBus<EventMap>();
  physics: PhysicsWorld = createScenePhysics(DT);
  private readonly city: City | undefined;
  private detach: (() => void) | null = null;

  constructor(city?: City, boxPoolSize?: number) {
    this.city = city;
    this.meshes = new MeshRegistry(new THREE.Scene(), { world: this.world, shadows: false, boxPoolSize });
    this.registry.register(copyPrevTransform, -1000);
    this.registry.register(integrateVelocity, 0);
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
    return { world: this.world, physics: this.physics, meshes: this.meshes, bus: this.bus, city: this.city };
  }

  /** New game for `seed` with its systems registered. */
  start(seed: number | string): GameSession {
    return this.attach(startNewGame(this.ctx, seed));
  }

  /** Loaded game with its systems registered. */
  load(data: SaveGame): GameSession {
    return this.attach(loadGame(this.ctx, envelope(data)));
  }

  attach(session: GameSession): GameSession {
    this.detach?.();
    this.detach = session.attachSystems(this.registry);
    return session;
  }

  step(session: GameSession, n: number, input: MoveInput = IDLE): void {
    for (let i = 0; i < n; i++) {
      session.fixedUpdate(input);
      this.registry.runAll(this.world, DT);
    }
  }

  /** What App does between sessions: the old session's systems go, new physics world, cleared ECS world. */
  reset(session?: GameSession): void {
    session?.dispose();
    this.detach?.();
    this.detach = null;
    this.physics.dispose();
    this.physics = createScenePhysics(DT);
    clearWorld(this.world);
  }

  dispose(): void {
    this.detach?.();
    this.meshes.dispose();
    this.physics.dispose();
  }
}

export function envelope(data: SaveGame): SaveEnvelope<SaveGame> {
  return { version: CURRENT_SAVE_VERSION, createdAt: 1, updatedAt: 1, slot: 't', data };
}

/** JSON round trip, as IndexedDB structured clone would preserve (f32 values survive exactly). */
export function roundTrip(data: SaveGame): SaveGame {
  return JSON.parse(JSON.stringify(data)) as SaveGame;
}
