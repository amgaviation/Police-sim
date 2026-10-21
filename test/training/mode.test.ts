import { describe, expect, it } from 'vitest';
import { EventBus } from '../../src/core/events';
import type { EventMap } from '../../src/core/event-map';
import { GAME_MODES, isModeSave, newModeSave } from '../../src/training/mode';
import { DrivingCourseRun, findCourse, pickCourseSegment } from '../../src/training/course';
import { DispatchTraining } from '../../src/training/dispatchScore';
import { SAMPLE_SCENARIOS } from '../../src/training/scenario';
import { BUILTIN_SCRIPTS, ScriptRunner } from '../../src/training/script';

describe('game modes', () => {
  it('lists the six modes', () => {
    expect([...GAME_MODES]).toEqual(['freePatrol', 'career', 'drivingAcademy', 'dispatchOnly', 'sandbox', 'coop']);
  });

  it('newModeSave is empty and valid for every mode', () => {
    for (const id of GAME_MODES) {
      const s = newModeSave(id);
      expect(s).toEqual({ version: 1, id, course: null, courseId: null, script: null, dispatch: null, scenario: null, coopRole: null });
      expect(isModeSave(s)).toBe(true);
    }
  });

  it('accepts a populated block and survives a JSON round trip', () => {
    const bus = new EventBus<EventMap>();
    const anchor = pickCourseSegment([{ ax: 0, az: 0, bx: 0, bz: -400 }], 0, 0);
    const course = findCourse('basic');
    if (!anchor || !course) throw new Error('fixture');
    const runner = new ScriptRunner(BUILTIN_SCRIPTS[0]!);
    runner.start(5);
    const training = new DispatchTraining(bus);
    training.onCreated(1, 'C-1', 2, 1, 0);
    const s = {
      ...newModeSave('dispatchOnly'),
      course: new DrivingCourseRun(course, anchor, bus).serialize(),
      courseId: 'basic',
      script: runner.serialize(),
      dispatch: training.serialize(),
      scenario: SAMPLE_SCENARIOS[0]!,
      coopRole: 'dispatcher' as const,
    };
    expect(isModeSave(s)).toBe(true);
    expect(isModeSave(JSON.parse(JSON.stringify(s)))).toBe(true);
  });

  it('rejects every malformed field', () => {
    const base = newModeSave('sandbox');
    expect(isModeSave(null)).toBe(false);
    expect(isModeSave('x')).toBe(false);
    expect(isModeSave({ ...base, version: 2 })).toBe(false);
    expect(isModeSave({ ...base, id: 'arcade' })).toBe(false);
    expect(isModeSave({ ...base, course: {} })).toBe(false);
    expect(isModeSave({ ...base, courseId: 3 })).toBe(false);
    expect(isModeSave({ ...base, script: { scriptId: 'a' } })).toBe(false);
    expect(isModeSave({ ...base, dispatch: { calls: 'x', total: 0, scored: 0 } })).toBe(false);
    expect(isModeSave({ ...base, scenario: { format: 'patrol-scenario' } })).toBe(false);
    expect(isModeSave({ ...base, coopRole: 'pilot' })).toBe(false);
  });
});
