import type { Menu } from '../ui';

/** Options every academy minigame screen takes (Phase 8 §11.1). */
export interface MinigameOptions {
  /** Session seed: the draws come from `createRng(seed).stream('academy:<module>:<attempt>')`. */
  readonly seed: number;
  /** Attempt number (`records[module].attempts` when the screen opens). */
  readonly attempt: number;
  /** Called once with the final 0..100 score. */
  readonly onScore: (score: number) => void;
  /** Called when the player leaves the screen (after a result or by Escape). */
  readonly onExit: () => void;
}

/** A minigame screen: a pausing Menu with an `open()`. */
export interface MinigameScreen extends Menu {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

/** Layout width of the headless stand-in element (screens built without a document). */
export const HEADLESS_ELEMENT = {} as HTMLElement;

/** True when the screen may build DOM (a document exists and a UIRoot was given). */
export function canBuildDom(ui: unknown): boolean {
  return ui !== null && typeof document !== 'undefined';
}
