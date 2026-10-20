/**
 * Force bus topics (Phase 5 design 6.4). Declared by declaration merging. `level` / `resistance` are plain strings here;
 * the recorder narrows them with its validator.
 */
export interface ForceAppliedEvent {
  seq: number;
  tool: string;
  level: string;
  personId: number;
  actorId: number;
  callId: number;
  resistance: string;
  hit: boolean;
  injury: number;
  fatal: boolean;
  cycle: number;
  riskFactors: string[];
  distance: number;
  restrained: boolean;
  sim: number;
}

/** A fellow officer applied force (misconduct episode). */
export interface ForceOtherEvent {
  seq: number;
  officer: string;
  level: string;
  personId: number;
  actorId: number;
  callId: number;
  resistance: string;
  restrained: boolean;
  distanceToOfficer: number;
  injury: number;
  sim: number;
}

/** The officer stopped a fellow officer's misconduct; `otherSeq` = `seq` of the latest `force:other` of the episode. */
export interface ForceIntervenedEvent {
  otherSeq: number;
  personId: number;
  callId: number;
  sim: number;
}

export interface ForceToolEvent {
  tool: string;
}

export interface ForceFlashEvent {
  text: string;
}

declare module '../core/event-map' {
  interface EventMap {
    'force:applied': ForceAppliedEvent;
    'force:other': ForceOtherEvent;
    'force:intervened': ForceIntervenedEvent;
    'force:tool': ForceToolEvent;
    'force:flash': ForceFlashEvent;
  }
}
