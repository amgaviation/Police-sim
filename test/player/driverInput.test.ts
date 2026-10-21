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
    expect(out).toEqual({ accelerate: 0.7, brake: 0.2, steer: -0.5, handbrake: true, lift: 0 });
  });

  it('reads the aircraft lift axis (Space +1, Shift -1 by default)', () => {
    const out: DriverInput = { accelerate: 0, brake: 0, steer: 0, handbrake: false };
    expect(readDriverInput(stub({ 'vehicle.lift': 1 }), out).lift).toBe(1);
    expect(readDriverInput(stub({ 'vehicle.lift': -0.4 }), out).lift).toBe(-0.4);
    expect(readDriverInput(stub({}), out).lift).toBe(0);
    expect(actionKind('vehicle.lift')).toBe('axis');
    expect(DEFAULT_BINDINGS['vehicle.lift']).toEqual([
      { device: 'keyboard', code: 'Space' },
      { device: 'keyboard', code: 'ShiftLeft', scale: -1 },
    ]);
  });

  it('clamps negative pedal values to 0', () => {
    const out = readDriverInput(stub({ 'vehicle.accelerate': -1, 'vehicle.brake': -0.3, 'vehicle.steer': 1 }), {
      accelerate: 1,
      brake: 1,
      steer: 0,
      handbrake: true,
    });
    expect(out).toEqual({ accelerate: 0, brake: 0, steer: 1, handbrake: false, lift: 0 });
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
          // The on-foot officer actions deliberately share Space / G / pad buttons with driving (design §12.5), and
          // the aircraft lift shares Space with the handbrake (aircraft have no handbrake, design §5.8).
          // Phase 9: the radio menu cursor is modal (it acts only while the radio menu is open and then takes the D-pad / A).
          if (other === id || other.startsWith('officer.') || other.startsWith('radio.cursor') || other === 'vehicle.lift') continue;
          expect(DEFAULT_BINDINGS[other].some((o) => o.device === b.device && o.code === b.code), `${id} ${b.code} vs ${other}`).toBe(false);
        }
      }
    }
  });
});
