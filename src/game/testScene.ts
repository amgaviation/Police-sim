import type { EntityId } from 'bitecs';
import { createRng, normalizeSeed, rngFromState, type Rng } from '../core/rng';
import { GameClock } from '../core/time';
import { EntityKind, KIND, PhysicsBody, Player, PrevTransform, Transform, copyTransformSlot } from '../ecs/components';
import { advanceTime, despawn, spawn, type GameWorld } from '../ecs/world';
import { PhysicsWorld, type Vec3 } from '../physics/physics';
import type { MeshRegistry } from '../render/meshSync';
import type { SaveEnvelope, SaveGame, SerializedEntity } from '../save/schema';
import { PlayerController, moveVelocity, yawFromQuaternion, yawQuaternion, type MoveInput } from './playerController';
import { BOX_SIZE, layoutDropLattice, layoutScene, nextBoxColor } from './sceneLayout';

/** Engine services a session builds its entities into. */
export interface GameContext {
  world: GameWorld;
  physics: PhysicsWorld;
  meshes: MeshRegistry;
}

/** Rigid-body motion state restored onto a spawned body (saves). */
export interface BodyMotion {
  linvel: Vec3;
  angvel: Vec3;
  sleeping: boolean;
}

interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export const GRAVITY: Vec3 = { x: 0, y: -9.81, z: 0 };
export const GROUND_HALF_SIZE = 100;
export const PLAYER_SIZE: Vec3 = { x: 0.8, y: 1.8, z: 0.8 };
export const PLAYER_COLOR = 0x1f3b6f;
const PLAYER_START: Vec3 = { x: 0, y: PLAYER_SIZE.y / 2, z: 6 };
const BOX_HALF: Vec3 = { x: BOX_SIZE / 2, y: BOX_SIZE / 2, z: BOX_SIZE / 2 };
const BOX_FRICTION = 0.8;
/** Lowest box centre of a `spawnRandomBoxes` drop (clears the player). */
const DROP_MIN_Y = 4;
/** Vertical distance kept between the highest existing box centre and a new drop. */
const DROP_CLEARANCE = 2 * BOX_SIZE;

/** Officer placeholder until Phase 1 has a character setup screen. */
const DEFAULT_OFFICER = { name: 'Officer Doe', badge: '4071' };

const scratchVel: Vec3 = { x: 0, y: 0, z: 0 };
const scratchQuat: Quat = { x: 0, y: 0, z: 0, w: 1 };

/**
 * A fresh physics world for one session: gravity plus the ground slab.
 * Rapier does not return to a pristine state after bodies are removed, so
 * every session needs its own world for the same seed to replay identically.
 * Requires `initRapier()` to have resolved.
 */
export function createScenePhysics(fixedDt: number): PhysicsWorld {
  const physics = PhysicsWorld.createSync(GRAVITY, fixedDt);
  physics.addGround(GROUND_HALF_SIZE, 0);
  return physics;
}

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

  /** Also rewinds the world clock to match `clock` (one world step per fixed step of simulated time). */
  constructor(ctx: GameContext, seed: number, rng: Rng = createRng(seed), clock: GameClock = new GameClock()) {
    this.ctx = ctx;
    this.seed = seed;
    this.rng = rng;
    this.clock = clock;
    this.colors = rng.stream('colors');
    this.officer = { ...DEFAULT_OFFICER };
    const time = ctx.world.time;
    time.dt = 0;
    time.elapsed = clock.simTime;
    time.step = Math.round(clock.simTime / ctx.physics.fixedDt);
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

  /** Physics world the session's bodies live in. */
  get physics(): PhysicsWorld {
    return this.ctx.physics;
  }

  /** Creates the player at `position`, facing `yaw`. */
  spawnPlayer(position: Vec3 = PLAYER_START, yaw = 0, motion?: BodyMotion): EntityId {
    this.assertLive();
    if (this.playerEid !== 0) throw new Error('Player already spawned');
    const half = { x: PLAYER_SIZE.x / 2, y: PLAYER_SIZE.y / 2, z: PLAYER_SIZE.z / 2 };
    const eid = this.spawnBody(KIND.Player, yawQuaternion(yaw, { x: 0, y: 0, z: 0, w: 1 }), motion, (id) => {
      this.ctx.physics.addBox(id, position, half, { kinematic: true, friction: 0.2 });
      this.ctx.meshes.addBox(id, { size: PLAYER_SIZE, color: PLAYER_COLOR });
    });
    this.controller.yaw = yaw;
    this.playerEid = eid;
    return eid;
  }

  /**
   * Spawns one dynamic box; the colour comes from the seeded colour stream.
   * Throws `RangeError` (spawning nothing) when the render pool is full.
   */
  spawnBox(position: Vec3, rotation?: Quat, motion?: BodyMotion): EntityId {
    this.assertLive();
    if (this.ctx.meshes.freeBoxSlots === 0) {
      throw new RangeError(`Box pool is full (${String(this.ctx.meshes.boxCapacity)} instances)`);
    }
    const eid = this.spawnBody(KIND.Prop, rotation, motion, (id) => {
      this.ctx.physics.addBox(id, position, BOX_HALF, { friction: BOX_FRICTION });
      this.ctx.meshes.addBox(id, { color: nextBoxColor(this.colors) });
    });
    this.boxEids.push(eid);
    return eid;
  }

  /** Boxes that can still be spawned before the render pool is full. */
  get boxCapacityLeft(): number {
    return this.ctx.meshes.freeBoxSlots;
  }

  /**
   * Drops up to `count` boxes over the player on a non-overlapping lattice
   * (jittered by the root generator) that starts above every existing box,
   * stopping when the render pool is full. Returns the spawned ids.
   */
  spawnRandomBoxes(count: number): EntityId[] {
    const n = Math.min(count, this.boxCapacityLeft);
    if (n <= 0) return [];
    const player = this.ctx.physics.getBody(this.playerEid)?.translation() ?? { x: 0, y: 0, z: 0 };
    let topY = DROP_MIN_Y - DROP_CLEARANCE;
    for (const eid of this.boxEids) {
      const y = this.ctx.physics.getBody(eid)?.translation().y;
      if (y !== undefined && y > topY) topY = y;
    }
    const placements = layoutDropLattice(this.rng, n, player.x, player.z, topY + DROP_CLEARANCE);
    return placements.map((placement) => this.spawnBox(placement));
  }

  /**
   * Advances the session by one fixed step of simulated time (clock and world
   * time) and drives the kinematic player body. Call before the physics step.
   */
  fixedUpdate(input: MoveInput): void {
    const dt = this.ctx.physics.fixedDt;
    advanceTime(this.ctx.world, dt);
    this.clock.addSimTime(dt);
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
    const all = this.playerEid === 0 ? this.boxEids : [this.playerEid, ...this.boxEids];
    for (const eid of all) this.removeEntity(eid);
    this.boxEids.length = 0;
    this.playerEid = 0;
  }

  /**
   * Creates the entity, then `attach` adds its body and mesh. Either all of
   * it exists afterwards or, if any step throws, none of it does.
   */
  private spawnBody(
    kind: number,
    rotation: Quat | undefined,
    motion: BodyMotion | undefined,
    attach: (eid: EntityId) => void,
  ): EntityId {
    const { world, physics } = this.ctx;
    const eid =
      kind === KIND.Player
        ? spawn(world, Transform, PrevTransform, Player, PhysicsBody)
        : spawn(world, Transform, PrevTransform, PhysicsBody);
    try {
      EntityKind.kind[eid] = kind;
      attach(eid);
      const body = physics.getBody(eid);
      if (!body) throw new Error(`Entity ${String(eid)} has no physics body`);
      if (rotation) body.setRotation(rotation, true);
      if (motion) {
        body.setLinvel(motion.linvel, true);
        body.setAngvel(motion.angvel, true);
        if (motion.sleeping) body.sleep();
      }
    } catch (error) {
      this.removeEntity(eid);
      throw error;
    }
    this.writeInitialTransform(eid);
    return eid;
  }

  private removeEntity(eid: EntityId): void {
    this.ctx.physics.removeBody(eid);
    this.ctx.meshes.remove(eid);
    despawn(this.ctx.world, eid);
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
  try {
    session.spawnPlayer();
    for (const placement of layoutScene(session.rng.stream('scene'))) session.spawnBox(placement);
  } catch (error) {
    session.dispose();
    throw error;
  }
  return session;
}

/** Reads the entity's state from its rigid body (the per-world source of truth). */
function serializeEntity(physics: PhysicsWorld, eid: EntityId): SerializedEntity {
  const kind = EntityKind.kind[eid] ?? KIND.None;
  const body = physics.getBody(eid);
  if (!body) throw new Error(`Entity ${String(eid)} has no physics body`);
  const t = body.translation();
  const r = body.rotation();
  const v = body.linvel();
  const w = body.angvel();
  return {
    kind,
    x: t.x,
    y: t.y,
    z: t.z,
    qx: r.x,
    qy: r.y,
    qz: r.z,
    qw: r.w,
    vx: v.x,
    vy: v.y,
    vz: v.z,
    wx: w.x,
    wy: w.y,
    wz: w.z,
    sleeping: body.isSleeping(),
  };
}

/** Snapshot of the session: seed, RNG state, clock, camera and every body's transform and motion (player first). */
export function serializeGame(session: GameSession): SaveGame {
  const clock = session.clock.toJSON();
  const entities: SerializedEntity[] = [];
  if (session.player !== 0) {
    // The camera can turn while no fixed step runs (time scale 0, console
    // pause), so the facing comes from the controller, not the body; the next
    // fixed step writes the same rotation to the body anyway.
    const player = serializeEntity(session.physics, session.player);
    const q = yawQuaternion(session.controller.yaw, { x: 0, y: 0, z: 0, w: 1 });
    entities.push({ ...player, qx: q.x, qy: q.y, qz: q.z, qw: q.w });
  }
  for (const eid of session.boxes) entities.push(serializeEntity(session.physics, eid));
  return {
    seed: session.seed,
    rngState: session.rng.state(),
    clock: { simTime: clock.simTime, timeScale: clock.timeScale },
    officer: { ...session.officer },
    camera: { pitch: session.controller.pitch },
    world: { entities },
  };
}

function motionOf(e: SerializedEntity): BodyMotion {
  return { linvel: { x: e.vx, y: e.vy, z: e.vz }, angvel: { x: e.wx, y: e.wy, z: e.wz }, sleeping: e.sleeping };
}

/**
 * Rapier wakes both bodies of every new contact pair, and a freshly built world
 * has no pairs yet, so the first real step would wake (and sag) a pile saved
 * asleep. One uncounted step without gravity, with every body held still,
 * builds the pairs; then the saved state is put back exactly: awake bodies get
 * their pose and velocities, sleeping ones the same without waking, then sleep.
 */
function primeContacts(physics: PhysicsWorld, restored: ReadonlyArray<readonly [EntityId, SerializedEntity]>): void {
  const raw = physics.raw;
  const gravity = raw.gravity;
  raw.gravity = { x: 0, y: 0, z: 0 };
  for (const [eid] of restored) {
    const body = physics.getBody(eid);
    body?.setLinvel({ x: 0, y: 0, z: 0 }, false);
    body?.setAngvel({ x: 0, y: 0, z: 0 }, false);
  }
  raw.step(); // no event queue: these contacts began before the save
  raw.gravity = gravity;
  for (const [eid, e] of restored) {
    const body = physics.getBody(eid);
    if (!body) continue;
    const linvel = { x: e.vx, y: e.vy, z: e.vz };
    const angvel = { x: e.wx, y: e.wy, z: e.wz };
    if (e.sleeping) {
      body.setTranslation({ x: e.x, y: e.y, z: e.z }, false);
      body.setRotation({ x: e.qx, y: e.qy, z: e.qz, w: e.qw }, false);
      body.setLinvel(linvel, false);
      body.setAngvel(angvel, false);
      body.sleep();
    } else {
      body.setTranslation({ x: e.x, y: e.y, z: e.z }, true);
      body.setRotation({ x: e.qx, y: e.qy, z: e.qz, w: e.qw }, true);
      body.setLinvel(linvel, true);
      body.setAngvel(angvel, true);
    }
  }
}

/**
 * Rebuilds a session from a save into `ctx` (use a fresh physics world, see
 * `createScenePhysics`): bodies are recreated with their saved transforms,
 * velocities and sleep state. Nothing is left behind if it throws.
 */
export function loadGame(ctx: GameContext, envelope: SaveEnvelope<SaveGame>): GameSession {
  const data = envelope.data;
  const clock = new GameClock().fromJSON({ simTime: data.clock.simTime, timeScale: data.clock.timeScale, paused: false });
  const session = new GameSession(ctx, normalizeSeed(data.seed), rngFromState(data.rngState), clock);
  try {
    session.officer = { ...data.officer };
    session.controller.pitch = data.camera.pitch;
    const restored: Array<[EntityId, SerializedEntity]> = [];
    for (const e of data.world.entities) {
      const position = { x: e.x, y: e.y, z: e.z };
      const rotation = { x: e.qx, y: e.qy, z: e.qz, w: e.qw };
      if (e.kind === KIND.Player) {
        if (session.player === 0) restored.push([session.spawnPlayer(position, yawFromQuaternion(rotation), motionOf(e)), e]);
      } else if (e.kind === KIND.Prop) {
        restored.push([session.spawnBox(position, rotation, motionOf(e)), e]);
      }
    }
    if (session.player === 0) session.spawnPlayer();
    primeContacts(ctx.physics, restored);
  } catch (error) {
    session.dispose();
    throw error;
  }
  return session;
}
