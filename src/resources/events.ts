/**
 * Resources bus topics (design §4.4), declared by declaration merging. Radio lines and HUD flashes use the
 * shared payloads of `src/units/types.ts`; the integrator bridges `resource:radio` to `RadioSystem.say`.
 */
import type { FlashPayload, RadioLinePayload } from '../units/types';

/** A unit was assigned to a call (`etaS` = the response-time estimate at dispatch). */
export interface ResourceDispatchedEvent {
  callsign: string;
  typeId: string;
  callId: number;
  etaS: number;
}

/** A unit reached its call. */
export interface ResourceArrivedEvent {
  callsign: string;
  typeId: string;
  callId: number;
}

/** A unit left its call (released, cancelled, call closed, loaded a patient). */
export interface ResourceClearedEvent {
  callsign: string;
  typeId: string;
  callId: number;
}

declare module '../core/event-map' {
  interface EventMap {
    'resource:dispatched': ResourceDispatchedEvent;
    'resource:arrived': ResourceArrivedEvent;
    'resource:cleared': ResourceClearedEvent;
    'resource:radio': RadioLinePayload;
    'resource:flash': FlashPayload;
  }
}
