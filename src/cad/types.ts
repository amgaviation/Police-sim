/**
 * Shared CAD contract of Phase 2 wave 2 (design §6.1): dispatch, radio, MDT and HUD build on these
 * shapes without importing each other. Everything here is plain data (JSON-safe) so it can be saved.
 */

export type Priority = 1 | 2 | 3 | 4;

export const UNIT_STATUSES = ['available', 'enRoute', 'onScene', 'busy', 'outOfService', 'transporting'] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

export type RequestVia = 'radio' | 'mdt' | 'voice' | 'key' | 'auto';
export const REQUEST_VIAS: readonly RequestVia[] = ['radio', 'mdt', 'voice', 'key', 'auto'];

export type RadioMode = 'tenCode' | 'plain';

/** Sim time drives timers; game time (30x) is only displayed (design §2). */
export interface CadTime {
  readonly sim: number;
  readonly game: number;
}

export interface CadLocation {
  readonly x: number;
  readonly z: number;
  readonly edge: number;
  /** "1240 N Oak Street". */
  readonly text: string;
  readonly street: string;
  readonly cross: string;
  /** "Oak Street at 5th Street" or "1200 block of N Oak Street". */
  readonly near: string;
  readonly district: string;
}

export const CALLER_KINDS = ['citizen', 'anonymous', 'alarm', 'business', 'officer'] as const;
export type CallerKind = (typeof CALLER_KINDS)[number];

export interface CallerInfo {
  readonly kind: CallerKind;
  readonly name: string;
  readonly phone: string;
  /** Records person id, -1 for none. */
  readonly personId: number;
}

export interface NarrativeEntry {
  readonly sim: number;
  readonly game: number;
  readonly source: string;
  readonly text: string;
}

export const CALL_STATUSES = ['pending', 'active', 'closed'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export interface CadCall {
  readonly id: number;
  /** "C-00042". */
  readonly number: string;
  readonly typeId: string;
  priority: Priority;
  readonly nature: string;
  location: CadLocation;
  readonly caller: CallerInfo;
  readonly narrative: NarrativeEntry[];
  status: CallStatus;
  /** Assigned callsigns, in assignment order. */
  units: string[];
  primary: string | null;
  offeredTo: string | null;
  /** Sim seconds; meaningful only while `offeredTo` is set. */
  offerExpires: number;
  readonly created: CadTime;
  dispatched: CadTime | null;
  firstOnScene: CadTime | null;
  closed: CadTime | null;
  disposition: string | null;
  readonly selfInitiated: boolean;
  persons: number[];
  vehicles: number[];
  /** Document ids linked to the call (documents created with this `callId`). */
  documents: string[];
  /** Ids of linked calls (duplicate reports, a pursuit and its stop); symmetric. */
  links: number[];
}

/** `resource` (Phase 6): a unit owned by the resources module (K9, EMS, fire, ...), tracked in CAD only. */
export type UnitKind = 'player' | 'ai' | 'resource';

export interface CadUnit {
  readonly callsign: string;
  readonly kind: UnitKind;
  readonly officer: string;
  readonly beat: string;
  /** Fleet car index of an AI unit, -1 for the player. */
  readonly fleetIndex: number;
  status: UnitStatus;
  callId: number | null;
  statusSince: CadTime;
  x: number;
  z: number;
  emergency: boolean;
}

export const STOP_ACTIONS = ['license', 'vin', 'warn', 'release', 'arrest'] as const;
export type StopAction = (typeof STOP_ACTIONS)[number];

export type UnitRequest =
  | { readonly kind: 'status'; readonly status: UnitStatus }
  | { readonly kind: 'acceptCall'; readonly callId: number }
  | { readonly kind: 'declineCall'; readonly callId: number }
  | { readonly kind: 'selfAssign'; readonly callId: number }
  | { readonly kind: 'clearCall'; readonly callId: number; readonly disposition: string }
  | { readonly kind: 'narrative'; readonly callId: number; readonly text: string }
  /** `vehicleId` -1 when the plate was typed. */
  | { readonly kind: 'runPlate'; readonly plate: string; readonly vehicleId: number }
  | { readonly kind: 'runPerson'; readonly personId: number }
  | { readonly kind: 'backup'; readonly code: 2 | 3 }
  | { readonly kind: 'location' }
  | { readonly kind: 'code4' }
  | { readonly kind: 'emergency' }
  /** Phase 6: request a resource unit type (K9, EMS, fire, ...); handled by the resources module, not the dispatcher. */
  | { readonly kind: 'resource'; readonly typeId: string }
  /** Announce / confirm the current stop. */
  | { readonly kind: 'trafficStop' }
  /** `personId` = the identity the driver claimed (-1 / absent: none), handled by the dispatcher. */
  | { readonly kind: 'stopContact'; readonly action: StopAction; readonly personId?: number }
  | { readonly kind: 'repeat' };

export type ReadbackSeverity = 'clear' | 'caution' | 'alert';

/** Structurally identical to records' `PlateSummary`. */
export interface PlateReadback {
  readonly plate: string;
  readonly found: boolean;
  readonly description: string;
  readonly owner: string;
  readonly ownerPersonId: number;
  readonly hits: readonly string[];
  readonly severity: ReadbackSeverity;
}

/** Structurally identical to records' `PersonSummary`. */
export interface PersonReadback {
  readonly personId: number;
  readonly name: string;
  readonly dob: string;
  readonly dl: string;
  readonly dlStatus: string;
  readonly hits: readonly string[];
  readonly severity: ReadbackSeverity;
}

export const STOP_OUTCOMES = ['active', 'released', 'arrest', 'lost'] as const;
export type StopOutcome = (typeof STOP_OUTCOMES)[number];

export interface TrafficStopInfo {
  callId: number;
  readonly vehicleId: number;
  readonly plate: string;
  x: number;
  z: number;
  readonly started: CadTime;
  /** -1 until the licence was requested. */
  driverId: number;
  readonly trueDriverId: number;
  plateRun: boolean;
  vinChecked: boolean;
  vinResult: string;
  /** Citation document ids issued on this stop. */
  citations: string[];
  outcome: StopOutcome;
}
