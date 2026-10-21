/**
 * Tutorial script and runtime types (Phase 9 design §8). The id lists are contracts shared with the integrator
 * (probes are read through `TutorialPorts`, topics are forwarded to `TutorialRunner.onEvent`).
 */

/** Simulation values a `{ probe }` step can wait for (booleans are 0 / 1). */
export const TUTORIAL_PROBES = ['speedKmh', 'driving', 'lightbar', 'siren', 'distanceToCallM'] as const;
export type TutorialProbe = (typeof TUTORIAL_PROBES)[number];

/** Bus topics a step can wait for; the integrator forwards every one of them to `TutorialRunner.onEvent`. */
export const TUTORIAL_TOPICS = [
  'player:mode',
  'unit:request',
  'cad:unitAssigned',
  'cad:unitStatus',
  'cad:callClosed',
  'cad:documentSaved',
  'traffic:pulledOver',
  'traffic:released',
  'dispatch:plateResult',
  'dispatch:backup',
] as const;
export type TutorialTopic = (typeof TUTORIAL_TOPICS)[number];

/** Actions a step runs once when it becomes current. */
export const TUTORIAL_ACTIONS = ['createCall', 'flash'] as const;
export type TutorialActionName = (typeof TUTORIAL_ACTIONS)[number];

/**
 * A bus event to wait for. `where` keys are dotted paths into the payload (`request.kind`); the values `"$player"` and
 * `"$call"` stand for the player callsign and the call bound by `createCall`. Comparison is `===`.
 */
export interface TutorialEventMatch {
  topic: TutorialTopic;
  where?: Record<string, string | number | boolean>;
}

export type TutorialUntil =
  /** The player presses Continue. */
  | { ack: true }
  /** The first matching bus event. */
  | { any: TutorialEventMatch[] }
  /** A probe value (checked every 15 fixed steps). */
  | { probe: TutorialProbe; gte?: number; lte?: number };

export type TutorialAction =
  /** Creates a call `minM`..`maxM` from the player and binds `$call`. */
  | { do: 'createCall'; typeId: string; minM: number; maxM: number }
  | { do: 'flash'; text: string };

export interface TutorialStep {
  id: string;
  title: string;
  /** May contain `{actionId}` tokens (replaced by the current key label at display time). */
  text: string;
  hint?: string;
  enter?: TutorialAction[];
  until: TutorialUntil;
  skippable?: boolean;
}

export interface TutorialScript {
  version: 1;
  id: string;
  title: string;
  steps: TutorialStep[];
}
