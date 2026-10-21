import { describe, expect, it } from 'vitest';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { DispatchTraining, MAX_RECORDS, TIMELY_S, isDispatchTrainingSave, scoreCall, type DispatchCallRecord } from '../../src/training/dispatchScore';

function record(over: Partial<DispatchCallRecord> = {}): DispatchCallRecord {
  return {
    callId: 1, number: 'C-1', priority: 2, createdSim: 0, firstAssignSim: 60, minUnits: 2, assigned: 2,
    assignedDistM: 500, nearestDistM: 500, closed: false, score: 0, ...over,
  };
}

describe('scoreCall', () => {
  it('has the timeliness table', () => {
    expect(TIMELY_S).toEqual({ 1: [30, 180], 2: [60, 300], 3: [120, 600], 4: [300, 1200] });
  });

  it('gives a perfect call 100', () => {
    expect(scoreCall(record(), 100)).toBe(100);
  });

  it('timeliness is full at the first threshold, linear, and 0 at the second', () => {
    // P2: full 50 at <= 60 s, zero at >= 300 s: 180 s wait is halfway = 25.
    expect(scoreCall(record({ firstAssignSim: 180 }), 200)).toBe(25 + 25 + 25);
    expect(scoreCall(record({ firstAssignSim: 300 }), 400)).toBe(0 + 25 + 25);
    expect(scoreCall(record({ firstAssignSim: 900 }), 1000)).toBe(50);
    expect(scoreCall(record({ priority: 1, firstAssignSim: 30 }), 40)).toBe(100);
    expect(scoreCall(record({ priority: 1, firstAssignSim: 105 }), 200)).toBe(25 + 50);
  });

  it('coverage is assigned over minimum units', () => {
    expect(scoreCall(record({ assigned: 1 }), 100)).toBe(50 + 13 + 25);
    expect(scoreCall(record({ assigned: 4, minUnits: 2 }), 100)).toBe(100);
  });

  it('proximity is nearest over assigned distance, full when none was nearer', () => {
    expect(scoreCall(record({ assignedDistM: 1000, nearestDistM: 500 }), 100)).toBe(50 + 25 + 13);
    expect(scoreCall(record({ assignedDistM: 400, nearestDistM: 500 }), 100)).toBe(100);
    expect(scoreCall(record({ assignedDistM: 0, nearestDistM: 0 }), 100)).toBe(100);
  });

  it('a call never assigned scores 0 once closed or older than the second threshold, and only timeliness while fresh', () => {
    const open = record({ firstAssignSim: -1, assigned: 0, assignedDistM: 0, nearestDistM: 0 });
    expect(scoreCall({ ...open, closed: true }, 50)).toBe(0);
    expect(scoreCall(open, 301)).toBe(0);
    expect(scoreCall(open, 60)).toBe(50);
  });
});

describe('DispatchTraining', () => {
  function rig(): { t: DispatchTraining; bus: EventBus<EventMap>; scores: EventMap['training:dispatchScore'][] } {
    const bus = new EventBus<EventMap>();
    const scores: EventMap['training:dispatchScore'][] = [];
    bus.on('training:dispatchScore', (e) => scores.push(e));
    return { t: new DispatchTraining(bus), bus, scores };
  }

  it('scores a call when it closes and emits training:dispatchScore with the running total', () => {
    const { t, scores } = rig();
    t.onCreated(1, 'C-1', 2, 2, 0);
    t.onAssigned(1, 40, 300, 300);
    t.onAssigned(1, 50, 600, 600);
    t.onClosed(1, 400);
    t.onCreated(2, 'C-2', 3, 1, 10);
    t.onClosed(2, 500);
    expect(scores).toEqual([
      { callNumber: 'C-1', score: 100, total: 100 },
      { callNumber: 'C-2', score: 0, total: 100 },
    ]);
    expect(t.average()).toBe(50);
    expect(t.grade()).toBe('F');
  });

  it('ignores unknown and already closed calls', () => {
    const { t, scores } = rig();
    t.onAssigned(9, 1, 1, 1);
    t.onClosed(9, 1);
    t.onCreated(1, 'C-1', 4, 1, 0);
    t.onClosed(1, 10);
    t.onClosed(1, 20);
    t.onAssigned(1, 30, 5, 5);
    expect(scores).toHaveLength(1);
  });

  it('grades at 90 / 80 / 70 / 60', () => {
    const grade = (score: number): string => {
      const bus = new EventBus<EventMap>();
      const t = new DispatchTraining(bus, { calls: [], total: score, scored: 1 });
      return t.grade();
    };
    expect([grade(95), grade(90), grade(89), grade(80), grade(75), grade(70), grade(65), grade(60), grade(59), grade(0)]).toEqual(['A', 'A', 'B', 'B', 'C', 'C', 'D', 'D', 'F', 'F']);
  });

  it('serialize / restore round trips and keeps counting', () => {
    const { t } = rig();
    t.onCreated(1, 'C-1', 1, 1, 0);
    t.onAssigned(1, 10, 100, 100);
    t.onClosed(1, 50);
    t.onCreated(2, 'C-2', 2, 1, 5);
    const save = JSON.parse(JSON.stringify(t.serialize())) as ReturnType<DispatchTraining['serialize']>;
    expect(isDispatchTrainingSave(save)).toBe(true);
    const bus = new EventBus<EventMap>();
    const again = new DispatchTraining(bus, save);
    expect(again.serialize()).toEqual(save);
    again.onAssigned(2, 20, 100, 100);
    again.onClosed(2, 100);
    expect(again.average()).toBe(100);
    expect(again.serialize().scored).toBe(2);
  });

  it('keeps at most 200 records, dropping closed ones first, without losing the totals', () => {
    const { t } = rig();
    t.onCreated(0, 'C-0', 1, 1, 0);
    t.onAssigned(0, 1, 1, 1);
    t.onClosed(0, 2);
    for (let i = 1; i <= MAX_RECORDS + 20; i++) t.onCreated(i, `C-${i}`, 4, 1, i);
    const save = t.serialize();
    expect(save.calls).toHaveLength(MAX_RECORDS);
    expect(save.calls.some((c) => c.callId === 0)).toBe(false);
    expect(save.scored).toBe(1);
    expect(save.total).toBeGreaterThan(0);
  });

  it('isDispatchTrainingSave rejects malformed blocks', () => {
    expect(isDispatchTrainingSave(null)).toBe(false);
    expect(isDispatchTrainingSave({ calls: [], total: 'x', scored: 0 })).toBe(false);
    expect(isDispatchTrainingSave({ calls: [{ callId: 1 }], total: 0, scored: 0 })).toBe(false);
    expect(isDispatchTrainingSave({ calls: [], total: 0, scored: -1 })).toBe(false);
    expect(isDispatchTrainingSave({ calls: Array.from({ length: 201 }, () => record()), total: 0, scored: 0 })).toBe(false);
  });
});
