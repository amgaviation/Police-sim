/**
 * Scene bus topics (Phase 3 design §11.9, §13). Declared here by declaration merging; payloads are
 * emitted on rare events only. `contact:*` payload shapes the scene consumes are declared below as plain
 * interfaces (the scene does not import `src/contact`); the topics themselves belong to the contact module.
 */
import type { CallOutcome } from './types';

export interface SceneMaterializedEvent {
  callId: number;
}

/** A dispatch radio line (the integrator bridges it to `RadioSystem.say('dispatch', text, speaker)`). */
export interface SceneRadioEvent {
  channel: 'dispatch';
  speaker: string | null;
  text: string;
  priority: boolean;
}

/** A spoken line of a scene person or the officer (subtitles, speech output). `personId` -1 = the officer. */
export interface SceneLineEvent {
  personId: number;
  speaker: string;
  text: string;
  language: string;
}

export interface SceneFlashEvent {
  text: string;
}

export interface ScenePursuitEvent {
  kind: 'vehicle' | 'foot';
  active: boolean;
  callId: number;
}

export interface SceneOutcomeEvent {
  outcome: CallOutcome;
}

/** Asks the integrator to open an MDT form prefilled for the call. */
export interface SceneOpenFormEvent {
  kind: 'citation' | 'report';
  callId: number;
  personId: number;
  vehicleId: number;
}

export type ForceKind = 'sidearmDrawn' | 'taserDrawn' | 'taser' | 'sidearmFire' | 'tackle' | 'struggle' | 'cuff';

/** Use-of-force hook (Phase 5 grades it). `callId` 0 when no call. */
export interface ForceUsedEvent {
  kind: ForceKind;
  personId: number;
  callId: number;
}

/** Payload of the contact module's `contact:event` topic (design §10.3). */
export interface ContactEventPayload {
  incident: string;
  callId: number;
  personId: number;
  role: string;
  flag: string;
}

/** Payload of the contact module's `contact:needsCall` topic. */
export interface ContactNeedsCallPayload {
  personId: number;
  x: number;
  z: number;
  incident: string;
}

declare module '../core/event-map' {
  interface EventMap {
    'scene:materialized': SceneMaterializedEvent;
    'scene:radio': SceneRadioEvent;
    'scene:line': SceneLineEvent;
    'scene:flash': SceneFlashEvent;
    'scene:pursuit': ScenePursuitEvent;
    'scene:outcome': SceneOutcomeEvent;
    'scene:openForm': SceneOpenFormEvent;
    'force:used': ForceUsedEvent;
  }
}
