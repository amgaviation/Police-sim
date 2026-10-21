/**
 * Gamepad navigation of the menus (design §7.4). While a menu is open the pad drives the same keys a keyboard would:
 * the D-pad and the left stick send arrow keys (with repeat), A activates, B goes back (Escape), LB / RB send Shift+Tab /
 * Tab. The synthesized keys reach `UIRoot` (document listener) and the `InputManager` (window listener) like real ones,
 * so every menu's keyboard handling works unchanged. Presentation only; headless (no DOM) it needs a fake target.
 */

/** What `GamepadNav` reads from the pad (`InputManager` implements it). */
export interface PadSource {
  /** True on the frame button `i` went down. */
  padPressed(i: number): boolean;
  /** Raw value 0..1 of button `i`. */
  padButton(i: number): number;
  /** Raw axis value -1..1. */
  padAxis(i: number): number;
}

/** What `GamepadNav` drives (`UIRoot` plus the focused element). */
export interface GamepadNavTarget {
  isMenuOpen(): boolean;
  /** The element keys are dispatched to (`document.activeElement` or the top menu element). */
  focusTarget(): EventTarget | null;
  /** Moves focus inside the top menu; false when nothing could take it. */
  moveFocus(dir: 1 | -1): boolean;
}

/** Sends one synthesized key event; returns true when nothing consumed it (not `defaultPrevented`). */
export type KeyDispatch = (target: EventTarget, type: 'keydown' | 'keyup', key: string, code: string, shift: boolean) => boolean;

/** Standard-mapping buttons. */
export const PAD_BUTTON = { a: 0, b: 1, lb: 4, rb: 5, up: 12, down: 13, left: 14, right: 15 } as const;
/** Standard-mapping left stick axes. */
export const PAD_AXIS = { x: 0, y: 1 } as const;
/** A stick deflection beyond this counts as a direction. */
export const STICK_THRESHOLD = 0.5;
/** A button value at or above this counts as held. */
export const BUTTON_HELD = 0.5;
/** Held time before a direction starts repeating (ms). */
export const REPEAT_DELAY_MS = 400;
/** Interval between repeats once repeating (ms). */
export const REPEAT_INTERVAL_MS = 120;

/**
 * Whether a held direction fires now. `heldMs` is how long it has been held, `lastFireMs` the time (same clock as
 * `nowMs`) of its last key, negative when it has not fired yet (it fires at once). Afterwards it fires once `heldMs`
 * reaches `REPEAT_DELAY_MS` and then every `REPEAT_INTERVAL_MS`.
 */
export function padRepeat(heldMs: number, lastFireMs: number, nowMs: number): boolean {
  if (lastFireMs < 0) return true;
  return heldMs >= REPEAT_DELAY_MS && nowMs - lastFireMs >= REPEAT_INTERVAL_MS;
}

/** The default dispatch: a real `KeyboardEvent` (bubbles, cancelable) on `target`; true when not default-prevented. */
export const defaultKeyDispatch: KeyDispatch = (target, type, key, code, shift) => {
  const event = new KeyboardEvent(type, { key, code, shiftKey: shift, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return !event.defaultPrevented;
};

const DIRECTIONS = [
  { key: 'ArrowUp', button: PAD_BUTTON.up, axis: PAD_AXIS.y, sign: -1 },
  { key: 'ArrowDown', button: PAD_BUTTON.down, axis: PAD_AXIS.y, sign: 1 },
  { key: 'ArrowLeft', button: PAD_BUTTON.left, axis: PAD_AXIS.x, sign: -1 },
  { key: 'ArrowRight', button: PAD_BUTTON.right, axis: PAD_AXIS.x, sign: 1 },
] as const;

/** Elements A clicks instead of sending Enter to. */
const CLICKABLE_TAGS = new Set(['BUTTON', 'A', 'SUMMARY']);
const CLICKABLE_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset']);

function isClickable(target: EventTarget): boolean {
  const t = target as { tagName?: unknown; type?: unknown; click?: unknown; getAttribute?: unknown };
  if (typeof t.click !== 'function') return false;
  const tag = typeof t.tagName === 'string' ? t.tagName.toUpperCase() : '';
  if (CLICKABLE_TAGS.has(tag)) return true;
  if (tag === 'INPUT') return typeof t.type === 'string' && CLICKABLE_INPUTS.has(t.type.toLowerCase());
  return typeof t.getAttribute === 'function' && (t.getAttribute as (n: string) => unknown).call(target, 'role') === 'button';
}

/**
 * Per-frame gamepad menu navigation. Call `update(nowMs)` once per frame (the app calls it just before `InputManager.update()`, so
 * the synthesized keys are read in the same frame); it does nothing while no menu is
 * open (and then forgets held directions, so a stick held while a menu opens does not fire at once).
 */
export class GamepadNav {
  private readonly pad: PadSource;
  private readonly target: GamepadNavTarget;
  private readonly dispatch: KeyDispatch;
  private readonly heldSince = [0, 0, 0, 0];
  private readonly lastFire = [-1, -1, -1, -1];
  private readonly held = [false, false, false, false];

  constructor(pad: PadSource, target: GamepadNavTarget, dispatch: KeyDispatch = defaultKeyDispatch) {
    this.pad = pad;
    this.target = target;
    this.dispatch = dispatch;
  }

  update(nowMs: number): void {
    const open = this.target.isMenuOpen();
    for (let i = 0; i < DIRECTIONS.length; i++) {
      const d = DIRECTIONS[i] as (typeof DIRECTIONS)[number];
      const down = this.pad.padButton(d.button) >= BUTTON_HELD || this.pad.padAxis(d.axis) * d.sign > STICK_THRESHOLD;
      if (!down) {
        this.held[i] = false;
        continue;
      }
      if (!this.held[i]) {
        // A direction already held when the menu opens waits for the delay before it repeats.
        this.held[i] = true;
        this.heldSince[i] = nowMs;
        this.lastFire[i] = open ? -1 : nowMs;
      }
      if (open && padRepeat(nowMs - (this.heldSince[i] as number), this.lastFire[i] as number, nowMs)) {
        this.lastFire[i] = nowMs;
        this.arrow(d.key);
      }
    }
    if (!open) return;
    if (this.pad.padPressed(PAD_BUTTON.a)) this.activate();
    if (this.pad.padPressed(PAD_BUTTON.b)) this.press('Escape', false);
    if (this.pad.padPressed(PAD_BUTTON.lb)) this.press('Tab', true);
    if (this.pad.padPressed(PAD_BUTTON.rb)) this.press('Tab', false);
  }

  /**
   * keydown on `to`, then keyup. A key that closes its own menu removes `to` from the page, and an event dispatched on a
   * detached element never reaches the window, so the input manager would keep the key held: the keyup goes to the
   * element that has the focus now (the page when nothing has).
   */
  private tap(to: EventTarget, key: string, shift: boolean): boolean {
    const free = this.dispatch(to, 'keydown', key, key, shift);
    let up: EventTarget = to;
    if ((to as { isConnected?: unknown }).isConnected === false) {
      const now = this.target.focusTarget();
      up = now !== null && (now as { isConnected?: unknown }).isConnected !== false ? now : typeof document !== 'undefined' ? document : to;
    }
    this.dispatch(up, 'keyup', key, key, shift);
    return free;
  }

  private arrow(key: string): void {
    const to = this.target.focusTarget();
    if (to === null) return;
    const free = this.tap(to, key, false);
    if (free) this.target.moveFocus(key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1);
  }

  private activate(): void {
    const to = this.target.focusTarget();
    if (to === null) return;
    if (isClickable(to)) {
      (to as HTMLElement).click();
      return;
    }
    this.tap(to, 'Enter', false);
  }

  private press(key: 'Escape' | 'Tab', shift: boolean): void {
    const to = this.target.focusTarget();
    if (to === null) return;
    const free = this.tap(to, key, shift);
    // The browser does not move focus for a synthetic Tab.
    if (free && key === 'Tab') this.target.moveFocus(shift ? -1 : 1);
  }
}
