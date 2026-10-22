/**
 * Incident recorder bus topics (Phase 5 design 9.1). Declared by declaration merging; payloads are emitted on rare events only.
 */

/** A new incident log was opened. */
export interface IncidentOpenedEvent {
  key: string;
}

/** An incident closed and its legal assessment is ready (`incidents.assessment(key)`). */
export interface IncidentClosedEvent {
  key: string;
  callId: number;
  score: number;
  unlawful: number;
  excessiveForce: number;
}

/** The live verdict of one use of force, e.g. "CED on active resistance: within policy (GS-8.1)". */
export interface IncidentForceVerdictEvent {
  key: string;
  eventId: number;
  verdict: 'justified' | 'questionable' | 'excessive';
  text: string;
}

/** A supervisor advisory (`terminatePursuit`: radio line; `activateBodycam`). */
export interface IncidentAdvisoryEvent {
  key: string;
  advisory: 'terminatePursuit' | 'activateBodycam';
  text: string;
}

/** The officer's report on an incident was filed. */
export interface IncidentReportEvent {
  key: string;
  docId: string;
}

/** A short HUD line. */
export interface IncidentFlashEvent {
  text: string;
}

/**
 * Phase 6: an order of the pursuit supervisor (emitted by the pursuit module). `terminate` is recorded as the
 * pursuit's termination advisory; the other orders are informational for the recorder.
 */
export interface PursuitOrderEvent {
  callId: number;
  order: 'terminate' | 'authorizePit' | 'denyPit' | 'handoff';
  by: string;
  text: string;
  sim: number;
}

declare module '../core/event-map' {
  interface EventMap {
    'pursuit:order': PursuitOrderEvent;
    'incident:opened': IncidentOpenedEvent;
    'incident:closed': IncidentClosedEvent;
    'incident:forceVerdict': IncidentForceVerdictEvent;
    'incident:advisory': IncidentAdvisoryEvent;
    'incident:report': IncidentReportEvent;
    'incident:flash': IncidentFlashEvent;
  }
}
