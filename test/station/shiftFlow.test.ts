import { describe, expect, it } from 'vitest';
import { SHIFT_STEPS, ShiftFlow } from '../../src/station/shiftFlow';

describe('ShiftFlow', () => {
  it('lists the five steps in order', () => {
    expect(SHIFT_STEPS).toEqual(['locker', 'briefing', 'armory', 'garage', 'onPatrol']);
  });

  it('starts at the locker with its objective', () => {
    const f = new ShiftFlow();
    expect(f.step).toBe('locker');
    expect(f.objective()).toBe('Shift: choose your gear at the locker (E)');
    expect(f.log).toEqual([]);
  });

  it('advances one step at a time and logs the sim time', () => {
    const f = new ShiftFlow();
    expect(f.complete('locker', 1)).toBe(true);
    expect(f.step).toBe('briefing');
    expect(f.objective()).toBe('Shift: attend roll call (E at the podium)');
    expect(f.complete('briefing', 2)).toBe(true);
    expect(f.objective()).toBe('Shift: sign out your weapons at the armory (E)');
    expect(f.complete('armory', 3)).toBe(true);
    expect(f.objective()).toBe('Shift: take a patrol car from the garage');
    expect(f.complete('garage', 4)).toBe(true);
    expect(f.step).toBe('onPatrol');
    expect(f.objective()).toBeNull();
    expect(f.log).toEqual([['locker', 1], ['briefing', 2], ['armory', 3], ['garage', 4]]);
  });

  it('skips earlier steps when a later one is completed, logging each', () => {
    const f = new ShiftFlow();
    expect(f.complete('armory', 10)).toBe(true);
    expect(f.step).toBe('garage');
    expect(f.log).toEqual([['locker', 10], ['briefing', 10], ['armory', 10]]);
  });

  it('ignores a step that is already behind', () => {
    const f = new ShiftFlow();
    f.complete('briefing', 1);
    expect(f.step).toBe('armory');
    expect(f.complete('locker', 2)).toBe(false);
    expect(f.complete('briefing', 2)).toBe(false);
    expect(f.step).toBe('armory');
    expect(f.log).toHaveLength(2);
  });

  it('completing onPatrol skips to patrol, and nothing advances once there', () => {
    const f = new ShiftFlow();
    expect(f.complete('onPatrol', 5)).toBe(true);
    expect(f.step).toBe('onPatrol');
    expect(f.log.map(([s]) => s)).toEqual(['locker', 'briefing', 'armory', 'garage']);
    expect(f.complete('onPatrol', 6)).toBe(false);
    expect(f.complete('garage', 6)).toBe(false);
    expect(f.log).toHaveLength(4);
  });

  it('restores a saved state', () => {
    const f = new ShiftFlow();
    f.restore('garage', [['locker', 1], ['briefing', 2], ['armory', 3]]);
    expect(f.step).toBe('garage');
    expect(f.log).toHaveLength(3);
    expect(f.complete('garage', 9)).toBe(true);
    expect(f.step).toBe('onPatrol');
  });
});
