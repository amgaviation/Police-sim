/** Court bus topics (Phase 5 design 11.3). Declared by declaration merging. */

/** A hearing was scheduled; the officer is subpoenaed. */
export interface CourtSubpoenaEvent {
  caseId: string;
  hearingGame: number;
  label: string;
}

/** The hearing is about to start (`reminderMin` before). */
export interface CourtReminderEvent {
  caseId: string;
  hearingGame: number;
}

/** The officer attended: the app opens the courtroom for this case. */
export interface CourtSessionEvent {
  caseId: string;
}

export interface CourtVerdictEvent {
  caseId: string;
  key: string;
  verdict: string;
  reason: string;
  credibilityDelta: number;
  impeached: boolean;
  missed: boolean;
}

export interface CourtFlashEvent {
  text: string;
}

declare module '../core/event-map' {
  interface EventMap {
    'court:subpoena': CourtSubpoenaEvent;
    'court:reminder': CourtReminderEvent;
    'court:session': CourtSessionEvent;
    'court:verdict': CourtVerdictEvent;
    'court:flash': CourtFlashEvent;
  }
}
