import { describe, expect, it } from 'vitest';
import { ACTION_IDS } from '../../src/input/actions';
import {
  BINDINGS_SCHEMA_VERSION,
  DEFAULT_BINDINGS,
  bindingSign,
  bindingsEqual,
  cloneBindings,
  isBinding,
  parseBindings,
  serializeBindings,
  withBindingSign,
  type Binding,
} from '../../src/input/bindings';
import { resolveActions } from '../../src/input/input';

describe('DEFAULT_BINDINGS', () => {
  it('binds every action to at least one valid binding', () => {
    for (const id of ACTION_IDS) {
      const list = DEFAULT_BINDINGS[id];
      expect(list.length, id).toBeGreaterThan(0);
      for (const b of list) expect(isBinding(b), `${id}: ${b.code}`).toBe(true);
    }
  });

  it('uses WASD and arrows for movement, Shift for sprint, Esc/Backquote/F3 for UI', () => {
    const codes = (id: keyof typeof DEFAULT_BINDINGS): string[] => DEFAULT_BINDINGS[id].map((b) => b.code);
    expect(codes('move.forward')).toEqual(expect.arrayContaining(['KeyW', 'ArrowUp']));
    expect(codes('move.left')).toEqual(expect.arrayContaining(['KeyA', 'ArrowLeft']));
    expect(codes('move.sprint')).toContain('ShiftLeft');
    expect(codes('interact')).toContain('KeyE');
    expect(codes('menu.toggle')).toContain('Escape');
    expect(codes('console.toggle')).toContain('Backquote');
    expect(codes('perf.toggle')).toContain('F3');
    expect(codes('vehicle.steer')).toContain('GamepadAxis0');
    expect(codes('vehicle.accelerate')).toContain('GamepadButton7');
  });
});

describe('isBinding', () => {
  it('accepts well-formed bindings for each device', () => {
    expect(isBinding({ device: 'keyboard', code: 'KeyW' })).toBe(true);
    expect(isBinding({ device: 'keyboard', code: 'KeyA', scale: -1 })).toBe(true);
    expect(isBinding({ device: 'mouse', code: 'MouseButton0' })).toBe(true);
    expect(isBinding({ device: 'mouse', code: 'MouseX', scale: 0.01 })).toBe(true);
    expect(isBinding({ device: 'gamepad', code: 'GamepadAxis2' })).toBe(true);
    expect(isBinding({ device: 'gamepad', code: 'GamepadButton12' })).toBe(true);
  });

  it('rejects malformed bindings', () => {
    expect(isBinding(null)).toBe(false);
    expect(isBinding('KeyW')).toBe(false);
    expect(isBinding({ device: 'touch', code: 'Tap' })).toBe(false);
    expect(isBinding({ device: 'keyboard', code: '' })).toBe(false);
    expect(isBinding({ device: 'keyboard', code: 'KeyW', scale: 'fast' })).toBe(false);
    expect(isBinding({ device: 'keyboard', code: 'KeyW', scale: Number.NaN })).toBe(false);
    expect(isBinding({ device: 'mouse', code: 'KeyW' })).toBe(false);
    expect(isBinding({ device: 'gamepad', code: 'MouseX' })).toBe(false);
  });
});

describe('serializeBindings / parseBindings', () => {
  it('round-trips a map through the versioned envelope', () => {
    const custom = cloneBindings(DEFAULT_BINDINGS);
    custom.interact = [{ device: 'keyboard', code: 'KeyF' }];
    const serialized = serializeBindings(custom);
    expect(serialized.version).toBe(BINDINGS_SCHEMA_VERSION);
    const parsed = parseBindings(JSON.parse(JSON.stringify(serialized)));
    expect(parsed).toEqual(custom);
  });

  it('serializing copies the map instead of aliasing it', () => {
    const custom = cloneBindings(DEFAULT_BINDINGS);
    const serialized = serializeBindings(custom);
    custom.interact.push({ device: 'keyboard', code: 'KeyF' });
    expect(serialized.bindings['interact']).toEqual(DEFAULT_BINDINGS.interact);
  });

  it('returns defaults for garbage input', () => {
    for (const junk of [undefined, null, 42, 'bindings', [], { version: 'x' }]) {
      expect(parseBindings(junk)).toEqual(DEFAULT_BINDINGS);
    }
  });

  it('accepts a bare record without the envelope', () => {
    const parsed = parseBindings({ interact: [{ device: 'keyboard', code: 'KeyF' }] });
    expect(parsed.interact).toEqual([{ device: 'keyboard', code: 'KeyF' }]);
    expect(parsed['move.forward']).toEqual(DEFAULT_BINDINGS['move.forward']);
  });

  it('falls back per action, drops bad entries and ignores unknown actions', () => {
    const parsed = parseBindings({
      version: BINDINGS_SCHEMA_VERSION,
      bindings: {
        'move.forward': 'KeyW',
        'move.back': [{ device: 'keyboard', code: 'KeyX' }, { device: 'laser', code: 'Pew' }, 7],
        'move.left': [],
        'fly.up': [{ device: 'keyboard', code: 'Space' }],
      },
    });
    expect(parsed['move.forward']).toEqual(DEFAULT_BINDINGS['move.forward']);
    expect(parsed['move.back']).toEqual([{ device: 'keyboard', code: 'KeyX' }]);
    expect(parsed['move.left']).toEqual([]);
    expect(Object.keys(parsed).sort()).toEqual([...ACTION_IDS].sort());
    expect('fly.up' in parsed).toBe(false);
  });

  it('never returns references into the input or the defaults', () => {
    const input: Binding[] = [{ device: 'keyboard', code: 'KeyF' }];
    const parsed = parseBindings({ interact: input });
    expect(parsed.interact[0]).not.toBe(input[0]);
    expect(parsed['move.forward']).not.toBe(DEFAULT_BINDINGS['move.forward']);
  });
});

describe('bindingsEqual', () => {
  it('treats a missing scale as 1', () => {
    expect(bindingsEqual({ device: 'keyboard', code: 'KeyW' }, { device: 'keyboard', code: 'KeyW', scale: 1 })).toBe(true);
    expect(bindingsEqual({ device: 'keyboard', code: 'KeyW' }, { device: 'keyboard', code: 'KeyW', scale: -1 })).toBe(false);
    expect(bindingsEqual({ device: 'keyboard', code: 'KeyW' }, { device: 'mouse', code: 'MouseX' })).toBe(false);
  });
});

describe('withBindingSign / bindingSign', () => {
  it('keeps a negative slot negative when a key replaces it (Steer left stays left)', () => {
    const old = DEFAULT_BINDINGS['vehicle.steer'][0];
    expect(old).toEqual({ device: 'keyboard', code: 'KeyA', scale: -1 });
    const sign = bindingSign(old);
    expect(sign).toBe(-1);
    expect(withBindingSign({ device: 'keyboard', code: 'KeyJ' }, sign, 'vehicle.steer')).toEqual({
      device: 'keyboard',
      code: 'KeyJ',
      scale: -1,
    });
    expect(withBindingSign({ device: 'gamepad', code: 'GamepadButton4' }, sign, 'vehicle.steer')).toEqual({
      device: 'gamepad',
      code: 'GamepadButton4',
      scale: -1,
    });
  });

  it('leaves positive slots as captured', () => {
    expect(bindingSign(undefined)).toBe(1);
    expect(bindingSign({ device: 'keyboard', code: 'KeyD' })).toBe(1);
    expect(withBindingSign({ device: 'keyboard', code: 'KeyK' }, 1, 'vehicle.steer')).toEqual({ device: 'keyboard', code: 'KeyK' });
  });

  it('gives a stick captured for a two-way axis the slot sign, not the push direction', () => {
    const up = { device: 'gamepad', code: 'GamepadAxis3', scale: -1 } as const;
    // Pushing the stick up into the default (positive) Look vertical slot must not invert look.
    expect(withBindingSign(up, bindingSign(DEFAULT_BINDINGS['look.y'][1]), 'look.y')).toEqual({ device: 'gamepad', code: 'GamepadAxis3' });
    // Pushing left into a negative slot inverts it, whichever way the stick went.
    const left = { device: 'gamepad', code: 'GamepadAxis2', scale: -1 } as const;
    expect(withBindingSign(left, -1, 'look.x')).toEqual({ device: 'gamepad', code: 'GamepadAxis2', scale: -1 });
    expect(withBindingSign({ ...left, scale: 1 }, -1, 'vehicle.steer')).toEqual({ device: 'gamepad', code: 'GamepadAxis2', scale: -1 });
  });

  it('keeps the push direction of a stick captured for a button or one-way axis', () => {
    const down = { device: 'gamepad', code: 'GamepadAxis1', scale: -1 } as const;
    expect(withBindingSign(down, 1, 'move.forward')).toEqual(down);
    expect(withBindingSign(down, -1, 'vehicle.accelerate')).toEqual(down);
  });

  it('never makes a button action negative when a key replaces a negative pad-axis slot', () => {
    const slot = DEFAULT_BINDINGS['move.forward'][2];
    expect(bindingSign(slot)).toBe(-1);
    const map = cloneBindings(DEFAULT_BINDINGS);
    map['move.forward'][2] = withBindingSign({ device: 'keyboard', code: 'KeyI' }, bindingSign(slot), 'move.forward');
    expect(map['move.forward'][2]).toEqual({ device: 'keyboard', code: 'KeyI' });
    const raw = { keys: new Set(['KeyW', 'KeyI']), mouseButtons: new Set<number>(), mouse: { x: 0, y: 0, wheel: 0 }, gamepadButtons: [], gamepadAxes: [] };
    expect(resolveActions(map, raw)['move.forward']).toBe(1);
  });
});

