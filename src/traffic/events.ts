import type { FleeEndReason } from './trafficSystem';

/** A traffic car entered or left the simulation. */
export interface TrafficCarEvent {
  eid: number;
  /** Registry id (see `vehicleRecord`). */
  vehicleId: number;
}

/** A traffic proxy hit a non-traffic body (usually the player car); the car is now `crashed` unless `fleeing`. */
export interface TrafficCollisionEvent {
  eid: number;
  vehicleId: number;
  /** Entity id of the other body. */
  other: number;
  /** Relative horizontal speed at contact (m/s). */
  impactSpeed: number;
  /** True when the car is fleeing: it was NOT crashed (the pursuit module decides: spin-out, crash or nothing). */
  fleeing?: boolean;
}

export type TrafficViolationKind = 'speeding' | 'redLight' | 'rollingStop' | 'tailgating' | 'weaving';

/** A violation within `observeRadius` of the focus; at most once per car, kind and edge. */
export interface TrafficViolationEvent {
  eid: number;
  vehicleId: number;
  kind: TrafficViolationKind;
  x: number;
  z: number;
  speedMph: number;
  limitMph: number;
}

/** The traffic-stop target was pulled over (it stopped at the curb): its pose. */
export interface TrafficPulledOverEvent {
  eid: number;
  vehicleId: number;
  x: number;
  z: number;
  yaw: number;
}

export type TrafficReleaseReason = 'released' | 'abandoned' | 'lost' | 'fled';

/** The stop target is no longer one: released (merges back), abandoned (stays parked), lost (focus too far) or fled (it drove off). */
export interface TrafficReleasedEvent {
  eid: number;
  vehicleId: number;
  reason: TrafficReleaseReason;
}

/** A car started fleeing (`TrafficSystem.flee`). */
export interface TrafficFleeingEvent {
  eid: number;
  vehicleId: number;
}

/** A flee ended: where the car was and why (crashed: stays as a wreck; escaped: already despawned; gaveUp / stopped: pulling to the curb). */
export interface TrafficFleeEndedEvent {
  eid: number;
  vehicleId: number;
  reason: FleeEndReason;
  x: number;
  z: number;
}

/** A fleet car reached its destination and parked at the curb. */
export interface TrafficFleetArrivedEvent {
  index: number;
  eid: number;
  x: number;
  z: number;
}

declare module '../core/event-map' {
  interface EventMap {
    'traffic:spawned': TrafficCarEvent;
    'traffic:despawned': TrafficCarEvent;
    'traffic:collision': TrafficCollisionEvent;
    'traffic:violation': TrafficViolationEvent;
    'traffic:pullingOver': TrafficCarEvent;
    'traffic:pulledOver': TrafficPulledOverEvent;
    'traffic:released': TrafficReleasedEvent;
    'traffic:fleetArrived': TrafficFleetArrivedEvent;
    'traffic:fleeing': TrafficFleeingEvent;
    'traffic:fleeEnded': TrafficFleeEndedEvent;
  }
}
