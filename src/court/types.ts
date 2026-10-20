import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import type { IncidentLog, LegalAssessment, ReportChoice, Ruleset } from '../legal/types';
import type { CourtConfig } from './data';

export const CASE_STATUSES = ['pending', 'pleaded', 'scheduled', 'inSession', 'heard', 'missed', 'closed'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const VERDICTS = ['convicted', 'acquitted', 'dismissed', 'paid'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const ANSWERS = ['yes', 'no', 'dontRecall'] as const;
export type Answer = (typeof ANSWERS)[number];

export const QUESTION_KINDS = ['resistanceAt', 'consentGiven', 'mirandaBefore', 'camDuring', 'reportAssertion', 'omission', 'repeat'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/** One cross-examination question (design 11.2). `truth` is the correct answer according to the incident log. */
export interface CrossExamQuestion {
  id: string;
  kind: QuestionKind;
  text: string;
  truth: 'yes' | 'no';
  /** What the officer's report implies the answer is; null when the report is silent or there is no report. */
  reportSays: 'yes' | 'no' | null;
  eventId: number;
  /** The event was recorded by an unmuted body camera: a lie about it is impeached by the footage. */
  onCamera: boolean;
  weight: number;
  /** For a `repeat`, the id of the question it re-asks (inverted); null otherwise. */
  pairOf: string | null;
}

export interface CrossExamInput {
  caseId: string;
  personId: number;
  log: IncidentLog;
  assessment: LegalAssessment;
  choices: readonly ReportChoice[];
  /** Ids of the report choices the officer asserted; null when no report was filed. */
  assertions: readonly string[] | null;
}

export interface TestimonyResult {
  credibilityDelta: number;
  /** 0..1 testimony strength. */
  score: number;
  consistent: number;
  /** Lies contradicted by unmuted bodycam footage. */
  impeached: number;
  /** Other answers that contradict the incident log (not on camera). */
  contradictions: number;
  evasive: number;
  selfInconsistent: number;
  /** Truthful answers that differ from what the report says. */
  reportMismatches: number;
  notes: string[];
}

export interface MotionRuling {
  text: string;
  granted: boolean;
  ruleIds: string[];
  dismissesCase: boolean;
}

export interface CourtCase {
  /** "CR-0001". */
  id: string;
  docId: string;
  docKind: 'booking' | 'citation';
  personId: number;
  personLabel: string;
  /** Incident key ('' when the incident is unknown). */
  key: string;
  callId: number;
  statutes: string[];
  offenses: string[];
  createdGame: number;
  /** -1 when there is no hearing (plea, paid). */
  hearingGame: number;
  status: CaseStatus;
  questions: CrossExamQuestion[];
  motions: MotionRuling[];
  verdict: Verdict | null;
  reason: string;
  testimony: TestimonyResult | null;
  reminded: boolean;
}

export type CourtRequest =
  | {
      readonly kind: 'open';
      readonly docId: string;
      readonly docKind: 'booking' | 'citation';
      readonly personId: number;
      readonly personLabel: string;
      readonly callId: number;
      readonly statutes: readonly string[];
    }
  | { readonly kind: 'attend'; readonly caseId: string }
  | { readonly kind: 'testify'; readonly caseId: string; readonly answers: readonly Answer[] }
  /** Console: hold the hearing now. */
  | { readonly kind: 'advance'; readonly caseId: string };

/** The incident recorder as the court sees it (Phase 5 design 4.4). */
export interface IncidentSource {
  log(key: string): IncidentLog | null;
  assessment(key: string): LegalAssessment | null;
  reportChoices(key: string): readonly ReportChoice[];
  /** Optional: the key of the incident whose log has a `charges` event with this document id (field contacts). */
  keyOfDoc?(docId: string): string | null;
}

export interface CourtDeps {
  readonly bus: EventBus<EventMap>;
  /** The live `court` stream: pleas, scheduling and verdict draws. */
  readonly rng: Rng;
  /** Session seed: cross-examinations draw from `createRng(seed).stream('court:' + caseId)`. */
  readonly seed: number;
  readonly incidents: IncidentSource;
  ruleset(): Ruleset;
  /** The latest graded report score (0..100) of an incident; null when none. */
  reportGrade(key: string): number | null;
  readonly config?: CourtConfig;
}
