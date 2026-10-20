/** Backup bus topics (design §4.4). Declared by declaration merging; the radio lines use the shared `RadioLinePayload`. */
import type { FlashPayload, RadioLinePayload } from '../units/types';
import type { CalloutKind, SwatPhase } from './types';

/** An officer called something out (the radio line also goes out as `backup:radio`). */
export interface BackupCalloutEvent {
  callsign: string;
  kind: CalloutKind;
  text: string;
  /** True when the callout was delayed by the lateCallout mistake. */
  late: boolean;
  callId: number;
}

/** A mistake of an officer became visible. */
export interface BackupMistakeEvent {
  callsign: string;
  kind: 'lateCallout' | 'poorPosition' | 'excessiveForce';
  callId: number;
}

/** A backup officer or the SWAT team cuffed a subject (the integrator forwards it to `scene.request({ kind: 'custody' })`). */
export interface BackupCustodyEvent {
  callId: number;
  personId: number;
  actorId: number;
  by: string;
}

/** A SWAT report or reply. */
export interface BackupSwatEvent {
  phase: SwatPhase;
  text: string;
  callId: number;
}

declare module '../core/event-map' {
  interface EventMap {
    'backup:callout': BackupCalloutEvent;
    'backup:mistake': BackupMistakeEvent;
    'backup:custody': BackupCustodyEvent;
    'backup:swat': BackupSwatEvent;
    'backup:radio': RadioLinePayload;
    'backup:flash': FlashPayload;
  }
}
