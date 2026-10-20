/**
 * Resources module contracts (Phase 6 design §4.1, §4.5, §8): unit statuses, requests, views, the structural
 * ports the module consumes and the `ResourcePort` other same-wave modules (pursuit, command) read it through.
 */
import type { CadState } from '../cad/cadState';
import type { CadLocation, CadTime } from '../cad/types';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng, RngState } from '../core/rng';
import type { GameWorld } from '../ecs/world';
import type { ActorInfo } from '../npc/types';
import type { SceneRequest } from '../scene/types';
import type { FleeState, FleetState } from '../traffic/trafficSystem';
import type { RosterState, UnitTypesData } from '../units';
import type { City } from '../world/city';

/** Where a resource unit is in its life cycle (design §4.1). `outOfService` is reserved (never set by Phase 6 data). */
export const RESOURCE_STATUSES = ['available', 'turnout', 'enRoute', 'onScene', 'transporting', 'returning', 'outOfService'] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

/** Urgency a ground resource unit drives at. */
export type ResourceUrgency = 'respond' | 'emergency';

/** A queued request, applied at the start of the next step. */
export type ResourceRequest =
  | { readonly kind: 'request'; readonly typeId: string; readonly callId: number; readonly via: 'radio' | 'mdt' | 'auto' | 'scene' }
  | { readonly kind: 'cancel'; readonly callsign: string }
  | { readonly kind: 'release'; readonly callsign: string };

/** One unit of the Resources list (MDT, console). The object is reused between steps: copy what you keep. */
export interface ResourceUnitView {
  callsign: string;
  typeId: string;
  label: string;
  status: ResourceStatus;
  callId: number;
  /** Live ETA in seconds, -1 when unknown or not en route. */
  etaS: number;
  x: number;
  z: number;
}

/** The air unit as the renderer and the FLIR camera need it. The object is reused between steps. */
export interface AirView {
  x: number;
  y: number;
  z: number;
  yaw: number;
  spot: boolean;
  targetX: number;
  targetZ: number;
  onTarget: boolean;
  /** Rotor angle (rad). */
  rotor: number;
}

/** HUD feed. The object is reused; strings change at most once a second. */
export interface ResourceHud {
  /** 'MEDIC-2 ETA 3:10': the soonest unit en route to the player's call. */
  next: string | null;
  /** Resource units on scene of the player's call. */
  onScene: number;
}

/** Saved state of one unit slot. */
export interface ResourceUnitSave {
  callsign: string;
  status: ResourceStatus;
  callId: number;
  etaS: number;
  /** Route-based travel estimate (s) behind `etaS` while in turnout. */
  travelS: number;
  expectedMps: number;
  turnoutUntil: number;
  /** Sim second the unit leaves the scene, -1 none (held until the call closes). */
  leaveAt: number;
  destX: number;
  destZ: number;
  urgency: ResourceUrgency;
  /** Person being transported, -1 none. */
  patient: number;
  noProgressSince: number;
  progressLeftM: number;
}

export interface ResourceAirSave {
  x: number;
  y: number;
  z: number;
  yaw: number;
  targetKind: string;
  targetId: number;
  tx: number;
  tz: number;
  onStationUntil: number;
  /** Actor ids already revealed by the FLIR camera. */
  revealed: number[];
}

export interface ResourceSave {
  version: 1;
  rng: RngState;
  units: ResourceUnitSave[];
  air: ResourceAirSave | null;
  /** Command posts remembered per call: [callId, x, z, levelIndex]. */
  posts: [number, number, number, number][];
  requests: ResourceRequest[];
  /** Last AVL / FLIR scan time slots (so a load continues exactly); absent in saves that predate them. */
  slots?: { avl: number; reveal: number };
}

// --- Ports (design §4.5, §8.2) ----------------------------------------------------------------------

/** What pursuit and command read the resources module through (declared by the consumers too). */
export interface ResourcePort {
  /** Queue a request (same as `ResourceSystem.request({ kind: 'request', ... })`). */
  requestType(typeId: string, callId: number, via: 'radio' | 'mdt' | 'auto'): void;
  /** Callsign of a sergeant (or higher) assigned to `callId` (en route or on scene), null none. */
  supervisorFor(callId: number): string | null;
  /** Units of `typeId` on scene of `callId`. */
  onScene(callId: number, typeId: string): number;
  /** Callsigns of units of `typeId` on scene of `callId` (fills and returns `out`). */
  onSceneUnits(callId: number, typeId: string, out: string[]): string[];
  /** The air unit (false while at base): position and whether it is over its target. */
  air(out: { x: number; z: number; y: number; onTarget: boolean; spot: boolean }): boolean;
  /** Point the air unit at a target; kind 'none' sends it back to orbit the call. */
  setAirTarget(kind: 'vehicle' | 'actor' | 'point' | 'none', id: number, x: number, z: number): void;
  /** EMS unit `callsign` loads patient `personId` and drives to the hospital; false when not an on-scene EMS unit. */
  transport(callsign: string, personId: number): boolean;
  /** Sends a ground unit to (x, z) (same call); false when unknown or not assigned. */
  directTo(callsign: string, x: number, z: number, urgency: 'respond' | 'emergency'): boolean;
  /** Pose of a resource unit's vehicle (false when not spawned). */
  unitPose(callsign: string, out: { x: number; z: number; yaw: number; speed: number }): boolean;
}

export interface ResourceTrafficPort {
  spawnFleetCar(index: number, x: number, z: number, look: { modelIndex: number; color: number }): number;
  removeFleetCar(index: number): void;
  setFleetDestination(index: number, x: number, z: number, urgency: 'respond' | 'emergency'): boolean;
  setFleetPatrol(index: number): void;
  fleetState(index: number, out: FleetState): FleetState | null;
  fleeState(vehicleId: number, out: FleeState): boolean;
}

export interface ResourceScenePort {
  request(r: SceneRequest): void;
  hasScenario(callId: number): boolean;
  serviceRequested(callId: number, kind: string): boolean;
}

export interface ResourceDispatchPort {
  readonly playerCallsign: string;
  /** Phase 3 API: opens a self-initiated call with the player assigned (used when a request has no call). */
  openSelfInitiated(typeId: string, priority: 1 | 2 | 3 | 4, at: { x: number; z: number }, narrative: string, t: CadTime): { id: number };
  locate(x: number, z: number): CadLocation;
}

export interface ResourceNpcPort {
  actorOfPerson(personId: number): number;
  actor(id: number, out: ActorInfo): ActorInfo | null;
  removeActor(id: number): void;
  reveal(id: number): void;
  actorIds(out: number[]): number[];
}

export interface ResourceDeps {
  readonly seed: number;
  readonly bus: EventBus<EventMap>;
  /** session.rng.stream('resources'). */
  readonly rng: Rng;
  readonly cad: CadState;
  readonly city: City;
  readonly world: GameWorld;
  readonly traffic: ResourceTrafficPort;
  readonly scene: ResourceScenePort;
  readonly dispatch: ResourceDispatchPort;
  readonly npc: ResourceNpcPort;
  readonly people: { setCustody(id: number, c: 'hospital'): void };
  readonly roster: RosterState;
  /** 0..1 road wetness, night flag (spotlight). */
  env(): { wetness: number; night: boolean };
  /** District traffic density x hour factor at (x, z) (integrator: districtTypes trafficDensity x density.json hour factor). */
  trafficDensity(x: number, z: number): number;
  /** Test variants of the unit data (default `UNIT_TYPES`). */
  readonly types?: UnitTypesData;
}
