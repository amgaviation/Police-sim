/**
 * Contact bus topics (design §10.3). Flags of `contact:event`: `contacted statement identified falseIdentity
 * custody caged released warned searched frisked pbt sfst bacOver sfstFail weaponFound contrabandFound
 * itemFound:<item> calmed forceUsed guardianNotified`, plus `interpreterRequested` (the scene starts the
 * interpreter service).
 */

export interface ContactEventEvent {
  /** `"C-00042"` or `"FC-<personId>-<epochDay>"`. */
  incident: string;
  callId: number;
  personId: number;
  role: string;
  flag: string;
}

/** A line for the subtitle bar. `language` is `'en'` or the label of an untranslated language. */
export interface ContactLineEvent {
  personId: number;
  speaker: 'officer' | 'subject' | 'system';
  text: string;
  language: string;
  /** Who the subtitle names: the claimed name, else a generic description (never the true record name). */
  label: string;
}

/** The escorted prisoner was placed in patrol car `vehicleIndex` (the session seats the person). */
export interface ContactCagedEvent {
  personId: number;
  vehicleIndex: number;
  callId: number;
}

/** Ask the integrator to open an MDT form. */
export interface ContactOpenFormEvent {
  kind: 'citation' | 'report';
  personId: number;
  vehicleId: number;
  callId: number;
}

/** A field contact without a call needs a self-initiated call; the scene answers with `attachCall`. */
export interface ContactNeedsCallEvent {
  personId: number;
  x: number;
  z: number;
  incident: string;
}

/** A consent was asked and answered (also the Phase 3 kinds; `buildingId` and `room` are -1 when unknown). */
export interface ContactConsentEvent {
  incident: string;
  callId: number;
  personId: number;
  kind: 'entry' | 'searchPremises' | 'searchRoom' | 'searchPerson' | 'searchVehicle' | 'pbt' | 'sfst';
  granted: boolean;
  /** False when the answer carries no legal weight (a juvenile without a guardian, a person with dementia). */
  valid: boolean;
  buildingId: number;
  room: number;
  sim: number;
}

declare module '../core/event-map' {
  interface EventMap {
    'contact:event': ContactEventEvent;
    'contact:line': ContactLineEvent;
    'contact:caged': ContactCagedEvent;
    'contact:openForm': ContactOpenFormEvent;
    'contact:needsCall': ContactNeedsCallEvent;
    'contact:consent': ContactConsentEvent;
  }
}
