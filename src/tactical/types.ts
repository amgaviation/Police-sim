/**
 * Structural types shared with other Phase 4 modules (design §4.3, §7.3, §8.1). They are declared here, identically
 * to the producers, so tactical imports neither `src/indoors` nor `src/npc`.
 */
import type { InteriorLayout } from '../interior/types';
import type { PartnerCommand } from './partner';
import type { SoundKind } from './sound';

/** Door state names (indoors `DOOR_STATE`). */
export type DoorStateName = 'closed' | 'open' | 'locked' | 'broken';

/** What tactical reads from the InteriorSystem. */
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

/** One actor that can hear and see (the NpcSystem fills reused objects of this shape). */
export interface Listener {
  actorId: number;
  personId: number;
  x: number;
  z: number;
  building: number;
  hearing: 'normal' | 'hardOfHearing' | 'deaf';
  asleep: boolean;
  yaw: number;
  eyeY: number;
}

/** Implemented by NpcSystem. */
export interface ListenerPort {
  /** Fills `out` (reused objects) with the actors within `radius` of (x, z); returns the count. */
  listeners(x: number, z: number, radius: number, out: Listener[]): number;
  stimulate(actorId: number, kind: 'sound' | 'sight' | 'light', amount: number, srcX: number, srcZ: number): void;
}

/** The officer as the tactical systems read it (feet position; `speed` m/s; `pitch` positive = looking down). */
export interface OfficerPose {
  x: number;
  z: number;
  yaw: number;
  pitch: number;
  building: number;
  speed: number;
  onFoot: boolean;
}

/** A fresh `Listener` (for pools). */
export function createListener(): Listener {
  return { actorId: 0, personId: 0, x: 0, z: 0, building: -1, hearing: 'normal', asleep: false, yaw: 0, eyeY: 1.6 };
}

/** Queued tactical requests (applied at the start of the next fixed step). */
export type TacticalRequest =
  | { readonly kind: 'crouch' }
  | { readonly kind: 'flashlight' }
  | { readonly kind: 'partner'; readonly command: PartnerCommand }
  | { readonly kind: 'sound'; readonly source: SoundKind; readonly x: number; readonly z: number; readonly building: number; readonly level?: number };
