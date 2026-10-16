import { describe, expect, it } from 'vitest';
import { ACTION_IDS } from '../../src/input/actions';
import {
  BINDINGS_SCHEMA_VERSION,
  DEFAULT_BINDINGS,
  bindingsEqual,
  cloneBindings,
  isBinding,
  parseBindings,
  serializeBindings,
  type Binding,
} from '../../src/input/bindings';

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
