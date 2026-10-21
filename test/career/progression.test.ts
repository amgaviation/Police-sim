import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import {
  ACADEMY_MODULES, CAREER_CONFIG, DOR_CATEGORIES, SPECIALTIES, SPECIALTY_IDS, academyPassed, assignmentEffects, dorFromStats, ftoEligibility,
  newTrainee, newWellbeing, probationStep, promotionEligibility, rankIndex, rateTrainee, recordAcademyScore, specialtyEligibility,
  type AcademyModule, type AcademyRecord, type CareerEligibilityInput, type DorReport, type EligibilityContext, type ShiftStats,
} from '../../src/career';
import { emptyShiftStats } from '../../src/career/save';

function academy(best = 100, passed = true): Record<AcademyModule, AcademyRecord> {
  const out = {} as Record<AcademyModule, AcademyRecord>;
  for (const m of ACADEMY_MODULES) out[m] = { best, attempts: 1, passed };
  return out;
}

function input(over: Partial<CareerEligibilityInput> = {}): CareerEligibilityInput {
  return {
    stage: 'patrol', rank: 'officer', assignment: 'patrol', seniorityShifts: 500, academy: academy(),
    wellbeing: { ...newWellbeing(), health: 1, fitness: 1 }, ...over,
  };
}

const CTX: EligibilityContext = { points: 2000, credibility: 80, sustainedIaRecent: 0, avgReport: 95 };

function stats(over: Partial<ShiftStats> = {}): ShiftStats {
  return { ...emptyShiftStats(), ...over };
}

describe('academy', () => {
  it('graduation needs all five modules passed', () => {
    const a = academy(-1, false);
    expect(academyPassed(a)).toBe(false);
    for (const m of ACADEMY_MODULES) {
      a[m] = { best: 100, attempts: 1, passed: true };
      expect(academyPassed(a)).toBe(m === 'legal');
    }
  });

  it('records the best score, the attempts and the pass mark', () => {
    let r: AcademyRecord = { best: -1, attempts: 0, passed: false };
    r = recordAcademyScore(r, 'firearms', 60);
    expect(r).toEqual({ best: 60, attempts: 1, passed: false });
    r = recordAcademyScore(r, 'firearms', 74);
    expect(r).toEqual({ best: 74, attempts: 2, passed: false });
    r = recordAcademyScore(r, 'firearms', 75);
    expect(r).toEqual({ best: 75, attempts: 3, passed: true });
    r = recordAcademyScore(r, 'firearms', 10);
    expect(r).toEqual({ best: 75, attempts: 4, passed: true });
    expect(recordAcademyScore({ best: -1, attempts: 0, passed: false }, 'driving', 70).passed).toBe(true);
    expect(recordAcademyScore({ best: -1, attempts: 0, passed: false }, 'driving', 69).passed).toBe(false);
  });

  it('does not mutate the record it was given', () => {
    const r: AcademyRecord = { best: 10, attempts: 1, passed: false };
    recordAcademyScore(r, 'legal', 90);
    expect(r).toEqual({ best: 10, attempts: 1, passed: false });
  });
});

describe('dorFromStats', () => {
  it('scores a quiet shift', () => {
    const d = dorFromStats(3, stats());
    expect(d.scores).toEqual({ safety: 5, procedure: 5, reports: 3, community: 3, driving: 5 });
    expect(d.average).toBe(4.2);
    expect(d.shiftNo).toBe(3);
    expect(d.notes).toEqual([]);
  });

  it('safety: unjustified force costs 2 each and more than 3 force events cost 1', () => {
    expect(dorFromStats(1, stats({ unjustifiedForce: 1 })).scores.safety).toBe(3);
    expect(dorFromStats(1, stats({ forceEvents: 4 })).scores.safety).toBe(4);
    expect(dorFromStats(1, stats({ forceEvents: 3 })).scores.safety).toBe(5);
    expect(dorFromStats(1, stats({ unjustifiedForce: 2, forceEvents: 5 })).scores.safety).toBe(1);
    expect(dorFromStats(1, stats({ unjustifiedForce: 9 })).scores.safety).toBe(1);
  });

  it('procedure: 1.5 per unlawful determination, rounded to 0.5, clamped at 1', () => {
    expect(dorFromStats(1, stats({ unlawfulDeterminations: 1 })).scores.procedure).toBe(3.5);
    expect(dorFromStats(1, stats({ unlawfulDeterminations: 2 })).scores.procedure).toBe(2);
    expect(dorFromStats(1, stats({ unlawfulDeterminations: 5 })).scores.procedure).toBe(1);
  });

  it('reports: 3 without reports, else 1 + 4 x average / 100', () => {
    expect(dorFromStats(1, stats({ reports: 2, reportSum: 180 })).scores.reports).toBe(4.5);
    expect(dorFromStats(1, stats({ reports: 1, reportSum: 100 })).scores.reports).toBe(5);
    expect(dorFromStats(1, stats({ reports: 1, reportSum: 0 })).scores.reports).toBe(1);
    expect(dorFromStats(1, stats({ reports: 2, reportSum: 130 })).scores.reports).toBe(3.5);
  });

  it('community: 3 plus the trust change in points, clamped to +-2', () => {
    expect(dorFromStats(1, stats({ trustDelta: 0.01 })).scores.community).toBe(4);
    expect(dorFromStats(1, stats({ trustDelta: 0.5 })).scores.community).toBe(5);
    expect(dorFromStats(1, stats({ trustDelta: -0.015 })).scores.community).toBe(1.5);
    expect(dorFromStats(1, stats({ trustDelta: -2 })).scores.community).toBe(1);
  });

  it('driving: 5 plus fleet points / 10, clamped at 1', () => {
    expect(dorFromStats(1, stats({ fleetPoints: -15 })).scores.driving).toBe(3.5);
    expect(dorFromStats(1, stats({ fleetPoints: -100 })).scores.driving).toBe(1);
    expect(dorFromStats(1, stats({ fleetPoints: 20 })).scores.driving).toBe(5);
  });

  it('notes name every category below 3', () => {
    const d = dorFromStats(1, stats({ reports: 1, reportSum: 10, unjustifiedForce: 2, fleetPoints: -30 }));
    expect(d.scores.reports).toBe(1.5);
    expect(d.notes).toEqual(['Officer safety needs work', 'Report writing needs work', 'Driving needs work']);
    expect(DOR_CATEGORIES.every((c) => d.scores[c] >= 1 && d.scores[c] <= 5)).toBe(true);
  });
});

describe('probationStep', () => {
  const dor = (average: number): DorReport => ({ shiftNo: 1, scores: { safety: 3, procedure: 3, reports: 3, community: 3, driving: 3 }, average, notes: [] });

  it('continues while shifts remain', () => {
    expect(probationStep(5, false, [dor(1)])).toEqual({ outcome: 'continue', left: 4, extended: false });
    expect(probationStep(2, true, [dor(1)])).toEqual({ outcome: 'continue', left: 1, extended: true });
  });

  it('passes at the end with an average of at least 3.0', () => {
    expect(probationStep(1, false, [dor(3), dor(3), dor(3)])).toEqual({ outcome: 'passed', left: 0, extended: false });
    expect(probationStep(1, false, [dor(4), dor(2.5), dor(3.5)]).outcome).toBe('passed');
  });

  it('extends once, then separates', () => {
    const bad = [dor(2), dor(2.5)];
    expect(probationStep(1, false, bad)).toEqual({ outcome: 'extended', left: 3, extended: true });
    expect(probationStep(1, true, bad)).toEqual({ outcome: 'separated', left: 0, extended: true });
  });

  it('an extension can still be passed', () => {
    expect(probationStep(1, true, [dor(2), dor(4.5), dor(4.5)]).outcome).toBe('passed');
  });

  it('separates without any report', () => {
    expect(probationStep(1, true, []).outcome).toBe('separated');
  });
});

describe('rankIndex', () => {
  it('orders the ranks', () => {
    expect(['officer', 'corporal', 'sergeant', 'lieutenant', 'captain'].map((r) => rankIndex(r as 'officer'))).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('specialtyEligibility', () => {
  it('every unit accepts a fully qualified patrol officer', () => {
    for (const unit of SPECIALTY_IDS) {
      expect(specialtyEligibility(unit, input(), CTX), unit).toEqual({ ok: true, reasons: [] });
    }
  });

  it('refuses a probationer and an officer already in the unit', () => {
    expect(specialtyEligibility('traffic', input({ stage: 'probation' }), CTX).reasons[0]).toContain('probation');
    const same = specialtyEligibility('k9', input({ assignment: 'k9' }), CTX);
    expect(same.ok).toBe(false);
    expect(same.reasons).toEqual(['Already assigned to K9 Unit']);
    expect(specialtyEligibility('k9', input({ assignment: 'traffic' }), CTX).ok).toBe(true);
  });

  it('traffic: seniority, driving score, health', () => {
    expect(specialtyEligibility('traffic', input({ seniorityShifts: 12 }), CTX).ok).toBe(true);
    expect(specialtyEligibility('traffic', input({ seniorityShifts: 9 }), CTX).reasons).toEqual(['Needs 10 shifts of seniority (have 9)']);
    const a = academy();
    a.driving = { best: 79, attempts: 2, passed: true };
    expect(specialtyEligibility('traffic', input({ academy: a }), CTX).reasons).toEqual(['Driving score 80 required (best 79)']);
    expect(specialtyEligibility('traffic', input({ wellbeing: { ...newWellbeing(), health: 0.5 } }), CTX).reasons).toEqual([
      'Health 60% required (have 50%)',
    ]);
  });

  it('k9: defensive score, points and fitness', () => {
    const a = academy();
    a.defensive = { best: 70, attempts: 1, passed: true };
    expect(specialtyEligibility('k9', input({ academy: a }), CTX).reasons).toEqual(['Defensive tactics score 75 required (best 70)']);
    expect(specialtyEligibility('k9', input(), { ...CTX, points: 40 }).reasons).toEqual(['Career points 50 required (have 40)']);
    expect(specialtyEligibility('k9', input({ wellbeing: { ...newWellbeing(), fitness: 0.4 } }), CTX).reasons).toEqual([
      'Fitness 50% required (have 40%)',
    ]);
  });

  it('detective: report and legal scores, points', () => {
    const a = academy();
    a.report = { best: 84, attempts: 1, passed: true };
    a.legal = { best: -1, attempts: 0, passed: true };
    expect(specialtyEligibility('detective', input({ academy: a }), CTX).reasons).toEqual([
      'Report writing score 85 required (best 84)', 'Legal score 80 required (best none)',
    ]);
    expect(specialtyEligibility('detective', input(), { ...CTX, points: 99 }).reasons).toEqual(['Career points 100 required (have 99)']);
  });

  it('swat: firearms, defensive, fitness, health', () => {
    const a = academy();
    a.firearms = { best: 84, attempts: 1, passed: true };
    expect(specialtyEligibility('swat', input({ academy: a }), CTX).reasons).toEqual(['Firearms score 85 required (best 84)']);
    expect(specialtyEligibility('swat', input({ wellbeing: { ...newWellbeing(), health: 1, fitness: 0.6 } }), CTX).reasons).toEqual([
      'Fitness 70% required (have 60%)',
    ]);
    expect(specialtyEligibility('swat', input({ wellbeing: { ...newWellbeing(), health: 0.7, fitness: 1 } }), CTX).reasons).toEqual([
      'Health 80% required (have 70%)',
    ]);
  });

  it('narcotics: legal score, sustained IA', () => {
    const a = academy();
    a.legal = { best: 79, attempts: 1, passed: true };
    expect(specialtyEligibility('narcotics', input({ academy: a }), CTX).reasons).toEqual(['Legal score 80 required (best 79)']);
    expect(specialtyEligibility('narcotics', input(), { ...CTX, sustainedIaRecent: 1 }).reasons).toEqual(['No sustained IA findings allowed']);
    expect(specialtyEligibility('narcotics', input({ seniorityShifts: 24 }), CTX).reasons).toEqual(['Needs 25 shifts of seniority (have 24)']);
  });

  it('air: driving 85 and the highest seniority', () => {
    const a = academy();
    a.driving = { best: 84, attempts: 1, passed: true };
    expect(specialtyEligibility('air', input({ academy: a }), CTX).reasons).toEqual(['Driving score 85 required (best 84)']);
    expect(specialtyEligibility('air', input({ seniorityShifts: 12 }), CTX).reasons).toEqual(['Needs 40 shifts of seniority (have 12)']);
  });

  it('lists every unmet requirement at once', () => {
    const r = specialtyEligibility('swat', input({ seniorityShifts: 0, academy: academy(0, false) }), { ...CTX, points: 0, sustainedIaRecent: 2 });
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBe(5);
    expect(r.reasons[0]).toBe('Needs 30 shifts of seniority (have 0)');
    expect(r.reasons).toContain('No sustained IA findings allowed');
    expect(r.reasons).toContain('Firearms score 85 required (best 0)');
  });

  it('accepts a custom specialty table', () => {
    const defs = { ...SPECIALTIES, air: { ...SPECIALTIES.air, minSeniorityShifts: 1000 } };
    expect(specialtyEligibility('air', input(), CTX, defs).reasons).toEqual(['Needs 1000 shifts of seniority (have 500)']);
  });
});

describe('ftoEligibility', () => {
  it('accepts a qualified patrol officer', () => {
    expect(ftoEligibility(input(), CTX)).toEqual({ ok: true, reasons: [] });
  });

  it('reports each unmet requirement', () => {
    expect(ftoEligibility(input({ seniorityShifts: 39 }), CTX).reasons).toEqual(['Needs 40 shifts of seniority (have 39)']);
    expect(ftoEligibility(input(), { ...CTX, avgReport: 64.4 }).reasons).toEqual(['Average report grade 70 required (have 64)']);
    expect(ftoEligibility(input(), { ...CTX, points: 49 }).reasons).toEqual(['Career points 50 required (have 49)']);
    expect(ftoEligibility(input({ assignment: 'fto' }), CTX).ok).toBe(false);
    expect(ftoEligibility(input({ stage: 'probation' }), CTX).ok).toBe(false);
  });
});

describe('promotionEligibility', () => {
  it('officer to corporal needs no exam', () => {
    const r = promotionEligibility('corporal', input({ seniorityShifts: 40 }), { ...CTX, points: 100 });
    expect(r).toEqual({ ok: true, reasons: [], exam: 0 });
  });

  it('reports the exam mark of the next rank', () => {
    expect(promotionEligibility('sergeant', input({ rank: 'corporal', seniorityShifts: 80 }), { ...CTX, points: 250 })).toEqual({
      ok: true, reasons: [], exam: 75,
    });
    expect(promotionEligibility('lieutenant', input({ rank: 'sergeant' }), CTX).exam).toBe(80);
    expect(promotionEligibility('captain', input({ rank: 'lieutenant' }), CTX).exam).toBe(85);
  });

  it('allows only the next rank', () => {
    const skip = promotionEligibility('sergeant', input(), CTX);
    expect(skip.ok).toBe(false);
    expect(skip.reasons).toEqual(['Only the next rank (corporal) is available']);
    expect(promotionEligibility('officer', input({ rank: 'corporal' }), CTX).ok).toBe(false);
    const top = promotionEligibility('captain', input({ rank: 'captain' }), CTX);
    expect(top).toEqual({ ok: false, reasons: ['Already at the highest rank'], exam: 0 });
  });

  it('lists seniority, points and sustained IA reasons with numbers', () => {
    const r = promotionEligibility('corporal', input({ seniorityShifts: 12 }), { ...CTX, points: 40, sustainedIaRecent: 1 });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual([
      'Needs 40 shifts of seniority (have 12)', 'Career points 100 required (have 40)', 'No sustained IA findings allowed',
    ]);
  });

  it('needs the patrol stage', () => {
    expect(promotionEligibility('corporal', input({ stage: 'probation' }), CTX).ok).toBe(false);
  });
});

describe('FTO trainee', () => {
  const truth = { safety: 3, procedure: 3, reports: 3, community: 3, driving: 3 };

  it('rates accuracy against the hidden truth', () => {
    const t = { name: 'T', truth };
    expect(rateTrainee(truth, t)).toEqual({ accuracy: 1, points: 10 });
    expect(rateTrainee({ safety: 4, procedure: 2, reports: 4, community: 2, driving: 4 }, t)).toEqual({ accuracy: 0.75, points: 8 });
    expect(rateTrainee({ safety: 1, procedure: 1, reports: 1, community: 1, driving: 1 }, t).accuracy).toBe(0.5);
    const far = rateTrainee({ safety: 5, procedure: 5, reports: 5, community: 5, driving: 5 }, { name: 'T', truth: { ...truth, safety: 1, procedure: 1, reports: 1, community: 1, driving: 1 } });
    expect(far).toEqual({ accuracy: 0, points: 0 });
    expect(CAREER_CONFIG.fto.pointsPerAccuracy).toBe(10);
  });

  it('newTrainee draws 1..5 per category deterministically', () => {
    const a = newTrainee(createRng(5), ['Pat', 'Sam']);
    const b = newTrainee(createRng(5), ['Pat', 'Sam']);
    expect(a).toEqual(b);
    expect(['Pat', 'Sam']).toContain(a.name);
    for (const c of DOR_CATEGORIES) {
      expect(a.truth[c]).toBeGreaterThanOrEqual(1);
      expect(a.truth[c]).toBeLessThanOrEqual(5);
      expect(Number.isInteger(a.truth[c])).toBe(true);
    }
    expect(newTrainee(createRng(5), []).name).toBe('Recruit');
    const seen = new Set<string>();
    for (let s = 0; s < 20; s++) seen.add(JSON.stringify(newTrainee(createRng(s), ['x']).truth));
    expect(seen.size).toBeGreaterThan(5);
  });
});

describe('assignmentEffects', () => {
  it('uses the specialty row, or the patrol and fto defaults', () => {
    expect(assignmentEffects('patrol')).toEqual({ callWeights: {}, fleetClass: 'patrol', uniformClass: 'classB', payPerHour: 0 });
    expect(assignmentEffects('fto')).toEqual({ callWeights: {}, fleetClass: 'patrol', uniformClass: 'classB', payPerHour: 3 });
    expect(assignmentEffects('traffic')).toEqual({ callWeights: { traffic: 3, dui: 2 }, fleetClass: 'traffic', uniformClass: 'classB', payPerHour: 2 });
    expect(assignmentEffects('swat').uniformClass).toBe('swat');
    expect(assignmentEffects('detective').payPerHour).toBe(4);
  });
});
