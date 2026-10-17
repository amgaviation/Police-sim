import { addComponent, hasComponent, type EntityId } from 'bitecs';
import { MAX_ENTITIES } from '../ecs/components';
import type { GameWorld } from '../ecs/world';

/** `PoliceLights.sirenFlags` bits (held this step). */
export const SIREN_FLAG = { horn: 1, manual: 2 } as const;

/**
 * Police equipment state the renderer and audio read (design §11.1, §12). Written every fixed step
 * by `PatrolEquipment.writeLook` (player cars) or the dispatcher (fleet cars). The light bar on/off
 * stays `VehicleLook.lights & LIGHT.lightbar`.
 */
export const PoliceLights = {
  /** `LIGHTBAR_PATTERNS` index. */
  pattern: new Uint8Array(MAX_ENTITIES),
  /** 0 off, otherwise 1 + `SIREN_TONES` index. */
  siren: new Uint8Array(MAX_ENTITIES),
  /** `SIREN_FLAG` bits. */
  sirenFlags: new Uint8Array(MAX_ENTITIES),
  /** 1 = spotlight on. */
  spot: new Uint8Array(MAX_ENTITIES),
  /** Spotlight yaw relative to the heading (rad, + = left). */
  spotYaw: new Float32Array(MAX_ENTITIES),
  /** Spotlight pitch (rad, + = up). */
  spotPitch: new Float32Array(MAX_ENTITIES),
  /** Light bar clock offset (s), so cars side by side do not flash in sync. */
  phase: new Float32Array(MAX_ENTITIES),
};

/** Adds `PoliceLights` to `eid` and resets every field of its slot (entity ids are recycled). */
export function attachPoliceLights(world: GameWorld, eid: EntityId, phase: number): void {
  addComponent(world, eid, PoliceLights);
  PoliceLights.pattern[eid] = 0;
  PoliceLights.siren[eid] = 0;
  PoliceLights.sirenFlags[eid] = 0;
  PoliceLights.spot[eid] = 0;
  PoliceLights.spotYaw[eid] = 0;
  PoliceLights.spotPitch[eid] = 0;
  PoliceLights.phase[eid] = phase;
}

export function hasPoliceLights(world: GameWorld, eid: EntityId): boolean {
  return hasComponent(world, eid, PoliceLights);
}
