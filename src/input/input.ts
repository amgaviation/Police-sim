import type { EventMap } from '../core/event-map';
import { bus as defaultBus, type EventBus } from '../core/events';
import { ACTION_IDS, actionKind, type ActionId } from './actions';
import { DEFAULT_BINDINGS, cloneBindings, type Binding, type BindingMap } from './bindings';
import { DEFAULT_INPUT_CONTEXT, isArbitrated, isEligible, isModal, rankOf, type InputContext } from './context';

/** Gamepad stick magnitude below which an axis reads as 0. */
export const GAMEPAD_DEADZONE = 0.15;
/** Absolute action value at or above which a button action counts as down. */
export const BUTTON_THRESHOLD = 0.5;

export interface MouseDelta {
  x: number;
  y: number;
  wheel: number;
}

/** Device-level snapshot for one frame, independent of any DOM event objects. */
export interface RawInputState {
  /** `KeyboardEvent.code`s currently held (or tapped since the last frame). */
  readonly keys: ReadonlySet<string>;
  /** `MouseEvent.button` indices currently held. */
  readonly mouseButtons: ReadonlySet<number>;
  /** Pixel / notch deltas accumulated over the frame. */
  readonly mouse: Readonly<MouseDelta>;
  /** Button values (0..1) of the active gamepad, indexed by button. */
  readonly gamepadButtons: readonly number[];
  /** Raw axis values (-1..1) of the active gamepad, before deadzone. */
  readonly gamepadAxes: readonly number[];
}

/** Resolved value of every action: -1..1 for axis actions, 0..1 for button actions. */
export type ActionState = Readonly<Record<ActionId, number>>;

const EMPTY_MOUSE: Readonly<MouseDelta> = { x: 0, y: 0, wheel: 0 };

const clamp = (v: number): number => Math.max(-1, Math.min(1, v));

/** Removes a centred deadzone and rescales the remainder to the full -1..1 range. */
export function applyDeadzone(value: number, deadzone: number = GAMEPAD_DEADZONE): number {
  const mag = Math.abs(value);
  if (mag < deadzone) return 0;
  return Math.sign(value) * Math.min(1, (mag - deadzone) / (1 - deadzone));
}

/** Value a single binding contributes (already multiplied by its `scale`). */
export function readBinding(binding: Binding, raw: RawInputState, deadzone: number = GAMEPAD_DEADZONE): number {
  const scale = binding.scale ?? 1;
  const { code } = binding;
  switch (binding.device) {
    case 'keyboard':
      return raw.keys.has(code) ? scale : 0;
    case 'mouse': {
      if (code === 'MouseX') return raw.mouse.x * scale;
      if (code === 'MouseY') return raw.mouse.y * scale;
      if (code === 'MouseWheel') return raw.mouse.wheel * scale;
      const index = codeIndex(code, 'MouseButton');
      return index !== undefined && raw.mouseButtons.has(index) ? scale : 0;
    }
    case 'gamepad': {
      const button = codeIndex(code, 'GamepadButton');
      if (button !== undefined) return (raw.gamepadButtons[button] ?? 0) * scale;
      const axis = codeIndex(code, 'GamepadAxis');
      if (axis !== undefined) return applyDeadzone(raw.gamepadAxes[axis] ?? 0, deadzone) * scale;
      return 0;
    }
  }
}

function codeIndex(code: string, prefix: string): number | undefined {
  if (!code.startsWith(prefix)) return undefined;
  const n = Number(code.slice(prefix.length));
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Pure mapping from device state to action values: every binding of an action
 * contributes `value * scale`, contributions are summed and clamped to -1..1.
 * Button actions are one-sided (0..1): a stick half pushed the other way, as
 * on "move back" while the stick is pushed forward, reads as released.
 */
export function resolveActions(
  bindings: Readonly<BindingMap>,
  raw: RawInputState,
  deadzone: number = GAMEPAD_DEADZONE,
  out: Record<ActionId, number> = {} as Record<ActionId, number>,
): ActionState {
  const state = out;
  for (const id of ACTION_IDS) {
    let sum = 0;
    for (const binding of bindings[id]) sum += readBinding(binding, raw, deadzone);
    state[id] = actionKind(id) === 'button' ? Math.max(0, Math.min(1, sum)) : clamp(sum);
  }
  return state;
}

/** True for bindings that read pointer movement or the wheel (not mouse buttons). */
export function isMouseMotionBinding(binding: Binding): boolean {
  return binding.device === 'mouse' && (binding.code === 'MouseX' || binding.code === 'MouseY' || binding.code === 'MouseWheel');
}

function zeroState(): Record<ActionId, number> {
  const state = {} as Record<ActionId, number>;
  for (const id of ACTION_IDS) state[id] = 0;
  return state;
}

// Minimal structural views of DOM events so handlers are callable without a DOM.
export interface KeyEventLike {
  readonly code: string;
  /** Produced character (`KeyboardEvent.key`); one character for printable keys. */
  readonly key?: string;
  readonly repeat?: boolean;
  readonly target?: unknown;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  preventDefault?(): void;
}
export interface MouseButtonEventLike {
  readonly button: number;
  readonly target?: unknown;
  preventDefault?(): void;
}
export interface MouseMoveEventLike {
  readonly movementX: number;
  readonly movementY: number;
}
export interface WheelEventLike {
  readonly deltaY: number;
}
export interface GamepadLike {
  readonly connected: boolean;
  readonly buttons: ReadonlyArray<{ readonly value: number; readonly pressed: boolean }>;
  readonly axes: readonly number[];
}

/** Called when pointer lock is released by the browser or the user (e.g. Escape). */
export type PointerLockLostListener = () => void;

/** Receives the next captured binding, or `null` when capture was cancelled (Escape). */
export type CaptureCallback = (binding: Binding | null) => void;

export interface InputManagerOptions {
  readonly bus?: EventBus<EventMap>;
  readonly bindings?: Readonly<BindingMap>;
  /** Request pointer lock on the attached element when it is clicked. Default false. */
  readonly pointerLock?: boolean;
  readonly deadzone?: number;
  /** Gamepad source; defaults to `navigator.getGamepads()`. */
  readonly getGamepads?: () => ReadonlyArray<GamepadLike | null>;
}

/** Actions whose keys keep working while a text field has focus. */
const UI_ACTIONS: ReadonlySet<ActionId> = new Set<ActionId>(['menu.toggle', 'console.toggle', 'perf.toggle']);

function defaultGetGamepads(): ReadonlyArray<GamepadLike | null> {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return [];
  try {
    return navigator.getGamepads();
  } catch {
    return [];
  }
}

/**
 * Keys that type a character into a text field. Backquote is exempt: it is the
 * console's own toggle and must keep working inside the console input.
 */
function isPrintableKey(e: KeyEventLike): boolean {
  return e.key !== undefined && e.key.length === 1 && e.code !== 'Backquote';
}

const MODIFIER_CODE = /^(Control|Alt|Meta|Shift)(Left|Right)$/;

/** Ctrl, Cmd or Alt plus another key: a browser or OS shortcut, not game input. */
function isShortcut(e: KeyEventLike): boolean {
  return (e.ctrlKey === true || e.metaKey === true || e.altKey === true) && !MODIFIER_CODE.test(e.code);
}

/** Controls a rebinding click must reach (Back, tabs, other chips) unless marked `data-capture-target`. */
const CAPTURE_EXEMPT = 'button, a, input, select, textarea, [role="tab"]';

/** `target.closest(selector) !== null` for DOM-like targets; false otherwise. */
function closestMatches(target: unknown, selector: string): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const closest = (target as { closest?: unknown }).closest;
  return typeof closest === 'function' && (closest as (s: string) => unknown).call(target, selector) !== null;
}

function isEditableTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true;
}

type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * Turns keyboard, mouse and gamepad input into abstract action state.
 *
 * Call `update()` exactly once per frame before reading: it polls gamepads,
 * resolves actions, rolls press/release edges and publishes the frame's mouse
 * delta. The `handle*` methods are the event listeners `attach()` installs and
 * may be called directly in tests.
 */
export class InputManager {
  private readonly bus: EventBus<EventMap>;
  private deadzoneValue: number;
  private readonly getGamepads: () => ReadonlyArray<GamepadLike | null>;
  private bindings: BindingMap;

  private readonly keys = new Set<string>();
  private readonly tappedKeys = new Set<string>();
  private readonly mouseButtons = new Set<number>();
  private readonly tappedMouseButtons = new Set<number>();
  private mouseAccum: MouseDelta = { x: 0, y: 0, wheel: 0 };
  private frameMouse: MouseDelta = { x: 0, y: 0, wheel: 0 };
  private readonly frameLook = { x: 0, y: 0 };
  private gamepadButtons: number[] = [];
  private gamepadAxes: number[] = [];
  private prevGamepadButtons: number[] = [];
  private prevGamepadAxes: number[] = [];
  private readonly heldKeys = new Set<string>();
  private readonly heldButtons = new Set<number>();
  /** Gamepad inputs just captured for rebinding; they read 0 until released. */
  private readonly suppressedButtons = new Set<number>();
  private readonly suppressedAxes = new Set<number>();
  private raw: RawInputState = {
    keys: this.keys,
    mouseButtons: this.mouseButtons,
    mouse: EMPTY_MOUSE,
    gamepadButtons: [],
    gamepadAxes: [],
  };

  private state: Record<ActionId, number> = zeroState();
  private nextState: Record<ActionId, number> = zeroState();
  private readonly down = new Set<ActionId>();
  private readonly pressed = new Set<ActionId>();
  private readonly released = new Set<ActionId>();

  /** Keys / buttons bound to two or more actions, arbitrated by `context` every update (see `context.ts`). */
  private shared: SharedKey[] = [];
  private sharedDirty = true;
  private readonly context: InputContext = { ...DEFAULT_INPUT_CONTEXT };
  /** Shared keys are arbitrated only once the game has described the situation (`setContext`). */
  private contextKnown = false;
  /** Shared keys taken by the radio menu until they are released. */
  private readonly claimed = new Set<string>();
  private readonly justPressed = new Set<string>();
  private readonly dropped: { id: ActionId; key: string }[] = [];
  private droppedCount = 0;

  private capture: CaptureCallback | null = null;
  private pointerLockEnabled: boolean;
  private locked = false;
  private element: HTMLElement | null = null;
  private disposers: Array<() => void> = [];
  private readonly pointerLockLost = new Set<PointerLockLostListener>();
  /** Swallow the click that follows a mouse button captured for rebinding. */
  private swallowClick = false;

  constructor(options: InputManagerOptions = {}) {
    this.bus = options.bus ?? defaultBus;
    this.deadzoneValue = clampDeadzone(options.deadzone ?? GAMEPAD_DEADZONE);
    this.getGamepads = options.getGamepads ?? defaultGetGamepads;
    this.bindings = cloneBindings(options.bindings ?? DEFAULT_BINDINGS);
    this.pointerLockEnabled = options.pointerLock ?? false;
  }

  // --- DOM wiring -----------------------------------------------------------

  /** Installs listeners; keyboard and blur go on the window, pointer events on `target`. */
  attach(target: HTMLElement | Window): void {
    this.detach();
    const element: HTMLElement | null = 'ownerDocument' in target ? target : null;
    const win: Window = 'ownerDocument' in target ? (target.ownerDocument.defaultView ?? window) : target;
    const doc = win.document;
    const pointerTarget: Listenable = element ?? win;
    this.element = element;

    this.listen(win, 'keydown', (e) => this.handleKeyDown(e as KeyboardEvent));
    this.listen(win, 'keyup', (e) => this.handleKeyUp(e as KeyboardEvent));
    this.listen(win, 'blur', () => this.handleBlur());
    this.listen(doc, 'pointerlockchange', () => {
      this.handlePointerLockChange(element !== null && doc.pointerLockElement === element);
    });
    // Rebinding capture takes mouse buttons from anywhere (the menu covers the canvas),
    // before any element sees them, and keeps the click from activating a control.
    this.listen(win, 'mousedown', (e) => this.handleCaptureMouseDown(e as MouseEvent), { capture: true });
    for (const type of ['click', 'auxclick', 'contextmenu']) {
      this.listen(win, type, (e) => this.handleCaptureClick(e), { capture: true });
    }
    this.listen(pointerTarget, 'mousedown', (e) => this.handleMouseDown(e as MouseEvent));
    // On the window: a button released over a menu or the console must not stay down.
    this.listen(win, 'mouseup', (e) => this.handleMouseUp(e as MouseEvent));
    this.listen(pointerTarget, 'mousemove', (e) => this.handleMouseMove(e as MouseEvent));
    this.listen(pointerTarget, 'wheel', (e) => this.handleWheel(e as WheelEvent), { passive: true });
    this.listen(pointerTarget, 'contextmenu', (e) => e.preventDefault());
  }

  /** Removes all listeners and clears device state. */
  detach(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.element = null;
    this.locked = false;
    this.handleBlur();
  }

  private listen(target: Listenable, type: string, handler: (e: Event) => void, options?: AddEventListenerOptions): void {
    target.addEventListener(type, handler, options);
    this.disposers.push(() => target.removeEventListener(type, handler, options));
  }

  // --- Event handlers -------------------------------------------------------

  handleKeyDown(e: KeyEventLike): void {
    if (this.capture) {
      e.preventDefault?.();
      if (e.repeat) return;
      this.deliverCapture(e.code === 'Escape' ? null : { device: 'keyboard', code: e.code });
      return;
    }
    // Leave shortcuts (Ctrl+L, Cmd+S) to the browser; on macOS the key's keyup would never come.
    if (isShortcut(e)) return;
    const editable = isEditableTarget(e.target);
    // In a text field, UI actions bound to printable keys must not swallow typing.
    const uiKey = this.isBound('keyboard', e.code, UI_ACTIONS) && !(editable && isPrintableKey(e));
    if (editable && !uiKey) return;
    // Gameplay keys keep their default (scrolling, activating buttons) while a menu control has focus.
    if (uiKey || (this.isBound('keyboard', e.code) && (this.locked || this.isGameTarget(e.target)))) e.preventDefault?.();
    if (e.repeat) return;
    this.keys.add(e.code);
    this.tappedKeys.add(e.code);
  }

  handleKeyUp(e: KeyEventLike): void {
    this.keys.delete(e.code);
    // macOS sends no keyup for keys released while Cmd was held.
    if (e.code === 'MetaLeft' || e.code === 'MetaRight') this.keys.clear();
  }

  /**
   * Window-level, capture-phase mousedown: delivers a pending rebinding capture.
   * A primary click on another control (Back, a tab, another chip) cancels the
   * capture and goes through; on the capturing chip or empty space it binds.
   */
  handleCaptureMouseDown(e: MouseButtonEventLike & { stopPropagation?(): void }): void {
    this.swallowClick = false;
    if (!this.capture) return;
    if (e.button === 0 && closestMatches(e.target, CAPTURE_EXEMPT) && !closestMatches(e.target, '[data-capture-target]')) {
      this.deliverCapture(null);
      return;
    }
    e.preventDefault?.();
    e.stopPropagation?.();
    this.swallowClick = true;
    this.deliverCapture({ device: 'mouse', code: `MouseButton${e.button}` });
  }

  /** Swallows the click/auxclick/contextmenu produced by a captured mouse button. */
  handleCaptureClick(e: { readonly type: string; preventDefault?(): void; stopPropagation?(): void }): void {
    if (!this.swallowClick) return;
    e.preventDefault?.();
    e.stopPropagation?.();
    if (e.type !== 'contextmenu') this.swallowClick = false;
  }

  /** Tracks pointer lock; notifies `onPointerLockLost` listeners when a held lock is released. */
  handlePointerLockChange(locked: boolean): void {
    if (locked && !this.pointerLockEnabled) {
      // Granted after locking was turned off (a menu opened while it was pending).
      this.element?.ownerDocument.exitPointerLock();
      return;
    }
    const wasLocked = this.locked;
    this.locked = locked;
    if (locked) return;
    this.clearMouse();
    this.mouseButtons.clear();
    if (wasLocked) for (const listener of [...this.pointerLockLost]) listener();
  }

  /** Subscribes to pointer-lock loss (the browser consumes the Escape that releases it). */
  onPointerLockLost(listener: PointerLockLostListener): () => void {
    this.pointerLockLost.add(listener);
    return () => {
      this.pointerLockLost.delete(listener);
    };
  }

  handleMouseDown(e: MouseButtonEventLike): void {
    if (this.capture) {
      e.preventDefault?.();
      this.deliverCapture({ device: 'mouse', code: `MouseButton${e.button}` });
      return;
    }
    // The click that grabs the pointer does only that: it must not also fire its action.
    if (this.pointerLockEnabled && !this.locked && this.requestPointerLock()) return;
    this.mouseButtons.add(e.button);
    this.tappedMouseButtons.add(e.button);
  }

  handleMouseUp(e: MouseButtonEventLike): void {
    this.mouseButtons.delete(e.button);
  }

  /** Accumulates movement; ignored while pointer lock is enabled but not held. */
  handleMouseMove(e: MouseMoveEventLike): void {
    if (this.pointerLockEnabled && !this.locked) return;
    this.mouseAccum.x += e.movementX;
    this.mouseAccum.y += e.movementY;
  }

  handleWheel(e: WheelEventLike): void {
    this.mouseAccum.wheel += Math.sign(e.deltaY);
  }

  /** Forgets every held key and button so nothing sticks after focus loss. */
  handleBlur(): void {
    this.keys.clear();
    this.tappedKeys.clear();
    this.mouseButtons.clear();
    this.tappedMouseButtons.clear();
    this.clearMouse();
  }

  // --- Per-frame update -----------------------------------------------------

  /** Polls gamepads, resolves actions, rolls edges and publishes the frame's mouse delta. */
  update(): void {
    this.pollGamepads();

    // Swap the accumulator with last frame's delta instead of allocating.
    const frameMouse = this.mouseAccum;
    this.mouseAccum = this.frameMouse;
    this.mouseAccum.x = 0;
    this.mouseAccum.y = 0;
    this.mouseAccum.wheel = 0;
    this.frameMouse = frameMouse;
    this.frameLook.x = frameMouse.x;
    this.frameLook.y = frameMouse.y;
    this.raw = {
      keys: this.tappedKeys.size === 0 ? this.keys : union(this.heldKeys, this.keys, this.tappedKeys),
      mouseButtons:
        this.tappedMouseButtons.size === 0 ? this.mouseButtons : union(this.heldButtons, this.mouseButtons, this.tappedMouseButtons),
      mouse: frameMouse,
      gamepadButtons: this.gamepadButtons,
      gamepadAxes: this.gamepadAxes,
    };
    this.justPressed.clear();
    for (const code of this.tappedKeys) this.justPressed.add(`keyboard:${code}`);
    this.tappedKeys.clear();
    this.tappedMouseButtons.clear();

    const state = resolveActions(this.bindings, this.raw, this.deadzoneValue, this.nextState);
    this.arbitrate(state);
    this.pressed.clear();
    this.released.clear();
    for (const id of ACTION_IDS) {
      const value = state[id];
      const isDown = Math.abs(value) >= BUTTON_THRESHOLD;
      if (isDown === this.down.has(id)) continue;
      if (isDown) {
        this.down.add(id);
        this.pressed.add(id);
      } else {
        this.down.delete(id);
        this.released.add(id);
      }
      if (actionKind(id) === 'button') this.bus.emit('input:action', { action: id, value, pressed: isDown });
    }
    this.nextState = this.state;
    this.state = state;
  }

  /**
   * Situation of the player for the actions that share keys (driving, aircraft, radio menu, session mode). Copied, so the
   * caller may reuse its object every frame.
   */
  setContext(ctx: Readonly<InputContext>): void {
    const c = this.context;
    c.driving = ctx.driving;
    c.aircraft = ctx.aircraft;
    c.radioMenu = ctx.radioMenu;
    c.mode = ctx.mode;
    this.contextKnown = true;
  }

  private rebuildShared(): void {
    this.sharedDirty = false;
    this.claimed.clear();
    const byKey = new Map<string, Set<ActionId>>();
    for (const id of ACTION_IDS) {
      for (const b of this.bindings[id]) {
        if (!isArbitrated(b)) continue;
        const key = `${b.device}:${b.code}`;
        const set = byKey.get(key) ?? new Set<ActionId>();
        set.add(id);
        byKey.set(key, set);
      }
    }
    this.shared = [];
    for (const [key, set] of byKey) {
      if (set.size < 2) continue;
      const code = key.slice(key.indexOf(':') + 1);
      const mouse = key.startsWith('mouse:') ? Number(code.slice('MouseButton'.length)) : -1;
      this.shared.push({ key, code, mouse, ids: [...set] });
    }
  }

  /**
   * A key bound to several actions acts for the eligible ones only (`isEligible`), and a rare opener gives way to a
   * non-rare action of the same key. While the radio menu is open a key pressed for it belongs to the menu until released.
   * Rewrites the values of the silenced actions without the bindings they lost; nothing changes for unshared inputs.
   */
  private arbitrate(state: Record<ActionId, number>): void {
    if (!this.contextKnown) return;
    if (this.sharedDirty) this.rebuildShared();
    if (this.shared.length === 0) return;
    const ctx = this.context;
    this.droppedCount = 0;
    for (const entry of this.shared) {
      const held = entry.mouse >= 0 ? this.raw.mouseButtons.has(entry.mouse) : this.raw.keys.has(entry.code);
      if (!held) {
        this.claimed.delete(entry.key);
        continue;
      }
      let claimed = this.claimed.has(entry.key);
      if (!claimed && ctx.radioMenu && this.justPressed.has(entry.key) && entry.ids.some((id) => isModal(id))) {
        this.claimed.add(entry.key);
        claimed = true;
      }
      let top = 0;
      for (const id of entry.ids) if (this.acts(id, claimed, ctx)) top = Math.max(top, rankOf(id));
      for (const id of entry.ids) {
        if (this.acts(id, claimed, ctx) && rankOf(id) === top) continue;
        let slot = this.dropped[this.droppedCount];
        if (slot === undefined) {
          slot = { id, key: entry.key };
          this.dropped[this.droppedCount] = slot;
        }
        slot.id = id;
        slot.key = entry.key;
        this.droppedCount++;
      }
    }
    for (let i = 0; i < this.droppedCount; i++) {
      const id = (this.dropped[i] as { id: ActionId }).id;
      let first = true;
      for (let j = 0; j < i; j++) if ((this.dropped[j] as { id: ActionId }).id === id) first = false;
      if (first) state[id] = this.valueWithout(id);
    }
  }

  private acts(id: ActionId, claimed: boolean, ctx: Readonly<InputContext>): boolean {
    return isEligible(id, ctx) && isModal(id) === claimed;
  }

  /** The resolved value of `id` without its dropped (shared, silenced) bindings. */
  private valueWithout(id: ActionId): number {
    let sum = 0;
    for (const b of this.bindings[id]) {
      if (isArbitrated(b) && this.isDropped(id, `${b.device}:${b.code}`)) continue;
      sum += readBinding(b, this.raw, this.deadzoneValue);
    }
    return actionKind(id) === 'button' ? Math.max(0, Math.min(1, sum)) : clamp(sum);
  }

  private isDropped(id: ActionId, key: string): boolean {
    for (let i = 0; i < this.droppedCount; i++) {
      const d = this.dropped[i] as { id: ActionId; key: string };
      if (d.id === id && d.key === key) return true;
    }
    return false;
  }

  private pollGamepads(): void {
    const pad = this.getGamepads().find((p): p is GamepadLike => p !== null && p.connected);
    // Double-buffered so polling does not allocate.
    const prevButtons = this.gamepadButtons;
    const prevAxes = this.gamepadAxes;
    this.gamepadButtons = this.prevGamepadButtons;
    this.gamepadAxes = this.prevGamepadAxes;
    this.prevGamepadButtons = prevButtons;
    this.prevGamepadAxes = prevAxes;
    this.gamepadButtons.length = pad ? pad.buttons.length : 0;
    this.gamepadAxes.length = pad ? pad.axes.length : 0;
    if (pad) {
      pad.buttons.forEach((b, i) => {
        this.gamepadButtons[i] = b.value > 0 ? b.value : b.pressed ? 1 : 0;
      });
      pad.axes.forEach((v, i) => {
        this.gamepadAxes[i] = v;
      });
    }
    suppressHeld(this.suppressedButtons, this.gamepadButtons);
    suppressHeld(this.suppressedAxes, this.gamepadAxes);
    if (!this.capture) return;

    // Rebinding capture: first button or axis that crosses the threshold this poll.
    for (let i = 0; i < this.gamepadButtons.length; i++) {
      const value = this.gamepadButtons[i] ?? 0;
      if (value >= BUTTON_THRESHOLD && (prevButtons[i] ?? 0) < BUTTON_THRESHOLD) {
        // Held through the rebind, it would fire the newly bound action this very frame.
        this.suppressedButtons.add(i);
        this.gamepadButtons[i] = 0;
        this.deliverCapture({ device: 'gamepad', code: `GamepadButton${i}` });
        return;
      }
    }
    for (let i = 0; i < this.gamepadAxes.length; i++) {
      const value = this.gamepadAxes[i] ?? 0;
      if (Math.abs(value) >= BUTTON_THRESHOLD && Math.abs(prevAxes[i] ?? 0) < BUTTON_THRESHOLD) {
        this.suppressedAxes.add(i);
        this.gamepadAxes[i] = 0;
        this.deliverCapture({ device: 'gamepad', code: `GamepadAxis${i}`, scale: Math.sign(value) });
        return;
      }
    }
  }

  // --- Queries ---------------------------------------------------------------

  isDown(action: ActionId): boolean {
    return this.down.has(action);
  }

  /** True only on the frame the action went down. */
  wasPressed(action: ActionId): boolean {
    return this.pressed.has(action);
  }

  /** True only on the frame the action went up. */
  wasReleased(action: ActionId): boolean {
    return this.released.has(action);
  }

  /** Resolved value in -1..1 (buttons read 0 or ±1 unless bound to an analog input). */
  axis(action: ActionId): number {
    return this.state[action];
  }

  /**
   * Like `axis` but without pointer-movement bindings (`MouseX`/`MouseY`/`MouseWheel`),
   * for stick-style rate input when mouse look is applied separately via `mouseDelta()`.
   */
  stickAxis(action: ActionId): number {
    let sum = 0;
    for (const binding of this.bindings[action]) {
      if (!isMouseMotionBinding(binding)) sum += readBinding(binding, this.raw, this.deadzoneValue);
    }
    return clamp(sum);
  }

  /** Unclamped pointer movement in pixels since the previous `update()` (valid until the next one). */
  mouseDelta(): Readonly<{ x: number; y: number }> {
    return this.frameLook;
  }

  /** Gamepad stick deadzone in [0, 0.95]. */
  get deadzone(): number {
    return this.deadzoneValue;
  }

  setDeadzone(deadzone: number): void {
    this.deadzoneValue = clampDeadzone(deadzone);
  }

  /** Wheel notches since the previous `update()` (positive = scrolled down). */
  wheelDelta(): number {
    return this.frameMouse.wheel;
  }

  // --- Bindings ---------------------------------------------------------------

  getBindings(): BindingMap {
    return cloneBindings(this.bindings);
  }

  setBindings(bindings: Readonly<BindingMap>): void {
    this.bindings = cloneBindings(bindings);
    this.sharedDirty = true;
  }

  resetBindings(): void {
    this.setBindings(DEFAULT_BINDINGS);
  }

  /** Replaces slot `index` of `action` (appends when `index` is past the end). */
  rebind(action: ActionId, index: number, binding: Binding): void {
    const list = this.bindings[action];
    if (index >= 0 && index < list.length) list[index] = { ...binding };
    else list.push({ ...binding });
    this.sharedDirty = true;
  }

  unbind(action: ActionId, index: number): void {
    this.bindings[action].splice(index, 1);
    this.sharedDirty = true;
  }

  /**
   * Routes the next key, mouse button, gamepad button or deflected gamepad
   * axis to `callback` instead of the action state. Escape cancels (callback
   * receives `null`). Returns a function that abandons the capture.
   */
  captureNext(callback: CaptureCallback): () => void {
    this.capture = callback;
    return () => {
      if (this.capture === callback) this.capture = null;
    };
  }

  isCapturing(): boolean {
    return this.capture !== null;
  }

  private deliverCapture(binding: Binding | null): void {
    const callback = this.capture;
    this.capture = null;
    callback?.(binding);
  }

  private isBound(device: Binding['device'], code: string, only?: ReadonlySet<ActionId>): boolean {
    for (const id of ACTION_IDS) {
      if (only && !only.has(id)) continue;
      for (const b of this.bindings[id]) if (b.device === device && b.code === code) return true;
    }
    return false;
  }

  // --- Pointer lock -----------------------------------------------------------

  /**
   * Movement gathered under the other mode (a free cursor over the console, say)
   * is dropped on a change, so it is never applied as a look jump.
   */
  setPointerLockEnabled(enabled: boolean): void {
    if (enabled !== this.pointerLockEnabled) {
      this.clearMouse();
      this.frameMouse.x = 0;
      this.frameMouse.y = 0;
      this.frameMouse.wheel = 0;
      this.frameLook.x = 0;
      this.frameLook.y = 0;
    }
    this.pointerLockEnabled = enabled;
    if (!enabled && this.locked) this.element?.ownerDocument.exitPointerLock();
  }

  isPointerLocked(): boolean {
    return this.locked;
  }

  /** The page itself rather than a focused control: body, document, window or the game canvas. */
  private isGameTarget(target: unknown): boolean {
    if (typeof target !== 'object' || target === null || target === this.element) return true;
    const tag = (target as { tagName?: unknown }).tagName;
    return tag === undefined || tag === 'BODY' || tag === 'HTML';
  }

  /** Asks for pointer lock; false when the element cannot lock the pointer. */
  private requestPointerLock(): boolean {
    const el = this.element;
    if (!el || typeof el.requestPointerLock !== 'function') return false;
    // Returns a promise in modern browsers, undefined in older ones; swallow rejections either way.
    void Promise.resolve(el.requestPointerLock()).catch(() => undefined);
    return true;
  }

  private clearMouse(): void {
    this.mouseAccum.x = 0;
    this.mouseAccum.y = 0;
    this.mouseAccum.wheel = 0;
  }
}

interface SharedKey {
  /** `keyboard:KeyW` / `mouse:MouseButton2`. */
  readonly key: string;
  readonly code: string;
  /** Mouse button index, -1 for a keyboard key. */
  readonly mouse: number;
  readonly ids: ActionId[];
}

function clampDeadzone(value: number): number {
  return Number.isFinite(value) ? Math.min(0.95, Math.max(0, value)) : GAMEPAD_DEADZONE;
}

/** Zeroes suppressed inputs that are still held; forgets those that were released. */
function suppressHeld(suppressed: Set<number>, values: number[]): void {
  for (const i of suppressed) {
    if (Math.abs(values[i] ?? 0) < BUTTON_THRESHOLD) suppressed.delete(i);
    else values[i] = 0;
  }
}

/** Fills `out` with the union of `a` and `b` (reused across frames). */
function union<T>(out: Set<T>, a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> {
  out.clear();
  for (const v of a) out.add(v);
  for (const v of b) out.add(v);
  return out;
}
