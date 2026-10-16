import type { EntityId } from 'bitecs';
import { createRng, normalizeSeed, rngFromState, type Rng } from '../core/rng';
import { GameClock } from '../core/time';
import { EntityKind, KIND, PhysicsBody, Player, PrevTransform, Transform, copyTransformSlot } from '../ecs/components';
import { despawn, spawn, type GameWorld } from '../ecs/world';
import type { PhysicsWorld, Vec3 } from '../physics/physics';
import type { MeshRegistry } from '../render/meshSync';
import type { SaveEnvelope, SaveGameV1, SerializedEntity } from '../save/schema';
import { PlayerController, moveVelocity, yawFromQuaternion, yawQuaternion, type MoveInput } from './playerController';
import { BOX_SIZE, layoutScene, nextBoxColor } from './sceneLayout';

/** Engine services a session builds its entities into. */
export interface GameContext {
  world: GameWorld;
  physics: PhysicsWorld;
  meshes: MeshRegistry;
}

export const PLAYER_SIZE: Vec3 = { x: 0.8, y: 1.8, z: 0.8 };
export const PLAYER_COLOR = 0x1f3b6f;
const PLAYER_START: Vec3 = { x: 0, y: PLAYER_SIZE.y / 2, z: 6 };
const BOX_HALF: Vec3 = { x: BOX_SIZE / 2, y: BOX_SIZE / 2, z: BOX_SIZE / 2 };
const BOX_FRICTION = 0.8;

/** Officer placeholder until Phase 1 has a character setup screen. */
const DEFAULT_OFFICER = { name: 'Officer Doe', badge: '4071' };

const scratchVel: Vec3 = { x: 0, y: 0, z: 0 };
const scratchQuat = { x: 0, y: 0, z: 0, w: 1 };

/**
 * One playable demo: a kinematic player box and a pile of dynamic boxes.
 * Owns the entities it created and tears them down in `dispose()`.
 */
export class GameSession {
  readonly seed: number;
  /** Root generator; its state is persisted so spawns continue deterministically after a load. */
  readonly rng: Rng;
  readonly clock: GameClock;
  readonly controller = new PlayerController();
  officer: { name: string; badge: string };
  private readonly ctx: GameContext;
  private readonly colors: Rng;
  private playerEid: EntityId = 0;
  private readonly boxEids: EntityId[] = [];
  private disposed = false;

  constructor(ctx: GameContext, seed: number, rng: Rng = createRng(seed), clock: GameClock = new GameClock()) {
    this.ctx = ctx;
    this.seed = seed;
    this.rng = rng;
    this.clock = clock;
    this.colors = rng.stream('colors');
    this.officer = { ...DEFAULT_OFFICER };
  }

  get player(): EntityId {
    return this.playerEid;
  }

  /** Box entity ids in spawn order (the order they are serialized in). */
  get boxes(): readonly EntityId[] {
    return this.boxEids;
  }

  get entityCount(): number {
    return this.boxEids.length + (this.playerEid === 0 ? 0 : 1);
  }

  /** Creates the player at `position`, facing `yaw`. */
  spawnPlayer(position: Vec3 = PLAYER_START, yaw = 0): EntityId {
    this.assertLive();
    if (this.playerEid !== 0) throw new Error('Player already spawned');
    const { world, physics, meshes } = this.ctx;
    const eid = spawn(world, Transform, PrevTransform, Player, PhysicsBody);
    EntityKind.kind[eid] = KIND.Player;
    const body = physics.addBox(eid, position, { x: PLAYER_SIZE.x / 2, y: PLAYER_SIZE.y / 2, z: PLAYER_SIZE.z / 2 }, {
      kinematic: true,
      friction: 0.2,
    });
    body.setRotation(yawQuaternion(yaw, scratchQuat), true);
    this.controller.yaw = yaw;
    meshes.addBox(eid, { size: PLAYER_SIZE, color: PLAYER_COLOR });
    this.playerEid = eid;
    this.writeInitialTransform(eid);
    return eid;
  }

  /** Spawns one dynamic box; the colour comes from the seeded colour stream. */
  spawnBox(position: Vec3, rotation?: { x: number; y: number; z: number; w: number }): EntityId {
    this.assertLive();
    const { world, physics, meshes } = this.ctx;
    const eid = spawn(world, Transform, PrevTransform, PhysicsBody);
    EntityKind.kind[eid] = KIND.Prop;
    const body = physics.addBox(eid, position, BOX_HALF, { friction: BOX_FRICTION });
    if (rotation) body.setRotation(rotation, true);
    meshes.addBox(eid, { color: nextBoxColor(this.colors) });
    this.boxEids.push(eid);
    this.writeInitialTransform(eid);
    return eid;
  }

  /** Drops `count` boxes around the player using the root generator. */
  spawnRandomBoxes(count: number): EntityId[] {
    const spawned: EntityId[] = [];
    const px = Transform.x[this.playerEid] ?? 0;
    const pz = Transform.z[this.playerEid] ?? 0;
    for (let i = 0; i < count; i++) {
      spawned.push(
        this.spawnBox({
          x: px + this.rng.nextFloat(-4, 4),
          y: this.rng.nextFloat(4, 10),
          z: pz + this.rng.nextFloat(-4, 4),
        }),
      );
    }
    return spawned;
  }

  /** Drives the kinematic player body for one fixed step; call before the physics step. */
  fixedUpdate(input: MoveInput): void {
    const body = this.ctx.physics.getBody(this.playerEid);
    if (!body) return;
    const yaw = this.controller.yaw;
    body.setLinvel(moveVelocity(input, yaw, scratchVel), true);
    body.setRotation(yawQuaternion(yaw, scratchQuat), true);
  }

  /** Removes every entity, body and mesh the session created. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const { world, physics, meshes } = this.ctx;
    const all = this.playerEid === 0 ? this.boxEids : [this.playerEid, ...this.boxEids];
    for (const eid of all) {
      physics.removeBody(eid);
      meshes.remove(eid);
      despawn(world, eid);
    }
    this.boxEids.length = 0;
    this.playerEid = 0;
  }

  private writeInitialTransform(eid: EntityId): void {
    const body = this.ctx.physics.getBody(eid);
    if (!body) return;
    const t = body.translation();
    const r = body.rotation();
    Transform.x[eid] = t.x;
    Transform.y[eid] = t.y;
    Transform.z[eid] = t.z;
    Transform.qx[eid] = r.x;
    Transform.qy[eid] = r.y;
    Transform.qz[eid] = r.z;
    Transform.qw[eid] = r.w;
    copyTransformSlot(Transform, PrevTransform, eid);
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('GameSession has been disposed');
  }
}

/** Builds the deterministic demo scene for `seed` (the same seed always yields the same layout). */
export function startNewGame(ctx: GameContext, seed: number | string): GameSession {
  const normalized = normalizeSeed(seed);
  const session = new GameSession(ctx, normalized);
  session.spawnPlayer();
  for (const placement of layoutScene(session.rng.stream('scene'))) session.spawnBox(placement);
  return session;
}

function serializeEntity(eid: EntityId): SerializedEntity {
  return {
    kind: EntityKind.kind[eid] ?? KIND.None,
    x: Transform.x[eid] ?? 0,
    y: Transform.y[eid] ?? 0,
    z: Transform.z[eid] ?? 0,
    qx: Transform.qx[eid] ?? 0,
    qy: Transform.qy[eid] ?? 0,
    qz: Transform.qz[eid] ?? 0,
    qw: Transform.qw[eid] ?? 1,
  };
}

/** Snapshot of the session: seed, RNG state, clock and every entity transform (player first). */
export function serializeGame(session: GameSession): SaveGameV1 {
  const clock = session.clock.toJSON();
  const entities: SerializedEntity[] = [];
  if (session.player !== 0) entities.push(serializeEntity(session.player));
  for (const eid of session.boxes) entities.push(serializeEntity(eid));
  return {
    seed: session.seed,
    rngState: session.rng.state(),
    clock: { simTime: clock.simTime, timeScale: clock.timeScale },
    officer: { ...session.officer },
    world: { entities },
  };
}

/**
 * Rebuilds a session from a save: bodies are recreated at their saved
 * transforms (at rest; velocities are not persisted in schema v1).
 */
export function loadGame(ctx: GameContext, envelope: SaveEnvelope<SaveGameV1>): GameSession {
  const data = envelope.data;
  const clock = new GameClock().fromJSON({ simTime: data.clock.simTime, timeScale: data.clock.timeScale, paused: false });
  const session = new GameSession(ctx, normalizeSeed(data.seed), rngFromState(data.rngState), clock);
  session.officer = { ...data.officer };
  for (const e of data.world.entities) {
    const position = { x: e.x, y: e.y, z: e.z };
    const rotation = { x: e.qx, y: e.qy, z: e.qz, w: e.qw };
    if (e.kind === KIND.Player) {
      if (session.player === 0) session.spawnPlayer(position, yawFromQuaternion(rotation));
    } else if (e.kind === KIND.Prop) {
      session.spawnBox(position, rotation);
    }
  }
  if (session.player === 0) session.spawnPlayer();
  return session;
}
