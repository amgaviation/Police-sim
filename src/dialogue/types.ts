import type { CarriedItem, Intoxication, NpcIdentity, OfficerHistory } from '../people';

/** Dialogue module types (design §9.1). Pure data: no THREE, no DOM. */

export const TONES = ['polite', 'neutral', 'commanding', 'aggressive'] as const;
export type Tone = (typeof TONES)[number];

export const COMM_MODES = ['verbal', 'written', 'gesture', 'translationApp', 'interpreter'] as const;
export type CommMode = (typeof COMM_MODES)[number];

/** Topics a person can be asked about; the id of a stored statement or fact. */
export const FACT_TOPICS = [
  'name',
  'dob',
  'address',
  'identity',
  'idCard',
  'appearance',
  'destination',
  'origin',
  'account',
  'drinking',
  'drugs',
  'weapons',
  'vehicleContents',
  'vehicleOwner',
  'injured',
  'suspectWhereabouts',
] as const;
export type FactTopic = (typeof FACT_TOPICS)[number];

/** The officer commands an utterance can carry (owned by npc; `release` and `returnToVehicle` are internal). */
export const NPC_COMMANDS = [
  'stop',
  'handsUp',
  'getDown',
  'turnAround',
  'comeHere',
  'stayBack',
  'followMe',
  'sitDown',
  'stepOut',
  'dropWeapon',
  'showHands',
  'leaveArea',
  'disperse',
  'calmDown',
  'turnOffEngine',
  'tossKeys',
  'walkBackward',
] as const;

export const INTENTS = [
  'greet',
  'explainReason',
  'requestId',
  'askName',
  'askDob',
  'ask',
  'consent',
  'command',
  'reassure',
  'miranda',
  'release',
  'warn',
  'thank',
] as const;
export type Intent = (typeof INTENTS)[number];

export const CONSENT_KINDS = ['searchPerson', 'searchVehicle', 'pbt', 'sfst', 'entry', 'searchPremises', 'searchRoom'] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

/** Conditions that gate an utterance in the menu (`notRestrainedOrAny` is always satisfied). */
export const REQUIREMENTS = [
  'inVehicle',
  'notInVehicle',
  'hasVehicle',
  'onCall',
  'armedSubject',
  'restrained',
  'notRestrained',
  'juvenile',
  'notJuvenile',
  'identityGiven',
  'notRestrainedOrAny',
  'premisesAuthority',
] as const;
export type Requirement = (typeof REQUIREMENTS)[number];

/** What the officer can say. `text` holds all four tones. */
export interface Utterance {
  readonly id: string;
  readonly topic: string;
  readonly intent: Intent;
  readonly fact: FactTopic | null;
  readonly consent: ConsentKind | null;
  readonly command: string | null;
  readonly requires: readonly Requirement[];
  readonly text: Readonly<Record<Tone, string>>;
}

/** An identity the subject gave (plain JSON, saved in the memory). */
export interface IdentityClaim {
  readonly kind: 'true' | 'relative' | 'invented' | 'alteredDob';
  /** The claimed person's id; -1 for an invented identity. */
  readonly personId: number;
  readonly first: string;
  readonly middle: string;
  readonly last: string;
  /** Epoch day. */
  readonly dob: number;
  readonly address: string;
  readonly document: 'dl' | 'fakeId' | 'none';
  /** '' when no document. */
  readonly dlNumber: string;
}

/** Built by contact from people and the scenario. */
export interface SubjectProfile {
  readonly personId: number;
  readonly identity: NpcIdentity;
  readonly intoxication: Intoxication;
  readonly demeanor: string;
  readonly role: string;
  readonly items: readonly CarriedItem[];
  readonly vehicleItems: readonly CarriedItem[];
  /** -1 none. */
  readonly vehicleOwnerId: number;
  /** Has a motive to lie (suspect role, wanted, contraband, intoxicated driver, stolen vehicle). */
  readonly guilty: boolean;
  readonly injured: boolean;
  readonly inVehicle: boolean;
  readonly restrained: boolean;
}

/** The scenario's hidden truth for one incident (contact passes it; it never reaches a view). */
export interface IncidentTruth {
  readonly destination: string;
  readonly origin: string;
  readonly account: string;
  readonly suspectWhereabouts: string;
  /** '' for a field contact without a call (the `onCall` requirement is false then). */
  readonly reason: string;
  /** True when this person is the scenario's suspect (the consent chance drops). Absent = false. */
  readonly suspect?: boolean;
}

/** A person's public record facts, as the contact module reads them from the records database. */
export interface DirectoryPerson {
  readonly first: string;
  readonly middle: string;
  readonly last: string;
  /** Epoch day. */
  readonly dob: number;
  readonly address: string;
  readonly dlNumber: string;
}

/**
 * Optional lookups the contact module supplies (wrapping RecordsDb). Without it the subject can only
 * claim `invented` identities (a relative needs the relative's record) and an invented licence number
 * is not checked against the registry.
 */
export interface DialogueDirectory {
  person(personId: number): DirectoryPerson | null;
  dlOnFile(dl: string): boolean;
}

export interface DialogueContext {
  readonly tone: Tone;
  readonly commMode: CommMode;
  /** 0..23 game hour. */
  readonly hour: number;
  readonly officerName: string;
  readonly presence: {
    readonly lights: boolean;
    readonly backup: number;
    readonly weapon: 'none' | 'sidearm' | 'taser';
    readonly uniform: boolean;
  };
  readonly history: OfficerHistory;
  /** Neighbourhood trust 0..1. */
  readonly trust: number;
  readonly truth: IncidentTruth;
  readonly guardianPresent: boolean;
  readonly interpreterAvailable: boolean;
  readonly directory?: DialogueDirectory;
  /** The premises the officer is at, when indoors or at a door: `authority` is true for a resident or owner. */
  readonly premises?: { readonly buildingId: number; readonly authority: boolean; readonly room: number };
}

/** Plain JSON (saved with the contact). */
export interface SubjectMemory {
  rapport: number;
  stress: number;
  greeted: boolean;
  reasonGiven: boolean;
  mirandized: boolean;
  identity: IdentityClaim | null;
  identityRefusals: number;
  /** The lie told per fact topic (first lie stored; replaced when the story changes). */
  lies: Record<string, string>;
  /** Times a fact topic was answered (truth, lie or confusion; refusals are not counted). */
  asked: Record<string, number>;
  consent: Partial<Record<ConsentKind, 'granted' | 'denied'>>;
  /** Rapport at the moment each consent was asked. */
  consentAskedAt: Partial<Record<ConsentKind, number>>;
}

export interface DialogueStatement {
  readonly fact: FactTopic;
  readonly value: string;
  readonly display: string;
  readonly truthful: boolean;
  readonly confused: boolean;
}

export interface DialogueResult {
  readonly lineKey: string;
  readonly text: string;
  readonly delayS: number;
  readonly understood: boolean;
  readonly statement: DialogueStatement | null;
  /** Set only when a claim was made or changed by this answer; `memory.identity` always holds the current one. */
  readonly identity: IdentityClaim | null;
  readonly consent: { readonly kind: ConsentKind; readonly granted: boolean; readonly valid: boolean } | null;
  readonly escalate: 'flee' | 'fight' | null;
  readonly calmed: boolean;
  readonly memory: SubjectMemory;
}
