import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { COURT_CONFIG, generateCrossExam, type CrossExamQuestion } from '../../src/court';
import { CAM } from '../../src/legal';
import { LogBuilder, arrestOnlyFixture, fixtureOf, richFixture, unlawfulArrestFixture, withReport, type Fixture } from './helpers';

function run(f: Fixture, assertions: string[] | null, caseId = 'CR-0001', personId = 1): CrossExamQuestion[] {
  return generateCrossExam(
    { caseId, personId, log: f.log, assessment: f.assessment, choices: f.choices, assertions },
    createRng(4242).stream('court:' + caseId),
    COURT_CONFIG,
  );
}

const ofKind = (qs: CrossExamQuestion[], kind: string): CrossExamQuestion[] => qs.filter((q) => q.kind === kind);

describe('generateCrossExam', () => {
  it('is deterministic per case id and differs between cases', () => {
    const f = richFixture();
    expect(run(f, null, 'CR-0001')).toEqual(run(f, null, 'CR-0001'));
    const other = run(f, null, 'CR-0002');
    expect(other.map((q) => q.eventId + q.kind)).not.toEqual(run(f, null, 'CR-0001').map((q) => q.eventId + q.kind));
    // Same questions, only the order changes.
    expect(other.filter((q) => q.kind !== 'repeat').map((q) => q.text).sort()).toEqual(
      run(f, null, 'CR-0001').filter((q) => q.kind !== 'repeat').map((q) => q.text).sort(),
    );
  });

  it('asks about the resistance of each force event, with the truth from the log', () => {
    const f = richFixture();
    // Raise the cap so both force events fit.
    const qs = generateCrossExam(
      { caseId: 'CR-0001', personId: 1, log: f.log, assessment: f.assessment, choices: f.choices, assertions: null },
      createRng(1),
      { ...COURT_CONFIG, maxQuestions: 20 },
    );
    const res = ofKind(qs, 'resistanceAt');
    expect(res.map((q) => q.eventId).sort((a, b) => a - b)).toEqual([f.ids.taser, f.ids.strike]);
    for (const q of res) {
      expect(q.truth).toBe('yes'); // no report: the question states the logged level
      expect(q.reportSays).toBeNull();
    }
    expect(res.find((q) => q.eventId === f.ids.taser)?.text).toBe(
      "Isn't it true that my client was actively resisting when you used the TASER?",
    );
    expect(res.find((q) => q.eventId === f.ids.strike)?.text).toContain('passively resisting');
  });

  it('weights an unjustified force application above a justified one', () => {
    const f = richFixture();
    const qs = generateCrossExam(
      { caseId: 'CR-0001', personId: 1, log: f.log, assessment: f.assessment, choices: f.choices, assertions: null },
      createRng(1),
      { ...COURT_CONFIG, maxQuestions: 20 },
    );
    expect(qs.find((q) => q.kind === 'resistanceAt' && q.eventId === f.ids.taser)?.weight).toBe(3);
    expect(qs.find((q) => q.kind === 'resistanceAt' && q.eventId === f.ids.strike)?.weight).toBe(5);
  });

  it('an overstated resistance level in the report is a no that the report says yes to', () => {
    const f = richFixture();
    const lie = `res:${f.ids.taser}:assaultive`;
    const qs = run(withReport(f, [lie]), [lie]);
    const q = ofKind(qs, 'resistanceAt').find((x) => x.eventId === f.ids.taser);
    expect(q).toBeDefined();
    expect(q?.truth).toBe('no');
    expect(q?.reportSays).toBe('yes');
    expect(q?.text).toContain('assaultive');
  });

  it('an accurate level in the report is a yes that the report says yes to', () => {
    const f = richFixture();
    const honest = `res:${f.ids.taser}:active`;
    const q = ofKind(run(f, [honest]), 'resistanceAt').find((x) => x.eventId === f.ids.taser);
    expect(q?.truth).toBe('yes');
    expect(q?.reportSays).toBe('yes');
  });

  it('consent: no for the frisk, yes for the consent vehicle search, from the log', () => {
    const f = richFixture();
    const qs = generateCrossExam(
      { caseId: 'CR-0001', personId: 1, log: f.log, assessment: f.assessment, choices: f.choices, assertions: null },
      createRng(1),
      { ...COURT_CONFIG, maxQuestions: 20 },
    );
    const frisk = ofKind(qs, 'consentGiven').find((q) => q.eventId === f.ids.frisk);
    const search = ofKind(qs, 'consentGiven').find((q) => q.eventId === f.ids.search);
    expect(frisk?.truth).toBe('no');
    expect(frisk?.weight).toBe(3); // the frisk was judged unlawful
    expect(frisk?.text).toBe('Did my client consent to the pat-down?');
    expect(search?.truth).toBe('yes');
    expect(search?.weight).toBe(1.5);
    expect(search?.text).toBe('Did my client consent to the search of the vehicle?');
  });

  it('consent reportSays comes from the consent assertion of the covering kind', () => {
    const f = richFixture();
    const qs = generateCrossExam(
      { caseId: 'CR-0001', personId: 1, log: f.log, assessment: f.assessment, choices: f.choices, assertions: ['consent:searchPerson:1'] },
      createRng(1),
      { ...COURT_CONFIG, maxQuestions: 20 },
    );
    const frisk = ofKind(qs, 'consentGiven').find((q) => q.eventId === f.ids.frisk);
    expect(frisk?.truth).toBe('no');
    expect(frisk?.reportSays).toBe('yes');
    expect(ofKind(qs, 'consentGiven').find((q) => q.eventId === f.ids.search)?.reportSays).toBeNull();
  });

  it('asks about Miranda before a custodial incriminating question, once per fact', () => {
    const b = new LogBuilder('C-00009', 'trafficStop');
    b.at(0).start().person(1, 'driver', 'Dana Cole');
    b.at(5).indicator(1, 'bacOver').indicator(1, 'odorAlcohol');
    b.at(10).detain(1).arrest(1);
    b.at(20).question(1, 'drinking', true).question(1, 'drinking', true).question(1, 'name', true).question(1, 'drugs', true);
    b.at(30).miranda(1, 'waived');
    b.at(40).question(1, 'weapons', true);
    const f = fixtureOf(b.build());
    const qs = generateCrossExam({ caseId: 'X', personId: 1, log: f.log, assessment: f.assessment, choices: f.choices, assertions: null }, createRng(1), {
      ...COURT_CONFIG, maxQuestions: 20,
    });
    const m = ofKind(qs, 'mirandaBefore');
    expect(m).toHaveLength(3); // drinking (once), drugs, weapons; not the booking question "name"
    expect(m.filter((q) => q.truth === 'no')).toHaveLength(2);
    expect(m.filter((q) => q.truth === 'yes')).toHaveLength(1);
    expect(m.find((q) => q.truth === 'yes')?.text).toContain('weapons');
    expect(m.every((q) => q.weight === 2.5)).toBe(true);
  });

  it('a miranda assertion in the report becomes the reportSays of the miranda question', () => {
    const f = richFixture();
    const q = ofKind(run(f, ['miranda:1']), 'mirandaBefore')[0];
    expect(q?.truth).toBe('no');
    expect(q?.reportSays).toBe('yes');
  });

  it('camera flags: truth and onCamera follow the unmuted body bit', () => {
    const f = richFixture();
    const qs = generateCrossExam(
      { caseId: 'CR-0001', personId: 1, log: f.log, assessment: f.assessment, choices: f.choices, assertions: null },
      createRng(1),
      { ...COURT_CONFIG, maxQuestions: 20 },
    );
    const cams = ofKind(qs, 'camDuring');
    expect(cams.map((q) => q.eventId).sort((a, b) => a - b)).toEqual([f.ids.frisk, f.ids.search, f.ids.arrest, f.ids.taser, f.ids.strike].map(Number).sort((a, b) => a - b));
    const taser = cams.find((q) => q.eventId === f.ids.taser);
    const strike = cams.find((q) => q.eventId === f.ids.strike);
    expect(taser?.truth).toBe('yes');
    expect(taser?.onCamera).toBe(true);
    expect(strike?.truth).toBe('no'); // muted
    expect(strike?.onCamera).toBe(false);
    expect(strike?.text).toBe('Was your body camera recording when you used force on my client?');
    expect(cams.find((q) => q.eventId === f.ids.search)?.text).toBe('Was your body camera recording when you conducted the search of the vehicle?');
  });

  it('a camera that was off (dash only) is not a recorded event', () => {
    const b = new LogBuilder('C-00010', 'trafficStop');
    b.at(0).start().person(1, 'driver', 'Ray Fox');
    b.bitsOnly(CAM.dash);
    b.at(10).arrest(1);
    const f = fixtureOf(b.build());
    const q = ofKind(run(f, null), 'camDuring')[0];
    expect(q?.truth).toBe('no');
    expect(q?.onCamera).toBe(false);
  });

  it('a camera claim in the report is the reportSays of the camera questions', () => {
    const f = arrestOnlyFixture();
    const q = ofKind(run(f, ['cam:full']), 'camDuring')[0];
    expect(q?.reportSays).toBe('yes');
    expect(ofKind(run(f, []), 'camDuring')[0]?.reportSays).toBeNull();
  });

  describe('report questions', () => {
    it('no report: no reportAssertion or omission questions and every reportSays is null', () => {
      const f = richFixture();
      const qs = run(f, null);
      expect(qs.length).toBeGreaterThan(0);
      expect(qs.some((q) => q.kind === 'reportAssertion' || q.kind === 'omission')).toBe(false);
      expect(qs.every((q) => q.reportSays === null)).toBe(true);
      const wide = generateCrossExam({ caseId: 'X', personId: 1, log: f.log, assessment: f.assessment, choices: f.choices, assertions: null }, createRng(1), {
        ...COURT_CONFIG, maxQuestions: 40,
      });
      expect(wide.some((q) => q.kind === 'reportAssertion' || q.kind === 'omission')).toBe(false);
    });

    it('omission questions exist only for key true facts the report did not assert', () => {
      const f = arrestOnlyFixture();
      const asserted = ['arrest:1', 'ind:bacOver:1'];
      const qs = generateCrossExam({ caseId: 'X', personId: 1, log: f.log, assessment: f.assessment, choices: f.choices, assertions: asserted }, createRng(1), {
        ...COURT_CONFIG, maxQuestions: 40,
      });
      const missing = f.choices.filter((c) => c.personId === 1 && c.key && c.truth === 'true' && !asserted.includes(c.id));
      const mentioned = f.choices.filter((c) => c.personId === 1 && c.key && c.truth === 'true' && asserted.includes(c.id));
      expect(missing.length).toBeGreaterThan(0);
      const omissions = ofKind(qs, 'omission');
      expect(omissions).toHaveLength(missing.length);
      for (const c of missing) expect(omissions.some((q) => q.text.includes(c.text))).toBe(true);
      for (const c of mentioned) expect(omissions.some((q) => q.text.includes(c.text))).toBe(false);
      for (const q of omissions) {
        expect(q.truth).toBe('yes');
        expect(q.reportSays).toBe('no');
        expect(q.weight).toBe(1);
      }
    });

    it('a report that asserts every key fact has no omission questions', () => {
      const f = arrestOnlyFixture();
      const all = f.choices.filter((c) => c.key).map((c) => c.id);
      const qs = generateCrossExam({ caseId: 'X', personId: 1, log: f.log, assessment: f.assessment, choices: f.choices, assertions: all }, createRng(1), {
        ...COURT_CONFIG, maxQuestions: 40,
      });
      expect(ofKind(qs, 'omission')).toHaveLength(0);
    });

    it('asserted false and unsupported choices are no-questions the report says yes to; at most two true ones are asked', () => {
      const f = arrestOnlyFixture();
      // pc:1:dui is true here (2.5 >= 2); ask about a false distractor and the true ones.
      const falseChoice = f.choices.find((c) => c.personId === 1 && c.truth === 'false' && c.id.startsWith('ind:'));
      expect(falseChoice).toBeDefined();
      const trueIds = f.choices.filter((c) => c.personId === 1 && c.truth === 'true').map((c) => c.id);
      expect(trueIds.length).toBeGreaterThan(2);
      const asserted = [(falseChoice as { id: string }).id, ...trueIds];
      const qs = generateCrossExam({ caseId: 'X', personId: 1, log: f.log, assessment: f.assessment, choices: f.choices, assertions: asserted }, createRng(1), {
        ...COURT_CONFIG, maxQuestions: 40,
      });
      const ra = ofKind(qs, 'reportAssertion');
      const lies = ra.filter((q) => q.truth === 'no');
      const honest = ra.filter((q) => q.truth === 'yes');
      expect(lies).toHaveLength(1);
      expect(lies[0]?.reportSays).toBe('yes');
      expect(lies[0]?.weight).toBe(2);
      expect(lies[0]?.text).toBe(`Your report states: "${(falseChoice as { text: string }).text}" Is that accurate?`);
      expect(honest).toHaveLength(2);
      expect(honest.every((q) => q.weight === 0.5 && q.reportSays === 'yes')).toBe(true);
    });

    it('an unsupported probable-cause claim is asked about as a lie', () => {
      const f = unlawfulArrestFixture();
      const unsupported = f.choices.find((c) => c.truth === 'unsupported');
      expect(unsupported).toBeDefined();
      const qs = generateCrossExam({ caseId: 'X', personId: 1, log: f.log, assessment: f.assessment, choices: f.choices, assertions: [(unsupported as { id: string }).id] }, createRng(1), {
        ...COURT_CONFIG, maxQuestions: 40,
      });
      const q = ofKind(qs, 'reportAssertion').find((x) => x.text.includes((unsupported as { text: string }).text));
      expect(q?.truth).toBe('no');
      expect(q?.reportSays).toBe('yes');
    });

    it('report questions about a choice on a recorded event are on camera', () => {
      const f = arrestOnlyFixture();
      const arrestChoice = f.choices.find((c) => c.id === 'arrest:1');
      const qs = generateCrossExam({ caseId: 'X', personId: 1, log: f.log, assessment: f.assessment, choices: f.choices, assertions: ['arrest:1'] }, createRng(1), {
        ...COURT_CONFIG, maxQuestions: 40,
      });
      const q = ofKind(qs, 'reportAssertion').find((x) => x.text.includes(arrestChoice?.text ?? '?'));
      expect(q?.onCamera).toBe(true);
      // A distractor has no event: never on camera.
      const distractor = f.choices.find((c) => c.eventId === -1 && c.personId === 1 && c.truth === 'false');
      const qs2 = generateCrossExam({ caseId: 'X', personId: 1, log: f.log, assessment: f.assessment, choices: f.choices, assertions: [distractor?.id ?? ''] }, createRng(1), {
        ...COURT_CONFIG, maxQuestions: 40,
      });
      expect(ofKind(qs2, 'reportAssertion')[0]?.onCamera).toBe(false);
    });
  });

  describe('cap and repeat', () => {
    it('keeps at most maxQuestions with a repeat appended once there are four or more', () => {
      const f = richFixture();
      const qs = run(f, null);
      expect(qs).toHaveLength(COURT_CONFIG.maxQuestions);
      expect(qs.map((q) => q.id)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6']);
      const repeats = ofKind(qs, 'repeat');
      expect(repeats).toHaveLength(1);
      expect(qs[qs.length - 1]).toBe(repeats[0]);
    });

    it('the repeat re-asks the heaviest question with the truth inverted', () => {
      const f = richFixture();
      const lie = `res:${f.ids.strike}:assaultive`;
      const qs = run(f, [lie]);
      const repeat = ofKind(qs, 'repeat')[0] as CrossExamQuestion;
      const pair = qs.find((q) => q.id === repeat.pairOf) as CrossExamQuestion;
      expect(pair.kind).toBe('resistanceAt');
      expect(pair.eventId).toBe(f.ids.strike); // the heaviest: unjustified force
      expect(repeat.truth).toBe(pair.truth === 'yes' ? 'no' : 'yes');
      expect(repeat.reportSays).toBe(pair.reportSays === 'yes' ? 'no' : pair.reportSays === 'no' ? 'yes' : null);
      expect(repeat.eventId).toBe(pair.eventId);
      expect(repeat.onCamera).toBe(pair.onCamera);
      expect(repeat.text).toContain('it is NOT true that my client was assaultive');
      // The pair is the heaviest candidate.
      const wide = generateCrossExam({ caseId: 'CR-0001', personId: 1, log: f.log, assessment: f.assessment, choices: f.choices, assertions: [lie] }, createRng(1), {
        ...COURT_CONFIG, maxQuestions: 40,
      });
      expect(Math.max(...wide.filter((q) => q.kind !== 'repeat').map((q) => q.weight))).toBe(pair.weight);
    });

    it('a repeat of a report question restates the quoted text', () => {
      const f = arrestOnlyFixture();
      const lie = f.choices.find((c) => c.personId === 1 && c.truth === 'false' && c.id.startsWith('ind:')) as { id: string; text: string };
      // Make the lie the heaviest by keeping only report-driven candidates: a log with a single event.
      const b = new LogBuilder('C-00011', 'trafficStop');
      b.at(0).start().person(1, 'driver', 'Al Ng');
      const tiny = fixtureOf(b.build());
      const choices = [
        ...tiny.choices,
        { id: 'x1', group: null, text: lie.text, personId: 1, truth: 'false' as const, key: false, eventId: -1 },
        { id: 'x2', group: null, text: 'I did a thing.', personId: 1, truth: 'false' as const, key: false, eventId: -1 },
        { id: 'x3', group: null, text: 'I did another thing.', personId: 1, truth: 'false' as const, key: false, eventId: -1 },
        { id: 'x4', group: null, text: 'I did a third thing.', personId: 1, truth: 'false' as const, key: false, eventId: -1 },
      ];
      const qs = generateCrossExam(
        { caseId: 'X', personId: 1, log: tiny.log, assessment: tiny.assessment, choices, assertions: ['x1', 'x2', 'x3', 'x4'] },
        createRng(1),
        COURT_CONFIG,
      );
      expect(qs).toHaveLength(5); // 4 lies + repeat
      const repeat = ofKind(qs, 'repeat')[0] as CrossExamQuestion;
      expect(repeat.truth).toBe('yes');
      expect(repeat.reportSays).toBe('no');
      expect(repeat.text).toMatch(/^So your testimony is that it is NOT true that ".+"\?$/);
    });

    it('fewer than four questions get no repeat', () => {
      const f = arrestOnlyFixture();
      const qs = run(f, null);
      expect(qs.length).toBeLessThan(4);
      expect(ofKind(qs, 'repeat')).toHaveLength(0);
    });

    it('ids are q1..qn in presented order and a repeat points at an earlier id', () => {
      const f = richFixture();
      const qs = run(f, null, 'CR-0042');
      qs.forEach((q, i) => expect(q.id).toBe(`q${i + 1}`));
      const repeat = ofKind(qs, 'repeat')[0] as CrossExamQuestion;
      expect(qs.findIndex((q) => q.id === repeat.pairOf)).toBeLessThan(qs.length - 1);
    });

    it('questions are only about the requested person', () => {
      const b = new LogBuilder('C-00012', 'trafficStop');
      b.at(0).start().person(1, 'driver', 'A One').person(2, 'passenger', 'B Two');
      b.at(5).indicator(1, 'bacOver').indicator(1, 'odorAlcohol');
      b.at(10).detain(1).detain(2);
      b.at(20).arrest(1);
      b.at(25).arrest(2);
      const f = fixtureOf(b.build());
      const wide = (pid: number): CrossExamQuestion[] =>
        generateCrossExam({ caseId: 'X', personId: pid, log: f.log, assessment: f.assessment, choices: f.choices, assertions: null }, createRng(1), {
          ...COURT_CONFIG, maxQuestions: 40,
        });
      const arrests = f.log.events.filter((e) => e.kind === 'arrest');
      expect(wide(1).map((q) => q.eventId)).toEqual([arrests[0]?.id]);
      expect(wide(2).map((q) => q.eventId)).toEqual([arrests[1]?.id]);
      expect(wide(9)).toEqual([]);
    });

    it('an empty incident yields no questions', () => {
      const b = new LogBuilder('C-00013', 'trafficStop');
      b.at(0).start().person(1, 'driver', 'Z');
      const f = fixtureOf(b.build());
      expect(run(f, null)).toEqual([]);
      expect(run(f, [])).toEqual([]);
    });
  });

  it('is independent of the log object identity (pure): log is not mutated', () => {
    const f = richFixture();
    const before = JSON.stringify(f.log);
    run(f, [`res:${f.ids.taser}:lethal`]);
    expect(JSON.stringify(f.log)).toBe(before);
  });

  it('works with the strict ruleset (custody includes gunpoint)', () => {
    const b = new LogBuilder('C-00014', 'trafficStop');
    b.at(0).start().person(1, 'driver', 'G P');
    b.at(10).question(1, 'drugs', false, true);
    const generic = fixtureOf(b.build(), 'generic');
    const strict = fixtureOf(b.build(), 'strict');
    expect(ofKind(run(generic, null), 'mirandaBefore')).toHaveLength(0);
    expect(ofKind(run(strict, null), 'mirandaBefore')).toHaveLength(1);
  });
});
