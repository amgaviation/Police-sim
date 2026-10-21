import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { ConductState } from '../../src/conduct/conductState';
import { isConductSave, newConductSave } from '../../src/conduct/save';
import type { ConductRequest } from '../../src/conduct/types';
import { harness, topics, type Harness } from './helpers';

/** Phase 7 hooks (design §11.6): `points` requests adjust the career points. */

const points = (delta: number, reason = 'Fleet: front damage', key = 'fleet:12:1'): ConductRequest => ({ kind: 'points', delta, reason, key });

describe('points request', () => {
  it('adds the delta on the next step, bumps the revision and emits conduct:points', () => {
    const h = harness();
    const rev = h.state.revision;
    h.state.request(points(-12));
    expect(h.state.career.points).toBe(0);
    h.step();
    expect(h.state.career.points).toBe(-12);
    expect(h.state.revision).toBeGreaterThan(rev);
    expect(topics(h, 'conduct:points')).toEqual([{ delta: -12, total: -12, reason: 'Fleet: front damage' }]);
    h.state.request(points(5, 'Clean inspection'));
    h.step();
    expect(h.state.career.points).toBe(-7);
    expect(topics(h, 'conduct:points').at(-1)).toEqual({ delta: 5, total: -7, reason: 'Clean inspection' });
  });

  it('applies several requests in order within one step', () => {
    const h = harness();
    h.state.request(points(-10, 'a'));
    h.state.request(points(-5, 'b'));
    h.state.request(points(3, 'c'));
    h.step();
    expect(h.state.career.points).toBe(-12);
    expect(topics(h, 'conduct:points')).toEqual([
      { delta: -10, total: -10, reason: 'a' },
      { delta: -5, total: -15, reason: 'b' },
      { delta: 3, total: -12, reason: 'c' },
    ]);
  });

  it('keeps the points an integer and ignores a zero move', () => {
    const h = harness();
    h.state.request(points(-2.6));
    h.step();
    expect(h.state.career.points).toBe(-3);
    expect(topics(h, 'conduct:points')).toEqual([{ delta: -3, total: -3, reason: 'Fleet: front damage' }]);
    h.state.request(points(0.2));
    h.step();
    expect(h.state.career.points).toBe(-3);
    expect(topics(h, 'conduct:points')).toHaveLength(1);
  });
});

describe('points in saves', () => {
  function queued(h: Harness): ReturnType<ConductState['serialize']> {
    return JSON.parse(JSON.stringify(h.state.serialize())) as ReturnType<ConductState['serialize']>;
  }

  it('a queued points request survives a save round trip and applies after restore', () => {
    const a = harness();
    a.state.request(points(-8, 'Fleet: wreck', 'fleet:3:2'));
    const save = queued(a);
    expect(save.queue).toEqual([{ kind: 'points', delta: -8, reason: 'Fleet: wreck', key: 'fleet:3:2' }]);
    expect(isConductSave(save)).toBe(true);

    const b = harness();
    b.state.restore(save);
    expect(b.state.career.points).toBe(0);
    b.step();
    expect(b.state.career.points).toBe(-8);
    expect(topics(b, 'conduct:points')).toEqual([{ delta: -8, total: -8, reason: 'Fleet: wreck' }]);
  });

  it('the applied points are saved with the career', () => {
    const a = harness();
    a.state.request(points(-8));
    a.step();
    const save = queued(a);
    expect(save.points).toBe(-8);
    const b = harness();
    b.state.restore(save);
    expect(b.state.career.points).toBe(-8);
  });

  it('the validator checks the request fields', () => {
    const base = newConductSave(createRng(1).stream('conduct').state());
    const withQueue = (r: unknown): unknown => ({ ...base, queue: [r] });
    expect(isConductSave(withQueue({ kind: 'points', delta: -3, reason: 'r', key: 'k' }))).toBe(true);
    expect(isConductSave(withQueue({ kind: 'points', reason: 'r', key: 'k' }))).toBe(false);
    expect(isConductSave(withQueue({ kind: 'points', delta: 'x', reason: 'r', key: 'k' }))).toBe(false);
    expect(isConductSave(withQueue({ kind: 'points', delta: Number.NaN, reason: 'r', key: 'k' }))).toBe(false);
    expect(isConductSave(withQueue({ kind: 'points', delta: 1, key: 'k' }))).toBe(false);
    expect(isConductSave(withQueue({ kind: 'points', delta: 1, reason: 'r' }))).toBe(false);
  });
});
