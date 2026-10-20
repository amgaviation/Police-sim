/**
 * Pursuit bus topics (Phase 6 design §4.4). Declared by declaration merging. `pursuit:order` is declared by the
 * incidents module (`src/incidents/events.ts`) and emitted by this one.
 */
import '../incidents/events';
import type { FlashPayload, RadioLinePayload } from '../units/types';
import type { PursuitTactic, TacticVerdict } from './types';

/** A tactic was tried or judged: PIT verdicts, spikes hit or missed, box-in, roadblock, air, perimeter, handoff. */
export interface PursuitTacticEvent {
  callId: number;
  tactic: PursuitTactic;
  verdict: TacticVerdict;
  text: string;
}

/** State patrol took primary at the city limits. */
export interface PursuitHandoffEvent {
  callId: number;
  to: string;
}

declare module '../core/event-map' {
  interface EventMap {
    'pursuit:tactic': PursuitTacticEvent;
    'pursuit:handoff': PursuitHandoffEvent;
    'pursuit:radio': RadioLinePayload;
    'pursuit:flash': FlashPayload;
  }
}
