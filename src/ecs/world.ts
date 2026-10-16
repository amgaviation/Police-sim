import {
  addComponent,
  addEntity,
  createWorld,
  entityExists,
  getAllEntities,
  removeEntity,
  resetWorld,
  type EntityId,
  type World,
} from 'bitecs';
import { MAX_ENTITIES, isValidSlot, resetComponentSlot } from './components';

/** Fixed-step clock carried on the world context. */
export interface WorldTime {
  /** Seconds of the current fixed step. */
  dt: number;
  /** Total simulated seconds. */
  elapsed: number;
  /** Number of fixed steps taken so far. */
  step: number;
}

export interface GameWorldContext {
  time: WorldTime;
  /** Live entities created through `spawn`; maintained so counting does not allocate. */
  liveEntities: number;
}

export type GameWorld = World<GameWorldContext>;

/** Any component reference accepted by bitecs: identity is by object reference. */
export type Component = object;

/** Sentinel for "no entity"; bitecs never issues id 0. */
export const NULL_ENTITY: EntityId = 0;

/** Creates an empty world with a zeroed clock. */
export function createGameWorld(): GameWorld {
  return createWorld<GameWorldContext>({ time: { dt: 0, elapsed: 0, step: 0 }, liveEntities: 0 });
}

/**
 * Creates an entity, clears its (possibly recycled) component slots, and attaches `components`.
 * Throws if the id would exceed `MAX_ENTITIES`.
 */
export function spawn(world: GameWorld, ...components: Component[]): EntityId {
  const eid = addEntity(world);
  if (!isValidSlot(eid)) {
    removeEntity(world, eid);
    throw new RangeError(`Entity limit reached (MAX_ENTITIES = ${String(MAX_ENTITIES)})`);
  }
  resetComponentSlot(eid);
  for (const component of components) addComponent(world, eid, component);
  world.liveEntities += 1;
  return eid;
}

/** Removes an entity; a no-op for ids that are not alive. */
export function despawn(world: GameWorld, eid: EntityId): void {
  if (!entityExists(world, eid)) return;
  removeEntity(world, eid);
  resetComponentSlot(eid);
  world.liveEntities -= 1;
}

/** Number of live entities (constant time; entities must be created with `spawn`). */
export function entityCount(world: GameWorld): number {
  return world.liveEntities;
}

/** Removes every entity and resets the clock; the world object itself stays valid. */
export function clearWorld(world: GameWorld): void {
  for (const eid of getAllEntities(world)) resetComponentSlot(eid);
  resetWorld(world);
  world.liveEntities = 0;
  world.time.dt = 0;
  world.time.elapsed = 0;
  world.time.step = 0;
}

/** Advances the world clock by one fixed step of `dt` seconds. */
export function advanceTime(world: GameWorld, dt: number): void {
  world.time.dt = dt;
  world.time.elapsed += dt;
  world.time.step += 1;
}
