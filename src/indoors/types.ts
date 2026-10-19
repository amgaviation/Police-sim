/** Interior runtime types (design §6.1, §4.3, §8.1, §11.3). Pure: no THREE, DOM or Rapier. */
import type { EventBus } from '../core/events';
import type { EventMap } from '../core/event-map';
import type { Rng } from '../core/rng';
import type { InteriorLayout, PointKind, Rect } from '../interior/types';
import type { BuildingIndex } from '../world/buildings';
import type { City } from '../world/city';
import type { PhysicsWorld } from '../physics/physics';

/** Door state numbers (saves, sound graph, npc nav). */
export const DOOR_STATE = { closed: 0, open: 1, locked: 2, broken: 3 } as const;
export type DoorStateId = (typeof DOOR_STATE)[keyof typeof DOOR_STATE];
export type DoorStateName = 'closed' | 'open' | 'locked' | 'broken';

/** State names by id (index = `DOOR_STATE` value). */
export const DOOR_STATE_NAMES: readonly DoorStateName[] = ['closed', 'open', 'locked', 'broken'];

export interface OccupantSpawn {
  buildingId: number;
  personId: number;
  x: number;
  z: number;
  yaw: number;
  pose: 'stand' | 'sit' | 'lying';
  profile: string;
  role: 'resident' | 'staff' | 'patron';
}

/** Implemented by the integrator over NpcSystem / RecordsDb / SceneDirector. */
export interface OccupantPort {
  /** Actor id, 0 when the npc pool is full. */
  spawn(spec: OccupantSpawn): number;
  remove(actorId: number): void;
  /** Busy actors (in contact, cuffed, following, scene roles) are never removed on unload. */
  busy(actorId: number): boolean;
  /** True when a scene owns this building (no ambient occupants then). */
  sceneOwns(buildingId: number): boolean;
}

export interface InteriorDeps {
  readonly seed: number;
  readonly city: City;
  readonly physics: PhysicsWorld;
  readonly bus: EventBus<EventMap>;
  /** `session.rng.stream('interior')`. */
  readonly rng: Rng;
  readonly buildings: BuildingIndex;
  readonly occupants: OccupantPort;
  /** Game seconds. */
  now(): number;
  kit(): { carried(item: string): number };
  /** Wall-clock milliseconds for `stats.stepMs` only (never read by the simulation). */
  readonly clock?: () => number;
}

/** Officer pose handed to the fixed step. `building` is informational: the system tracks `officerBuilding` itself. */
export interface OfficerAt {
  x: number;
  z: number;
  yaw: number;
  building: number;
  onFoot: boolean;
}

export type InteriorRequest =
  | { readonly kind: 'enter'; readonly buildingId: number; readonly door: number }
  | { readonly kind: 'exit'; readonly door: number }
  | {
      readonly kind: 'door';
      readonly buildingId: number;
      readonly door: number;
      readonly action: 'toggle' | 'open' | 'close' | 'knock' | 'kick' | 'ram' | 'lock' | 'unlock' | 'announce';
    }
  | { readonly kind: 'switch'; readonly buildingId: number; readonly room: number };

export type InteriorInteractable =
  | { kind: 'entrance'; buildingId: number; door: number; distance: number }
  | { kind: 'exit'; buildingId: number; door: number; distance: number }
  | { kind: 'door'; buildingId: number; door: number; state: DoorStateName; distance: number }
  | { kind: 'switch'; buildingId: number; room: number; on: boolean; distance: number }
  | { kind: 'point'; buildingId: number; point: number; pointKind: PointKind; distance: number };

/** What tactical and scenes read from the InteriorSystem (declared identically in their own types files). */
export interface InteriorQuery {
  /** Building the officer is in, -1 outdoors. */
  readonly officerBuilding: number;
  /** Pure layout (cached), null when the building is not enterable. */
  layout(buildingId: number): InteriorLayout | null;
  doorState(buildingId: number, door: number): DoorStateName;
  /** Increments whenever any door of the building changes state (sound graph cache key). */
  doorRevision(buildingId: number): number;
  roomLit(buildingId: number, room: number): boolean;
}

/**
 * Navigation port the npc module uses indoors (declared identically as `IndoorNavPort` in `src/npc/types.ts`).
 * `path`: waypoints (x, z pairs) from (x, z) to (tx, tz), the point count, 0 when unreachable.
 * `exit`: waypoints to the nearest reachable exterior door, the point count (0 none); `pose` receives the outdoor pose.
 * `hideSpot`: claims the free hiding spot farthest from (awayX, awayZ), writes its pose, returns its index (-1 none).
 */
export interface IndoorNavPort {
  path(buildingId: number, x: number, z: number, tx: number, tz: number, out: Float32Array): number;
  exit(buildingId: number, x: number, z: number, out: Float32Array, pose: { x: number; z: number; yaw: number }): number;
  hideSpot(buildingId: number, x: number, z: number, awayX: number, awayZ: number, pose: { x: number; z: number; yaw: number }): number;
  releaseHide(buildingId: number, index: number): void;
}

/**
 * Floor plan for the minimap (§6.4, §11.3): `rooms` holds minX, minZ, maxX, maxZ per room; `doors` holds x, z and
 * open (0 | 1) per door. The arrays are cached per building and refreshed in place.
 */
export interface FloorPlan {
  readonly rooms: Float32Array;
  readonly doors: Float32Array;
  readonly rect: Rect;
}
