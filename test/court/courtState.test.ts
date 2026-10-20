import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import {
  COURT_CONFIG, CourtState, convictionChance, evidenceStrength, generateCrossExam, scoreTestimony, type Answer, type CourtRequest,
} from '../../src/court';
import { getRuleset } from '../../src/legal';
import {
  HOUR, LogBuilder, SEED, arrestOnlyFixture, fixtureOf, harness, richFixture, scriptedRng, sourceOf, suppressedFixture, time, unlawfulArrestFixture, withReport,
  type Fixture, type Harness, type ScriptedRng,
} from './helpers';

const DUI = ['TR-360'];
const DRUGS = ['PC-260'];

interface Rig { court: CourtState; h: Harness; rng: ScriptedRng }

function rig(fixtures: Fixture[], script: number[] = [], grade: number | null = null): Rig {
  const rng = scriptedRng(...script);
  const h = harness(sourceOf(...fixtures), rng, grade);
  return { court: new CourtState(h.deps), h, rng };
}

function open(callId: number, statutes: string[], docKind: 'booking' | 'citation' = 'booking', docId = 'DOC-1', personId = 1): CourtRequest {
  return { kind: 'open', docId, docKind, personId, personLabel: 'Sam Rivera', callId, statutes };
}

function step(r: Rig, game: number): void {
  r.court.step(1 / 60, time(game));
}

const DAY_TEN = 10 * HOUR;
/** Opens a scheduled booking at 10:00 (u1 = 0.99 never pleads, u2 = 0.5 gives a 14:00 hearing). */
function scheduled(fixtures: Fixture[], statutes = DUI, callId = 7, extra: number[] = [], grade: number | null = null): Rig {
  const r = rig(fixtures, [0.99, 0.5, ...extra], grade);
  r.court.request(open(callId, statutes));
  step(r, DAY_TEN);
  return r;
}

const HEARING = 14 * HOUR;

/** Like `scheduled`, but the incident's assessment only becomes known after the case was opened (`reveal`). */
function late(fixtures: Fixture[], statutes = DUI): Rig & { reveal: () => void } {
  const src = sourceOf(...fixtures);
  let live = false;
  const rng = scriptedRng(0.99, 0.5);
  const h = harness({ ...src, assessment: (k: string) => (live ? src.assessment(k) : null) }, rng, null);
  const court = new CourtState(h.deps);
  court.request(open(7, statutes));
  step({ court, h, rng }, DAY_TEN);
  return { court, h, rng, reveal: () => { live = true; } };
}

describe('CourtState: opening cases', () => {
  it('queues requests until the next step', () => {
    const r = rig([richFixture()], [0.99, 0.5]);
    r.court.request(open(7, DUI));
    expect(r.court.cases()).toHaveLength(0);
    expect(r.court.revision).toBe(0);
    step(r, DAY_TEN);
    expect(r.court.cases()).toHaveLength(1);
    expect(r.court.revision).toBeGreaterThan(0);
  });

  it('a citation that is not contested is paid and closed with no hearing', () => {
    const r = rig([], [0.9, 0.5]);
    r.court.request(open(0, ['TR-300'], 'citation'));
    step(r, DAY_TEN);
    const c = r.court.cases()[0];
    expect(c).toMatchObject({ id: 'CR-0001', docKind: 'citation', status: 'closed', verdict: 'paid', hearingGame: -1, reason: 'paid', createdGame: DAY_TEN });
    expect(r.rng.draws).toBe(2);
    expect(r.h.of('court:subpoena')).toHaveLength(0);
    expect(r.h.of('court:verdict')).toEqual([
      { caseId: 'CR-0001', key: '', verdict: 'paid', reason: 'paid', credibilityDelta: 0, impeached: false, missed: false },
    ]);
  });

  it('a contested citation is scheduled and subpoenaed', () => {
    const r = rig([], [0.1, 0.5]);
    r.court.request(open(0, ['TR-300'], 'citation'));
    step(r, DAY_TEN);
    const c = r.court.cases()[0];
    expect(c?.status).toBe('scheduled');
    expect(c?.verdict).toBeNull();
    expect(c?.hearingGame).toBe(HEARING);
    expect(r.h.of('court:subpoena')).toHaveLength(1);
    expect(r.rng.draws).toBe(2);
  });

  it('a booking pleads out when the first draw is under base + bonus * strength', () => {
    // Strong case: dui strength 1 -> plea chance 0.6.
    const strong = rig([richFixture()], [0.55, 0.5]);
    strong.court.request(open(7, DUI));
    step(strong, DAY_TEN);
    expect(strong.court.cases()[0]).toMatchObject({ status: 'pleaded', verdict: 'convicted', reason: 'plea', hearingGame: -1 });
    expect(strong.rng.draws).toBe(2);
    expect(strong.h.of('court:subpoena')).toHaveLength(0);
    expect(strong.h.of('court:verdict')).toHaveLength(1);

    const notStrong = rig([richFixture()], [0.65, 0.5]);
    notStrong.court.request(open(7, DUI));
    step(notStrong, DAY_TEN);
    expect(notStrong.court.cases()[0]?.status).toBe('scheduled');
  });

  it('the plea chance rises with the strength of the evidence', () => {
    // A lawful stop on weaving and alcohol odor, no arrest: dui strength 0.5 -> plea chance 0.45 (a strong case pleads at 0.6).
    const b = new LogBuilder('C-00007', 'trafficStop');
    b.at(0).start().person(1, 'driver', 'Sam Rivera');
    b.at(5).indicator(1, 'weaving').indicator(1, 'odorAlcohol');
    b.at(10).detain(1);
    const mid = fixtureOf(b.build());
    const w = rig([mid], [0.5, 0.5]);
    w.court.request(open(7, DUI));
    step(w, DAY_TEN);
    expect(w.court.cases()[0]?.status).toBe('scheduled');
    const lo = rig([mid], [0.44, 0.5]);
    lo.court.request(open(7, DUI));
    step(lo, DAY_TEN);
    expect(lo.court.cases()[0]?.status).toBe('pleaded');
  });

  it('a bad arrest or all-suppressed evidence is dismissed at booking, whatever the plea roll', () => {
    for (const [fixture, statutes, reason] of [
      [unlawfulArrestFixture(), DUI, 'unlawfulArrest'], [suppressedFixture(), DRUGS, 'suppression'],
    ] as const) {
      const key = 'C-00007';
      const f = { ...fixture, log: { ...fixture.log, key }, assessment: { ...fixture.assessment, key } };
      for (const u1 of [0.01, 0.99]) {
        const r = rig([f], [u1, 0.5]);
        r.court.request(open(7, statutes));
        step(r, DAY_TEN);
        expect(r.court.cases()[0], reason).toMatchObject({ status: 'closed', verdict: 'dismissed', reason, hearingGame: -1 });
        expect(r.rng.draws).toBe(2);
        expect(r.h.of('court:subpoena')).toHaveLength(0);
        expect(r.h.of('court:verdict')).toHaveLength(1);
      }
    }
  });

  it('a citation after an unlawful stop with all evidence suppressed is dismissed, not paid', () => {
    const f = suppressedFixture();
    const bad = { ...f, log: { ...f.log, key: 'C-00007' }, assessment: { ...f.assessment, key: 'C-00007' } };
    for (const u1 of [0.01, 0.99]) {
      const r = rig([bad], [u1, 0.5]);
      r.court.request(open(7, DRUGS, 'citation'));
      step(r, DAY_TEN);
      expect(r.court.cases()[0]).toMatchObject({ status: 'closed', verdict: 'dismissed', reason: 'suppression' });
    }
  });

  it('a booking that does not plead is scheduled with a subpoena event', () => {
    const r = scheduled([richFixture()]);
    const c = r.court.cases()[0];
    expect(c).toMatchObject({
      id: 'CR-0001', docId: 'DOC-1', docKind: 'booking', personId: 1, personLabel: 'Sam Rivera', key: 'C-00007', callId: 7,
      statutes: DUI, offenses: ['dui'], createdGame: DAY_TEN, hearingGame: HEARING, status: 'scheduled', verdict: null, reminded: false,
    });
    expect(r.rng.draws).toBe(2);
    const sub = r.h.of('court:subpoena');
    expect(sub).toEqual([{ caseId: 'CR-0001', hearingGame: HEARING, label: expect.stringContaining('Sam Rivera') as string }]);
    expect(r.h.of('court:flash').length).toBeGreaterThan(0);
  });

  it('always consumes exactly two draws per case opened', () => {
    for (const [u1, u2, kind] of [[0.99, 0.1, 'booking'], [0.01, 0.9, 'booking'], [0.99, 0.9, 'citation'], [0.01, 0.9, 'citation']] as const) {
      const r = rig([richFixture()], [u1, u2]);
      r.court.request(open(7, DUI, kind));
      step(r, DAY_TEN);
      expect(r.rng.draws).toBe(2);
    }
  });

  it('numbers cases, lists newest first and ignores a repeated document', () => {
    const r = rig([richFixture()], [0.99, 0.5, 0.99, 0.5]);
    r.court.request(open(7, DUI, 'booking', 'DOC-1'));
    r.court.request(open(7, DUI, 'booking', 'DOC-2'));
    r.court.request(open(7, DUI, 'booking', 'DOC-2'));
    step(r, DAY_TEN);
    expect(r.court.cases().map((c) => c.id)).toEqual(['CR-0002', 'CR-0001']);
    expect(r.court.case('CR-0001')?.docId).toBe('DOC-1');
    expect(r.court.case('CR-9999')).toBeNull();
    expect(r.rng.draws).toBe(4);
  });

  it('uses the incident whose log has the document when the port can find it', () => {
    const f = richFixture();
    const source = { ...sourceOf(f), keyOfDoc: (doc: string) => (doc === 'DOC-F' ? 'C-00007' : null) };
    const rng = scriptedRng(0.99, 0.5);
    const h = harness(source, rng);
    const court = new CourtState(h.deps);
    court.request(open(0, DUI, 'booking', 'DOC-F'));
    court.step(1 / 60, time(DAY_TEN));
    expect(court.cases()[0]?.key).toBe('C-00007');
  });

  it('falls back to the key the officer was working when there is no call and no document link', () => {
    const rng = scriptedRng(0.99, 0.5);
    const h = harness(sourceOf(richFixture()), rng);
    const court = new CourtState(h.deps);
    court.request({ ...(open(0, DUI, 'booking', 'DOC-G') as Extract<CourtRequest, { kind: 'open' }>), key: 'FC-5-1' });
    court.step(1 / 60, time(DAY_TEN));
    expect(court.cases()[0]?.key).toBe('FC-5-1');
  });

  it('opens a case whose incident is unknown and later hears it without questions', () => {
    const r = rig([], [0.99, 0.5]);
    r.court.request(open(99, DUI));
    step(r, DAY_TEN);
    expect(r.court.cases()[0]).toMatchObject({ key: 'C-00099', status: 'scheduled', offenses: ['dui'] });
    r.court.request({ kind: 'attend', caseId: 'CR-0001' });
    step(r, HEARING);
    expect(r.court.cases()[0]).toMatchObject({ status: 'inSession', questions: [], motions: [] });
    r.court.request({ kind: 'testify', caseId: 'CR-0001', answers: [] });
    r.rng.script.push(0.0);
    step(r, HEARING + 60);
    expect(r.court.cases()[0]?.verdict).toBe('convicted');
  });

  it('unmapped statutes leave the offenses empty', () => {
    const r = rig([], [0.99, 0.5]);
    r.court.request(open(0, ['XX-000']));
    step(r, DAY_TEN);
    expect(r.court.cases()[0]?.offenses).toEqual([]);
  });

  it('keeps at most 60 cases, dropping the oldest finished ones', () => {
    const r = rig([], []);
    r.rng.script.push(0.99, 0.5); // the first stays scheduled
    r.court.request(open(0, DUI, 'booking', 'DOC-keep'));
    for (let i = 0; i < 70; i++) {
      r.rng.script.push(0.9, 0.5);
      r.court.request(open(0, ['TR-300'], 'citation', `DOC-c${i}`));
    }
    step(r, DAY_TEN);
    const cases = r.court.cases();
    expect(cases).toHaveLength(60);
    expect(cases.some((c) => c.docId === 'DOC-keep')).toBe(true); // active cases survive
    expect(cases[0]?.docId).toBe('DOC-c69');
    expect(cases.filter((c) => c.status === 'closed')).toHaveLength(59);
  });
});

describe('CourtState: reminders and the attendance window', () => {
  it('reminds once, reminderMin before the hearing', () => {
    const r = scheduled([richFixture()]);
    step(r, 12 * HOUR + 59 * 60);
    expect(r.h.of('court:reminder')).toHaveLength(0);
    step(r, 13 * HOUR);
    expect(r.h.of('court:reminder')).toEqual([{ caseId: 'CR-0001', hearingGame: HEARING }]);
    expect(r.court.cases()[0]?.reminded).toBe(true);
    step(r, 13 * HOUR + 60);
    step(r, 13 * HOUR + 1800);
    expect(r.h.of('court:reminder')).toHaveLength(1);
  });

  it('checks once per game minute', () => {
    const r = scheduled([richFixture()]);
    const before = r.court.revision;
    step(r, 13 * HOUR - 1);
    step(r, 13 * HOUR - 1);
    expect(r.h.of('court:reminder')).toHaveLength(0);
    step(r, 13 * HOUR);
    step(r, 13 * HOUR + 30);
    expect(r.h.of('court:reminder')).toHaveLength(1);
    expect(r.court.revision).toBeGreaterThan(before);
  });

  it('a jump over the reminder time still reminds once', () => {
    const r = scheduled([richFixture()]);
    step(r, 14 * HOUR + 600);
    expect(r.h.of('court:reminder')).toHaveLength(1);
    step(r, 14 * HOUR + 1200);
    expect(r.h.of('court:reminder')).toHaveLength(1);
  });

  it('can attend from windowBefore before to windowAfter after the hearing', () => {
    const r = scheduled([richFixture()]);
    const id = 'CR-0001';
    expect(r.court.canAttend(id, HEARING - 31 * 60)).toBe(false);
    expect(r.court.canAttend(id, HEARING - 30 * 60)).toBe(true);
    expect(r.court.canAttend(id, HEARING)).toBe(true);
    expect(r.court.canAttend(id, HEARING + 120 * 60)).toBe(true);
    expect(r.court.canAttend(id, HEARING + 120 * 60 + 1)).toBe(false);
    expect(r.court.canAttend('CR-0042', HEARING)).toBe(false);
  });

  it('attending outside the window does nothing but flash', () => {
    const r = scheduled([richFixture()]);
    const flashes = r.h.of('court:flash').length;
    r.court.request({ kind: 'attend', caseId: 'CR-0001' });
    step(r, HEARING - 2 * HOUR);
    expect(r.court.cases()[0]?.status).toBe('scheduled');
    expect(r.h.of('court:session')).toHaveLength(0);
    expect(r.h.of('court:flash').length).toBe(flashes + 1);
    r.court.request({ kind: 'attend', caseId: 'CR-0404' });
    step(r, HEARING - HOUR);
    expect(r.h.of('court:session')).toHaveLength(0);
  });

  it('next() is the soonest scheduled hearing that is not past its window', () => {
    const r = rig([richFixture()], [0.99, 0.1, 0.99, 0.9, 0.9, 0.5]);
    r.court.request(open(7, DUI, 'booking', 'A')); // u2 0.1 -> 10:00 + 2.4 h -> 13:00
    r.court.request(open(7, DUI, 'booking', 'B')); // u2 0.9 -> 10:00 + 5.6 h -> 16:00
    r.court.request(open(0, ['TR-300'], 'citation', 'C')); // paid
    step(r, DAY_TEN);
    expect(r.court.next(DAY_TEN)?.docId).toBe('A');
    expect(r.court.next(13 * HOUR + 1800)?.docId).toBe('A');
    expect(r.court.next(15 * HOUR + 1)?.docId).toBe('B'); // A's window (13:00 + 2 h) is over
    expect(r.court.next(24 * HOUR)).toBeNull();
  });

  it('advance moves the hearing to now', () => {
    const r = scheduled([richFixture()]);
    expect(r.court.canAttend('CR-0001', DAY_TEN)).toBe(false);
    r.court.request({ kind: 'advance', caseId: 'CR-0001' });
    step(r, DAY_TEN + 120);
    const c = r.court.cases()[0];
    expect(c?.hearingGame).toBe(DAY_TEN + 120);
    expect(c?.reminded).toBe(true);
    expect(r.court.canAttend('CR-0001', DAY_TEN + 120)).toBe(true);
    step(r, DAY_TEN + 600);
    expect(r.h.of('court:reminder')).toHaveLength(0);
    // Advancing a case that has no hearing changes nothing.
    r.court.request({ kind: 'advance', caseId: 'CR-0404' });
    step(r, DAY_TEN + 720);
  });
});

describe('CourtState: attending and testifying', () => {
  function attended(fixtures: Fixture[], statutes = DUI, extra: number[] = [], grade: number | null = null): Rig {
    const r = scheduled(fixtures, statutes, 7, extra, grade);
    r.court.request({ kind: 'attend', caseId: 'CR-0001' });
    step(r, HEARING);
    return r;
  }

  it('attending generates the questions from the report and the log, emits the session', () => {
    const f = withReport(richFixture(), [`res:${richFixture().ids.taser}:assaultive`]);
    const r = attended([f]);
    const c = r.court.cases()[0];
    expect(c?.status).toBe('inSession');
    expect(r.h.of('court:session')).toEqual([{ caseId: 'CR-0001' }]);
    const expected = generateCrossExam(
      { caseId: 'CR-0001', personId: 1, log: f.log, assessment: f.assessment, choices: f.choices, assertions: f.log.reports[0]?.assertions ?? null },
      createRng(SEED).stream('court:CR-0001'),
      COURT_CONFIG,
    );
    expect(c?.questions).toEqual(expected);
    expect(c?.questions.some((q) => q.kind === 'resistanceAt' && q.truth === 'no' && q.reportSays === 'yes')).toBe(true);
    expect(c?.motions.length).toBeGreaterThan(0);
  });

  it('uses the latest report of the incident, and none when no report was filed', () => {
    const base = richFixture();
    const two = withReport(withReport(base, ['arrest:1'], 4000), [`res:${base.ids.strike}:lethal`], 6000);
    const r = attended([two]);
    expect(r.court.cases()[0]?.questions.some((q) => q.kind === 'resistanceAt' && q.text.includes('threatening lethal force'))).toBe(true);
    const none = attended([base]);
    expect(none.court.cases()[0]?.questions.every((q) => q.reportSays === null)).toBe(true);
  });

  it('a dismissing motion cuts the questions to three', () => {
    const f = unlawfulArrestFixture();
    const bad = { ...f, log: { ...f.log, key: 'C-00007' }, assessment: { ...f.assessment, key: 'C-00007' } };
    const r = late([bad]);
    r.reveal();
    r.court.request({ kind: 'attend', caseId: 'CR-0001' });
    step(r, HEARING);
    const c = r.court.cases()[0];
    expect(c?.status).toBe('inSession');
    expect(c?.motions[0]?.dismissesCase).toBe(true);
    expect(c?.questions.length).toBeLessThanOrEqual(3);
  });

  it('attending again after a load announces the session without regenerating', () => {
    const r = attended([richFixture()]);
    const questions = r.court.cases()[0]?.questions;
    r.court.request({ kind: 'attend', caseId: 'CR-0001' });
    step(r, HEARING + 60);
    expect(r.h.of('court:session')).toHaveLength(2);
    expect(r.court.cases()[0]?.questions).toBe(questions);
  });

  it('a case left in session (the player closed the courtroom) can be resumed and shows as next', () => {
    const r = attended([richFixture()]);
    expect(r.court.canAttend('CR-0001', HEARING + 600)).toBe(true);
    expect(r.court.next(HEARING + 600)?.id).toBe('CR-0001');
    r.court.request({ kind: 'attend', caseId: 'CR-0001' });
    step(r, HEARING + 660);
    expect(r.h.of('court:session')).toHaveLength(2);
  });

  it('a case left in session past the window is missed, not stranded', () => {
    const r = attended([richFixture()]);
    step(r, HEARING + 130 * 60);
    const c = r.court.cases()[0];
    expect(c?.status).toBe('missed');
    expect(c?.verdict).not.toBeNull();
    expect(r.court.canAttend('CR-0001', HEARING + 131 * 60)).toBe(false);
    expect(r.court.next(HEARING + 131 * 60)).toBeNull();
    expect(r.h.of('court:verdict')).toHaveLength(1);
  });

  it('testimony must answer every question', () => {
    const r = attended([richFixture()]);
    r.court.request({ kind: 'testify', caseId: 'CR-0001', answers: ['yes'] });
    step(r, HEARING + 60);
    expect(r.court.cases()[0]?.status).toBe('inSession');
    expect(r.h.of('court:verdict')).toHaveLength(0);
    // Only an attended case can be testified.
    const idle = scheduled([richFixture()]);
    idle.court.request({ kind: 'testify', caseId: 'CR-0001', answers: [] });
    step(idle, HEARING);
    expect(idle.court.cases()[0]?.status).toBe('scheduled');
  });

  function truthful(r: Rig): Answer[] {
    return (r.court.cases()[0]?.questions ?? []).map((q) => q.truth);
  }

  it('a conviction is decided by one draw against the conviction chance', () => {
    const f = richFixture();
    const strength = evidenceStrength(f.assessment, f.log, 1, 'dui', getRuleset('generic'));
    const probe = attended([f]);
    const answers = truthful(probe);
    const testimony = scoreTestimony(probe.court.cases()[0]?.questions ?? [], answers);
    const p = convictionChance(strength, testimony.score, 50 + 0, false); // no graded report: neutral grade
    expect(p).toBeGreaterThan(0.02);
    expect(p).toBeLessThan(0.98);

    const guilty = attended([f], DUI, [p - 0.001]);
    guilty.court.request({ kind: 'testify', caseId: 'CR-0001', answers: truthful(guilty) });
    step(guilty, HEARING + 60);
    expect(guilty.court.cases()[0]).toMatchObject({ status: 'closed', verdict: 'convicted', reason: 'proven' });
    expect(guilty.rng.draws).toBe(3);
    expect(guilty.court.cases()[0]?.testimony?.consistent).toBe(answers.length);

    const free = attended([f], DUI, [p + 0.001]);
    free.court.request({ kind: 'testify', caseId: 'CR-0001', answers: truthful(free) });
    step(free, HEARING + 60);
    expect(free.court.cases()[0]).toMatchObject({ status: 'closed', verdict: 'acquitted', reason: 'reasonableDoubt' });
  });

  it('the graded report moves the odds', () => {
    const f = richFixture();
    const strength = evidenceStrength(f.assessment, f.log, 1, 'dui', getRuleset('generic'));
    const probe = attended([f]);
    const score = scoreTestimony(probe.court.cases()[0]?.questions ?? [], truthful(probe)).score;
    const mid = (convictionChance(strength, score, 100, false) + convictionChance(strength, score, 0, false)) / 2;
    const run = (grade: number): string | null => {
      const r = attended([f], DUI, [mid], grade);
      r.court.request({ kind: 'testify', caseId: 'CR-0001', answers: truthful(r) });
      step(r, HEARING + 60);
      return r.court.cases()[0]?.verdict ?? null;
    };
    expect(run(100)).toBe('convicted');
    expect(run(0)).toBe('acquitted');
  });

  it('the verdict event carries the credibility change and whether footage impeached the officer', () => {
    const f = richFixture();
    const honest = attended([f], DUI, [0]);
    honest.court.request({ kind: 'testify', caseId: 'CR-0001', answers: truthful(honest) });
    step(honest, HEARING + 60);
    const hv = honest.h.of('court:verdict')[0] as { credibilityDelta: number; impeached: boolean; missed: boolean; key: string; verdict: string };
    expect(hv.credibilityDelta).toBeGreaterThan(0);
    expect(hv.impeached).toBe(false);
    expect(hv.missed).toBe(false);
    expect(hv.key).toBe('C-00007');
    expect(hv.verdict).toBe('convicted');

    const liar = attended([f], DUI, [0]);
    const qs = liar.court.cases()[0]?.questions ?? [];
    const lies: Answer[] = qs.map((q) => (q.onCamera ? (q.truth === 'yes' ? 'no' : 'yes') : q.truth));
    expect(qs.some((q) => q.onCamera)).toBe(true);
    liar.court.request({ kind: 'testify', caseId: 'CR-0001', answers: lies });
    step(liar, HEARING + 60);
    const lv = liar.h.of('court:verdict')[0] as { credibilityDelta: number; impeached: boolean };
    expect(lv.impeached).toBe(true);
    expect(lv.credibilityDelta).toBeLessThan(hv.credibilityDelta);
    expect(liar.court.cases()[0]?.testimony?.impeached).toBeGreaterThan(0);
  });

  it('an unlawful arrest dismisses the case without a draw', () => {
    const f = unlawfulArrestFixture();
    const bad = { ...f, log: { ...f.log, key: 'C-00007' }, assessment: { ...f.assessment, key: 'C-00007' } };
    const r = late([bad]);
    r.reveal();
    r.court.request({ kind: 'attend', caseId: 'CR-0001' });
    step(r, HEARING);
    r.court.request({ kind: 'testify', caseId: 'CR-0001', answers: truthful(r) });
    step(r, HEARING + 60);
    expect(r.court.cases()[0]).toMatchObject({ status: 'closed', verdict: 'dismissed', reason: 'unlawfulArrest' });
    expect(r.rng.draws).toBe(2);
    expect(r.h.of('court:verdict')).toHaveLength(1);
  });

  it('suppressed evidence with nothing left dismisses the case', () => {
    const f = suppressedFixture();
    const bad = { ...f, log: { ...f.log, key: 'C-00007' }, assessment: { ...f.assessment, key: 'C-00007' } };
    const r = late([bad], DRUGS);
    r.reveal();
    r.court.request({ kind: 'attend', caseId: 'CR-0001' });
    step(r, HEARING);
    expect(r.court.cases()[0]?.motions.some((m) => m.text.includes('GRANTED'))).toBe(true);
    r.court.request({ kind: 'testify', caseId: 'CR-0001', answers: truthful(r) });
    step(r, HEARING + 60);
    expect(r.court.cases()[0]).toMatchObject({ verdict: 'dismissed', reason: 'suppression' });
    expect(r.rng.draws).toBe(2);
  });
});

describe('CourtState: missed hearings', () => {
  it('is missed once the window has passed, with one draw and the missed flag', () => {
    const r = scheduled([richFixture()], DUI, 7, [0.0]);
    step(r, HEARING + 120 * 60); // exactly at the end of the window: still open
    expect(r.court.cases()[0]?.status).toBe('scheduled');
    step(r, HEARING + 121 * 60);
    const c = r.court.cases()[0];
    expect(c).toMatchObject({ status: 'missed', verdict: 'convicted', reason: 'missed', testimony: null });
    expect(r.rng.draws).toBe(3);
    expect(r.h.of('court:verdict')).toEqual([
      { caseId: 'CR-0001', key: 'C-00007', verdict: 'convicted', reason: 'missed', credibilityDelta: 0, impeached: false, missed: true },
    ]);
    // It cannot be attended or missed again.
    r.court.request({ kind: 'attend', caseId: 'CR-0001' });
    step(r, HEARING + 122 * 60);
    expect(r.h.of('court:session')).toHaveLength(0);
    expect(r.h.of('court:verdict')).toHaveLength(1);
  });

  it('missing is much worse for the prosecution\'s odds only through the missed factor', () => {
    const f = richFixture();
    const strength = evidenceStrength(f.assessment, f.log, 1, 'dui', getRuleset('generic'));
    const p = convictionChance(strength, null, null, true);
    const lo = scheduled([f], DUI, 7, [p - 0.001]);
    step(lo, HEARING + 3 * HOUR);
    expect(lo.court.cases()[0]?.verdict).toBe('convicted');
    const hi = scheduled([f], DUI, 7, [p + 0.001]);
    step(hi, HEARING + 3 * HOUR);
    expect(hi.court.cases()[0]?.verdict).toBe('acquitted');
  });

  it('motions are applied to a missed hearing: an unlawful arrest is dismissed without a draw', () => {
    const f = unlawfulArrestFixture();
    const bad = { ...f, log: { ...f.log, key: 'C-00007' }, assessment: { ...f.assessment, key: 'C-00007' } };
    const r = late([bad]);
    r.reveal();
    step(r, HEARING + 3 * HOUR);
    expect(r.court.cases()[0]).toMatchObject({ status: 'missed', verdict: 'dismissed', reason: 'unlawfulArrest' });
    expect(r.rng.draws).toBe(2);
    expect((r.h.of('court:verdict')[0] as { missed: boolean }).missed).toBe(true);
    expect(r.court.cases()[0]?.motions.length).toBeGreaterThan(0);
  });

  it('an attended case is not missed while its window is open', () => {
    const r = scheduled([richFixture()]);
    r.court.request({ kind: 'attend', caseId: 'CR-0001' });
    step(r, HEARING);
    step(r, HEARING + HOUR);
    expect(r.court.cases()[0]?.status).toBe('inSession');
  });

  it('a hearing missed during a long time skip is found at the next step', () => {
    const r = scheduled([arrestOnlyFixture()].map((f) => ({ ...f, log: { ...f.log, key: 'C-00007' }, assessment: { ...f.assessment, key: 'C-00007' } })));
    step(r, HEARING + 3 * 24 * HOUR);
    expect(r.court.cases()[0]?.status).toBe('missed');
  });
});

describe('CourtState: determinism and saves', () => {
  function scenario(): CourtState {
    const f = withReport(richFixture(), ['arrest:1']);
    const rng = createRng(SEED).stream('court');
    const h = harness(sourceOf(f), rng, 70);
    const court = new CourtState(h.deps);
    for (let i = 0; i < 6; i++) court.request(open(7, DUI, i % 3 === 2 ? 'citation' : 'booking', `DOC-${i}`));
    court.step(1 / 60, time(DAY_TEN));
    court.request({ kind: 'attend', caseId: 'CR-0002' });
    court.step(1 / 60, time(HEARING));
    return court;
  }

  it('two runs from the same seed give identical saves', () => {
    expect(scenario().serialize()).toEqual(scenario().serialize());
  });

  it('a save restores into a fresh court that continues identically', () => {
    const a = scenario();
    const saved = JSON.parse(JSON.stringify(a.serialize())) as ReturnType<CourtState['serialize']>;
    const f = withReport(richFixture(), ['arrest:1']);
    const rng = createRng(1).stream('other');
    const h = harness(sourceOf(f), rng, 70);
    const b = new CourtState(h.deps);
    b.restore(saved);
    expect(b.serialize()).toEqual(a.serialize());
    expect(b.revision).toBeGreaterThan(0);
    // Continue both: testify, a new case and a missed hearing.
    for (const court of [a, b]) {
      const c = court.case('CR-0002');
      court.request({ kind: 'testify', caseId: 'CR-0002', answers: (c?.questions ?? []).map((q) => q.truth) });
      court.request(open(7, DUI, 'booking', 'DOC-late'));
      court.step(1 / 60, time(HEARING + 60));
      court.step(1 / 60, time(HEARING + 2 * 86400));
    }
    expect(b.serialize()).toEqual(a.serialize());
  });

  it('restoring replaces the previous state and the queue survives a save', () => {
    const a = scenario();
    a.request({ kind: 'advance', caseId: 'CR-0001' });
    const saved = a.serialize();
    expect(saved.queue).toEqual([{ kind: 'advance', caseId: 'CR-0001' }]);
    const f = richFixture();
    const b = new CourtState(harness(sourceOf(f), scriptedRng()).deps);
    b.request(open(7, DUI));
    b.restore(saved);
    b.step(1 / 60, time(HEARING + 120));
    expect(b.cases().map((c) => c.id)).toEqual(a.cases().map((c) => c.id));
  });

  it('serialize returns a detached copy', () => {
    const a = scenario();
    const s = a.serialize();
    s.cases[0]!.personLabel = 'changed';
    expect(a.cases()[0]?.personLabel).toBe('Sam Rivera');
    expect(a.serialize().cases[0]?.personLabel).toBe('Sam Rivera');
  });

  it('request copies its argument', () => {
    const r = rig([richFixture()], [0.99, 0.5]);
    const statutes = ['TR-360'];
    r.court.request({ kind: 'open', docId: 'D', docKind: 'booking', personId: 1, personLabel: 'X', callId: 7, statutes });
    statutes.push('PC-260');
    step(r, DAY_TEN);
    expect(r.court.cases()[0]?.statutes).toEqual(['TR-360']);
  });
});
