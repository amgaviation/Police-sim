import { ACTION_IDS, actionKind, isActionId, isBipolar, type ActionId } from './actions';

export type InputDevice = 'keyboard' | 'mouse' | 'gamepad';

/**
 * One physical input mapped to an action.
 *
 * `code` is `KeyboardEvent.code` for the keyboard, `MouseButton<n>` /
 * `MouseX` / `MouseY` / `MouseWheel` for the mouse and `GamepadButton<n>` /
 * `GamepadAxis<n>` for a gamepad. `scale` multiplies the raw value (use -1 to
 * invert an axis or to map a key to the negative side of an axis action).
 */
export interface Binding {
  readonly device: InputDevice;
  readonly code: string;
  readonly scale?: number;
}

export type BindingMap = Record<ActionId, Binding[]>;

/** Bump when the serialized shape changes; `parseBindings` stays lenient. */
export const BINDINGS_SCHEMA_VERSION = 1;

export interface SerializedBindings {
  readonly version: number;
  readonly bindings: Readonly<Record<string, readonly Binding[]>>;
}

const key = (code: string, scale?: number): Binding =>
  scale === undefined ? { device: 'keyboard', code } : { device: 'keyboard', code, scale };
const mouse = (code: string, scale?: number): Binding =>
  scale === undefined ? { device: 'mouse', code } : { device: 'mouse', code, scale };
const pad = (code: string, scale?: number): Binding =>
  scale === undefined ? { device: 'gamepad', code } : { device: 'gamepad', code, scale };

/**
 * Mouse look contributes `pixels * MOUSE_LOOK_SCALE` to the look axes before
 * clamping; use `InputManager.mouseDelta()` for unclamped pixel deltas.
 */
export const MOUSE_LOOK_SCALE = 0.01;

export const DEFAULT_BINDINGS: Readonly<BindingMap> = {
  'move.forward': [key('KeyW'), key('ArrowUp'), pad('GamepadAxis1', -1)],
  'move.back': [key('KeyS'), key('ArrowDown'), pad('GamepadAxis1')],
  'move.left': [key('KeyA'), key('ArrowLeft'), pad('GamepadAxis0', -1)],
  'move.right': [key('KeyD'), key('ArrowRight'), pad('GamepadAxis0')],
  'move.sprint': [key('ShiftLeft'), key('ShiftRight'), pad('GamepadButton10')],
  'look.x': [mouse('MouseX', MOUSE_LOOK_SCALE), pad('GamepadAxis2')],
  'look.y': [mouse('MouseY', MOUSE_LOOK_SCALE), pad('GamepadAxis3')],
  interact: [key('KeyE'), pad('GamepadButton0')],
  'menu.toggle': [key('Escape'), pad('GamepadButton9')],
  'console.toggle': [key('Backquote')],
  'perf.toggle': [key('F3')],
  'vehicle.accelerate': [key('KeyW'), key('ArrowUp'), pad('GamepadButton7')],
  'vehicle.brake': [key('KeyS'), key('ArrowDown'), pad('GamepadButton6')],
  'vehicle.steer': [key('KeyA', -1), key('KeyD'), key('ArrowLeft', -1), key('ArrowRight'), pad('GamepadAxis0')],
  'vehicle.siren': [key('KeyQ'), pad('GamepadButton3')],
  'vehicle.lights': [key('KeyL'), pad('GamepadButton2')],
  'camera.toggle': [key('KeyV'), pad('GamepadButton8')],
  'vehicle.handbrake': [key('Space'), pad('GamepadButton1')],
  'vehicle.headlights': [key('KeyH'), pad('GamepadButton12')],
  'map.toggle': [key('KeyM'), pad('GamepadButton13')],
  'vehicle.sirenTone': [key('KeyR'), pad('GamepadButton4')],
  'vehicle.horn': [key('KeyG'), pad('GamepadButton11')],
  'vehicle.manual': [key('KeyF')],
  'vehicle.lightPattern': [key('KeyK')],
  'vehicle.spotlight': [key('KeyJ')],
  'vehicle.spotAim': [mouse('MouseButton2')],
  'vehicle.equipment': [key('KeyX')],
  'mdt.toggle': [key('Tab')],
  'target.runPlate': [key('KeyP'), pad('GamepadButton15')],
  'radio.menu': [key('KeyT'), pad('GamepadButton14')],
  'radio.option1': [key('Digit1')],
  'radio.option2': [key('Digit2')],
  'radio.option3': [key('Digit3')],
  'radio.option4': [key('Digit4')],
  'radio.option5': [key('Digit5')],
  'radio.option6': [key('Digit6')],
  'radio.option7': [key('Digit7')],
  'radio.option8': [key('Digit8')],
  'radio.option9': [key('Digit9')],
  'radio.ptt': [key('KeyB'), pad('GamepadButton5')],
  'radio.emergency': [key('KeyZ')],
  'radio.channelPrev': [key('BracketLeft')],
  'radio.channelNext': [key('BracketRight')],
  'radio.scan': [key('Backslash')],
};

const MOUSE_CODE = /^Mouse(Button\d+|X|Y|Wheel)$/;
const GAMEPAD_CODE = /^Gamepad(Button|Axis)\d+$/;

function isDevice(value: unknown): value is InputDevice {
  return value === 'keyboard' || value === 'mouse' || value === 'gamepad';
}

/**
 * Fits a captured binding to a slot of `action` whose sign is `sign` (-1 for
 * slots such as "Steer left"). A captured gamepad axis records the way the
 * stick was pushed: button and one-way axis actions keep that direction,
 * while two-way axes (look, steer) take the slot's sign instead, so pushing a
 * stick up into "Look vertical" does not invert it. Button actions are never
 * negative.
 */
export function withBindingSign(captured: Binding, sign: number, action: ActionId): Binding {
  if (captured.device === 'gamepad' && captured.code.startsWith('GamepadAxis')) {
    if (!isBipolar(action)) return { ...captured };
    const axis: Binding = { device: captured.device, code: captured.code };
    return sign < 0 ? { ...axis, scale: -1 } : axis;
  }
  if (sign >= 0 || actionKind(action) === 'button') return { ...captured };
  return { ...captured, scale: -Math.abs(captured.scale ?? 1) };
}

/** Sign of a binding's scale: -1 for negative slots, otherwise 1. */
export function bindingSign(binding: Binding | undefined): -1 | 1 {
  return binding !== undefined && (binding.scale ?? 1) < 0 ? -1 : 1;
}

/** True when `value` is a structurally valid binding for its device. */
export function isBinding(value: unknown): value is Binding {
  if (typeof value !== 'object' || value === null) return false;
  const { device, code, scale } = value as Record<string, unknown>;
  if (!isDevice(device) || typeof code !== 'string' || code.length === 0) return false;
  if (scale !== undefined && (typeof scale !== 'number' || !Number.isFinite(scale))) return false;
  if (device === 'mouse') return MOUSE_CODE.test(code);
  if (device === 'gamepad') return GAMEPAD_CODE.test(code);
  return true;
}

export function bindingsEqual(a: Binding, b: Binding): boolean {
  return a.device === b.device && a.code === b.code && (a.scale ?? 1) === (b.scale ?? 1);
}

/** Deep-copies a binding map so callers can mutate it freely. */
export function cloneBindings(map: Readonly<BindingMap>): BindingMap {
  const out = {} as BindingMap;
  for (const id of ACTION_IDS) out[id] = map[id].map((b) => ({ ...b }));
  return out;
}

export function serializeBindings(map: Readonly<BindingMap>): SerializedBindings {
  return { version: BINDINGS_SCHEMA_VERSION, bindings: cloneBindings(map) };
}

/**
 * Builds a complete binding map from untrusted data (a serialized envelope or
 * a bare `{ action: Binding[] }` record). Actions that are missing or malformed
 * fall back to their defaults, malformed entries inside a valid list are
 * dropped, and unknown actions are ignored.
 */
export function parseBindings(input: unknown): BindingMap {
  const result = cloneBindings(DEFAULT_BINDINGS);
  const source = unwrap(input);
  if (!source) return result;
  for (const [id, value] of Object.entries(source)) {
    if (!isActionId(id) || !Array.isArray(value)) continue;
    result[id] = value.filter(isBinding).map((b) => ({ ...b }));
  }
  return result;
}

function unwrap(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  if ('version' in record && typeof record['bindings'] === 'object' && record['bindings'] !== null) {
    return record['bindings'] as Record<string, unknown>;
  }
  return record;
}
