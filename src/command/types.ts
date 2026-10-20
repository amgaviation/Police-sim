/**
 * Incident command types (Phase 6 design §11): triage, levels, negotiation, requests, views and the structural ports the
 * command system consumes. Pure type and id-list module (no runtime dependencies).
 */
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import type { CadState } from '../cad/cadState';
import type { CadTime } from '../cad/types';
import type { ActorInfo } from '../npc/types';
import type { SceneRequest } from '../scene/types';
import type { RoadGraph } from '../world/roadGraph';

// --- Id lists (§4.1) -------------------------------------------------------------------------------------

/** START triage tags: green, yellow, red, black. */
export const TRIAGE_TAGS = ['minor', 'delayed', 'immediate', 'expectant'] as const;
export type TriageTag = (typeof TRIAGE_TAGS)[number];

/** Command levels of an incident. */
export const COMMAND_LEVELS = ['none', 'incident', 'major', 'disaster'] as const;
export type CommandLevel = (typeof COMMAND_LEVELS)[number];

/** Outcomes of a negotiation. */
export const NEGOTIATION_OUTCOMES = ['ongoing', 'surrender', 'stalled', 'breakdown'] as const;
export type NegotiationOutcome = (typeof NEGOTIATION_OUTCOMES)[number];

/** Negotiation stages in order. */
export const NEGOTIATION_STAGES = ['contact', 'rapport', 'problem', 'resolution'] as const;
export type NegStage = (typeof NEGOTIATION_STAGES)[number];

/** Officer tone (identical to `Tone` of the dialogue panel). */
export const NEGOTIATION_TONES = ['polite', 'neutral', 'commanding', 'aggressive'] as const;
export type NegTone = (typeof NEGOTIATION_TONES)[number];

/** SWAT commands the command panel forwards to the backup module. */
export const COMMAND_SWAT_COMMANDS = ['stage', 'stack', 'breach', 'clear', 'hold', 'withdraw'] as const;
export type CommandSwatCommand = (typeof COMMAND_SWAT_COMMANDS)[number];

/** Subject temperaments (identical to the people module's `Temperament`). */
export type NegTemperament = 'calm' | 'timid' | 'irritable' | 'volatile';

// --- Triage ----------------------------------------------------------------------------------------------

/** What a rescuer can read from a patient in about six seconds (START inputs plus two scene facts). */
export interface Vitals {
  walking: boolean;
  breathing: boolean;
  breathesAfterAirway: boolean;
  respRate: number;
  radialPulse: boolean;
  capRefillS: number;
  followsCommands: boolean;
  trapped: boolean;
  contaminated: boolean;
}

/** What the transport order needs of a victim. */
export interface TransportCandidate {
  personId: number;
  tag: TriageTag | null;
  transported: boolean;
  trapped: boolean;
  contaminated: boolean;
}

// --- Configuration (command.json) --------------------------------------------------------------------------

export type TransportTag = 'immediate' | 'delayed' | 'minor';

export interface CommandConfig {
  readonly levels: {
    /** Family id -> the command level of a call of that family. */
    readonly families: Readonly<Record<string, Exclude<CommandLevel, 'none'>>>;
    readonly majorUnitsOnScene: number;
  };
  readonly post: { readonly standoffM: number; readonly autoOnArrival: boolean };
  readonly triage: {
    readonly roles: readonly string[];
    readonly assessS: number;
    readonly rangeM: number;
    readonly aiAssessS: number;
    readonly aiErrorRate: number;
  };
  readonly transport: {
    readonly order: readonly TransportTag[];
    readonly loadS: number;
    readonly perUnit: Readonly<Record<TransportTag, number>>;
  };
  readonly fire: { readonly extricateS: number; readonly deconS: number };
  readonly tcp: { readonly radiusM: number; readonly max: number; readonly blockadeRadiusM: number };
  readonly evac: {
    readonly radiusM: { readonly hazmat: number; readonly package: number; readonly barricade: number; readonly default: number };
    readonly buildingS: number;
    readonly fireFactor: number;
    readonly segments: number;
  };
  readonly inner: { readonly offsetM: number };
  readonly needs: {
    readonly emsPerImmediate: number;
    readonly emsPerDelayed: number;
    readonly firePerTrapped: number;
    readonly fireHazmat: number;
    readonly maxEms: number;
    readonly maxFire: number;
  };
  readonly negotiation: {
    readonly startTrust: number;
    readonly startAgitation: number;
    readonly surrenderTrust: number;
    readonly surrenderAgitation: number;
    readonly surrenderTurns: number;
    readonly breakdownAgitation: number;
    readonly stallTurns: number;
    readonly noiseSd: number;
    readonly negotiatorBonus: number;
  };
}

/** One thing the officer can say to the subject. */
export interface NegotiationOption {
  readonly id: string;
  readonly text: string;
  /** Trust change at neutral tone. */
  readonly trust: number;
  /** Agitation change. */
  readonly agitation: number;
  /** Stages in which the option is appropriate. */
  readonly stages: readonly NegStage[];
  /** Trust needed before the option is appropriate. */
  readonly minTrust?: number;
}

export interface NegotiationCategory {
  readonly id: string;
  readonly label: string;
  readonly options: readonly NegotiationOption[];
}

export interface NegotiationData {
  readonly categories: readonly NegotiationCategory[];
  readonly replies: {
    readonly calm: readonly string[];
    readonly neutral: readonly string[];
    readonly agitated: readonly string[];
    readonly surrender: readonly string[];
    readonly breakdown: readonly string[];
  };
  readonly toneFactor: Readonly<Record<NegTone, number>>;
  readonly stageTrust: Readonly<Record<NegStage, number>>;
  readonly subject: {
    readonly temperament: Readonly<Record<NegTemperament, number>>;
    readonly hostage: number;
    readonly intoxicated: number;
    readonly crisis: number;
  };
}

// --- Negotiation state -------------------------------------------------------------------------------------

export interface NegState {
  trust: number;
  agitation: number;
  turns: number;
  goodTurns: number;
  stage: NegStage;
  outcome: NegotiationOutcome;
  lastReply: string;
  /** Alternating lines: officer, subject, officer, subject, ... (the last 60). */
  history: string[];
}

export interface NegSubject {
  temperament: NegTemperament;
  hostage: boolean;
  intoxicated: boolean;
  crisis: boolean;
}

/** One category of `negotiationOptions`. */
export interface NegotiationMenuCategory {
  category: string;
  label: string;
  options: { id: string; text: string; enabled: boolean; hint: string }[];
}

// --- Requests and views ---------------------------------------------------------------------------------------

/** Plan changes of a SWAT command (same shape as the backup port). */
export interface SwatPlan {
  entry?: 'front' | 'rear';
  tempo?: 'deliberate' | 'dynamic';
  lessLethal?: boolean;
}

/** Everything the UI, the console and the radio ask of the command system (applied at the start of the next step). */
export type CommandRequest =
  | { readonly kind: 'establish'; readonly callId?: number }
  /** Start assessing the nearest untagged victim in range. */
  | { readonly kind: 'assess' }
  | { readonly kind: 'tag'; readonly personId: number; readonly tag: TriageTag }
  | { readonly kind: 'tcp'; readonly on: boolean }
  | { readonly kind: 'evacuate' }
  | { readonly kind: 'contain' }
  | { readonly kind: 'requestNeeds' }
  | { readonly kind: 'negotiate'; readonly optionId: string; readonly tone: NegTone }
  | { readonly kind: 'negotiationOpen' }
  | { readonly kind: 'negotiationClose' }
  | { readonly kind: 'swat'; readonly command: CommandSwatCommand; readonly plan?: SwatPlan }
  | { readonly kind: 'standDown' };

export interface CommandPostView {
  callId: number;
  level: string;
  x: number;
  z: number;
  commander: string;
}

export interface VictimRow {
  personId: number;
  actorId: number;
  label: string;
  tag: TriageTag | null;
  by: 'player' | 'ems' | null;
  correct: boolean | null;
  trapped: boolean;
  contaminated: boolean;
  transported: boolean;
}

export interface CommandBoard {
  post: CommandPostView | null;
  victims: readonly VictimRow[];
  counts: Record<TriageTag | 'untagged', number>;
  tcps: { staffed: number; total: number };
  evac: { progress: number; radiusM: number } | null;
  inner: { staffed: number; total: number } | null;
  swat: string | null;
  negotiation: { trust: number; agitation: number; outcome: string; stage: string } | null;
  needs: { ems: number; fire: number; supervisor: number };
  units: readonly { callsign: string; label: string; status: string; etaS: number }[];
}

/** What the triage panel shows. It never contains the START answer (graded inside the system only). */
export interface TriagePrompt {
  personId: number;
  label: string;
  /** 0..1 while assessing. */
  progress: number;
  /** Set once assessed. */
  vitals: Vitals | null;
  tag: TriageTag | null;
}

// --- Ports (§4.5, declared by the consumer; the integrator wires the real objects) ------------------------------

/** The resources module as the command system sees it. */
export interface ResourcePort {
  /** Queue a request (same as ResourceSystem.request({ kind: 'request', ... })). */
  requestType(typeId: string, callId: number, via: 'radio' | 'mdt' | 'auto'): void;
  /** Callsign of a sergeant (or higher) assigned to `callId` (en route or on scene), null none. */
  supervisorFor(callId: number): string | null;
  /** Units of `typeId` on scene of `callId`. */
  onScene(callId: number, typeId: string): number;
  /** Callsigns of units of `typeId` on scene of `callId` (fills and returns `out`). */
  onSceneUnits(callId: number, typeId: string, out: string[]): string[];
  /** EMS unit `callsign` loads patient `personId` and drives to the hospital; false when not an on-scene EMS unit. */
  transport(callsign: string, personId: number): boolean;
}

/** A post the backup module staffs with an on-foot officer. */
export interface PostSpec {
  id: string;
  x: number;
  z: number;
  yaw: number;
  kind: 'inner' | 'tcp' | 'evac';
}

/** The backup module as the command system sees it. */
export interface BackupPort {
  /** Asks an available on-foot officer of the call to staff a post; returns the callsign or null when none is free. */
  staffPost(post: PostSpec): string | null;
  /** Releases every post of `kind` (all when omitted). */
  clearPosts(kind?: 'inner' | 'tcp' | 'evac'): void;
  /** Posts currently staffed (officer within 3 m of it). */
  staffed(kind: 'inner' | 'tcp' | 'evac'): number;
  /** A SWAT command (+ optional plan change) for the team on `callId`'s building; returns the reply text. */
  swat(callId: number, command: CommandSwatCommand, plan?: SwatPlan): string;
  /** SWAT phase on the call ('enRoute' when the team has not arrived, null when no SWAT unit is assigned). */
  swatPhase(callId: number): string | null;
}

export interface CommandParticipant {
  role: string;
  personId: number;
  actorId: number;
  injured: boolean;
  deceased: boolean;
}

export interface CommandBuilding {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  door: { x: number; z: number };
}

export interface CommandDeps {
  readonly seed: number;
  readonly bus: EventBus<EventMap>;
  /** session.rng.stream('command'). */
  readonly rng: Rng;
  readonly graph: RoadGraph;
  readonly cad: CadState;
  readonly scene: {
    request(r: SceneRequest): void;
    participants(callId: number): CommandParticipant[];
    hasScenario(callId: number): boolean;
    familyOf(callId: number): string | null;
    flagsOf(callId: number): ReadonlySet<string> | null;
    buildingOfCall(callId: number): number;
  };
  readonly npc: {
    actor(id: number, out: ActorInfo): ActorInfo | null;
    removeActor(id: number): void;
    forceState(id: number, s: 'leave' | 'handsUp'): void;
    actorsOfCall(callId: number, out: number[]): number[];
    walkTo(id: number, x: number, z: number): void;
  };
  readonly people: {
    identity(id: number): { temperament: NegTemperament; mental: string };
    intoxication(id: number): { bac: number; drug: string };
    setInjured(id: number, v: number): void;
  };
  readonly resources: ResourcePort;
  readonly backup: BackupPort;
  /** BuildingIndex.near: number of buildings within `r` of (x, z). */
  buildingsNear(x: number, z: number, r: number): number;
  /** BuildingIndex.building. */
  building(id: number): CommandBuilding | null;
  /** Optional live ETA (s) of an en-route unit, -1 unknown (the MDT's `eta`). */
  eta?(callsign: string): number;
  readonly config?: CommandConfig;
}

/** The player's situation, passed to every `step`. */
export interface CommandContext {
  x: number;
  z: number;
  yaw: number;
  onFoot: boolean;
  /** Building the player is in, -1 outdoors. */
  building: number;
  /** The player's current call, 0 (or less) none. */
  callId: number;
}

/** Re-export so consumers of this module need not reach into the cad module for the step time. */
export type { CadTime };
