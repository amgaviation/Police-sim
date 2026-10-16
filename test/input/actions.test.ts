import { describe, expect, it } from 'vitest';
import { ACTIONS, ACTION_IDS, actionKind, isActionId } from '../../src/input/actions';

describe('actions', () => {
  it('lists every action id exactly once', () => {
    expect(ACTION_IDS).toEqual(Object.keys(ACTIONS));
    expect(new Set(ACTION_IDS).size).toBe(ACTION_IDS.length);
    expect(ACTION_IDS).toContain('move.forward');
    expect(ACTION_IDS).toContain('vehicle.siren');
    expect(ACTION_IDS).toContain('camera.toggle');
  });

  it('classifies look and steering as axes and everything else as buttons', () => {
    expect(actionKind('look.x')).toBe('axis');
    expect(actionKind('look.y')).toBe('axis');
    expect(actionKind('vehicle.steer')).toBe('axis');
    expect(actionKind('vehicle.accelerate')).toBe('axis');
    expect(actionKind('move.forward')).toBe('button');
    expect(actionKind('interact')).toBe('button');
    expect(actionKind('console.toggle')).toBe('button');
  });

  it('isActionId rejects unknown ids and non-strings', () => {
    expect(isActionId('move.forward')).toBe(true);
    expect(isActionId('move.sideways')).toBe(false);
    expect(isActionId('toString')).toBe(false);
    expect(isActionId(42)).toBe(false);
    expect(isActionId(null)).toBe(false);
  });
});
