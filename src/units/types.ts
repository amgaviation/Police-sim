/**
 * Phase 6 unit types, roster and response-time contracts (design §4.1-§4.3, §5). The id lists are
 * the single source of the ids other Phase 6 modules re-declare; do not reorder or rename them.
 */

// --- Fixed id lists (§4.1) ----------------------------------------------------------

/** What a unit does on scene (design §8.5). */
export const UNIT_BEHAVIORS = [
  'patrol', 'supervisor', 'command', 'k9', 'swat', 'air', 'ems', 'fire', 'tow', 'coroner', 'detectives', 'csu',
  'animalControl', 'bombSquad', 'negotiator', 'statePatrol', 'federal',
] as const;
export type UnitBehavior = (typeof UNIT_BEHAVIORS)[number];

/** Who handles a request: the Phase 2 dispatcher (`backup2` / `backup3` / `emergency`) or `ResourceSystem` (`resource`). */
export const SEND_KINDS = ['backup2', 'backup3', 'emergency', 'resource'] as const;
export type SendKind = (typeof SEND_KINDS)[number];

/** Where a resource unit starts, returns to and is spawned. */
export const UNIT_BASES = ['station', 'hospital', 'airport', 'harbor', 'highway', 'edge'] as const;
export type UnitBase = (typeof UNIT_BASES)[number];

export const RANKS = ['officer', 'sergeant', 'lieutenant', 'chief'] as const;
export type Rank = (typeof RANKS)[number];

/** Roster events that move stress or loyalty (`roster.json`). */
export const ROSTER_EVENTS = [
  'shotsFired', 'weaponSeen', 'fight', 'forceUsed', 'pursuitMinute', 'callHandled', 'coveredByPlayer', 'abandoned',
  'intervenedOnThem', 'requestedAndArrived', 'officerInjured',
] as const;
export type RosterEvent = (typeof ROSTER_EVENTS)[number];

export const MISTAKE_KINDS = ['lateCallout', 'poorPosition', 'excessiveForce'] as const;
export type MistakeKind = (typeof MISTAKE_KINDS)[number];

// --- Shared payloads (§4.3) ---------------------------------------------------------

/** A radio line of a Phase 6 module; the integrator calls RadioSystem.say(channel === 'current' ? radio.channel : channel, text, speaker). */
export interface RadioLinePayload {
  channel: 'dispatch' | 'tac' | 'car' | 'fireEms' | 'county' | 'state' | 'current';
  speaker: string;
  text: string;
  /** Interrupts lower-priority traffic (radio net priority); default false. */
  priority?: boolean;
}

/** A HUD one-liner (`<module>:flash`). */
export interface FlashPayload {
  text: string;
}

// --- Unit types (§4.2) --------------------------------------------------------------

/** Radio channel ids a unit type may use (the Phase 2 channels). */
export const UNIT_CHANNELS = ['dispatch', 'tac', 'car', 'fireEms', 'county', 'state'] as const;
export type UnitChannel = (typeof UNIT_CHANNELS)[number];

/** On-foot figures a resource unit shows on scene. */
export interface UnitCrew {
  readonly count: number;
  readonly dog: boolean;
  /** `"#rrggbb"` jacket colour and its 0xRRGGBB value. */
  readonly top: string;
  readonly topRgb: number;
  readonly bottom: string;
  readonly bottomRgb: number;
}

/**
 * One requestable or chain-of-command unit type. Types that go to the Phase 2 dispatcher
 * (`send !== 'resource'`) carry neutral defaults for the resource fields (`callsign ''`, `count 0`,
 * `vehicle 'none'`, `crew.count 0`, `sceneServices []`, `rank null`).
 */
export interface UnitType {
  readonly id: string;
  readonly label: string;
  /** Radio menu line (at most 28 characters). */
  readonly menu: string;
  readonly voice: readonly string[];
  readonly requestable: boolean;
  /** Radio menu / MDT order, unique among requestable types; null when not requestable. */
  readonly menuOrder: number | null;
  readonly send: SendKind;
  readonly behavior: UnitBehavior;
  readonly resolves: string;
  /** Callsign template with `{n}` (resource types). */
  readonly callsign: string;
  readonly count: number;
  /** Vehicle model id, or `'none'` for the air unit (and the patrol types). */
  readonly vehicle: string;
  /** Fleet car body colour (`"#rrggbb"`) and its 0xRRGGBB value. */
  readonly color: string;
  readonly colorRgb: number;
  readonly base: UnitBase;
  /** Turnout seconds for priority 1 and priority 4 (interpolated by priority). */
  readonly turnoutS: readonly [number, number];
  readonly speedFactor: number;
  readonly crew: UnitCrew;
  readonly sceneServices: readonly string[];
  /** Stay after arrival when no work keeps the unit (sim seconds, [min, max]). */
  readonly onSceneS: readonly [number, number];
  readonly channel: UnitChannel;
  readonly rank: Rank | null;
}

export interface UnitTypesData {
  /** First traffic fleet index of the resource units (the six patrol units use 0..5). */
  readonly fleetIndexBase: number;
  readonly maxFleetCars: number;
  readonly airSpeedMps: number;
  readonly airAltitudeM: number;
  readonly types: readonly UnitType[];
}

/** One expanded unit of a resource type (design §5.2). */
export interface ResourceSlot {
  readonly typeId: string;
  readonly callsign: string;
  /** 1..count. */
  readonly index: number;
  /** Traffic fleet index; -1 for the air unit. */
  readonly fleetIndex: number;
}

// --- Response time (§5.3) -----------------------------------------------------------

export type Urgency = 'routine' | 'respond' | 'emergency';

export interface EtaConfig {
  readonly urgencyFactor: Readonly<Record<Urgency, number>>;
  readonly trafficPenalty: Readonly<Record<Urgency, number>>;
  readonly wetPenalty: number;
  readonly minTravelS: number;
  readonly rankCandidates: number;
}

export interface EtaInput {
  /** `PointRoute.time` (s, at the posted limits incl. junction penalties); 0 when already there. */
  routeTimeS: number;
  routeLengthM: number;
  priority: 1 | 2 | 3 | 4;
  urgency: Urgency;
  /** 0..2: district traffic density x hour factor (1 = normal). */
  trafficDensity: number;
  /** 0..1 road wetness. */
  wetness: number;
  turnoutS: readonly [number, number];
  speedFactor: number;
}

export interface EtaResult {
  etaS: number;
  turnoutS: number;
  travelS: number;
}

// --- Roster (§5.4) ------------------------------------------------------------------

export interface OfficerTraits {
  aggression: number;
  discipline: number;
  experience: number;
  composure: number;
  communication: number;
}

export interface OfficerProfile {
  callsign: string;
  rank: Rank;
  first: string;
  last: string;
  /** "Sgt. M. Chen". */
  name: string;
  traits: OfficerTraits;
  /** 0xRRGGBB skin and hair for the figure. */
  skin: number;
  hair: number;
  /** Metres. */
  height: number;
}

export interface OfficerDynamic {
  stress: number;
  fatigue: number;
  loyalty: number;
  calls: number;
  mistakes: number;
  arrivals: number;
}

/** Chance of each mistake kind. */
export interface MistakeChances {
  lateCallout: number;
  poorPosition: number;
  excessiveForce: number;
}

/** Which mistakes happened on one roll. */
export interface MistakeRolls {
  lateCallout: boolean;
  poorPosition: boolean;
  excessiveForce: boolean;
}

/** One mistake kind's weights; missing trait keys count as 0. */
export interface MistakeWeights {
  readonly base: number;
  readonly stress: number;
  readonly fatigue: number;
  readonly loyalty: number;
  readonly aggression: number;
  readonly discipline: number;
  readonly experience: number;
  readonly composure: number;
  readonly communication: number;
}

export interface RosterConfig {
  readonly traits: Readonly<Record<keyof OfficerTraits, readonly [number, number]>>;
  readonly rankTitles: Readonly<Record<Rank, string>>;
  readonly stress: {
    readonly start: number;
    readonly decayPerMin: number;
    readonly events: Readonly<Partial<Record<RosterEvent, number>>>;
  };
  readonly fatigue: { readonly start: number; readonly perHour: number; readonly perCall: number; readonly max: number };
  readonly loyalty: { readonly start: readonly [number, number]; readonly events: Readonly<Partial<Record<RosterEvent, number>>> };
  readonly mistakes: Readonly<Record<MistakeKind, MistakeWeights>>;
  readonly maxChance: Readonly<Record<MistakeKind, number>>;
}

export interface RosterSave {
  version: 1;
  officers: {
    callsign: string;
    rank: Rank;
    stress: number;
    fatigue: number;
    loyalty: number;
    calls: number;
    mistakes: number;
    arrivals: number;
  }[];
}
