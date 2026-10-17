import type { ZoneName } from './damage';

/** A drivable vehicle took an impact above `damage.minImpactSpeed`. */
export interface VehicleDamagedEvent {
  eid: number;
  zone: ZoneName;
  amount: number;
  impactSpeed: number;
}

export interface VehicleTireBurstEvent {
  eid: number;
  /** FL 0, FR 1, RL 2, RR 3. */
  wheel: number;
}

export interface VehicleEntityEvent {
  eid: number;
}

declare module '../core/event-map' {
  interface EventMap {
    'vehicle:damaged': VehicleDamagedEvent;
    'vehicle:tireBurst': VehicleTireBurstEvent;
    'vehicle:engineStalled': VehicleEntityEvent;
    'vehicle:engineFailed': VehicleEntityEvent;
    'vehicle:fuelEmpty': VehicleEntityEvent;
  }
}
