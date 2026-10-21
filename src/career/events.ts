import type { CareerRank, CareerStage, DutyAssignment, ShiftSummary } from './types';

/** Career bus topics (Phase 8 design §4.3). Declared by declaration merging. */

/** HUD one-liner. */
export interface CareerFlashEvent {
  text: string;
}

/** Emitted on any change of stage, rank or assignment. */
export interface CareerStageEvent {
  stage: CareerStage;
  rank: CareerRank;
  assignment: DutyAssignment;
}

/** A career point award (FTO trainee rating, promotion bonus); bridged to the conduct points. */
export interface CareerPointsEvent {
  delta: number;
  reason: string;
  key: string;
}

declare module '../core/event-map' {
  interface EventMap {
    'career:flash': CareerFlashEvent;
    'career:stage': CareerStageEvent;
    'career:shiftSummary': ShiftSummary;
    'career:points': CareerPointsEvent;
  }
}
