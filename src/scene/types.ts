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
import type { InteriorLayout } from '../interior/types';
import type { NpcSystem } from '../npc/npcSystem';
import type { Population } from '../people/population';
import type { RecordsDb } from '../records/db';
import type { TrafficSystem } from '../traffic/trafficSystem';
import type { SceneConfig } from './data';
import type { IndoorConfig } from './indoor';
import type { BuildingIndex, BuildingInfo } from '../world/buildings';
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

// --- Phase 4 ports (structural: the integrator wires the real objects, `tsc` checks assignability) ----------------

/** Door state names of the interior system. */
export type SceneDoorState = 'closed' | 'open' | 'locked' | 'broken';

/** What the scene reads and drives of the `InteriorSystem` (design §12.2). */
export interface SceneInteriorsPort {
  /** Building the officer is in, -1 outdoors. */
  readonly officerBuilding: number;
  layout(buildingId: number): InteriorLayout | null;
  building(buildingId: number): BuildingInfo | null;
  setDoorState(buildingId: number, door: number, state: SceneDoorState): void;
  doorState(buildingId: number, door: number): SceneDoorState;
  /** Optional: reserves a hiding spot so the npc hide reaction does not pick it (`InteriorSystem.claimHideSpot`). */
  claimHideSpot?(buildingId: number, index: number): void;
}

/** The buildings the scene binds calls to (a `BuildingIndex`). */
export type SceneBuildingsPort = Pick<BuildingIndex, 'nearestEntrance' | 'building'>;

/** Evidence placed by the scene (structurally `PlaceItemSpec` of the investigation module). */
export interface ScenePlaceItem {
  callId: number;
  item: string;
  label: string;
  x: number;
  /** Metres above the floor for interior items, the world height outdoors. */
  y: number;
  z: number;
  buildingId: number;
  room: number;
  furniture: number;
  container: 'none' | 'drawer' | 'cabinet' | 'closet' | 'safe';
  concealed: boolean;
  ownerPersonId: number;
  incriminating: boolean;
}

/** Structurally `CaseSummary` of the investigation module. */
export interface CaseSummaryLike {
  items: number;
  found: number;
  plainView: number;
  suppressed: number;
  collected: number;
  custodyComplete: boolean;
  photos: number;
  markers: number;
  prints: number;
  canvass: number;
  consents: number;
  bodycam: boolean;
}

/** Structurally the investigation system's `EvidencePort` side. */
export interface SceneEvidencePort {
  placeItem(spec: ScenePlaceItem): string;
  removeCallItems(callId: number): void;
  summary(callId: number): CaseSummaryLike;
}

/** What the investigation module reads of a call (structurally `CallContext`; `SceneDirector.callContext`). */
export interface SceneCallContext {
  exigency: boolean;
  warrant: boolean;
  readonly arrests: readonly { personId: number; buildingId: number; room: number; sim: number }[];
  buildingId: number;
  family: string;
  suspectPersonId: number;
  anchorX: number;
  anchorZ: number;
  /** The call's family offers the `requestK9` action. */
  k9: boolean;
}

/** An arrest made on a call, with where it happened (`custody:<role>`). */
export interface SceneArrest {
  personId: number;
  buildingId: number;
  room: number;
  sim: number;
}

/** Payload of the `interior:door` topic (`scene.onDoorEvent`). */
export interface SceneDoorEvent {
  buildingId: number;
  door: number;
  action: string;
  success: boolean;
  x: number;
  z: number;
  by: string;
}

/** Payload of the `npc:aware` topic (`scene.onNpcAware`). */
export interface SceneAwareEvent {
  actorId: number;
  personId: number;
  callId: number;
  level: 'alert' | 'aware';
  reaction: string;
  cause: string;
}

/** Payload shapes of the investigation topics the scene reads (`scene.onInvestigation`). */
export interface InvestigationPayloads {
  'investigation:photo': { callId: number };
  'investigation:collected': { callId: number };
  'investigation:canvass': { callId: number };
  'investigation:tape': { callId: number; closed: boolean; points: number[] };
  'investigation:plainView': { callId: number; itemId: string };
  'investigation:custodyComplete': { callId: number };
  'investigation:k9Alert': { callId: number; kind: 'person' | 'item'; actorId: number };
}
export type InvestigationTopic = keyof InvestigationPayloads;

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
  /** Phase 4: the interior system. Calls bind to a building only when both `interiors` and `buildings` are given. */
  readonly interiors?: SceneInteriorsPort;
  readonly buildings?: SceneBuildingsPort;
  /** Phase 4: evidence goes through this port (ground evidence of every call; tool rows of the panel are then hints). */
  readonly evidence?: SceneEvidencePort;
  /** Phase 4: weapons signed out of the armory (default both). */
  weaponsAvailable?(): { sidearm: boolean; taser: boolean };
  /** Indoor rules override (tests); default `src/data/scene/indoor.json`. */
  readonly indoorConfig?: IndoorConfig;
  /** Phase 5: neighbourhood trust 0..1 at a point; replaces `trustOf(district)` in the context of a shouted command. */
  trustAt?(x: number, z: number): number;
  /** Phase 5: multiplies the dispatch-error rates of a new scenario (`ScenarioInput.errorScale`; tips quality) at the call location. */
  errorScaleAt?(x: number, z: number): number;
  /** Phase 5: chance 0..1 of hostile onlookers when an outdoor call sees an arrest or force; the roll only happens when given. */
  hostilityAt?(x: number, z: number): number;
}

/** The officer as the scene sees them each step. */
export interface OfficerFocus {
  x: number;
  z: number;
  yaw: number;
  speed: number;
  onFoot: boolean;
  /** Building the officer is in (interior level), -1 or absent outdoors. */
  building?: number;
}

export type SceneRequest =
  | { readonly kind: 'weapon' }
  | { readonly kind: 'fire'; readonly dirX: number; readonly dirZ: number }
  | { readonly kind: 'tackle' }
  | { readonly kind: 'shout' }
  /**
   * Phase 5: the officer calls off the active vehicle pursuit (the car keeps running; it counts as escaped).
   * Phase 6: `reason: 'handoff'` ends it as a jurisdiction handoff (end reason `handoff`, flag `pursuitHandoff`).
   */
  | { readonly kind: 'terminatePursuit'; readonly reason?: 'terminated' | 'handoff' }
  /** Phase 6: a real unit was requested for `service` on the call (same as pressing the action); ignored without a scenario or when already requested. */
  | { readonly kind: 'serviceRequest'; readonly callId: number; readonly service: string }
  /** Phase 6: the real unit of `service` arrived (applies the service's flags and effect without the scene's arrival line). */
  | { readonly kind: 'serviceArrived'; readonly callId: number; readonly service: string }
  /** Phase 6: a backup officer cuffed `personId` (flag `custody:<role>`, custody arrested; no radio line). */
  | { readonly kind: 'custody'; readonly callId: number; readonly personId: number; readonly by: string }
  /** Phase 6: the command module sets a flag listed in `scene.json` `commandFlags`. */
  | { readonly kind: 'commandFlag'; readonly callId: number; readonly flag: string }
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
  /** Phase 6: a real unit (resources module) serves the request: `dueSim` is Infinity, no scene acknowledgement or arrival line. */
  external?: boolean;
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
  /** Phase 4: the building the call is bound to (design §12.1), -1 outdoors. */
  buildingId: number;
  /** Per participant: the hiding spot index of a hidden actor inside the building, -1 none. */
  hideSpots: number[];
  /** Sim second the officer knocked (-1 never). */
  knockedSim: number;
  /** Sim second a resident answers the knock (-1 none pending). */
  answerDueSim: number;
  /** Arrests made on the call, with where. */
  arrests: SceneArrest[];
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
  /** Phase 4 (present on bound calls): the building the call was bound to, -1 outdoors. */
  buildingId?: number;
  /** Phase 4: the legal basis the officer entered the building on (`consent`, `exigency`, `warrant`, `publicArea`, `none`), null when never inside. */
  entry?: string | null;
  /** Phase 4: the case file summary (present when the scene has an evidence port). */
  case?: CaseSummaryLike;
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
