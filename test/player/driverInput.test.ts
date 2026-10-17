import { describe, expect, it } from 'vitest';
import { ACTION_IDS, actionKind, type ActionId } from '../../src/input/actions';
import { DEFAULT_BINDINGS, isBinding } from '../../src/input/bindings';
import { readDriverInput, type DriverInput } from '../../src/player/driverInput';

function stub(axes: Partial<Record<ActionId, number>>, down: ActionId[] = []) {
  return {
    axis: (id: ActionId) => axes[id] ?? 0,
    isDown: (id: ActionId) => down.includes(id),
  };
}

describe('readDriverInput', () => {
  it('reads pedals, steering and handbrake', () => {
    const out: DriverInput = { accelerate: 0, brake: 0, steer: 0, handbrake: false };
    const r = readDriverInput(stub({ 'vehicle.accelerate': 0.7, 'vehicle.brake': 0.2, 'vehicle.steer': -0.5 }, ['vehicle.handbrake']), out);
    expect(r).toBe(out);
    expect(out).toEqual({ accelerate: 0.7, brake: 0.2, steer: -0.5, handbrake: true });
  });

  it('clamps negative pedal values to 0', () => {
    const out = readDriverInput(stub({ 'vehicle.accelerate': -1, 'vehicle.brake': -0.3, 'vehicle.steer': 1 }), {
      accelerate: 1,
      brake: 1,
      steer: 0,
      handbrake: true,
    });
    expect(out).toEqual({ accelerate: 0, brake: 0, steer: 1, handbrake: false });
  });
});

describe('player input actions', () => {
  const added = [
    ['vehicle.handbrake', 'Space', 'GamepadButton1'],
    ['vehicle.headlights', 'KeyH', 'GamepadButton12'],
    ['map.toggle', 'KeyM', 'GamepadButton13'],
  ] as const;

  it('are listed as buttons with valid default bindings', () => {
    for (const [id, keyCode, padCode] of added) {
      expect(ACTION_IDS).toContain(id);
      expect(actionKind(id)).toBe('button');
      const list = DEFAULT_BINDINGS[id];
      for (const b of list) expect(isBinding(b)).toBe(true);
      expect(list).toContainEqual({ device: 'keyboard', code: keyCode });
      expect(list).toContainEqual({ device: 'gamepad', code: padCode });
    }
  });

  it('do not reuse a key or button already bound to another action', () => {
    for (const [id] of added) {
      for (const b of DEFAULT_BINDINGS[id]) {
        for (const other of ACTION_IDS) {
          // The on-foot officer actions deliberately share Space / G / pad buttons with driving (design §12.5).
          if (other === id || other.startsWith('officer.')) continue;
          expect(DEFAULT_BINDINGS[other].some((o) => o.device === b.device && o.code === b.code), `${id} ${b.code} vs ${other}`).toBe(false);
        }
      }
    }
  });
});
