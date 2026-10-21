/**
 * Training bus topics (Phase 8 design 4.3 / 7.8), declared by declaration merging. Emitted on rare events only
 * (a gate, a cone, the end of a run, a scored call), so the payload objects are allocated freely.
 */

/** Driving course progress: on a gate pass or miss, a cone hit, the finish and an abort. */
export interface TrainingCourseEvent {
  /** Gates resolved so far (passed or missed). */
  gate: number;
  gates: number;
  /** Cones hit so far. */
  cones: number;
  /** Gates missed so far. */
  missed: number;
  done: boolean;
  /** Provisional score 0..100 (final when `done`). */
  score: number;
  timeS: number;
}

/** A scored dispatch call was closed: its score and the running total (sum of the scores of all scored calls). */
export interface TrainingDispatchScoreEvent {
  callNumber: string;
  score: number;
  total: number;
}

export interface TrainingFlashEvent {
  text: string;
}

declare module '../core/event-map' {
  interface EventMap {
    'training:course': TrainingCourseEvent;
    'training:dispatchScore': TrainingDispatchScoreEvent;
    'training:flash': TrainingFlashEvent;
  }
}
