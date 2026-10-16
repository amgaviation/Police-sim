import type { EntityId } from 'bitecs';

/** Hard cap on live entity ids; every typed-array store is sized to this. */
export const MAX_ENTITIES = 20000;

/** Structure-of-arrays store for a position + unit quaternion. */
export interface TransformStore {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly qx: Float32Array;
  readonly qy: Float32Array;
  readonly qz: Float32Array;
  readonly qw: Float32Array;
}

/** Structure-of-arrays store for a linear velocity (units/second). */
export interface VelocityStore {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
}

function createTransformStore(): TransformStore {
  const store = {
    x: new Float32Array(MAX_ENTITIES),
    y: new Float32Array(MAX_ENTITIES),
    z: new Float32Array(MAX_ENTITIES),
    qx: new Float32Array(MAX_ENTITIES),
    qy: new Float32Array(MAX_ENTITIES),
    qz: new Float32Array(MAX_ENTITIES),
    qw: new Float32Array(MAX_ENTITIES),
  };
  store.qw.fill(1);
  return store;
}

/** Current simulation-space transform, written by the fixed step. */
export const Transform: TransformStore = createTransformStore();

/** Transform from the previous fixed step; the renderer interpolates between the two. */
export const PrevTransform: TransformStore = createTransformStore();

/** Linear velocity, integrated by `integrateVelocity` unless the entity has `PhysicsBody`. */
export const Velocity: VelocityStore = {
  x: new Float32Array(MAX_ENTITIES),
  y: new Float32Array(MAX_ENTITIES),
  z: new Float32Array(MAX_ENTITIES),
};

/** Tag: the player-controlled entity. */
export const Player = {};

/** Tag: entity has a renderable mesh owned by the render module. */
export const RenderMesh = {};

/** Tag: entity's transform is owned by the physics module (skipped by `integrateVelocity`). */
export const PhysicsBody = {};

/** Entity categories. Plain const map (no enums); values are stable and persisted. */
export const KIND = {
  None: 0,
  Player: 1,
  Officer: 2,
  Civilian: 3,
  Vehicle: 4,
  Prop: 5,
} as const;

export type KindName = keyof typeof KIND;
export type KindId = (typeof KIND)[KindName];

/** Per-entity category, one of the `KIND` values. */
export const EntityKind = { kind: new Uint8Array(MAX_ENTITIES) };

/** Returns true when `eid` can index the fixed-size stores. */
export function isValidSlot(eid: EntityId): boolean {
  return Number.isInteger(eid) && eid >= 0 && eid < MAX_ENTITIES;
}

/** Resets a transform slot to the origin with an identity rotation. */
export function resetTransformSlot(store: TransformStore, eid: EntityId): void {
  store.x[eid] = 0;
  store.y[eid] = 0;
  store.z[eid] = 0;
  store.qx[eid] = 0;
  store.qy[eid] = 0;
  store.qz[eid] = 0;
  store.qw[eid] = 1;
}

/** Resets a velocity slot to zero. */
export function resetVelocitySlot(store: VelocityStore, eid: EntityId): void {
  store.x[eid] = 0;
  store.y[eid] = 0;
  store.z[eid] = 0;
}

/**
 * Resets every data component slot for `eid` to its default value.
 * Entity ids are recycled by bitecs, so this must run before a slot is reused.
 */
export function resetComponentSlot(eid: EntityId): void {
  resetTransformSlot(Transform, eid);
  resetTransformSlot(PrevTransform, eid);
  resetVelocitySlot(Velocity, eid);
  EntityKind.kind[eid] = KIND.None;
}

/** Copies the transform of `eid` from `src` into `dst`. */
export function copyTransformSlot(src: TransformStore, dst: TransformStore, eid: EntityId): void {
  dst.x[eid] = src.x[eid] ?? 0;
  dst.y[eid] = src.y[eid] ?? 0;
  dst.z[eid] = src.z[eid] ?? 0;
  dst.qx[eid] = src.qx[eid] ?? 0;
  dst.qy[eid] = src.qy[eid] ?? 0;
  dst.qz[eid] = src.qz[eid] ?? 0;
  dst.qw[eid] = src.qw[eid] ?? 1;
}
