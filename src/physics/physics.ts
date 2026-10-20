import RAPIER, {
  type Collider,
  type ColliderDesc,
  type EventQueue,
  type RigidBody,
  type World,
} from '@dimforge/rapier3d-compat';
import type { EntityId } from 'bitecs';
import { Transform, type TransformStore } from '../ecs/components';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface BodyOptions {
  /** Dynamic (simulated) body when true, fixed otherwise. Default true. */
  dynamic?: boolean;
  /** Velocity-based kinematic body (moved by `setLinvel`, ignores gravity); overrides `dynamic`. */
  kinematic?: boolean;
  /** Total mass in kg; omitted means Rapier derives it from the shape at density 1. */
  mass?: number;
  friction?: number;
  restitution?: number;
}

export interface CollisionEvent {
  /** Entity ids of the two colliders; `undefined` for untracked colliders such as the ground. */
  a: EntityId | undefined;
  b: EntityId | undefined;
  /** True when contact began this step, false when it ended. */
  started: boolean;
}

export type CollisionListener = (event: CollisionEvent) => void;

export interface RayHit {
  /** Entity owning the hit collider, if it was added through this wrapper. */
  eid?: EntityId;
  point: Vec3;
  normal: Vec3;
  /** Distance along `dir` (in multiples of `dir`'s length) to the hit. */
  toi: number;
}

const DEFAULT_GRAVITY: Vec3 = { x: 0, y: -9.81, z: 0 };
const DEFAULT_DT = 1 / 60;
const GROUND_HALF_THICKNESS = 0.5;

let initPromise: Promise<void> | undefined;
let rapierReady = false;

/** Loads the Rapier WASM module once; later calls share the same promise. */
export function initRapier(): Promise<void> {
  initPromise ??= RAPIER.init().then(() => {
    rapierReady = true;
  });
  return initPromise;
}

/** True once `initRapier()` has resolved. */
export function isRapierReady(): boolean {
  return rapierReady;
}

/**
 * Fixed-timestep Rapier world that maps ECS entity ids to rigid bodies.
 *
 * Determinism: Rapier produces bit-identical results for the same sequence of
 * operations on the same platform/build, so two worlds fed identical inputs stay
 * in lockstep. The timestep is fixed at construction and never varied.
 */
export class PhysicsWorld {
  readonly fixedDt: number;
  private readonly world: World;
  private readonly events: EventQueue;
  private readonly bodies = new Map<EntityId, RigidBody>();
  private readonly eidByBody = new Map<number, EntityId>();
  private readonly eidByCollider = new Map<number, EntityId>();
  private readonly listeners = new Set<CollisionListener>();
  private readonly groundColliders = new Set<number>();
  private readonly scratchVec: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly scratchRot = { x: 0, y: 0, z: 0, w: 1 };
  private disposed = false;

  private constructor(gravity: Vec3, fixedDt: number) {
    this.fixedDt = fixedDt;
    this.world = new RAPIER.World(gravity);
    this.world.timestep = fixedDt;
    this.events = new RAPIER.EventQueue(true);
  }

  /** Initialises Rapier (once) and creates a world with the given gravity and step size. */
  static async create(gravity: Vec3 = DEFAULT_GRAVITY, fixedDt = DEFAULT_DT): Promise<PhysicsWorld> {
    await initRapier();
    return PhysicsWorld.createSync(gravity, fixedDt);
  }

  /** Synchronous `create` for when `initRapier()` has already resolved; throws otherwise. */
  static createSync(gravity: Vec3 = DEFAULT_GRAVITY, fixedDt = DEFAULT_DT): PhysicsWorld {
    if (!(fixedDt > 0)) throw new RangeError('fixedDt must be positive');
    if (!rapierReady) throw new Error('Rapier is not initialised; await initRapier() first');
    return new PhysicsWorld({ ...gravity }, fixedDt);
  }

  /** Underlying Rapier world, for vehicles/characters in later phases. */
  get raw(): World {
    return this.world;
  }

  get bodyCount(): number {
    return this.bodies.size;
  }

  /** True after `dispose()`; owners of raw Rapier objects skip their own cleanup then. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Advances the simulation by exactly `fixedDt` and dispatches collision events. */
  step(): void {
    this.assertLive();
    this.world.step(this.events);
    if (this.listeners.size === 0) {
      this.events.clear();
      return;
    }
    this.events.drainCollisionEvents((h1, h2, started) => {
      const event: CollisionEvent = {
        a: this.eidByCollider.get(h1),
        b: this.eidByCollider.get(h2),
        started,
      };
      for (const listener of this.listeners) listener(event);
    });
  }

  /** Subscribes to collision start/stop events; returns an unsubscribe function. */
  onCollision(listener: CollisionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Adds a fixed ground slab of `halfSize` x `halfSize` whose top surface is at `y`.
   * Not tracked by an entity id (see `isGround`).
   */
  addGround(halfSize = 100, y = 0, friction = 1): Collider {
    this.assertLive();
    const desc = RAPIER.ColliderDesc.cuboid(halfSize, GROUND_HALF_THICKNESS, halfSize)
      .setTranslation(0, y - GROUND_HALF_THICKNESS, 0)
      .setFriction(friction)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const collider = this.world.createCollider(desc);
    this.groundColliders.add(collider.handle);
    return collider;
  }

  /** True for a collider made by `addGround` (character controllers walk on it rather than into it). */
  isGround(handle: number): boolean {
    return this.groundColliders.has(handle);
  }

  /** Adds a box body for `eid`. `halfExtents` are half the box size on each axis. */
  addBox(eid: EntityId, position: Vec3, halfExtents: Vec3, options: BodyOptions = {}): RigidBody {
    const shape = RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z);
    return this.addBody(eid, position, shape, options);
  }

  /** Adds an upright cylinder body for `eid` (rotation about Y does not change its footprint). */
  addCylinder(eid: EntityId, position: Vec3, halfHeight: number, radius: number, options: BodyOptions = {}): RigidBody {
    return this.addBody(eid, position, RAPIER.ColliderDesc.cylinder(halfHeight, radius), options);
  }

  /** Adds a sphere body for `eid`. */
  addSphere(eid: EntityId, position: Vec3, radius: number, options: BodyOptions = {}): RigidBody {
    return this.addBody(eid, position, RAPIER.ColliderDesc.ball(radius), options);
  }

  /**
   * Tracks a body created directly on `raw` (e.g. a vehicle chassis) under `eid`, together with
   * every collider attached to it, so `syncToEcs`, `getBody`, `removeBody` and collision events
   * see it like a body added through this wrapper. Throws if `eid` already has a body.
   */
  registerBody(eid: EntityId, body: RigidBody): void {
    this.assertLive();
    if (this.bodies.has(eid)) throw new Error(`Entity ${String(eid)} already has a physics body`);
    this.bodies.set(eid, body);
    this.eidByBody.set(body.handle, eid);
    for (let i = 0; i < body.numColliders(); i++) {
      this.eidByCollider.set(body.collider(i).handle, eid);
    }
  }

  /** Removes the body (and its colliders) tracked for `eid`; no-op if untracked. */
  removeBody(eid: EntityId): void {
    const body = this.bodies.get(eid);
    if (!body) return;
    for (let i = 0; i < body.numColliders(); i++) {
      this.eidByCollider.delete(body.collider(i).handle);
    }
    this.eidByBody.delete(body.handle);
    this.bodies.delete(eid);
    this.world.removeRigidBody(body);
  }

  has(eid: EntityId): boolean {
    return this.bodies.has(eid);
  }

  getBody(eid: EntityId): RigidBody | undefined {
    return this.bodies.get(eid);
  }

  /** Entity id tracked for a Rapier rigid-body handle, if any. */
  eidOfBody(handle: number): EntityId | undefined {
    return this.eidByBody.get(handle);
  }

  /** Entity id tracked for a Rapier collider handle, if any. */
  eidOfCollider(handle: number): EntityId | undefined {
    return this.eidByCollider.get(handle);
  }

  /** Copies every tracked body's translation and rotation into the ECS transform store. */
  syncToEcs(store: TransformStore = Transform): void {
    const t = this.scratchVec;
    const r = this.scratchRot;
    for (const [eid, body] of this.bodies) {
      body.translation(t);
      body.rotation(r);
      store.x[eid] = t.x;
      store.y[eid] = t.y;
      store.z[eid] = t.z;
      store.qx[eid] = r.x;
      store.qy[eid] = r.y;
      store.qz[eid] = r.z;
      store.qw[eid] = r.w;
    }
  }

  /**
   * Casts a ray and returns the closest hit, or null.
   * `toi` is in multiples of `dir`; pass a unit `dir` to get a distance.
   * `excludeEid` skips that entity's body (e.g. the caster).
   *
   * Queries use the broad-phase as of the last `step()`: colliders added since
   * then are invisible until the next step (Rapier has no JS-side refresh).
   */
  castRay(origin: Vec3, dir: Vec3, maxToi = 100, solid = true, excludeEid?: EntityId): RayHit | null {
    this.assertLive();
    const ray = new RAPIER.Ray(origin, dir);
    const excludeBody = excludeEid === undefined ? undefined : this.bodies.get(excludeEid);
    const hit = this.world.castRayAndGetNormal(ray, maxToi, solid, undefined, undefined, undefined, excludeBody);
    if (!hit) return null;
    const p = ray.pointAt(hit.timeOfImpact);
    const n = hit.normal;
    return {
      eid: this.eidByCollider.get(hit.collider.handle),
      point: { x: p.x, y: p.y, z: p.z },
      normal: { x: n.x, y: n.y, z: n.z },
      toi: hit.timeOfImpact,
    };
  }

  /** Frees WASM memory; the instance is unusable afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.bodies.clear();
    this.eidByBody.clear();
    this.eidByCollider.clear();
    this.events.free();
    this.world.free();
  }

  private addBody(eid: EntityId, position: Vec3, shape: ColliderDesc, options: BodyOptions): RigidBody {
    this.assertLive();
    if (this.bodies.has(eid)) throw new Error(`Entity ${String(eid)} already has a physics body`);
    const bodyDesc = (
      options.kinematic
        ? RAPIER.RigidBodyDesc.kinematicVelocityBased()
        : (options.dynamic ?? true)
          ? RAPIER.RigidBodyDesc.dynamic()
          : RAPIER.RigidBodyDesc.fixed()
    ).setTranslation(position.x, position.y, position.z);
    const body = this.world.createRigidBody(bodyDesc);
    shape.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    if (options.mass !== undefined) shape.setMass(options.mass);
    if (options.friction !== undefined) shape.setFriction(options.friction);
    if (options.restitution !== undefined) shape.setRestitution(options.restitution);
    const collider = this.world.createCollider(shape, body);
    this.bodies.set(eid, body);
    this.eidByBody.set(body.handle, eid);
    this.eidByCollider.set(collider.handle, eid);
    return body;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('PhysicsWorld has been disposed');
  }
}
