import { describe, expect, it } from 'vitest';
import type { CareerRequest, DorCategory, ShiftSummary, Trainee } from '../../src/career';
import { ShiftSummaryScreen, statLines, summaryModel } from '../../src/ui/career/summary';
import {
  DEFAULT_RATING, TraineeEvalPanel, defaultRatings, ratingRequest, setRating, traineeModel,
} from '../../src/ui/career/trainee';
import { harness, NIGHT, saveAt, stepAt } from './fto';
import { key, offDutyHarness } from './helpers';

describe('summaryModel', () => {
  it('turns a real shift summary into pay, stats and wellbeing rows', () => {
    const h = offDutyHarness();
    const s = h.summary;
    const m = summaryModel(s);
    expect(m.title).toBe('Shift 1 complete');
    expect(m.pay.total).toBe(s.pay.total);
    expect(m.pay.rows.map((r) => r.label)).toEqual(['Base pay', 'Night differential']);
    expect(m.pay.rows.reduce((sum, r) => sum + r.amount, 0)).toBe(s.pay.total);
    expect(m.dor).toBeNull();
    expect(m.stats.map((r) => r.label)).toContain('Calls handled');
    expect(m.bars.map((b) => b.label)).toEqual(['Fatigue', 'Stress', 'Health']);
    expect(m.next).toMatch(/22:00 - 06:00$/);
  });

  it('Escape continues like Enter (the pad\'s B), once', () => {
    const summary = offDutyHarness().summary;
    const got: ShiftSummary[] = [];
    const screen = new ShiftSummaryScreen(null, { continue: (s) => got.push(s) });
    screen.open(summary);
    expect(screen.onKeyDown(key('Escape'))).toBe(true);
    expect(got).toEqual([summary]);
    expect(screen.isOpen).toBe(false);
    expect(screen.onKeyDown(key('Escape'))).toBe(false);
  });

  it('shows deductions as a negative line and the DOR of a probation shift', () => {
    const base = offDutyHarness().summary;
    const s: ShiftSummary = {
      ...base,
      pay: { ...base.pay, deductions: 100, overtime: 40, total: base.pay.total + 40 - 100 },
      dor: { shiftNo: 1, scores: { safety: 4, procedure: 3.5, reports: 2, community: 3, driving: 5 }, average: 3.5, notes: ['Report writing needs work'] },
      events: [{ game: 90000, kind: 'note', text: 'Something happened' }],
    };
    const m = summaryModel(s);
    expect(m.pay.rows.find((r) => r.label === 'Deductions')?.amount).toBe(-100);
    expect(m.pay.rows.find((r) => r.label === 'Overtime')?.amount).toBe(40);
    expect(m.dor?.rows.map((r) => `${r.label} ${String(r.value)}`)).toEqual([
      'Officer safety 4', 'Procedure 3.5', 'Report writing 2', 'Community relations 3', 'Driving 5',
    ]);
    expect(m.dor?.notes).toEqual(['Report writing needs work']);
    expect(m.events).toHaveLength(1);
    expect(m.events[0]?.text).toBe('Something happened');
  });

  it('formats the stat lines', () => {
    const lines = Object.fromEntries(statLines({
      calls: 6, arrests: 2, reports: 2, reportSum: 171, forceEvents: 0, unjustifiedForce: 0, unlawfulDeterminations: 1, pursuits: 1,
      fleetPoints: -3, trustDelta: 0.0123, courtMinutes: 90, overtimeMinutes: 35,
    }).map((l) => [l.label, l.text]));
    expect(lines['Reports']).toBe('2 (average grade 86)');
    expect(lines['Use of force']).toBe('none');
    expect(lines['Community trust']).toBe('+1.2 points');
    expect(lines['Court time']).toBe('90 min');
    expect(lines['Overtime']).toBe('35 min');
  });
});

describe('ShiftSummaryScreen (headless)', () => {
  it('Continue / Enter hands the summary to the host once and closes', () => {
    const summary = offDutyHarness().summary;
    const got: ShiftSummary[] = [];
    const screen = new ShiftSummaryScreen(null, { continue: (s) => got.push(s) });
    expect(screen.onKeyDown(key('Enter'))).toBe(false); // closed
    screen.open(summary);
    expect(screen.isOpen).toBe(true);
    expect(screen.summary).toBe(summary);
    expect(screen.onKeyDown(key('Enter'))).toBe(true);
    expect(screen.onKeyDown(key('Enter'))).toBe(false);
    screen.proceed();
    expect(got).toEqual([summary]);
    expect(screen.isOpen).toBe(false);
  });
});

describe('trainee evaluation', () => {
  const trainee: Trainee = { name: 'Riley', truth: { safety: 4, procedure: 2, reports: 5, community: 3, driving: 1 } };

  function make(t: Trainee | null = trainee): { panel: TraineeEvalPanel; requests: CareerRequest[]; closed: number[] } {
    const requests: CareerRequest[] = [];
    const closed: number[] = [];
    const panel = new TraineeEvalPanel(null, { trainee: () => t, request: (r) => requests.push(r), close: () => closed.push(1) });
    return { panel, requests, closed };
  }

  it('starts at the middle rating and clamps to 1..5', () => {
    expect(Object.values(defaultRatings())).toEqual([3, 3, 3, 3, 3]);
    expect(DEFAULT_RATING).toBe(3);
    expect(setRating(defaultRatings(), 'safety', 9).safety).toBe(5);
    expect(setRating(defaultRatings(), 'safety', -2).safety).toBe(1);
    expect(setRating(defaultRatings(), 'safety', 3.6).safety).toBe(4);
    expect(setRating(defaultRatings(), 'safety', Number.NaN).safety).toBe(3);
  });

  it('the model never shows the trainee truth', () => {
    const m = traineeModel(trainee, defaultRatings());
    expect(m.name).toBe('Riley');
    expect(m.rows.map((r) => r.label)).toEqual(['Officer safety', 'Procedure', 'Report writing', 'Community relations', 'Driving']);
    expect(JSON.stringify(m)).not.toContain('truth');
    expect(m.rows.every((r) => r.value === 3)).toBe(true);
    expect(traineeModel(null, defaultRatings()).name).toBe('');
  });

  it('submits a traineeRating request with the chosen ratings', () => {
    const { panel, requests, closed } = make();
    expect(panel.open()).toBe(true);
    panel.rate('safety', 5);
    panel.rate('driving', 1);
    panel.onKeyDown(key('ArrowDown')); // procedure
    panel.onKeyDown(key('4'));
    panel.onKeyDown(key('ArrowDown')); // reports
    panel.onKeyDown(key('ArrowRight'));
    panel.onKeyDown(key('ArrowRight'));
    panel.onKeyDown(key('ArrowRight')); // clamps at 5
    expect(panel.onKeyDown(key('Enter'))).toBe(true);
    const expected: Record<DorCategory, number> = { safety: 5, procedure: 4, reports: 5, community: 3, driving: 1 };
    expect(requests).toEqual([{ kind: 'traineeRating', ratings: expected }]);
    expect(closed).toEqual([1]);
    expect(panel.isOpen).toBe(false);
  });

  it('Escape skips without a request; no trainee means nothing opens', () => {
    const { panel, requests, closed } = make();
    panel.open();
    expect(panel.onKeyDown(key('Escape'))).toBe(true);
    expect(requests).toEqual([]);
    expect(closed).toEqual([1]);
    const none = make(null);
    expect(none.panel.open()).toBe(false);
    expect(none.panel.submit()).toBeNull();
    expect(ratingRequest(defaultRatings())).toEqual({ kind: 'traineeRating', ratings: defaultRatings() });
  });

  it('the request is accepted by a real FTO career state and awards points by accuracy', () => {
    const h = harness(saveAt());
    stepAt(h, NIGHT);
    const t = h.career.view.trainee;
    expect(t).not.toBeNull();
    const { panel } = (() => {
      const p = new TraineeEvalPanel(null, { trainee: () => h.career.view.trainee, request: (r) => h.career.request(r), close: () => undefined });
      return { panel: p };
    })();
    expect(panel.open()).toBe(true);
    for (const c of ['safety', 'procedure', 'reports', 'community', 'driving'] as const) panel.rate(c, t?.truth[c] ?? 3);
    panel.submit();
    stepAt(h, NIGHT + 1);
    expect(h.points).toHaveLength(1);
    expect(h.points[0]?.delta).toBe(10);
    expect(h.career.view.trainee).toBeNull();
  });
});
