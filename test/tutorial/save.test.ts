import { describe, expect, it } from 'vitest';
import { TUTORIAL_PENDING_MAX, TUTORIAL_QUEUE_MAX, isTutorialSave, newTutorialSave, type TutorialSave } from '../../src/tutorial';

const good = (): TutorialSave => {
  const s = newTutorialSave('firstShift');
  s.index = 5;
  s.entered = true;
  s.callId = 12;
  s.probeTick = 7;
  s.skipped = ['enterCar'];
  s.queue = [{ topic: 'cad:callClosed', payload: { callId: 3, nested: { a: 'x', b: true } } }];
  s.pending = ['ack', 'skip', 'end'];
  return s;
};
const bad = (patch: Record<string, unknown>): unknown => ({ ...good(), ...patch });

describe('newTutorialSave', () => {
  it('is a valid fresh save', () => {
    expect(newTutorialSave('firstShift')).toEqual({
      version: 1, scriptId: 'firstShift', index: 0, entered: false, callId: -1, probeTick: 0,
      skipped: [], done: false, completed: false, queue: [], pending: [],
    });
    expect(isTutorialSave(newTutorialSave('firstShift'))).toBe(true);
  });

  it('returns independent objects', () => {
    const a = newTutorialSave('firstShift');
    a.queue.push({ topic: 'x', payload: {} });
    expect(newTutorialSave('firstShift').queue).toEqual([]);
  });
});

describe('isTutorialSave', () => {
  it('accepts a mid-script block, also after a JSON round trip', () => {
    expect(isTutorialSave(good())).toBe(true);
    expect(isTutorialSave(JSON.parse(JSON.stringify(good())))).toBe(true);
  });

  it('accepts a finished and an ended block', () => {
    expect(isTutorialSave(bad({ index: 14, done: true, completed: true }))).toBe(true);
    expect(isTutorialSave(bad({ done: true, completed: false }))).toBe(true);
  });

  it('rejects non-objects', () => {
    for (const x of [null, undefined, 3, 'x', [], true]) expect(isTutorialSave(x)).toBe(false);
  });

  it('rejects an unknown or malformed script id and a wrong version', () => {
    expect(isTutorialSave(bad({ scriptId: 'nope' }))).toBe(false);
    expect(isTutorialSave(bad({ scriptId: 'toString' }))).toBe(false);
    expect(isTutorialSave(bad({ scriptId: 4 }))).toBe(false);
    expect(isTutorialSave(bad({ version: 2 }))).toBe(false);
    expect(isTutorialSave(bad({ version: undefined }))).toBe(false);
  });

  it('rejects bad numbers', () => {
    for (const index of [-1, 15, 1.5, '3', NaN, null]) expect(isTutorialSave(bad({ index })), `index ${String(index)}`).toBe(false);
    for (const callId of [-2, 1.5, '1', NaN, Infinity]) expect(isTutorialSave(bad({ callId })), `callId ${String(callId)}`).toBe(false);
    for (const probeTick of [-1, 15, 0.5, '2']) expect(isTutorialSave(bad({ probeTick })), `probeTick ${String(probeTick)}`).toBe(false);
    expect(isTutorialSave(bad({ probeTick: 14 }))).toBe(true);
    expect(isTutorialSave(bad({ index: 14 }))).toBe(true); // everything entered, not yet finished: the runner finishes it
  });

  it('rejects bad flags', () => {
    for (const k of ['entered', 'done', 'completed']) {
      expect(isTutorialSave(bad({ [k]: 1 })), k).toBe(false);
      expect(isTutorialSave(bad({ [k]: undefined })), k).toBe(false);
    }
    expect(isTutorialSave(bad({ completed: true }))).toBe(false); // completed without done
    expect(isTutorialSave(bad({ done: true, completed: true, index: 5 }))).toBe(false); // completed before the last step
  });

  it('rejects bad skipped lists', () => {
    expect(isTutorialSave(bad({ skipped: 'enterCar' }))).toBe(false);
    expect(isTutorialSave(bad({ skipped: [3] }))).toBe(false);
    expect(isTutorialSave(bad({ skipped: new Array(15).fill('x') }))).toBe(false);
  });

  it('rejects bad queues', () => {
    expect(isTutorialSave(bad({ queue: {} }))).toBe(false);
    expect(isTutorialSave(bad({ queue: [null] }))).toBe(false);
    expect(isTutorialSave(bad({ queue: [{ topic: '', payload: {} }] }))).toBe(false);
    expect(isTutorialSave(bad({ queue: [{ topic: 'a', payload: null }] }))).toBe(false);
    expect(isTutorialSave(bad({ queue: [{ topic: 'a', payload: [] }] }))).toBe(false);
    expect(isTutorialSave(bad({ queue: [{ topic: 'a', payload: { list: [1] } }] }))).toBe(false);
    expect(isTutorialSave(bad({ queue: [{ topic: 'a', payload: { n: NaN } }] }))).toBe(false);
    expect(isTutorialSave(bad({ queue: [{ topic: 'a', payload: { f: undefined } }] }))).toBe(false);
    expect(isTutorialSave(bad({ queue: [{ topic: 'a', payload: { f: null } }] }))).toBe(false);
    const full = Array.from({ length: TUTORIAL_QUEUE_MAX }, () => ({ topic: 'a', payload: {} }));
    expect(isTutorialSave(bad({ queue: full }))).toBe(true);
    expect(isTutorialSave(bad({ queue: [...full, { topic: 'a', payload: {} }] }))).toBe(false);
  });

  it('rejects bad pending lists', () => {
    expect(isTutorialSave(bad({ pending: ['stop'] }))).toBe(false);
    expect(isTutorialSave(bad({ pending: 'ack' }))).toBe(false);
    expect(isTutorialSave(bad({ pending: new Array(TUTORIAL_PENDING_MAX).fill('ack') }))).toBe(true);
    expect(isTutorialSave(bad({ pending: new Array(TUTORIAL_PENDING_MAX + 1).fill('ack') }))).toBe(false);
  });

  it('rejects a payload nested deeper than the copy limit', () => {
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 20; i++) deep = { n: deep };
    expect(isTutorialSave(bad({ queue: [{ topic: 'a', payload: deep }] }))).toBe(false);
  });
});
