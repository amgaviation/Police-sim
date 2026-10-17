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

  it('adds the Phase 2 button actions with readable labels', () => {
    const expected: Record<string, string> = {
      'vehicle.sirenTone': 'Siren tone',
      'vehicle.horn': 'Air horn',
      'vehicle.manual': 'Manual siren',
      'vehicle.lightPattern': 'Light pattern',
      'vehicle.spotlight': 'Spotlight',
      'vehicle.spotAim': 'Aim spotlight (hold)',
      'vehicle.equipment': 'Vehicle equipment',
      'mdt.toggle': 'MDT',
      'target.runPlate': 'Run plate',
      'radio.menu': 'Radio menu',
      'radio.ptt': 'Push to talk',
      'radio.emergency': 'Emergency button',
      'radio.channelPrev': 'Previous channel',
      'radio.channelNext': 'Next channel',
      'radio.scan': 'Radio scan',
    };
    for (let i = 1; i <= 9; i++) expected[`radio.option${i}`] = `Radio option ${i}`;
    for (const [id, label] of Object.entries(expected)) {
      expect(isActionId(id), id).toBe(true);
      if (!isActionId(id)) continue;
      expect(ACTIONS[id]).toEqual({ kind: 'button', label });
    }
  });
});
