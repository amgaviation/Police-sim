/**
 * Command bus topics (Phase 6 design §4.4), declared by declaration merging. Radio lines and HUD flashes use the shared
 * payloads of `src/units/types.ts`; the integrator bridges `command:radio` to `RadioSystem.say`.
 */
import type { FlashPayload, RadioLinePayload } from '../units/types';
import type { CommandLevel, NegotiationOutcome, TriageTag } from './types';

/** The command post of a call opened or closed. */
export interface CommandPostEvent {
  callId: number;
  level: CommandLevel;
  x: number;
  z: number;
  open: boolean;
}

/** A victim got a triage tag (`correct` = the tag equals the START answer). */
export interface CommandTriageEvent {
  callId: number;
  personId: number;
  tag: TriageTag;
  correct: boolean;
  by: 'player' | 'ems';
}

/** A negotiation turn happened (or the negotiation opened). */
export interface CommandNegotiationEvent {
  callId: number;
  outcome: NegotiationOutcome;
  trust: number;
  agitation: number;
}

declare module '../core/event-map' {
  interface EventMap {
    'command:post': CommandPostEvent;
    'command:triage': CommandTriageEvent;
    'command:negotiation': CommandNegotiationEvent;
    'command:radio': RadioLinePayload;
    'command:flash': FlashPayload;
  }
}
