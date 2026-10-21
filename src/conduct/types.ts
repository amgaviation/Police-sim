import type { EventBus } from '../core/events';
import type { EventMap } from '../core/event-map';
import type { Rng } from '../core/rng';
import type { LegalAssessment, IncidentLog, ReportChoice } from '../legal/types';
import type { ConductConfigs, IaSeverity } from './data';

export const IA_FINDINGS = ['exonerated', 'unfounded', 'notSustained', 'sustained'] as const;
export type IaFinding = (typeof IA_FINDINGS)[number];

export const DUTY_STATUSES = ['active', 'suspended', 'adminLeave', 'terminated'] as const;
export type DutyStatus = (typeof DUTY_STATUSES)[number];

export const DISCIPLINE_ACTIONS = ['counseling', 'writtenReprimand', 'suspension', 'termination', 'civilSuit', 'criminalCharges'] as const;
export type DisciplineActionId = (typeof DISCIPLINE_ACTIONS)[number];

export type ReportLetter = 'A' | 'B' | 'C' | 'D' | 'F';

/** The graded report (design 10.2). */
export interface ReportGrade {
  docId: string;
  key: string;
  score: number;
  letter: ReportLetter;
  /** 0..1, share of the key true facts the report asserts. */
  completeness: number;
  /** Texts of unasserted key facts (at most 5). */
  missing: string[];
  contradictions: { text: string; onCamera: boolean }[];
  /** Texts of asserted claims the log does not support. */
  unsupported: string[];
  game: number;
}

/** One rule that fired for an incident. */
export interface IaTrigger {
  rule: string;
  severity: IaSeverity;
  /** Events the trigger is about (force events, violating events); empty for a complaint. */
  eventIds: number[];
}

export type IaStatement =
  | { kind: 'account'; claims: { eventId: number; resistance: string }[] }
  | { kind: 'acknowledge' }
  | { kind: 'none' };

export interface IaStatementOption {
  text: string;
  statement: IaStatement;
}

export interface DisciplineAction {
  action: DisciplineActionId;
  /** Game hours (suspension). */
  hours: number;
  /** Currency (civilSuit). */
  amount: number;
  caseId: string;
  game: number;
}

export interface IaCase {
  /** "IA-0001". */
  id: string;
  /** Incident key. */
  key: string;
  openedGame: number;
  triggers: IaTrigger[];
  severity: IaSeverity;
  status: 'open' | 'closed';
  statement: IaStatement | null;
  finding: IaFinding | null;
  untruthful: boolean;
  discipline: DisciplineAction[];
  closedGame: number;
}

export interface Commendation {
  /** The commendation rule id. */
  id: string;
  label: string;
  /** Incident key. */
  key: string;
  game: number;
  points: number;
}

export interface CareerStats {
  incidents: number;
  arrests: number;
  lawfulArrests: number;
  excessiveForce: number;
  convictions: number;
  dismissals: number;
  reportsFiled: number;
  avgReport: number;
}

export interface CareerView {
  status: DutyStatus;
  statusUntilGame: number;
  statusReason: string;
  points: number;
  credibility: number;
  commendations: readonly Commendation[];
  discipline: readonly DisciplineAction[];
  ia: readonly IaCase[];
  reports: readonly ReportGrade[];
  stats: CareerStats;
}

export type ConductRequest =
  | { readonly kind: 'incidentClosed'; readonly key: string; readonly aggressiveLines: number }
  | { readonly kind: 'report'; readonly key: string; readonly docId: string; readonly assertions: readonly string[] }
  | { readonly kind: 'iaStatement'; readonly caseId: string; readonly statement: IaStatement }
  | {
      readonly kind: 'verdict'; readonly key: string; readonly caseId: string; readonly verdict: string; readonly reason: string;
      readonly credibilityDelta: number; readonly impeached: boolean; readonly missed: boolean;
    }
  | { readonly kind: 'trust'; readonly district: string; readonly delta: number; readonly reason: string }
  | { readonly kind: 'reinstate' }
  /** Phase 7: career points from outside the conduct rules (e.g. fleet damage charges); `key` names the source. */
  | { readonly kind: 'points'; readonly delta: number; readonly reason: string; readonly key: string };

/** Structural port to the incident recorder (design 4.4); the integrator wires `IncidentSystem`. */
export interface IncidentSource {
  log(key: string): IncidentLog | null;
  assessment(key: string): LegalAssessment | null;
  reportChoices(key: string): readonly ReportChoice[];
}

export interface ConductDeps {
  readonly bus: EventBus<EventMap>;
  /** The session stream 'conduct'. */
  readonly rng: Rng;
  readonly incidents: IncidentSource;
  /** District type name of an incident ('' unknown). */
  districtOf(key: string): string;
  /** Current injury (0..1) of a person. */
  injuryOf(personId: number): number;
  readonly configs?: Partial<ConductConfigs>;
}
