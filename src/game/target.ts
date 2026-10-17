import { generateRegistration, mountedPlate, vehicleDescription } from '../records/vehicle';
import { pickTrafficCar, type PickResult } from '../traffic/pick';
import { REGISTRY_POPULATION } from '../traffic/registry';
import { isFleetVehicleId, type TrafficView } from '../traffic/trafficSystem';

/** Reticle reach (m) and how much larger than its body a car's pick box is (m) (design §7.5). */
export const TARGET_RANGE_M = 60;
export const TARGET_ASSIST_M = 1;
/** A target stays locked this long after the reticle left it (ms), so the HUD line does not flicker. */
export const TARGET_HOLD_MS = 1500;

/** The car under the reticle: its registry id, entity, the plate actually mounted on it and what it looks like. */
export interface TargetInfo {
  readonly vehicleId: number;
  eid: number;
  readonly plate: string;
  /** "2019 black Sedan": the car itself (not the registration its plate belongs to). */
  readonly description: string;
}

/** Plate and look of registry vehicle `vehicleId` as an officer sees them (pure; does not touch the records snapshot). */
export function describeTarget(seed: number, vehicleId: number, eid: number): TargetInfo {
  return {
    vehicleId,
    eid,
    plate: mountedPlate(seed, vehicleId).plate,
    description: vehicleDescription(generateRegistration(seed, vehicleId)),
  };
}

/**
 * Target lock for plate runs (design §15: picked at 10 Hz from the camera). Fleet cars are never
 * targets. A target is kept `TARGET_HOLD_MS` after the ray stops hitting it. Presentation-side
 * state: nothing here feeds back into the simulation.
 */
export class TargetTracker {
  private readonly seed: number;
  private readonly hit: PickResult = { slot: -1, vehicleId: -1, eid: 0, distance: 0 };
  private current: TargetInfo | null = null;
  private seenMs = -Infinity;

  constructor(seed: number) {
    this.seed = seed;
  }

  get target(): TargetInfo | null {
    return this.current;
  }

  /** Casts the 2D ray from (ox, oz) along (dx, dz) through the traffic view; returns the locked target. */
  update(view: TrafficView, ox: number, oz: number, dx: number, dz: number, nowMs: number): TargetInfo | null {
    const hit = pickTrafficCar(view, ox, oz, dx, dz, TARGET_RANGE_M, TARGET_ASSIST_M, this.hit);
    if (hit && hit.vehicleId >= 0 && hit.vehicleId < REGISTRY_POPULATION && !isFleetVehicleId(hit.vehicleId)) {
      if (this.current?.vehicleId !== hit.vehicleId) this.current = describeTarget(this.seed, hit.vehicleId, hit.eid);
      else this.current.eid = hit.eid;
      this.seenMs = nowMs;
    } else if (this.current && nowMs - this.seenMs > TARGET_HOLD_MS) {
      this.current = null;
    }
    return this.current;
  }

  clear(): void {
    this.current = null;
    this.seenMs = -Infinity;
  }
}
