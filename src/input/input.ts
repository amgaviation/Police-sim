import type { EventMap } from '../core/event-map';
import { bus as defaultBus, type EventBus } from '../core/events';
import { ACTION_IDS, actionKind, type ActionId } from './actions';
import { DEFAULT_BINDINGS, cloneBindings, type Binding, type BindingMap } from './bindings';

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

/** Resolved value of every action, clamped to -1..1. */
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
 */
export function resolveActions(
  bindings: Readonly<BindingMap>,
  raw: RawInputState,
  deadzone: number = GAMEPAD_DEADZONE,
): ActionState {
  const state = {} as Record<ActionId, number>;
  for (const id of ACTION_IDS) {
    let sum = 0;
    for (const binding of bindings[id]) sum += readBinding(binding, raw, deadzone);
    state[id] = clamp(sum);
  }
  return state;
}

function zeroState(): Record<ActionId, number> {
  const state = {} as Record<ActionId, number>;
  for (const id of ACTION_IDS) state[id] = 0;
  return state;
}

// Minimal structural views of DOM events so handlers are callable without a DOM.
export interface KeyEventLike {
  readonly code: string;
  readonly repeat?: boolean;
  readonly target?: unknown;
  preventDefault?(): void;
}
export interface MouseButtonEventLike {
  readonly button: number;
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
  private readonly deadzone: number;
  private readonly getGamepads: () => ReadonlyArray<GamepadLike | null>;
  private bindings: BindingMap;

  private readonly keys = new Set<string>();
  private readonly tappedKeys = new Set<string>();
  private readonly mouseButtons = new Set<number>();
  private readonly tappedMouseButtons = new Set<number>();
  private mouseAccum: MouseDelta = { x: 0, y: 0, wheel: 0 };
  private frameMouse: Readonly<MouseDelta> = EMPTY_MOUSE;
  private gamepadButtons: number[] = [];
  private gamepadAxes: number[] = [];

  private state: Record<ActionId, number> = zeroState();
  private readonly down = new Set<ActionId>();
  private readonly pressed = new Set<ActionId>();
  private readonly released = new Set<ActionId>();

  private capture: CaptureCallback | null = null;
  private pointerLockEnabled: boolean;
  private locked = false;
  private element: HTMLElement | null = null;
  private disposers: Array<() => void> = [];

  constructor(options: InputManagerOptions = {}) {
    this.bus = options.bus ?? defaultBus;
    this.deadzone = options.deadzone ?? GAMEPAD_DEADZONE;
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
      this.locked = element !== null && doc.pointerLockElement === element;
      if (!this.locked) this.clearMouse();
    });
    this.listen(pointerTarget, 'mousedown', (e) => this.handleMouseDown(e as MouseEvent));
    this.listen(pointerTarget, 'mouseup', (e) => this.handleMouseUp(e as MouseEvent));
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
    const uiKey = this.isBound('keyboard', e.code, UI_ACTIONS);
    if (isEditableTarget(e.target) && !uiKey) return;
    if (uiKey || this.isBound('keyboard', e.code)) e.preventDefault?.();
    if (e.repeat) return;
    this.keys.add(e.code);
    this.tappedKeys.add(e.code);
  }

  handleKeyUp(e: KeyEventLike): void {
    this.keys.delete(e.code);
  }

  handleMouseDown(e: MouseButtonEventLike): void {
    if (this.capture) {
      e.preventDefault?.();
      this.deliverCapture({ device: 'mouse', code: `MouseButton${e.button}` });
      return;
    }
    if (this.pointerLockEnabled && !this.locked) this.requestPointerLock();
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

    const raw: RawInputState = {
      keys: this.tappedKeys.size === 0 ? this.keys : new Set([...this.keys, ...this.tappedKeys]),
      mouseButtons:
        this.tappedMouseButtons.size === 0 ? this.mouseButtons : new Set([...this.mouseButtons, ...this.tappedMouseButtons]),
      mouse: this.mouseAccum,
      gamepadButtons: this.gamepadButtons,
      gamepadAxes: this.gamepadAxes,
    };
    this.frameMouse = this.mouseAccum;
    this.mouseAccum = { x: 0, y: 0, wheel: 0 };
    this.tappedKeys.clear();
    this.tappedMouseButtons.clear();

    const state = resolveActions(this.bindings, raw, this.deadzone);
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
    this.state = state;
  }

  private pollGamepads(): void {
    const pad = this.getGamepads().find((p): p is GamepadLike => p !== null && p.connected);
    const prevButtons = this.gamepadButtons;
    const prevAxes = this.gamepadAxes;
    this.gamepadButtons = pad ? pad.buttons.map((b) => (b.value > 0 ? b.value : b.pressed ? 1 : 0)) : [];
    this.gamepadAxes = pad ? [...pad.axes] : [];
    if (!this.capture) return;

    // Rebinding capture: first button or axis that crosses the threshold this poll.
    for (let i = 0; i < this.gamepadButtons.length; i++) {
      const value = this.gamepadButtons[i] ?? 0;
      if (value >= BUTTON_THRESHOLD && (prevButtons[i] ?? 0) < BUTTON_THRESHOLD) {
        this.deliverCapture({ device: 'gamepad', code: `GamepadButton${i}` });
        return;
      }
    }
    for (let i = 0; i < this.gamepadAxes.length; i++) {
      const value = this.gamepadAxes[i] ?? 0;
      if (Math.abs(value) >= BUTTON_THRESHOLD && Math.abs(prevAxes[i] ?? 0) < BUTTON_THRESHOLD) {
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

  /** Unclamped pointer movement in pixels since the previous `update()`. */
  mouseDelta(): { x: number; y: number } {
    return { x: this.frameMouse.x, y: this.frameMouse.y };
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
  }

  resetBindings(): void {
    this.setBindings(DEFAULT_BINDINGS);
  }

  /** Replaces slot `index` of `action` (appends when `index` is past the end). */
  rebind(action: ActionId, index: number, binding: Binding): void {
    const list = this.bindings[action];
    if (index >= 0 && index < list.length) list[index] = { ...binding };
    else list.push({ ...binding });
  }

  unbind(action: ActionId, index: number): void {
    this.bindings[action].splice(index, 1);
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

  setPointerLockEnabled(enabled: boolean): void {
    this.pointerLockEnabled = enabled;
    if (!enabled && this.locked) this.element?.ownerDocument.exitPointerLock();
  }

  isPointerLocked(): boolean {
    return this.locked;
  }

  private requestPointerLock(): void {
    const el = this.element;
    if (!el || typeof el.requestPointerLock !== 'function') return;
    // Returns a promise in modern browsers, undefined in older ones; swallow rejections either way.
    void Promise.resolve(el.requestPointerLock()).catch(() => undefined);
  }

  private clearMouse(): void {
    this.mouseAccum = { x: 0, y: 0, wheel: 0 };
  }
}
