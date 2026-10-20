/**
 * Pursuit module types (Phase 6 design §10): the tuning data, the pure-function shapes, the runtime dependencies
 * and the structural ports to the same-wave resources module (declared here by the consumer, §4.5).
 */
import type { CadState } from '../cad/cadState';
import type { EventBus } from '../core/events';
import type { EventMap } from '../core/event-map';
import type { Rng } from '../core/rng';
import type { ActorInfo } from '../npc/types';
import type { SceneRequest } from '../scene/types';
import type { FleeInfo, FleetState } from '../traffic/trafficSystem';
import type { RoadGraph } from '../world/roadGraph';

/** Pursuit tactics reported by `pursuit:tactic` (§4.1). */
export const PURSUIT_TACTICS = ['pit', 'spikes', 'boxIn', 'roadblock', 'air', 'perimeter', 'handoff'] as const;
export type PursuitTactic = (typeof PURSUIT_TACTICS)[number];

/** Result classes of a contact between the police car and the suspect (§4.1). */
export const CONTACT_KINDS = ['pit', 'ram', 'bump', 'none'] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

/** Verdict of a tactic as shown to the player. */
export type TacticVerdict = 'withinPolicy' | 'outsidePolicy' | 'failed' | 'success';

// --- Data (src/data/pursuit/pursuit.json) -------------------------------------------------------------------

export interface PitConfig {
  minMph: number;
  maxMph: number;
  maxRelMph: number;
  rearZoneFrac: number;
  lateralMinFrac: number;
  maxHeadingDeg: number;
  ramMph: number;
  forbiddenModels: readonly string[];
  requiresAuthorization: boolean;
  allowedOffenses: readonly string[];
}

export interface SpikesConfig {
  lengthM: number;
  aheadJunctions: number;
  setbackM: number;
  expireS: number;
  playerDeployRangeM: number;
  tiresOnHit: number;
}

export interface BoxInConfig {
  maxSuspectMph: number;
  radiusM: number;
  minAiUnits: number;
  requirePlayer: boolean;
}

export interface RoadblockConfig {
  aheadM: number;
  lateralM: number;
  minUnits: number;
  decelMps2: number;
  stopMps: number;
}

export interface RiskConfig {
  overLimitPer10Mph: number;
  district: Readonly<Record<string, number>>;
  wet: number;
  night: number;
  density: number;
  perMinute: number;
  nonViolent: number;
  lostSight: number;
  airUnitRelief: number;
}

export interface SupervisorConfig {
  monitorDelayS: number;
  riskTerminate: number;
  riskTerminateNonViolent: number;
  lostSightS: number;
  checkS: number;
  repeatS: number;
}

export interface PerimeterConfig {
  radiusM: number;
  posts: number;
  postNearM: number;
  escapeM: number;
  requestK9: boolean;
  requestAir: boolean;
  lostSightS: number;
}

export interface CityLimits {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface HandoffConfig {
  cityLimits: CityLimits;
  requestAheadS: number;
  takeoverM: number;
  resolveS: readonly [number, number];
  catchChance: number;
  removeAfterS: number;
}

/** The validated contents of `pursuit.json`. */
export interface PursuitConfig {
  pit: PitConfig;
  spikes: SpikesConfig;
  boxIn: BoxInConfig;
  roadblock: RoadblockConfig;
  risk: RiskConfig;
  supervisor: SupervisorConfig;
  perimeter: PerimeterConfig;
  handoff: HandoffConfig;
  follow: { replanS: number };
  air: { trackM: number };
}

// --- Pure-function shapes --------------------------------------------------------------------------------------

/** Pose of a car for contact classification (yaw 0 = facing -Z; speed in m/s along the heading). */
export interface CarPose {
  x: number;
  z: number;
  yaw: number;
  speed: number;
  halfLength: number;
  halfWidth: number;
}

/** `classifyContact` output. `reasons` lists the failed PIT checks (for the HUD); empty for a PIT. */
export interface ContactResult {
  kind: ContactKind;
  dir: 1 | -1;
  relMph: number;
  reasons: string[];
}

/** A spike strip lying across the road. */
export interface Strip {
  id: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  placedSim: number;
  owner: string;
  active: boolean;
}

// --- Runtime -------------------------------------------------------------------------------------------------------

/** Requests from the UI (queued, applied at the start of the next step). */
export type PursuitRequest =
  | { readonly kind: 'requestPit' }
  | { readonly kind: 'spikesAhead' }
  | { readonly kind: 'deployStrip' }
  | { readonly kind: 'boxIn' }
  | { readonly kind: 'roadblock' }
  | { readonly kind: 'air' }
  | { readonly kind: 'perimeter' };

/** One-line pursuit HUD feed; `verdict` is the last tactic verdict text. */
export interface PursuitHud {
  line: string;
  verdict: string | null;
}

/** One entry of the pursuit tactics panel. */
export interface PursuitMenuItem {
  id: PursuitRequest['kind'];
  label: string;
  enabled: boolean;
  hint: string;
}

/** Per-step view of the player. */
export interface PursuitContext {
  /** The player's driven police car, or null on foot. */
  car: CarPose | null;
  /** Entity id of the driven car (the `other` of a collision), 0 none. */
  carId: number;
  lights: boolean;
  siren: boolean;
  onFoot: boolean;
  x: number;
  z: number;
  yaw: number;
  /** The officer carries a spike strip (OfficerKit). */
  carryingStrip: boolean;
  playerCallsign: string;
}

/** The incidents ruleset as the pursuit needs it (integrator: `incidents.ruleset.pursuit` + `allowedOverMph` + offense). */
export interface PursuitRulesPort {
  allowedOffenses(): readonly string[];
  maxDurationS(): number;
  terminateGraceS(): number;
  /** Allowed mph over the limit in `district` (legal `allowedOverMph`). */
  allowedOverMph(district: string, wet: boolean, night: boolean): number;
  /** The pursuit's offense from the incident assessment, null unknown. `callId` is the call the incident log files the pursuit under (the owner scenario call, else the pursuit call). */
  offense(callId: number): string | null;
}

/** The resources module (wave 2) as the pursuit needs it (§4.5). */
export interface ResourcePort {
  /** Queue a request (same as `ResourceSystem.request({ kind: 'request', ... })`). */
  requestType(typeId: string, callId: number, via: 'radio' | 'mdt' | 'auto'): void;
  /** Callsign of a sergeant (or higher) assigned to `callId` (en route or on scene), null none. */
  supervisorFor(callId: number): string | null;
  /** Units of `typeId` on scene of `callId`. */
  onScene(callId: number, typeId: string): number;
  /** Callsigns of units of `typeId` on scene of `callId` (fills and returns `out`). */
  onSceneUnits(callId: number, typeId: string, out: string[]): string[];
  /** The air unit (null while at base): position and whether it is over its target. */
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

/** Traffic hooks used by the pursuit (the real `TrafficSystem` is assignable). */
export interface PursuitTrafficPort {
  fleeInfo(vehicleId: number, out: FleeInfo): boolean;
  deflate(vehicleId: number, tires: number): boolean;
  spinOut(vehicleId: number, dir: 1 | -1): boolean;
  crashCar(vehicleId: number): boolean;
  setFleeSpeedCap(vehicleId: number, capMps: number): boolean;
  setFleeTracked(vehicleId: number, tracked: boolean): boolean;
  stopFlee(vehicleId: number): boolean;
  removeVehicle(vehicleId: number): boolean;
  slotOfVehicle(vehicleId: number): number;
  fleetState(index: number, out: FleetState): FleetState | null;
}

/** Dispatcher hooks used by the pursuit (the real `Dispatcher` is assignable). */
export interface PursuitDispatchPort {
  directUnit(callsign: string, x: number, z: number, urgency: 'respond' | 'emergency'): boolean;
  undirectUnit(callsign: string): void;
  aiUnitsOnCall(callId: number, out: string[]): string[];
  sendBackup(code: 2 | 3, n: number): string[];
}

export interface PursuitNpcPort {
  actorOfPerson(personId: number): number;
  actor(id: number, out: ActorInfo): ActorInfo | null;
  forceState(id: number, s: 'handsUp'): void;
}

export interface PursuitDeps {
  readonly seed: number;
  readonly bus: EventBus<EventMap>;
  /** `session.rng.stream('pursuit')`. */
  readonly rng: Rng;
  readonly graph: RoadGraph;
  readonly cad: CadState;
  readonly traffic: PursuitTrafficPort;
  readonly dispatcher: PursuitDispatchPort;
  readonly resources: ResourcePort;
  readonly scene: { request(r: SceneRequest): void };
  readonly npc: PursuitNpcPort;
  readonly rules: PursuitRulesPort;
  /** Registry model id of a vehicle (`vehicleRecord(seed, id).modelId`). */
  modelOf(vehicleId: number): string;
  /** District name and effective limit at (x, z). */
  roadAt(x: number, z: number): { district: string; limitMph: number };
  env(): { wet: boolean; night: boolean };
  trafficDensity(x: number, z: number): number;
  readonly config?: PursuitConfig;
}
