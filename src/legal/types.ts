/**
 * Legal engine types (Phase 5 design §4.3, §5.1, §5.4, §5.9). Pure: no DOM, no THREE, no other Phase 5 module.
 * The `IncidentLog` is the central contract between the incident recorder and every judge of the officer's conduct.
 */

// --- Fixed id lists (design §4.1) --------------------------------------------------------------

/** Camera state bits carried by every event. */
export const CAM = { body: 1, muted: 2, dash: 4 } as const;

export const RESISTANCE_LEVELS = ['compliant', 'passive', 'active', 'assaultive', 'lethal'] as const;
export type Resistance = (typeof RESISTANCE_LEVELS)[number];

export const FORCE_LEVELS = ['presence', 'verbal', 'softHands', 'hardHands', 'ocSpray', 'baton', 'taser', 'k9', 'lessLethal', 'firearm'] as const;
export type ForceLevel = (typeof FORCE_LEVELS)[number];

export const CONSENT_KINDS = ['entry', 'searchPremises', 'searchRoom', 'searchPerson', 'searchVehicle', 'pbt', 'sfst'] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

export const CLAIMED_BASES = ['plainView', 'consent', 'warrant', 'incidentToArrest', 'exigency', 'protectiveSweep', 'publicArea'] as const;
export type ClaimedBasis = (typeof CLAIMED_BASES)[number];

export const SEARCH_TARGETS = ['person', 'vehicle', 'premises', 'room', 'container'] as const;
export type SearchTarget = (typeof SEARCH_TARGETS)[number];

export const INDICATOR_SOURCES = ['observation', 'lookup', 'statement', 'evidence', 'test', 'call'] as const;
export type IndicatorSource = (typeof INDICATOR_SOURCES)[number];

export const DOCTRINES = [
  'detention', 'frisk', 'friskScope', 'search', 'arrest', 'consent', 'exigency', 'entry', 'miranda', 'test', 'force',
  'intervene', 'pursuit', 'recording', 'evidence',
] as const;
export type Doctrine = (typeof DOCTRINES)[number];

export const INCIDENT_EVENT_KINDS = [
  'start', 'person', 'indicator', 'detention', 'command', 'question', 'statement', 'miranda', 'consent', 'frisk', 'search',
  'seizure', 'test', 'arrest', 'charges', 'release', 'force', 'otherForce', 'intervene', 'entry', 'exigency', 'warrant',
  'service', 'pursuitStart', 'pursuitSample', 'pursuitEnd', 'advisory', 'cam', 'close',
] as const;

export const OFFENSES = ['traffic', 'dui', 'drugs', 'weapons', 'warrant', 'felonyVehicle', 'property', 'violent', 'obstruction'] as const;
export type Offense = (typeof OFFENSES)[number];

export const INDICATORS = [
  'trafficViolation', 'speeding', 'weaving', 'expiredRegistration', 'licenseInvalid', 'stolenVehicle', 'stolenPlate',
  'plateMismatch', 'ownerWarrant', 'warrantHit', 'boloMatch', 'odorAlcohol', 'admissionDrinking', 'sfstFail', 'bacOver',
  'odorCannabis', 'contrabandPlainView', 'contrabandFound', 'weaponSeen', 'weaponFound', 'weaponCall', 'callSuspect',
  'victimInjury', 'assaultOnOfficer', 'flight', 'falseIdentity',
] as const;
export type IndicatorId = (typeof INDICATORS)[number];

// --- Incident log (design §4.3) ----------------------------------------------------------------

/** An item found or seized. `ref` is the people item instance id or the investigation item id. */
export interface FoundItem { ref: string; item: string; label: string; category: string; weapon: boolean; incriminating: boolean }

/** Fields of every event. `personId` -1 = the incident as a whole (vehicle hits, call information). */
export interface EventBase { id: number; t: number; game: number; personId: number; cam: number }

export interface StartEvent extends EventBase { kind: 'start'; callId: number; typeId: string; family: string; field: boolean }
export interface PersonEvent extends EventBase { kind: 'person'; role: string; label: string }
export interface IndicatorEvent extends EventBase { kind: 'indicator'; indicator: string; source: IndicatorSource; sourceEvent: number; detail: string }
export interface DetentionEvent extends EventBase { kind: 'detention'; how: 'trafficStop' | 'command' | 'cuffed' | 'takedown' | 'other' }
export interface CommandEvent extends EventBase { kind: 'command'; command: string; outcome: string }
export interface QuestionEvent extends EventBase { kind: 'question'; fact: string; utterance: string; custody: boolean; gunpoint: boolean }
export interface StatementEvent extends EventBase { kind: 'statement'; fact: string; value: string; display: string; custody: boolean }
export interface MirandaEvent extends EventBase { kind: 'miranda'; result: 'waived' | 'invoked' | 'misunderstood'; custody: boolean }
export interface ConsentEvent extends EventBase { kind: 'consent'; consent: ConsentKind; granted: boolean; valid: boolean; weaponDrawn: boolean; aggressiveLines: number; buildingId: number }
export interface FriskEvent extends EventBase { kind: 'frisk'; found: FoundItem[] }
export interface SearchEvent extends EventBase { kind: 'search'; target: SearchTarget; claimedBasis: ClaimedBasis | null; found: FoundItem[]; buildingId: number; vehicleId: number }
export interface SeizureEvent extends EventBase { kind: 'seizure'; item: FoundItem; fromEvent: number }
export interface TestEvent extends EventBase { kind: 'test'; test: 'pbt' | 'sfst'; result: 'over' | 'under' | 'fail' | 'pass' }
export interface ArrestEvent extends EventBase { kind: 'arrest'; how: 'cuff' | 'booking' }
export interface ChargesEvent extends EventBase { kind: 'charges'; statutes: string[]; docId: string }
export interface ReleaseEvent extends EventBase { kind: 'release'; how: 'release' | 'warn' | 'citation' | 'uncuff' }
export interface ForceEvent extends EventBase {
  kind: 'force'; forceId: number; tool: string; level: ForceLevel; resistance: Resistance; hit: boolean;
  injury: number; fatal: boolean; cycle: number; riskFactors: string[]; distance: number; restrained: boolean;
}
export interface OtherForceEvent extends EventBase { kind: 'otherForce'; officer: string; level: ForceLevel; resistance: Resistance; distanceToOfficer: number; seq: number; restrained: boolean }
export interface InterveneEvent extends EventBase { kind: 'intervene'; otherEvent: number }
export interface EntryEvent extends EventBase { kind: 'entry'; buildingId: number; publicPlace: boolean }
/** `buildingId` limits the exigency to that building (absent or -1: the whole call). */
export interface ExigencyEvent extends EventBase { kind: 'exigency'; reason: string; buildingId?: number }
export interface WarrantEvent extends EventBase { kind: 'warrant'; scope: 'arrest' | 'search' }
export interface ServiceEvent extends EventBase { kind: 'service'; service: string; phase: 'requested' | 'arrived' }
export interface PursuitStartEvent extends EventBase { kind: 'pursuitStart'; pursuit: 'vehicle' | 'foot'; pursuitCallId: number }
export interface PursuitSampleEvent extends EventBase { kind: 'pursuitSample'; speedMph: number; limitMph: number; district: string; wet: boolean; night: boolean; lights: boolean; siren: boolean }
export interface PursuitEndEvent extends EventBase { kind: 'pursuitEnd'; reason: string }
export interface AdvisoryEvent extends EventBase { kind: 'advisory'; advisory: 'terminatePursuit' | 'activateBodycam'; text: string }
export interface CamEvent extends EventBase { kind: 'cam'; body: boolean; muted: boolean; dash: boolean }
export interface CloseEvent extends EventBase { kind: 'close'; disposition: string; outcomeId: string }

export type IncidentEvent = StartEvent | PersonEvent | IndicatorEvent | DetentionEvent | CommandEvent | QuestionEvent
  | StatementEvent | MirandaEvent | ConsentEvent | FriskEvent | SearchEvent | SeizureEvent | TestEvent | ArrestEvent
  | ChargesEvent | ReleaseEvent | ForceEvent | OtherForceEvent | InterveneEvent | EntryEvent | ExigencyEvent
  | WarrantEvent | ServiceEvent | PursuitStartEvent | PursuitSampleEvent | PursuitEndEvent | AdvisoryEvent | CamEvent | CloseEvent;
export type IncidentEventKind = IncidentEvent['kind'];

/** The officer's filed report on an incident (statements of fact checked in the MDT). */
export interface ReportRecord { docId: string; assertions: string[]; sim: number; game: number }

export interface IncidentPerson { personId: number; role: string; label: string }

export interface IncidentLog {
  /** "C-00042" (call number) or "FC-<personId>-<epochDay>" (field contact) or "FI-<epochDay>-<n>" (ad hoc). */
  key: string;
  callId: number;
  typeId: string;
  family: string;
  /** District type name of the incident location ('' unknown). */
  district: string;
  openedSim: number;
  openedGame: number;
  closed: boolean;
  closedSim: number;   // -1 while open
  closedGame: number;  // -1 while open
  /** Ordered by `t`, then `id` (ids increase globally). */
  events: IncidentEvent[];
  people: IncidentPerson[];
  reports: ReportRecord[];
}

// --- Ruleset (design §5.1) ---------------------------------------------------------------------

export interface RuleDef { id: string; doctrine: Doctrine; title: string; cite: string; text: string }
export interface IndicatorDef { label: string; offense: Offense; rs: number; pc: number; armed: number }
export interface OffenseDef { label: string; severity: number; arrestable: boolean; vehicleEvidence: boolean }

export interface Ruleset {
  version: 1;
  /** File stem, e.g. "generic". */
  id: string;
  name: string;
  description: string;
  /** Every `*RuleId` below must name one of these. */
  rules: RuleDef[];
  indicators: Record<string, IndicatorDef>;
  offenses: Record<Offense, OffenseDef>;
  /** Call family -> offense of its suspect role (a missing family falls back to the indicator table). */
  familyOffense: Record<string, Offense>;
  /** CAD statute id -> offense. */
  statuteOffense: Record<string, Offense>;
  thresholds: { rs: number; pc: number; armed: number };
  /** `attenuating`: indicators that survive an unlawful detention (taint attenuation). */
  detention: { ruleId: string; attenuating: string[] };
  frisk: { ruleId: string; scopeRuleId: string; plainFeel: boolean; plainFeelCategories: string[] };
  arrest: { ruleId: string; warrantRuleId: string };
  sita: { ruleId: string; vehicleRuleId: string; windowS: number; preArrestS: number; vehicle: 'broad' | 'gant' };
  automobile: { enabled: boolean; ruleId: string };
  consent: { ruleId: string; scopeRuleId: string; coercionRuleId: string; coercedByWeaponDrawn: boolean; maxAggressiveLines: number };
  exigency: { ruleId: string; windowS: number };
  entry: { ruleId: string };
  premises: { protectiveSweepRuleId: string; plainViewRuleId: string };
  test: { ruleId: string; impliedAfterArrest: boolean };
  miranda: { ruleId: string; invocationRuleId: string; custodyIncludesGunpoint: boolean; incriminatingFacts: string[]; responseWindowS: number };
  force: {
    ruleId: string; restrainedRuleId: string; lethalRuleId: string; displayRuleId: string;
    levels: Record<ForceLevel, number>;
    maxByResistance: Record<Resistance, number>;
    /** Minimum resistance for pointing a firearm (event tool 'firearmDisplay'). */
    displayFirearmMin: Resistance;
    taser: { maxCycles: number; cycleRuleId: string; riskFactors: string[]; riskAllowedAt: Resistance; riskRuleId: string };
  };
  intervene: { ruleId: string; windowS: number; radiusM: number };
  pursuit: {
    ruleId: string; speedRuleId: string; terminateRuleId: string; equipmentRuleId: string;
    allowedOffenses: Offense[];
    /** Key 'default' required, others = district names. */
    maxOverLimitMph: Record<string, number>;
    maxOverS: number; wetFactor: number; nightFactor: number; requireLightsSiren: boolean;
    maxDurationS: number; terminateGraceS: number;
  };
  recording: { ruleId: string; muteRuleId: string; activationGraceS: number; requiredFor: string[]; dashCounts: string[] };
  evidence: { exclusionRuleId: string; fruitRuleId: string; inevitableDiscovery: boolean; inevitableRuleId: string };
}

// --- Assessment (design §5.4) ------------------------------------------------------------------

export type Outcome = 'lawful' | 'unlawful' | 'questionable';

export interface Determination {
  /** "d1", "d2", ... in creation order. */
  id: string;
  doctrine: Doctrine; eventId: number; personId: number; t: number;
  outcome: Outcome; ruleIds: string[];
  /** One plain sentence for the UI. */
  reason: string;
  /** Search basis that made it lawful ('consent', 'incidentToArrest', 'automobile', ...). */
  basis: string | null;
  /** Recording: every violating event; others: [eventId]. */
  eventIds: number[];
}

export interface EvidenceRuling {
  eventId: number; ref: string; label: string; personId: number;
  kind: 'item' | 'statement' | 'test';
  offense: Offense | null; admissible: boolean; ruleIds: string[];
  /** Root event id of the taint, -1 when admissible. */
  taintedBy: number;
  reason: string;
}

export type ForceVerdict = 'justified' | 'questionable' | 'excessive';

export interface ForceRuling {
  eventId: number; personId: number; level: ForceLevel; tool: string; resistance: Resistance;
  maxAllowed: ForceLevel; verdict: ForceVerdict; factors: string[]; ruleIds: string[];
  /** A fellow officer's force (otherForce). */
  other: boolean;
}

export interface PursuitRuling {
  startEventId: number; personId: number; offense: Offense | null; startAllowed: boolean; overLimitS: number;
  lightsSirenOk: boolean; advisoryIgnoredS: number; durationS: number; terminated: boolean;
  outcome: Outcome; ruleIds: string[]; reasons: string[];
}

export interface PersonAssessment {
  personId: number;
  /** null = never detained. */
  detained: boolean; detentionLawful: boolean | null;
  arrested: boolean; arrestLawful: boolean | null;
  /** Best offense with PC at the first arrest. */
  arrestOffense: Offense | null;
  /** Untainted pc per offense at the first arrest. */
  pcAtArrest: Partial<Record<Offense, number>>;
  /** Untainted rs sum at the first detention (0 if none). */
  rsAtDetention: number;
  suppressedStatements: number;
}

export interface LegalSummary {
  unlawful: number; questionable: number; suppressed: number; excessiveForce: number; questionableForce: number; score: number;
}

export interface LegalAssessment {
  rulesetId: string; key: string;
  determinations: Determination[]; evidence: EvidenceRuling[]; force: ForceRuling[]; pursuits: PursuitRuling[];
  persons: PersonAssessment[];
  summary: LegalSummary;
}

// --- Report choices (design §5.9) --------------------------------------------------------------

export interface ReportChoice {
  /** Stable id, see `buildReportChoices`. */
  id: string;
  /** Exclusive group (at most one may be asserted), null = independent. */
  group: string | null;
  /** First person, past tense. */
  text: string;
  personId: number;
  /** Hidden from the UI. */
  truth: 'true' | 'false' | 'unsupported';
  /** A complete report must assert it. */
  key: boolean;
  /** The event it is about (-1 for distractors without one). */
  eventId: number;
}
