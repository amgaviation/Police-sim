import layoutsJson from '../data/a11y/layouts.json';
import { ACTION_IDS } from '../input/actions';
import { DEFAULT_BINDINGS, cloneBindings, isBinding, parseBindings, type Binding, type BindingMap } from '../input/bindings';
import { fail, readArray, readObject, readVersion } from '../vehicles/json';

/**
 * One-handed binding presets (design §9.2). Presentation of input only: picking a layout replaces the stored key
 * bindings (the settings menu does that), nothing here feeds the simulation. A one-handed keyboard has fewer keys
 * than the game has actions, so rarely used panel openers share a key with actions of another context (on foot vs
 * in a car, mode-exclusive screens, debug toggles); every key can still be rebound in the settings menu.
 */

export const ONE_HANDED_LAYOUTS = ['off', 'left', 'right'] as const;
export type OneHandedLayout = (typeof ONE_HANDED_LAYOUTS)[number];

/** Short names used in settings hints: "Key bindings replaced by the <name> layout". */
export const LAYOUT_NAMES: Readonly<Record<OneHandedLayout, string>> = {
  off: 'default',
  left: 'left-hand',
  right: 'right-hand',
};

const range = (prefix: string, from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${String(from + i)}`);

/** Keyboard codes the left-hand layout may use (no mouse). */
export const LEFT_KEYS: ReadonlySet<string> = new Set([
  'Backquote',
  ...range('Digit', 1, 6),
  'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT',
  'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG',
  'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB',
  'Tab', 'CapsLock', 'ShiftLeft', 'ControlLeft', 'AltLeft', 'Space', 'Escape',
  ...range('F', 1, 6),
]);

/** Keyboard codes the right-hand layout may use, besides the mouse (`MouseX`, `MouseY`, `MouseButton0-2`, `MouseWheel`). */
export const RIGHT_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  ...range('Numpad', 0, 9),
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEnter',
  'Enter', 'Backspace', 'Delete', 'End', 'Home', 'PageUp', 'PageDown', 'Insert',
  'ShiftRight', 'ControlRight',
  'Slash', 'Period', 'Comma', 'Semicolon', 'Quote', 'BracketLeft', 'BracketRight', 'Backslash', 'Minus', 'Equal',
  ...range('F', 7, 12),
]);

/** Mouse codes the right-hand layout may use. */
export const RIGHT_MOUSE_CODES: ReadonlySet<string> = new Set(['MouseX', 'MouseY', 'MouseButton0', 'MouseButton1', 'MouseButton2', 'MouseWheel']);

type HandLayout = 'left' | 'right';

/**
 * Validates `layouts.json`: every `ACTION_IDS` entry needs at least one structurally valid binding in both hands.
 * Gamepad bindings are added from `DEFAULT_BINDINGS`. Throws an Error naming the file and the dotted path.
 */
export function parseLayouts(json: unknown, file = 'layouts.json'): Readonly<Record<HandLayout, Readonly<BindingMap>>> {
  const root = readObject(json, file, '');
  readVersion(root, file);
  const out = {} as Record<HandLayout, BindingMap>;
  for (const hand of ['left', 'right'] as const) {
    const table = readObject(root[hand], file, hand);
    const map = {} as BindingMap;
    for (const id of ACTION_IDS) {
      const path = `${hand}.${id}`;
      const list = readArray(table[id], file, path, 1);
      const bindings: Binding[] = [];
      list.forEach((value, index) => {
        if (!isBinding(value)) fail(file, `${path}[${String(index)}]`, `must be a valid binding, got ${JSON.stringify(value)}`);
        bindings.push({ ...value });
      });
      for (const pad of DEFAULT_BINDINGS[id]) if (pad.device === 'gamepad') bindings.push({ ...pad });
      map[id] = bindings;
    }
    out[hand] = parseBindings(map);
  }
  return out;
}

const LAYOUTS = parseLayouts(layoutsJson);

/**
 * A fresh binding map for `layout`: `'off'` is a copy of the defaults, `'left'` and `'right'` the one-handed
 * presets (keyboard and mouse from `layouts.json`, gamepad bindings kept from the defaults).
 */
export function layoutBindings(layout: OneHandedLayout): BindingMap {
  return layout === 'off' ? cloneBindings(DEFAULT_BINDINGS) : cloneBindings(LAYOUTS[layout]);
}

/** True for a known layout id. */
export function isOneHandedLayout(value: unknown): value is OneHandedLayout {
  return typeof value === 'string' && (ONE_HANDED_LAYOUTS as readonly string[]).includes(value);
}
