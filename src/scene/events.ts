/**
 * Scene bus topics (Phase 3 design §11.9, §13). Declared here by declaration merging; payloads are
 * emitted on rare events only. `contact:*` payload shapes the scene consumes are declared below as plain
 * interfaces (the scene does not import `src/contact`); the topics themselves belong to the contact module.
 */
import type { CallOutcome } from './types';

export interface SceneMaterializedEvent {
  callId: number;
  /** Phase 4 (present when the scene runs with interiors): the bound building, -1 outdoors. */
  buildingId?: number;
}

/** A service (EMS, K9, ...) was requested or arrived on a call (the integrator starts the K9 sweep on `k9` + `arrived`). */
export interface SceneServiceEvent {
  callId: number;
  kind: string;
  phase: 'requested' | 'arrived';
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
  /** Phase 5: the call whose stop or scene the pursuit came from (0 none). Set on start and end. */
  ownerCallId?: number;
  /** Phase 5: the pursued driver or runner (-1 unknown). Set on start and end. */
  personId?: number;
  /** Phase 5, `active: false` only: `escaped crashed stopped gaveUp caught terminated` (the traffic flee reasons; `caught` for a runner brought down). */
  endReason?: string;
}

/** An officer command shouted at a person (`SceneDirector.shout`), after the actor's reaction was applied. */
export interface SceneCommandEvent {
  callId: number;
  personId: number;
  actorId: number;
  command: string;
  /** `comply refuse flee fight confused`. */
  outcome: string;
  sim: number;
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

/** Payload of the contact module's `contact:consent` topic (design phase 4 §8.2). */
export interface ContactConsentPayload {
  incident: string;
  callId: number;
  personId: number;
  kind: string;
  granted: boolean;
  valid: boolean;
  buildingId: number;
  room: number;
  sim: number;
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
    'scene:service': SceneServiceEvent;
    'scene:radio': SceneRadioEvent;
    'scene:line': SceneLineEvent;
    'scene:flash': SceneFlashEvent;
    'scene:pursuit': ScenePursuitEvent;
    'scene:command': SceneCommandEvent;
    'scene:outcome': SceneOutcomeEvent;
    'scene:openForm': SceneOpenFormEvent;
    'force:used': ForceUsedEvent;
  }
}
