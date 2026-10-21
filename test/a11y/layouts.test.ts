import { describe, expect, it } from 'vitest';
import { PHASE8_ACTIONS } from '../../src/a11y/audit';
import {
  LAYOUT_NAMES,
  LEFT_KEYS,
  ONE_HANDED_LAYOUTS,
  RIGHT_KEYS,
  RIGHT_MOUSE_CODES,
  UNBOUND_BY_DESIGN,
  isOneHandedLayout,
  layoutBindings,
  parseLayouts,
} from '../../src/a11y/layouts';
import layoutsJson from '../../src/data/a11y/layouts.json';
import { ACTION_IDS, type ActionId } from '../../src/input/actions';
import { bindingCollisions, unreachableActions } from '../../src/input/context';
import { DEFAULT_BINDINGS, isBinding, parseBindings, serializeBindings, type Binding } from '../../src/input/bindings';

const left = layoutBindings('left');
const right = layoutBindings('right');
const key = (b: Binding): boolean => b.device === 'keyboard';

describe('ONE_HANDED_LAYOUTS', () => {
  it('lists off, left and right', () => {
    expect(ONE_HANDED_LAYOUTS).toEqual(['off', 'left', 'right']);
    expect(Object.keys(LAYOUT_NAMES)).toEqual([...ONE_HANDED_LAYOUTS]);
    expect(isOneHandedLayout('left')).toBe(true);
    expect(isOneHandedLayout('both')).toBe(false);
    expect(isOneHandedLayout(true)).toBe(false);
  });
});

describe('default bindings cover every action', () => {
  it('has at least one default binding per action, including the Phase 8 ones', () => {
    for (const id of ACTION_IDS) expect(DEFAULT_BINDINGS[id].length, id).toBeGreaterThanOrEqual(1);
    expect(PHASE8_ACTIONS).toEqual(['career.menu', 'coop.menu', 'dispatch.console']);
    for (const id of PHASE8_ACTIONS) expect(ACTION_IDS).toContain(id);
  });
});

describe.each([
  ['left', left],
  ['right', right],
] as const)('%s layout', (name, map) => {
  it('binds every action to at least one binding, except those the hand has no key for', () => {
    expect(Object.keys(map).sort()).toEqual([...ACTION_IDS].sort());
    for (const id of ACTION_IDS) {
      if (UNBOUND_BY_DESIGN[name].includes(id)) continue;
      expect(map[id].length, `${name}: ${id}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('only holds structurally valid bindings', () => {
    for (const id of ACTION_IDS) for (const b of map[id]) expect(isBinding(b), `${name}: ${id} ${b.code}`).toBe(true);
  });

  it('keeps two actions of the same situation off one key (no press fires several actions)', () => {
    const doubles = bindingCollisions(map, ACTION_IDS).filter((c) => !c.shadowed);
    expect(doubles, doubles.map((c) => `${c.key}: ${c.actions.join(' + ')}`).join('; ')).toEqual([]);
  });

  it('leaves no bound action hidden behind a more important one on every key it has', () => {
    expect(unreachableActions(map, ACTION_IDS)).toEqual([]);
  });

  it('keeps the gamepad bindings of the defaults', () => {
    for (const id of ACTION_IDS) {
      const pads = (list: readonly Binding[]): Binding[] => list.filter((b) => b.device === 'gamepad');
      expect(pads(map[id]), `${name}: ${id}`).toEqual(pads(DEFAULT_BINDINGS[id]));
    }
  });

  it('has a keyboard or mouse binding for every action, except those the hand has no key for', () => {
    for (const id of ACTION_IDS) {
      expect(map[id].some((b) => b.device !== 'gamepad'), `${name}: ${id}`).toBe(!UNBOUND_BY_DESIGN[name].includes(id));
    }
  });

  it('survives a serialize / parse round trip', () => {
    expect(parseBindings(JSON.parse(JSON.stringify(serializeBindings(map))))).toEqual(map);
  });

  it('never binds an input twice within one action', () => {
    for (const id of ACTION_IDS) {
      const seen = new Set<string>();
      for (const b of map[id]) {
        const k = `${b.device}:${b.code}:${String(b.scale ?? 1)}`;
        expect(seen.has(k), `${name}: ${id} ${k}`).toBe(false);
        seen.add(k);
      }
    }
  });
});

describe('left-hand layout', () => {
  it('uses only the allowed left-hand keys and no mouse', () => {
    for (const id of ACTION_IDS) {
      for (const b of left[id]) {
        expect(b.device === 'mouse', `${id}: ${b.code}`).toBe(false);
        if (key(b)) expect(LEFT_KEYS.has(b.code), `${id}: ${b.code}`).toBe(true);
      }
    }
  });

  it('puts look on Q / E and R / F, steering on A / D and radio options on digits 1-6 and F4-F6', () => {
    expect(left['look.x']).toContainEqual({ device: 'keyboard', code: 'KeyQ', scale: -1 });
    expect(left['look.x']).toContainEqual({ device: 'keyboard', code: 'KeyE' });
    expect(left['look.y']).toContainEqual({ device: 'keyboard', code: 'KeyR', scale: -1 });
    expect(left['look.y']).toContainEqual({ device: 'keyboard', code: 'KeyF' });
    expect(left['vehicle.steer']).toContainEqual({ device: 'keyboard', code: 'KeyA', scale: -1 });
    expect(left['vehicle.steer']).toContainEqual({ device: 'keyboard', code: 'KeyD' });
    const options = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'F4', 'F5', 'F6'];
    options.forEach((code, i) => {
      expect(left[`radio.option${String(i + 1)}` as ActionId]).toContainEqual({ device: 'keyboard', code });
    });
  });

  it('keeps movement, menu and radio basics on their own keys within their context', () => {
    const owners = (code: string): ActionId[] => ACTION_IDS.filter((id) => left[id].some((b) => key(b) && b.code === code));
    expect(owners('KeyW')).toEqual(['move.forward', 'vehicle.accelerate']);
    expect(owners('Escape')).toEqual(['menu.toggle']);
    expect(owners('KeyG')).toEqual(['interact']);
    expect(owners('KeyT')).toEqual(['radio.menu']);
    expect(owners('KeyB')).toEqual(['radio.ptt']);
    expect(owners('KeyZ')).toEqual(['radio.emergency']);
    expect(owners('Tab')).toEqual(['mdt.toggle']);
  });

  it('puts the Phase 8 screens on keys of the left hand', () => {
    for (const id of PHASE8_ACTIONS) expect(left[id].some((b) => key(b) && LEFT_KEYS.has(b.code)), id).toBe(true);
  });
});

describe('right-hand layout', () => {
  it('uses only right-hand keys and mouse codes', () => {
    for (const id of ACTION_IDS) {
      for (const b of right[id]) {
        if (key(b)) expect(RIGHT_KEYS.has(b.code), `${id}: ${b.code}`).toBe(true);
        if (b.device === 'mouse') expect(RIGHT_MOUSE_CODES.has(b.code), `${id}: ${b.code}`).toBe(true);
      }
    }
  });

  it('uses no left-hand-only keyboard key', () => {
    const leftOnly = [...LEFT_KEYS].filter((code) => !RIGHT_KEYS.has(code));
    for (const id of ACTION_IDS) for (const b of right[id]) expect(leftOnly.includes(b.code) && key(b), `${id}: ${b.code}`).toBe(false);
  });

  it('keeps mouse look and the arrows for movement', () => {
    expect(right['look.x'].some((b) => b.device === 'mouse' && b.code === 'MouseX')).toBe(true);
    expect(right['look.y'].some((b) => b.device === 'mouse' && b.code === 'MouseY')).toBe(true);
    expect(right['move.forward']).toContainEqual({ device: 'keyboard', code: 'ArrowUp' });
    expect(right['officer.fire']).toContainEqual({ device: 'mouse', code: 'MouseButton0' });
    expect(right['radio.option9']).toContainEqual({ device: 'keyboard', code: 'Numpad9' });
  });
});

describe('key sets', () => {
  it('have no overlap that would make a hand ambiguous', () => {
    expect([...LEFT_KEYS].filter((code) => RIGHT_KEYS.has(code))).toEqual([]);
  });

  it('match the design lists', () => {
    for (const code of ['Backquote', 'Digit1', 'Digit6', 'KeyQ', 'KeyB', 'Tab', 'CapsLock', 'ShiftLeft', 'ControlLeft', 'AltLeft', 'Space', 'Escape', 'F1', 'F6']) {
      expect(LEFT_KEYS.has(code), code).toBe(true);
    }
    for (const code of ['Digit7', 'F7', 'KeyH', 'Enter', 'ArrowUp']) expect(LEFT_KEYS.has(code), code).toBe(false);
    for (const code of ['ArrowUp', 'Numpad0', 'Numpad9', 'NumpadEnter', 'Enter', 'Backspace', 'Home', 'PageDown', 'ShiftRight', 'ControlRight', 'Slash', 'Equal', 'F7', 'F12']) {
      expect(RIGHT_KEYS.has(code), code).toBe(true);
    }
    for (const code of ['Escape', 'KeyW', 'F6', 'Digit1', 'Tab']) expect(RIGHT_KEYS.has(code), code).toBe(false);
  });
});

describe('layoutBindings', () => {
  it("returns a copy of the default bindings for 'off'", () => {
    const off = layoutBindings('off');
    expect(off).toEqual(DEFAULT_BINDINGS);
    off['interact'].push({ device: 'keyboard', code: 'KeyX' });
    expect(DEFAULT_BINDINGS['interact']).toEqual([{ device: 'keyboard', code: 'KeyE' }, { device: 'gamepad', code: 'GamepadButton0' }]);
    expect(layoutBindings('off')).toEqual(DEFAULT_BINDINGS);
  });

  it('returns a fresh map every call so callers may mutate it', () => {
    const a = layoutBindings('left');
    a['interact'].length = 0;
    expect(layoutBindings('left')['interact'].length).toBeGreaterThan(0);
    expect(layoutBindings('left')).not.toBe(layoutBindings('left'));
  });
});

describe('parseLayouts', () => {
  const clone = (): { version: number; left: Record<string, unknown>; right: Record<string, unknown> } =>
    JSON.parse(JSON.stringify(layoutsJson)) as { version: number; left: Record<string, unknown>; right: Record<string, unknown> };

  it('accepts the shipped file', () => {
    expect(() => parseLayouts(layoutsJson)).not.toThrow();
  });

  it('rejects an action without bindings, naming the file and path', () => {
    const bad = clone();
    delete bad.left['interact'];
    expect(() => parseLayouts(bad)).toThrow(/layouts\.json: left\.interact must be an array/);
    const empty = clone();
    empty.right['interact'] = [];
    expect(() => parseLayouts(empty)).toThrow(/right\.interact must have at least 1 items/);
  });

  it('rejects malformed bindings and a wrong version', () => {
    const bad = clone();
    bad.right['interact'] = [{ device: 'mouse', code: 'KeyE' }];
    expect(() => parseLayouts(bad)).toThrow(/right\.interact\[0\] must be a valid binding/);
    const old = clone();
    old.version = 2;
    expect(() => parseLayouts(old)).toThrow(/version must be 1/);
  });
});

describe('Phase 9 radio menu cursor in the one-handed layouts', () => {
  const CURSOR = ['radio.cursorPrev', 'radio.cursorNext', 'radio.cursorSelect'] as const;

  it('the right hand binds PageUp / PageDown / Enter', () => {
    expect(right['radio.cursorPrev']).toContainEqual({ device: 'keyboard', code: 'PageUp' });
    expect(right['radio.cursorNext']).toContainEqual({ device: 'keyboard', code: 'PageDown' });
    expect(right['radio.cursorSelect']).toContainEqual({ device: 'keyboard', code: 'Enter' });
  });

  it('the left hand lists the three in UNBOUND_BY_DESIGN (its digit keys choose the options)', () => {
    for (const id of CURSOR) {
      expect(UNBOUND_BY_DESIGN.left, id).toContain(id);
      expect(left[id].some((b) => b.device !== 'gamepad'), id).toBe(false);
    }
    for (const id of CURSOR) expect(UNBOUND_BY_DESIGN.right).not.toContain(id);
  });

  it('both hands keep the gamepad D-pad and A for the cursor', () => {
    for (const map of [left, right]) {
      expect(map['radio.cursorPrev']).toContainEqual({ device: 'gamepad', code: 'GamepadButton12' });
      expect(map['radio.cursorNext']).toContainEqual({ device: 'gamepad', code: 'GamepadButton13' });
      expect(map['radio.cursorSelect']).toContainEqual({ device: 'gamepad', code: 'GamepadButton0' });
    }
  });

  it('the right-hand keys are right-hand keys, shared only with actions that never act while the radio menu is open', () => {
    for (const id of CURSOR) {
      for (const b of right[id]) if (b.device === 'keyboard') expect(RIGHT_KEYS.has(b.code), `${id} ${b.code}`).toBe(true);
    }
    const sharing = (code: string): ActionId[] => ACTION_IDS.filter((id) => right[id].some((b) => b.device === 'keyboard' && b.code === code));
    // Enter is also "interact" and PageUp / PageDown are other actions' keys: modal actions take them while the menu is open
    expect(sharing('Enter')).toContain('interact');
    expect(sharing('Enter')).toContain('radio.cursorSelect');
    expect(bindingCollisions(right, ACTION_IDS).filter((c) => c.actions.some((a) => (CURSOR as readonly string[]).includes(a)))).toEqual([]);
  });

  it('the layout files validate with the new actions (every action has a table entry in both hands)', () => {
    const json = layoutsJson as unknown as Record<'left' | 'right', Record<string, unknown>>;
    for (const hand of ['left', 'right'] as const) for (const id of CURSOR) expect(Array.isArray(json[hand][id]), `${hand}.${id}`).toBe(true);
    expect(() => parseLayouts(layoutsJson)).not.toThrow();
    const missing = structuredClone(layoutsJson) as unknown as { right: Record<string, unknown> };
    delete missing.right['radio.cursorSelect'];
    expect(() => parseLayouts(missing)).toThrow(/radio\.cursorSelect/);
  });
});
