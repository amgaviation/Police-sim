/**
 * Persistent-world types (Phase 8 design §4.1, §6.2, §6.4). Pure data: no imports from other Phase 8 modules.
 */

export const PREMISE_FLAGS = ['weapon', 'violence', 'arrest', 'officerSafety', 'drugs', 'mentalHealth', 'repeat'] as const;
export type PremiseFlag = (typeof PREMISE_FLAGS)[number];

export const CASE_STATUSES = ['open', 'followUp', 'cleared', 'cold'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const OFFENDER_CUSTODY = ['jailed', 'released', 'atLarge'] as const;
export type OffenderCustody = (typeof OFFENDER_CUSTODY)[number];

/** Equals the cad `STATUTE_CLASSES`. */
export const OFFENSE_CLASSES = ['infraction', 'misdemeanor', 'felony', 'warrant'] as const;
export type OffenseClass = (typeof OFFENSE_CLASSES)[number];

export const VERDICTS = ['convicted', 'plea', 'acquitted', 'dismissed'] as const;
export type WorldVerdict = (typeof VERDICTS)[number];

/** One closed call at an address (newest last in `PremiseRecord.entries`). */
export interface PremiseEntry {
  game: number;
  callNumber: string;
  typeId: string;
  nature: string;
  disposition: string;
  flags: PremiseFlag[];
}

/** A closed call as the integrator reports it to the world. */
export interface ClosedCallInfo {
  callId: number;
  number: string;
  typeId: string;
  nature: string;
  category: string;
  x: number;
  z: number;
  edge: number;
  text: string;
  district: string;
  disposition: string;
  flags: PremiseFlag[];
  persons: number[];
  game: number;
}

/** Call history of one address; `key` is `premiseKey(text)`. */
export interface PremiseRecord {
  key: string;
  text: string;
  x: number;
  z: number;
  edge: number;
  district: string;
  entries: PremiseEntry[];
}

/** A case that lingers across shifts. `id` is 'CS-0001'. */
export interface CaseRecord {
  id: string;
  callId: number;
  callNumber: string;
  typeId: string;
  nature: string;
  status: CaseStatus;
  openedGame: number;
  lastGame: number;
  shiftsOpen: number;
  locationText: string;
  x: number;
  z: number;
  suspects: number[];
  witnesses: number[];
  evidence: number;
}

/** An arrested person; released offenders recidivate (suspect roles of later calls prefer them). */
export interface OffenderRecord {
  personId: number;
  arrests: number;
  lastArrestGame: number;
  custody: OffenderCustody;
  releaseGame: number;
  risk: number;
  district: string;
  lastCallNumber: string;
  x: number;
  z: number;
  juvenile: boolean;
  offenseClass: OffenseClass;
  convicted: boolean;
}

/** A witness whose record address changes over time (`movedGame` -1 = never moved). */
export interface WitnessRecord {
  personId: number;
  caseId: string;
  addressText: string;
  movedGame: number;
}

export interface NeighborhoodState {
  crime: number;
  trend: number;
  history: number[];
}

export type WorldRequest =
  | { kind: 'callClosed'; call: ClosedCallInfo }
  | {
      kind: 'arrest'; personId: number; district: string; callNumber: string; x: number; z: number; game: number;
      offenseClass: OffenseClass; juvenile: boolean; priors: number;
    }
  | { kind: 'verdict'; personId: number; verdict: WorldVerdict; game: number }
  | {
      kind: 'caseOpen'; callId: number; number: string; typeId: string; nature: string; game: number; locationText: string;
      x: number; z: number; suspects: number[]; witnesses: number[]; evidence: number;
    }
  | { kind: 'caseUpdate'; callId: number; game: number; suspectsAdd?: number[]; witnessesAdd?: number[]; evidenceDelta?: number; status?: CaseStatus }
  | { kind: 'witness'; personId: number; callId: number; addressText: string };

export interface EvolveInput {
  fromGame: number;
  toGame: number;
  /** Trust 0..1 per district (missing = 0.5). */
  trust: Readonly<Record<string, number>>;
  arrestsByDistrict: Readonly<Record<string, number>>;
  /** Address text for a witness's new home from one draw in [0, 1); null = unknown. */
  addressAt: (u: number) => string | null;
}

/** A warrant-service call the integrator creates for an open case with a known suspect (bind `personId` with `bindPerson`). */
export interface FollowUpCall {
  caseId: string;
  /** The case's original call id. */
  callId: number;
  typeId: 'warrantService';
  personId: number;
  x: number;
  z: number;
}

export interface EvolveResult {
  days: number;
  released: number[];
  moves: { personId: number; address: string | null }[];
  followUps: FollowUpCall[];
  trustDeltas: { district: string; delta: number }[];
  news: string[];
}
