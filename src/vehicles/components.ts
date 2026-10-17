import { addComponent, type EntityId } from 'bitecs';
import { MAX_ENTITIES } from '../ecs/components';
import type { GameWorld } from '../ecs/world';

/** `VehicleLook.lights` bits. */
export const LIGHT = { head: 1, brake: 2, reverse: 4, hazard: 8, lightbar: 16 } as const;

/** `VehicleLook.faults` bits (equipment faults drawn by the renderer). */
export const FAULT = { headLeftOut: 1, headRightOut: 2, tailOut: 4, brakeOut: 8 } as const;

/** Render-facing vehicle state, shared by drivable and traffic vehicles. */
export const VehicleLook = {
  /** `VehicleModel.index`. */
  model: new Uint8Array(MAX_ENTITIES),
  /** Body colour 0xRRGGBB. */
  color: new Uint32Array(MAX_ENTITIES),
  /** `LIGHT` bits, written every step by the vehicle's owner. */
  lights: new Uint8Array(MAX_ENTITIES),
  /** `FAULT` bits. */
  faults: new Uint8Array(MAX_ENTITIES),
  /** 4 per entity at `eid * 4 + ZONE`: front, rear, left, right, 0..1. */
  damage: new Float32Array(MAX_ENTITIES * 4),
};

/** Tag: a player-drivable vehicle (`DrivableVehicle`). */
export const Drivable = {};

/** Adds `VehicleLook` to `eid` and resets its fields (entity ids are recycled). */
export function attachVehicleLook(world: GameWorld, eid: EntityId, modelIndex: number, color: number, faults = 0): void {
  addComponent(world, eid, VehicleLook);
  VehicleLook.model[eid] = modelIndex;
  VehicleLook.color[eid] = color;
  VehicleLook.lights[eid] = 0;
  VehicleLook.faults[eid] = faults;
  VehicleLook.damage.fill(0, eid * 4, eid * 4 + 4);
}

/** Adds the `Drivable` tag to `eid`. */
export function attachDrivable(world: GameWorld, eid: EntityId): void {
  addComponent(world, eid, Drivable);
}
