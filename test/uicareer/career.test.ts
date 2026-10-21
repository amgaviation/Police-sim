import { describe, expect, it } from 'vitest';
import { CAREER_CONFIG, SPECIALTIES, type CareerRank, type CareerRequest, type CareerView, type EligibilityContext } from '../../src/career';
import {
  CAREER_TABS, CareerScreen, bidModel, careerOverviewModel, evaluationsModel, payModel, promotionModel, toggleBidPref, unitsModel,
  type CareerHost,
} from '../../src/ui/career/careerScreen';
import { GOOD_CTX, key, offDutyHarness, viewOf } from './helpers';

const BAD_CTX: EligibilityContext = { points: 0, credibility: 10, sustainedIaRecent: 3, avgReport: 20 };

describe('careerOverviewModel', () => {
  it('describes a fresh patrol officer with clear severities', () => {
    const m = careerOverviewModel(viewOf('patrol'));
    const byLabel = Object.fromEntries(m.lines.map((l) => [l.label, l]));
    expect(byLabel['Stage']?.text).toBe('Sworn patrol officer');
    expect(byLabel['Rank']?.text).toBe('Officer');
    expect(byLabel['Assignment']?.text).toBe('Patrol');
    expect(byLabel['Position']?.text).toBe('Night · Downtown');
    expect(byLabel['Money']?.text).toBe('$ 1 500');
    expect(byLabel['Shift']?.text).toContain('Shift 1 on duty');
    expect(m.lines.every((l) => l.severity === 'clear' || l.label === 'Family' || l.label === 'Fitness')).toBe(true);
  });

  it('flags tiredness, stress, debt and poor health by severity', () => {
    const v = viewOf('patrol', (s) => {
      s.wellbeing.fatigue = 0.9;
      s.wellbeing.stress = 0.65;
      s.wellbeing.health = 0.3;
      s.wellbeing.sleepDebtH = 5;
      s.money = -40;
    });
    const sev = Object.fromEntries(careerOverviewModel(v).lines.map((l) => [l.label, l.severity]));
    expect(sev).toMatchObject({ Fatigue: 'alert', Stress: 'caution', Health: 'alert', 'Sleep debt': 'caution', Money: 'alert' });
    expect(careerOverviewModel(v).lines.find((l) => l.label === 'Money')?.text).toBe('-$ 40');
  });

  it('reads probation and academy stages', () => {
    expect(careerOverviewModel(viewOf('probation')).lines[0]?.text).toBe('Probation · 5 shifts left');
    expect(careerOverviewModel(viewOf('academy')).lines[0]?.text).toBe('Academy recruit');
    expect(careerOverviewModel(viewOf('separated')).lines[0]).toMatchObject({ text: 'Separated from the department', severity: 'alert' });
  });

  it('shows the off-duty state and the performance penalties', () => {
    const h = offDutyHarness((s) => {
      s.wellbeing.fatigue = 0.9;
    });
    const lines = careerOverviewModel(h.career.view).lines;
    expect(lines.find((l) => l.label === 'Shift')?.text).toContain('Off duty · next');
    expect(lines.find((l) => l.label === 'Performance')?.text).toMatch(/^Aim spread x\d\.\d\d · steering lag \d\.\d\d s$/);
  });
});

describe('unitsModel', () => {
  it('lists the six units and the FTO assignment', () => {
    const rows = unitsModel(viewOf('patrol'), GOOD_CTX);
    expect(rows.map((r) => r.id)).toEqual(['traffic', 'k9', 'detective', 'swat', 'narcotics', 'air', 'fto']);
    expect(rows.map((r) => r.label).slice(0, 6)).toEqual(['traffic', 'k9', 'detective', 'swat', 'narcotics', 'air'].map((id) => SPECIALTIES[id as keyof typeof SPECIALTIES].label));
    expect(rows.at(-1)?.label).toBe('Field training officer');
  });

  it('gives every unmet requirement as a reason', () => {
    const rows = unitsModel(viewOf('patrol'), BAD_CTX);
    const swat = rows.find((r) => r.id === 'swat');
    expect(swat?.eligible).toBe(false);
    expect(swat?.reasons.length).toBeGreaterThan(2);
    expect(swat?.reasons.some((r) => r.includes('shifts of seniority'))).toBe(true);
    expect(swat?.reasons.some((r) => r.includes('Career points'))).toBe(true);
    const fto = rows.find((r) => r.id === 'fto');
    expect(fto?.reasons.some((r) => r.includes('Average report grade'))).toBe(true);
  });

  it('is eligible with enough seniority, scores and points; marks the current assignment', () => {
    const v = viewOf('patrol', (s) => {
      s.seniorityShifts = 500;
      s.rank = 'sergeant';
      for (const m of Object.keys(s.academy) as (keyof typeof s.academy)[]) s.academy[m] = { best: 100, attempts: 1, passed: true };
      s.wellbeing.fitness = 1;
    });
    const rows = unitsModel(v, GOOD_CTX);
    expect(rows.find((r) => r.id === 'traffic')).toMatchObject({ eligible: true, reasons: [], current: false });
    expect(rows.find((r) => r.id === 'fto')?.eligible).toBe(true);
    const inFto = unitsModel(viewOf('patrol', (s) => { s.assignment = 'fto'; s.seniorityShifts = 500; }), GOOD_CTX);
    expect(inFto.find((r) => r.id === 'fto')).toMatchObject({ current: true, eligible: false });
  });

  it('refuses everything outside the patrol stage', () => {
    const rows = unitsModel(viewOf('probation'), GOOD_CTX);
    expect(rows.every((r) => !r.eligible && r.reasons[0]?.startsWith('Only patrol officers can apply'))).toBe(true);
  });
});

describe('bidModel', () => {
  it('lists the 12 positions and the stored preferences', () => {
    const v = viewOf('patrol', (s) => {
      s.bid.prefs = [{ slot: 'day', beat: 'suburbs' }, { slot: 'swing', beat: 'highway' }];
      s.bid.nextBidShift = 4;
    });
    const m = bidModel(v);
    expect(m.options).toHaveLength(12);
    expect(m.options[0]).toEqual({ key: 'day:downtown', label: 'Day · Downtown' });
    expect(m.options.at(-1)).toEqual({ key: 'night:highway', label: 'Night · Highway' });
    expect(m.prefs).toEqual([{ slot: 'day', beat: 'suburbs' }, { slot: 'swing', beat: 'highway' }]);
    expect(m.nextBidShift).toBe(4);
    expect(m.shiftsUntilBid).toBe(2);
    expect(m.maxPrefs).toBe(CAREER_CONFIG.bidding.maxPrefs);
  });

  it('toggles preferences up to the maximum', () => {
    let prefs = toggleBidPref([], { slot: 'day', beat: 'downtown' });
    prefs = toggleBidPref(prefs, { slot: 'night', beat: 'highway' });
    expect(prefs.map((p) => `${p.slot}:${p.beat}`)).toEqual(['day:downtown', 'night:highway']);
    prefs = toggleBidPref(prefs, { slot: 'day', beat: 'downtown' });
    expect(prefs.map((p) => `${p.slot}:${p.beat}`)).toEqual(['night:highway']);
    let full = [] as ReturnType<typeof toggleBidPref>;
    for (const beat of ['downtown', 'suburbs', 'industrial', 'highway'] as const) full = toggleBidPref(full, { slot: 'swing', beat });
    expect(full).toHaveLength(CAREER_CONFIG.bidding.maxPrefs);
    expect(toggleBidPref(full, { slot: 'day', beat: 'downtown' })).toHaveLength(CAREER_CONFIG.bidding.maxPrefs);
    expect(toggleBidPref(full, { slot: 'day', beat: 'downtown' }, 5)).toHaveLength(5);
  });
});

describe('promotionModel', () => {
  it('names the next rank, the requirements and the exam mark', () => {
    const m = promotionModel(viewOf('patrol'), BAD_CTX);
    expect(m).toMatchObject({ current: 'officer', next: 'corporal', ok: false, exam: 0 });
    expect(m.reasons.length).toBeGreaterThan(0);
    const sergeant = promotionModel(viewOf('patrol', (s) => { s.rank = 'corporal'; s.seniorityShifts = 5000; }), GOOD_CTX);
    expect(sergeant).toMatchObject({ next: 'sergeant', ok: true });
    expect(sergeant.exam).toBeGreaterThan(0);
    expect(promotionModel(viewOf('patrol', (s) => { s.rank = 'captain'; }), GOOD_CTX)).toMatchObject({ next: null, ok: false });
  });
});

describe('payModel and evaluationsModel', () => {
  it('shows the newest pay first with the non-zero components', () => {
    const h = offDutyHarness();
    const m = payModel(h.career.view);
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]?.shiftNo).toBe(1);
    expect(m.rows[0]?.lines.map((l) => l.label)).toEqual(['Base', 'Night differential']);
    expect(m.rows[0]?.total).toBe(h.summary.pay.total);
    expect(m.rentPerWeek).toBe(CAREER_CONFIG.pay.rentPerWeek);
    expect(payModel(viewOf('patrol')).rows).toEqual([]);
  });

  it('lists academy results, DORs newest first and the history', () => {
    const v = viewOf('probation', (s) => {
      s.dor = [
        { shiftNo: 1, scores: { safety: 4, procedure: 3, reports: 2, community: 3, driving: 5 }, average: 3.4, notes: ['Report writing needs work'] },
        { shiftNo: 2, scores: { safety: 5, procedure: 5, reports: 5, community: 5, driving: 5 }, average: 5, notes: [] },
      ];
      s.history = [{ game: 100, kind: 'graduated', text: 'Graduated' }, { game: 200, kind: 'note', text: 'Later' }];
    });
    const m = evaluationsModel(v);
    expect(m.dor.map((d) => d.shiftNo)).toEqual([2, 1]);
    expect(m.dor[1]?.scores.map((s) => s.label)).toEqual(['Officer safety', 'Procedure', 'Report writing', 'Community relations', 'Driving']);
    expect(m.dor[1]?.notes).toEqual(['Report writing needs work']);
    expect(m.academy).toHaveLength(5);
    expect(m.academy[0]).toEqual({ label: 'Driving', best: 'none', passed: true });
    expect(m.history.map((h) => h.text)).toEqual(['Later', 'Graduated']);
  });
});

describe('CareerScreen (headless)', () => {
  function make(view: CareerView, ctx: EligibilityContext = GOOD_CTX): { screen: CareerScreen; requests: CareerRequest[]; exams: CareerRank[]; closed: number[]; setView(v: CareerView): void } {
    const requests: CareerRequest[] = [];
    const exams: CareerRank[] = [];
    const closed: number[] = [];
    let current = view;
    let examScore = 88;
    const host: CareerHost = {
      view: () => current,
      eligibility: () => ctx,
      names: () => ['A', 'B'],
      request: (r) => requests.push(r),
      startExam: (rank, done) => { exams.push(rank); done(examScore); examScore = 0; },
      close: () => closed.push(1),
    };
    const screen = new CareerScreen(null, host);
    return { screen, requests, exams, closed, setView: (v) => { current = v; } };
  }

  it('switches tabs with digits and arrows and closes through the host', () => {
    const { screen, closed } = make(viewOf('patrol'));
    screen.open();
    expect(screen.tab).toBe('overview');
    screen.onKeyDown(key('3'));
    expect(screen.tab).toBe('units');
    screen.onKeyDown(key('ArrowRight'));
    expect(screen.tab).toBe('promotion');
    screen.onKeyDown(key('ArrowLeft'));
    screen.onKeyDown(key('ArrowLeft'));
    screen.onKeyDown(key('ArrowLeft'));
    screen.onKeyDown(key('ArrowLeft'));
    expect(screen.tab).toBe('evaluations'); // wraps
    expect(CAREER_TABS).toHaveLength(6);
    expect(screen.onKeyDown(key('7'))).toBe(false);
    expect(screen.onKeyDown(key('Escape'))).toBe(true);
    expect(closed).toEqual([1]);
  });

  it('applies for units with the eligibility context and returns to patrol', () => {
    const { screen, requests } = make(viewOf('patrol'));
    screen.open('units');
    screen.applyUnit('k9');
    screen.applyUnit('fto');
    screen.returnToPatrol();
    expect(requests).toEqual([
      { kind: 'applySpecialty', unit: 'k9', ctx: GOOD_CTX },
      { kind: 'applyFto', ctx: GOOD_CTX },
      { kind: 'returnToPatrol' },
    ]);
  });

  it('edits and submits the bid draft', () => {
    const { screen, requests } = make(viewOf('patrol', (s) => { s.bid.prefs = [{ slot: 'day', beat: 'suburbs' }]; }));
    screen.open('schedule');
    expect(screen.bidDraft).toEqual([{ slot: 'day', beat: 'suburbs' }]);
    screen.toggleBid({ slot: 'night', beat: 'highway' });
    screen.toggleBid({ slot: 'day', beat: 'suburbs' });
    expect(screen.bidDraft).toEqual([{ slot: 'night', beat: 'highway' }]);
    screen.submitBid();
    expect(requests).toEqual([{ kind: 'submitBid', prefs: [{ slot: 'night', beat: 'highway' }] }]);
  });

  it('promotion runs the exam when the rank has one and sends the score', () => {
    const view = viewOf('patrol', (s) => { s.rank = 'corporal'; s.seniorityShifts = 5000; });
    const { screen, requests, exams } = make(view);
    screen.open('promotion');
    screen.promote();
    expect(exams).toEqual(['sergeant']);
    expect(requests).toEqual([{ kind: 'promotion', rank: 'sergeant', examScore: 88, ctx: GOOD_CTX }]);
  });

  it('promotion without an exam sends at once; an ineligible officer sends nothing', () => {
    const noExam = make(viewOf('patrol', (s) => { s.seniorityShifts = 5000; }));
    noExam.screen.open('promotion');
    noExam.screen.promote();
    expect(noExam.exams).toEqual([]);
    expect(noExam.requests).toEqual([{ kind: 'promotion', rank: 'corporal', examScore: 100, ctx: GOOD_CTX }]);
    const nope = make(viewOf('patrol'), BAD_CTX);
    nope.screen.open('promotion');
    nope.screen.promote();
    expect(nope.requests).toEqual([]);
  });

  it('keeps a bid draft being edited when the view changes underneath it', () => {
    const t = make(viewOf('patrol'));
    t.screen.open('schedule');
    t.screen.toggleBid({ slot: 'swing', beat: 'industrial' });
    t.setView(viewOf('patrol', (s) => { s.seniorityShifts = 3; }));
    t.screen.refresh();
    expect(t.screen.bidDraft).toEqual([{ slot: 'swing', beat: 'industrial' }]);
  });
});
