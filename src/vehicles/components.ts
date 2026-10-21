import { addComponent, type EntityId } from 'bitecs';
import { MAX_ENTITIES } from '../ecs/components';
import type { GameWorld } from '../ecs/world';
import { VEHICLE_MODELS, type VehicleModel } from './model';

/** `VehicleLook.lights` bits. */
export const LIGHT = { head: 1, brake: 2, reverse: 4, hazard: 8, lightbar: 16 } as const;

/** `VehicleLook.faults` bits (equipment faults drawn by the renderer). */
export const FAULT = { headLeftOut: 1, headRightOut: 2, tailOut: 4, brakeOut: 8 } as const;

/** `VehicleLook.trim` bits: optional parts the renderer draws per instance. */
export const TRIM = { pushBar: 1, spotlight: 2, hiddenBar: 4, noBar: 8 } as const;

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
  /** Two-wheeler visual lean (rad, + = right side down), 0 for everything else. */
  lean: new Float32Array(MAX_ENTITIES),
  /** Rotor speed 0..1 (helicopter, drone). */
  rotor: new Float32Array(MAX_ENTITIES),
  /** `TRIM` bits. */
  trim: new Uint8Array(MAX_ENTITIES),
};

/**
 * `TRIM` bits of a build: pushBar when the model has a push bumper and `pushBar`, spotlight when the model has one
 * and `spotlight`, hiddenBar / noBar from the livery's light-bar style.
 */
export function trimBits(model: VehicleModel, pushBar: boolean, spotlight: boolean, lightbarStyle: 'roof' | 'hidden' | 'none'): number {
  let bits = 0;
  if (pushBar && model.equipment?.pushBumper != null) bits |= TRIM.pushBar;
  if (spotlight && model.equipment?.spotlight === true) bits |= TRIM.spotlight;
  if (lightbarStyle === 'hidden') bits |= TRIM.hiddenBar;
  else if (lightbarStyle === 'none') bits |= TRIM.noBar;
  return bits;
}

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
  VehicleLook.lean[eid] = 0;
  VehicleLook.rotor[eid] = 0;
  const model = VEHICLE_MODELS[modelIndex];
  VehicleLook.trim[eid] = model ? trimBits(model, true, true, 'roof') : 0;
}

/** Adds the `Drivable` tag to `eid`. */
export function attachDrivable(world: GameWorld, eid: EntityId): void {
  addComponent(world, eid, Drivable);
}
