import { describe, expect, it } from 'vitest';
import { ACTION_IDS } from '../../src/input/actions';
import { DEFAULT_BINDINGS, cloneBindings, type BindingMap } from '../../src/input/bindings';
import {
  GAMEPAD_DEADZONE,
  applyDeadzone,
  readBinding,
  resolveActions,
  type RawInputState,
} from '../../src/input/input';

function raw(partial: Partial<RawInputState> = {}): RawInputState {
  return {
    keys: new Set<string>(),
    mouseButtons: new Set<number>(),
    mouse: { x: 0, y: 0, wheel: 0 },
    gamepadButtons: [],
    gamepadAxes: [],
    ...partial,
  };
}

describe('applyDeadzone', () => {
  it('zeroes values inside the deadzone and rescales the rest', () => {
    expect(applyDeadzone(0)).toBe(0);
    expect(applyDeadzone(0.1)).toBe(0);
    expect(applyDeadzone(-0.14)).toBe(0);
    expect(applyDeadzone(GAMEPAD_DEADZONE)).toBe(0);
    expect(applyDeadzone(1)).toBe(1);
    expect(applyDeadzone(-1)).toBe(-1);
    expect(applyDeadzone(0.575)).toBeCloseTo(0.5);
    expect(applyDeadzone(-0.575)).toBeCloseTo(-0.5);
  });

  it('honours a custom deadzone and clamps overshoot', () => {
    expect(applyDeadzone(0.25, 0.5)).toBe(0);
    expect(applyDeadzone(0.75, 0.5)).toBeCloseTo(0.5);
    expect(applyDeadzone(1.5, 0.1)).toBe(1);
  });
});

describe('readBinding', () => {
  it('reads keyboard keys as 0/1 times scale', () => {
    const state = raw({ keys: new Set(['KeyA']) });
    expect(readBinding({ device: 'keyboard', code: 'KeyA' }, state)).toBe(1);
    expect(readBinding({ device: 'keyboard', code: 'KeyA', scale: -1 }, state)).toBe(-1);
    expect(readBinding({ device: 'keyboard', code: 'KeyD' }, state)).toBe(0);
  });

  it('reads mouse buttons, axes and wheel', () => {
    const state = raw({ mouseButtons: new Set([0, 2]), mouse: { x: 40, y: -10, wheel: 1 } });
    expect(readBinding({ device: 'mouse', code: 'MouseButton0' }, state)).toBe(1);
    expect(readBinding({ device: 'mouse', code: 'MouseButton1' }, state)).toBe(0);
    expect(readBinding({ device: 'mouse', code: 'MouseButton2' }, state)).toBe(1);
    expect(readBinding({ device: 'mouse', code: 'MouseX', scale: 0.01 }, state)).toBeCloseTo(0.4);
    expect(readBinding({ device: 'mouse', code: 'MouseY' }, state)).toBe(-10);
    expect(readBinding({ device: 'mouse', code: 'MouseWheel', scale: -1 }, state)).toBe(-1);
  });

  it('reads gamepad buttons raw and axes through the deadzone', () => {
    const state = raw({ gamepadButtons: [0, 0.3], gamepadAxes: [0.1, -1] });
    expect(readBinding({ device: 'gamepad', code: 'GamepadButton1' }, state)).toBeCloseTo(0.3);
    expect(readBinding({ device: 'gamepad', code: 'GamepadButton7' }, state)).toBe(0);
    expect(readBinding({ device: 'gamepad', code: 'GamepadAxis0' }, state)).toBe(0);
    expect(readBinding({ device: 'gamepad', code: 'GamepadAxis1' }, state)).toBe(-1);
    expect(readBinding({ device: 'gamepad', code: 'GamepadAxis1', scale: -1 }, state)).toBe(1);
    expect(readBinding({ device: 'gamepad', code: 'GamepadAxis9' }, state)).toBe(0);
  });

  it('returns 0 for unparseable codes', () => {
    const state = raw({ keys: new Set(['KeyA']), mouseButtons: new Set([0]), gamepadButtons: [1] });
    expect(readBinding({ device: 'mouse', code: 'MouseButtonX' }, state)).toBe(0);
    expect(readBinding({ device: 'gamepad', code: 'GamepadTrigger' }, state)).toBe(0);
  });
});

describe('resolveActions', () => {
  it('produces a value for every action, zero when idle', () => {
    const state = resolveActions(DEFAULT_BINDINGS, raw());
    expect(Object.keys(state).sort()).toEqual([...ACTION_IDS].sort());
    for (const id of ACTION_IDS) expect(state[id]).toBe(0);
  });

  it('maps held keys to their actions through the defaults', () => {
    const state = resolveActions(DEFAULT_BINDINGS, raw({ keys: new Set(['KeyW', 'ShiftLeft', 'KeyE']) }));
    expect(state['move.forward']).toBe(1);
    expect(state['vehicle.accelerate']).toBe(1);
    expect(state['move.sprint']).toBe(1);
    expect(state.interact).toBe(1);
    expect(state['move.back']).toBe(0);
  });

  it('combines opposing keys on an axis action using their scales', () => {
    expect(resolveActions(DEFAULT_BINDINGS, raw({ keys: new Set(['KeyA']) }))['vehicle.steer']).toBe(-1);
    expect(resolveActions(DEFAULT_BINDINGS, raw({ keys: new Set(['KeyD']) }))['vehicle.steer']).toBe(1);
    expect(resolveActions(DEFAULT_BINDINGS, raw({ keys: new Set(['KeyA', 'KeyD']) }))['vehicle.steer']).toBe(0);
  });

  it('sums contributions from several devices and clamps to -1..1', () => {
    const state = resolveActions(DEFAULT_BINDINGS, raw({ keys: new Set(['KeyD', 'ArrowRight']), gamepadAxes: [1] }));
    expect(state['vehicle.steer']).toBe(1);
    const mixed = resolveActions(DEFAULT_BINDINGS, raw({ keys: new Set(['KeyA']), gamepadAxes: [0.575] }));
    expect(mixed['vehicle.steer']).toBeCloseTo(-0.5);
  });

  it('applies the deadzone to stick-driven button actions', () => {
    const idle = resolveActions(DEFAULT_BINDINGS, raw({ gamepadAxes: [0, -0.1] }));
    expect(idle['move.forward']).toBe(0);
    const pushed = resolveActions(DEFAULT_BINDINGS, raw({ gamepadAxes: [0, -1] }));
    expect(pushed['move.forward']).toBe(1);
    expect(pushed['move.back']).toBe(-1);
    const custom = resolveActions(DEFAULT_BINDINGS, raw({ gamepadAxes: [0, -0.4] }), 0.5);
    expect(custom['move.forward']).toBe(0);
  });

  it('reads analog triggers as partial axis values', () => {
    const buttons: number[] = [];
    buttons[7] = 0.25;
    const state = resolveActions(DEFAULT_BINDINGS, raw({ gamepadButtons: buttons }));
    expect(state['vehicle.accelerate']).toBeCloseTo(0.25);
    expect(state['vehicle.brake']).toBe(0);
  });

  it('feeds scaled mouse movement into the look axes', () => {
    const state = resolveActions(DEFAULT_BINDINGS, raw({ mouse: { x: 50, y: -500, wheel: 0 } }));
    expect(state['look.x']).toBeCloseTo(0.5);
    expect(state['look.y']).toBe(-1);
  });

  it('respects custom bindings and empty binding lists', () => {
    const custom: BindingMap = cloneBindings(DEFAULT_BINDINGS);
    custom.interact = [{ device: 'mouse', code: 'MouseButton0' }];
    custom['move.forward'] = [];
    const state = resolveActions(custom, raw({ keys: new Set(['KeyW', 'KeyE']), mouseButtons: new Set([0]) }));
    expect(state.interact).toBe(1);
    expect(state['move.forward']).toBe(0);
  });
});
