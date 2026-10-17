/**
 * Scene director contracts (Phase 3 design §11.9). `ContactTarget`, `IncidentInfo`, `IncidentResolver`,
 * `Presence` and `ContactPort` are structural copies of the contact module's shapes (design §10.2): the
 * scene must not import `src/contact`, the integrator's `tsc` checks they stay assignable.
 */
import type { CadState } from '../cad/cadState';
import type { CadTime } from '../cad/types';
import type { Grade, Scenario, VariantKind } from '../calls';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import type { Dispatcher } from '../dispatch/dispatcher';
import type { IncidentTruth } from '../dialogue/types';
import type { NpcSystem } from '../npc/npcSystem';
import type { Population } from '../people/population';
import type { RecordsDb } from '../records/db';
import type { TrafficSystem } from '../traffic/trafficSystem';
import type { SceneConfig } from './data';
import type { City } from '../world/city';

// --- Structural copies of the contact module (design §10.2) ------------------------------------------

export type ContactTarget =
  | { readonly kind: 'actor'; readonly actorId: number }
  | { readonly kind: 'ped'; readonly slot: number }
  | { readonly kind: 'occupant'; readonly vehicleId: number; readonly seat: number };

export interface IncidentInfo {
  /** "C-00042" (a call number) or "FC-<personId>-<epochDay>". */
  readonly key: string;
  readonly callId: number;
  readonly role: string;
  readonly truth: IncidentTruth;
  readonly guilty: boolean;
  /** The vehicle this person is associated with, -1 for none. */
  readonly vehicleId: number;
  /** Traffic-stop driver or passenger. */
  readonly stop: boolean;
}

export interface IncidentResolver {
  resolveIncident(personId: number, target: ContactTarget): IncidentInfo | null;
}

export type OfficerWeapon = 'none' | 'sidearm' | 'taser';

export interface Presence {
  readonly lights: boolean;
  readonly siren: boolean;
  readonly backup: number;
  readonly weapon: OfficerWeapon;
}

/** What the scene needs from the contact manager (structurally `ContactManager`). */
export interface ContactPort {
  open(target: ContactTarget, incident: IncidentInfo | null, t: CadTime): number;
  attachCall(incident: string, callId: number, role?: string): void;
}

// --- Dependencies and requests -----------------------------------------------------------------------

export interface PatrolCarInfo {
  readonly eid: number;
  readonly lightbar: boolean;
  readonly siren: boolean;
}

export interface SceneDeps {
  readonly seed: number;
  readonly city: City;
  readonly bus: EventBus<EventMap>;
  readonly cad: CadState;
  readonly records: RecordsDb;
  readonly people: Population;
  readonly npc: NpcSystem;
  readonly traffic: TrafficSystem;
  readonly dispatcher: Dispatcher;
  readonly contact: ContactPort;
  /** `session.rng.stream('scene')`. */
  readonly rng: Rng;
  /** The officer's trunk kit: `carried` counts an item, `use` consumes it (false when missing). */
  kit(): { carried(item: string): number; use(item: string, n: number): boolean };
  patrolCars(): readonly PatrolCarInfo[];
  /** Optional wall-clock milliseconds, used only for `stats.stepMs` (`performance.now` is forbidden here). */
  readonly clock?: () => number;
  /** Tuning override (tests); default `src/data/scene/scene.json`. */
  readonly config?: SceneConfig;
}

/** The officer as the scene sees them each step. */
export interface OfficerFocus {
  x: number;
  z: number;
  yaw: number;
  speed: number;
  onFoot: boolean;
}

export type SceneRequest =
  | { readonly kind: 'weapon' }
  | { readonly kind: 'fire'; readonly dirX: number; readonly dirZ: number }
  | { readonly kind: 'tackle' }
  | { readonly kind: 'shout' }
  | { readonly kind: 'action'; readonly callId: number; readonly actionId: string }
  | { readonly kind: 'clear'; readonly callId: number; readonly disposition: string | null };

// --- Runtime state -----------------------------------------------------------------------------------

export type ActionStateKind = 'done' | 'running' | 'requested';

export interface ActionState {
  id: string;
  state: ActionStateKind;
  /** Sim second a running action completes (-1 otherwise). */
  dueSim: number;
}

export interface ServiceState {
  kind: string;
  /** Sim second the service arrives. */
  dueSim: number;
  arrived: boolean;
  /** Sim second a delayed effect (the tactical team's resolution) happens, -1 none. */
  effectDueSim: number;
  /** Sim second the dispatcher acknowledges the request on the radio, -1 none. */
  ackDueSim: number;
}

/** Live state of one scenario (design §11.1). */
export interface ScenarioRuntime {
  readonly scenario: Scenario;
  readonly flags: Set<string>;
  createdSim: number;
  materialized: boolean;
  /** Per participant: the actor id, 0 = not spawned. */
  actorIds: number[];
  timelineIdx: number;
  /** Sim second the officer arrived, -1 before. */
  arrivedSim: number;
  actions: ActionState[];
  services: ServiceState[];
  ambushArmed: boolean;
  forceUsed: string[];
  /** Calls whose scenarios share this one's pursuit / driver flags (a subject vehicle's own scenario). */
  mirror: number[];
}

/** Graded result of a call (Phase 5 input; design §11.7). */
export interface CallOutcome {
  callId: number;
  number: string;
  typeId: string;
  family: string;
  variants: VariantKind[];
  branch: string;
  outcomeId: string;
  suggested: string;
  /** What CAD recorded. */
  disposition: string;
  grade: Grade;
  flags: string[];
  materialized: boolean;
  resolvedBy: 'player' | 'ai';
  createdSim: number;
  /** -1 when the officer never arrived. */
  arrivedSim: number;
  closedSim: number;
  forceUsed: string[];
}

export interface SceneHud {
  readonly scene: { readonly title: string; readonly objectives: readonly { readonly text: string; readonly done: boolean }[] } | null;
  readonly pursuit: string | null;
}

export interface SceneStats {
  scenarios: number;
  materialized: number;
  stepMs: number;
}
