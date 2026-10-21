import type { CaseStatus } from './types';

/** World bus topics (Phase 8 design §4.3). Declared by declaration merging. */

/** A released offender was picked as a suspect of a later call. */
export interface WorldRecidivistEvent {
  personId: number;
  callId: number;
  arrests: number;
}

/** A case was opened or changed status. */
export interface WorldCaseEvent {
  caseId: string;
  callId: number;
  status: CaseStatus;
}

export interface WorldFlashEvent {
  text: string;
}

declare module '../core/event-map' {
  interface EventMap {
    'world:recidivist': WorldRecidivistEvent;
    'world:case': WorldCaseEvent;
    'world:flash': WorldFlashEvent;
  }
}
