/** Tutorial bus topics (Phase 9 design §4.3), declared by declaration merging. */

/** A step became current (emitted once per step, including the first). */
export interface TutorialStepEvent {
  scriptId: string;
  index: number;
  id: string;
  count: number;
}

/** The tutorial finished (`completed` true) or was ended early; emitted once. */
export interface TutorialDoneEvent {
  scriptId: string;
  completed: boolean;
  /** Number of steps the player skipped. */
  skipped: number;
}

/** The `flash` step action: a one-line notice for the HUD. */
export interface TutorialFlashEvent {
  text: string;
}

declare module '../core/event-map' {
  interface EventMap {
    'tutorial:step': TutorialStepEvent;
    'tutorial:done': TutorialDoneEvent;
    'tutorial:flash': TutorialFlashEvent;
  }
}
