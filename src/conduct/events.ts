/** Conduct bus topics (Phase 5 design 10.3). Declared by declaration merging. */

/** An IA case was opened for an incident; `reasons` are readable trigger labels. */
export interface ConductIaEvent {
  caseId: string;
  key: string;
  reasons: string[];
}

export interface ConductIaResolvedEvent {
  caseId: string;
  finding: string;
  /** Discipline action ids. */
  discipline: string[];
}

export interface ConductReportEvent {
  docId: string;
  key: string;
  score: number;
  letter: string;
}

export interface ConductCommendationEvent {
  id: string;
  label: string;
  key: string;
}

export interface ConductDisciplineEvent {
  action: string;
  hours: number;
  amount: number;
  caseId: string;
}

export interface ConductStatusEvent {
  status: string;
  untilGame: number;
  reason: string;
}

/** Emitted only when `|delta| >= 0.005`. */
export interface ConductTrustEvent {
  district: string;
  value: number;
  delta: number;
  reason: string;
}

/** Career points moved by a `points` request (Phase 7). */
export interface ConductPointsEvent {
  delta: number;
  total: number;
  reason: string;
}

declare module '../core/event-map' {
  interface EventMap {
    'conduct:ia': ConductIaEvent;
    'conduct:iaResolved': ConductIaResolvedEvent;
    'conduct:report': ConductReportEvent;
    'conduct:commendation': ConductCommendationEvent;
    'conduct:discipline': ConductDisciplineEvent;
    'conduct:status': ConductStatusEvent;
    'conduct:trust': ConductTrustEvent;
    'conduct:points': ConductPointsEvent;
  }
}
