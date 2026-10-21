import { describe, expect, it } from 'vitest';
import { CAREER_CONFIG, type CareerView, type OffDutyActivity } from '../../src/career';
import { ApartmentScreen, activityHint, apartmentModel, clampActivityHours, type ApartmentHost } from '../../src/ui/career/apartment';
import { offDutyHarness, viewOf } from './helpers';

describe('apartmentModel', () => {
  it('shows the hours left, the next shift, the bars and enabled activities when off duty', () => {
    const h = offDutyHarness();
    const v = h.career.view;
    const m = apartmentModel(v);
    expect(m.hoursLeft).toBeCloseTo(v.offDuty?.hoursLeft ?? -1, 9);
    expect(m.hoursLeft).toBeGreaterThan(8);
    expect(m.nextShift).toMatch(/^\d\d\/\d\d\/\d{4} 22:00 - 06:00$/);
    expect(m.bars.map((b) => b.key)).toEqual(['fatigue', 'stress', 'health', 'fitness', 'family']);
    expect(m.activities.map((a) => a.id)).toEqual(['rest', 'exercise', 'family', 'secondJob']);
    expect(m.activities.every((a) => a.enabled && a.maxHours > 0)).toBe(true);
    expect(m.activities.find((a) => a.id === 'rest')?.maxHours).toBeCloseTo(Math.min(m.hoursLeft, CAREER_CONFIG.wellbeing.activities.rest.maxPerDay), 9);
    expect(m.canReport).toBe(true);
    expect(m.warnings).toEqual([]);
  });

  it('disables everything while on duty and when separated', () => {
    const onDuty = apartmentModel(viewOf('patrol'));
    expect(onDuty.hoursLeft).toBe(0);
    expect(onDuty.activities.every((a) => !a.enabled && a.maxHours === 0)).toBe(true);
    expect(onDuty.canReport).toBe(false);
    expect(onDuty.nextShift).toBe('');
    expect(apartmentModel(viewOf('separated')).canReport).toBe(false);
  });

  it('limits each activity by the daily maximum minus what is already planned', () => {
    const h = offDutyHarness();
    const before = apartmentModel(h.career.view).activities.find((a) => a.id === 'secondJob');
    const max = CAREER_CONFIG.wellbeing.activities.secondJob.maxPerDay;
    expect(before?.maxHours).toBeCloseTo(Math.min(h.career.view.offDuty?.hoursLeft ?? 0, max), 9);
    expect(h.career.planActivity('secondJob', max).ok).toBe(true);
    const after = apartmentModel(h.career.view);
    expect(after.activities.find((a) => a.id === 'secondJob')).toMatchObject({ maxHours: 0, enabled: false });
    expect(after.plan).toEqual([{ activity: 'secondJob', label: 'Second job', hours: max }]);
    expect(after.activities.find((a) => a.id === 'rest')?.enabled).toBe(true);
    // Using up all the hours disables all activities.
    h.career.planActivity('rest', h.career.view.offDuty?.hoursLeft ?? 0);
    expect(apartmentModel(h.career.view).activities.every((a) => !a.enabled)).toBe(true);
  });

  it('warns about sleep debt, money, critical stress and unfitness', () => {
    const h = offDutyHarness((s) => {
      s.wellbeing.sleepDebtH = 6.4;
      s.money = -9000;
      s.wellbeing.stress = 0.9;
    });
    const w = apartmentModel(h.career.view).warnings;
    expect(w).toContain('Sleep debt 6h');
    expect(w).toContain('Money below zero');
    expect(w).toContain('Critical stress');
    expect(w.some((x) => x.startsWith('Not fit for duty'))).toBe(false);
    const unfit = offDutyHarness((s) => { s.wellbeing.stress = 0.97; });
    expect(apartmentModel(unfit.career.view).warnings[0]).toBe('Not fit for duty: Critical stress: mandatory leave');
    const hurt = offDutyHarness((s) => { s.wellbeing.health = 0.2; });
    expect(apartmentModel(hurt.career.view).warnings[0]).toContain('Not fit for duty: Injured');
  });

  it('counts the neglected days when the host gives them, else falls back to the wellbeing values', () => {
    const h = offDutyHarness();
    const v = h.career.view;
    expect(apartmentModel(v, { daysWithoutFamily: 3, daysWithoutExercise: 0 }).warnings).toEqual(['Family time neglected for 3 days']);
    expect(apartmentModel(v, { daysWithoutFamily: 1, daysWithoutExercise: 0 }).warnings).toEqual(['Family time neglected for 1 day']);
    const grace = CAREER_CONFIG.wellbeing.neglect.exerciseGraceDays;
    expect(apartmentModel(v, { daysWithoutFamily: 0, daysWithoutExercise: grace }).warnings).toEqual([]);
    expect(apartmentModel(v, { daysWithoutFamily: 0, daysWithoutExercise: grace + 1 }).warnings).toEqual(['Fitness falling']);
    const lonely = offDutyHarness((s) => { s.wellbeing.family = 0.1; s.wellbeing.fitness = 0.2; });
    expect(apartmentModel(lonely.career.view).warnings).toEqual(['Family time neglected', 'Fitness falling']);
  });

  it('describes the per-hour effects of an activity', () => {
    expect(activityHint(CAREER_CONFIG.wellbeing.activities.rest)).toMatch(/^Per hour: .*sleep.* · up to \d+ h$/);
    expect(activityHint({ fatigue: 0, stress: 0, fitness: 0, family: 0, money: 0, sleep: 0, maxPerDay: 2 })).toBe('Per hour: no effect · up to 2 h');
    expect(activityHint({ fatigue: 0.1, stress: -0.05, fitness: 0, family: 0.2, money: 24, sleep: 0, maxPerDay: 4 })).toBe('Per hour: +10 % fatigue, -5 % stress, +20 % family, $ 24 · up to 4 h');
  });

  it('clamps stepper hours', () => {
    expect(clampActivityHours(3, 6.5)).toBe(3);
    expect(clampActivityHours(9, 6.5)).toBe(6);
    expect(clampActivityHours(0, 6.5)).toBe(1);
    expect(clampActivityHours(2, 0.5)).toBe(0.5);
    expect(clampActivityHours(2, 0)).toBe(0);
    expect(clampActivityHours(Number.NaN, 4)).toBe(1);
  });
});

describe('ApartmentScreen (headless)', () => {
  function make(): { screen: ApartmentScreen; calls: string[]; setReport: (r: void | { ok: boolean; reason: string }) => void; harness: ReturnType<typeof offDutyHarness> } {
    const harness = offDutyHarness();
    const calls: string[] = [];
    let report: void | { ok: boolean; reason: string };
    const host: ApartmentHost = {
      view: (): CareerView => harness.career.view,
      plan: (a: OffDutyActivity, hours: number) => {
        calls.push(`plan ${a} ${String(hours)}`);
        return harness.career.planActivity(a, hours);
      },
      courtLines: () => ['Tue 09:00 Case C-1'],
      reportForDuty: () => {
        calls.push('report');
        return report;
      },
      openCareer: () => { calls.push('career'); },
    };
    return { screen: new ApartmentScreen(null, host), calls, setReport: (r) => { report = r; }, harness };
  }

  it('steps and plans whole hours through the host and shows the result', () => {
    const { screen, calls, harness } = make();
    screen.open();
    screen.step('exercise', 1);
    screen.step('exercise', 1);
    expect(screen.stepperHours('exercise')).toBe(3);
    expect(screen.go('exercise').ok).toBe(true);
    expect(calls).toEqual(['plan exercise 3']);
    expect(harness.career.view.offDuty?.plan).toEqual([{ activity: 'exercise', hours: 3 }]);
    screen.step('rest', 1);
    screen.step('rest', -9);
    expect(screen.stepperHours('rest')).toBe(1);
  });

  it('does not plan an activity with no hours left', () => {
    const { screen, calls, harness } = make();
    screen.open();
    expect(harness.career.planActivity('exercise', CAREER_CONFIG.wellbeing.activities.exercise.maxPerDay).ok).toBe(true);
    const r = screen.go('exercise');
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('Report for duty goes to the host; a refusal stays on screen and Escape is not consumed', () => {
    const { screen, calls, setReport } = make();
    screen.open();
    screen.reportForDuty();
    setReport({ ok: false, reason: 'Critical stress: mandatory leave' });
    screen.reportForDuty();
    expect(calls).toEqual(['report', 'report']);
    expect(screen.isOpen).toBe(true);
    expect(screen.onKeyDown()).toBe(false);
    expect(screen.model.canReport).toBe(true);
  });

  it('update() is a no-op without a DOM', () => {
    const { screen } = make();
    screen.open();
    expect(() => { screen.update(1000); }).not.toThrow();
  });
});
