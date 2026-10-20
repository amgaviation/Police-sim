import { describe, expect, it } from 'vitest';
import { COURT_CONFIG, convictionChance, evidenceStrength, motionRulings, scheduleHearing } from '../../src/court';
import { getRuleset } from '../../src/legal';
import {
  LogBuilder, arrestOnlyFixture, drugs, fixtureOf, lawfulSearchFixture, richFixture, suppressedFixture, unlawfulArrestFixture,
} from './helpers';

const generic = getRuleset('generic');
const strict = getRuleset('strict');

describe('motionRulings', () => {
  it('an unlawful arrest dismisses the case first, citing the arrest rule', () => {
    const f = unlawfulArrestFixture();
    const m = motionRulings(f.assessment, 1, ['dui'], generic);
    expect(m[0]).toEqual({
      text: 'Motion to dismiss: unlawful arrest — GRANTED',
      granted: true,
      ruleIds: [generic.arrest.ruleId],
      dismissesCase: true,
    });
    expect(m.filter((x) => x.dismissesCase)).toHaveLength(1);
  });

  it('a lawful arrest brings no dismissal', () => {
    const f = arrestOnlyFixture();
    expect(motionRulings(f.assessment, 1, ['dui'], generic)).toEqual([]);
  });

  it('suppressed items are listed with their rule ids', () => {
    const f = suppressedFixture();
    const ruling = f.assessment.evidence.find((r) => !r.admissible);
    expect(ruling).toBeDefined();
    const m = motionRulings(f.assessment, 1, ['drugs'], generic);
    expect(m).toHaveLength(1);
    expect(m[0]?.granted).toBe(true);
    expect(m[0]?.dismissesCase).toBe(false);
    expect(m[0]?.ruleIds).toEqual([generic.evidence.fruitRuleId, generic.evidence.exclusionRuleId]);
    expect(m[0]?.text).toBe(`Motion to suppress Baggie of pills — GRANTED (${generic.evidence.fruitRuleId}, ${generic.evidence.exclusionRuleId})`);
  });

  it('evidence that bears on another offense is not argued', () => {
    const f = suppressedFixture();
    expect(motionRulings(f.assessment, 1, ['traffic'], generic)).toEqual([]);
    // With no charged offenses known everything is argued.
    expect(motionRulings(f.assessment, 1, [], generic)).toHaveLength(1);
  });

  it('suppression is per defendant', () => {
    const f = suppressedFixture();
    expect(motionRulings(f.assessment, 2, ['drugs'], generic)).toEqual([]);
  });

  it('one denied motion shows the lawful basis of a search', () => {
    const f = lawfulSearchFixture();
    const m = motionRulings(f.assessment, 1, ['dui', 'drugs'], generic);
    expect(m).toHaveLength(1);
    expect(m[0]).toEqual({
      text: 'Motion to suppress Baggie of pills — DENIED (incidentToArrest: GS-4.1)',
      granted: false,
      ruleIds: ['GS-4.1'],
      dismissesCase: false,
    });
  });

  it('lists the granted motions before the denied one', () => {
    const b = new LogBuilder('C-00020', 'trafficStop');
    b.at(0).start().person(1, 'driver', 'Mo Tion');
    b.at(5).indicator(1, 'weaving');
    b.at(10).detain(1);
    b.at(15).consent(1, 'searchVehicle', true, true);
    b.at(20).search(1, 'vehicle', [drugs('x')], { claimedBasis: 'consent' });
    b.at(30).arrest(1); // 0.4 pc: unlawful arrest
    const f = fixtureOf(b.build());
    const m = motionRulings(f.assessment, 1, ['dui', 'drugs'], generic);
    expect(m[0]?.dismissesCase).toBe(true);
    expect(m.map((x) => x.granted)).toEqual([...m.map((x) => x.granted)].sort((a, c) => Number(c) - Number(a)));
  });

  it('a search without a lawful basis produces no denied motion', () => {
    const f = suppressedFixture();
    expect(motionRulings(f.assessment, 1, ['drugs'], generic).some((x) => !x.granted)).toBe(false);
  });

  it('works against the strict ruleset', () => {
    const f = fixtureOf(unlawfulArrestFixture().log, 'strict');
    const m = motionRulings(f.assessment, 1, ['dui'], strict);
    expect(m[0]?.dismissesCase).toBe(true);
    expect(m[0]?.ruleIds[0]).toMatch(/^SS-/);
  });
});

describe('evidenceStrength', () => {
  it('sums the pc of the person\'s indicators over the threshold, capped at 1', () => {
    const f = arrestOnlyFixture(); // bacOver 1.5 + weaving 0.4 + odor 0.6 = 2.5
    expect(evidenceStrength(f.assessment, f.log, 1, 'dui', generic)).toBe(1);
    const weak = unlawfulArrestFixture(); // weaving only: 0.4 of 2.0
    expect(evidenceStrength(weak.assessment, weak.log, 1, 'dui', generic)).toBeCloseTo(0.2, 9);
  });

  it('counts only indicators of the asked offense', () => {
    const f = arrestOnlyFixture();
    expect(evidenceStrength(f.assessment, f.log, 1, 'drugs', generic)).toBe(0);
    expect(evidenceStrength(f.assessment, f.log, 1, 'traffic', generic)).toBe(0);
  });

  it('adds 1.0 per admissible item of the offense', () => {
    const f = lawfulSearchFixture();
    expect(evidenceStrength(f.assessment, f.log, 1, 'drugs', generic)).toBeCloseTo(0.5, 9);
    expect(evidenceStrength(f.assessment, f.log, 1, 'weapons', generic)).toBe(0);
    // A second admissible item doubles it.
    const b = new LogBuilder('C-00021', 'trafficStop');
    b.at(0).start().person(1, 'driver', 'Two Items');
    b.at(5).indicator(1, 'bacOver').indicator(1, 'odorAlcohol');
    b.at(10).detain(1);
    b.at(20).arrest(1);
    b.at(30).search(1, 'person', [drugs('a'), drugs('b')]);
    const two = fixtureOf(b.build());
    expect(evidenceStrength(two.assessment, two.log, 1, 'drugs', generic)).toBe(1);
  });

  it('evidence the court suppressed is worth nothing (item and the indicator it produced)', () => {
    const f = suppressedFixture();
    expect(f.assessment.evidence.every((r) => !r.admissible)).toBe(true);
    expect(evidenceStrength(f.assessment, f.log, 1, 'drugs', generic)).toBe(0);
  });

  it('a statement suppressed under Miranda does not count toward probable cause', () => {
    const b = new LogBuilder('C-00022', 'trafficStop');
    b.at(0).start().person(1, 'driver', 'St Ate');
    b.at(5).indicator(1, 'weaving');
    b.at(10).detain(1).arrest(1);
    b.at(20).question(1, 'drinking', true);
    b.statement(1, 'drinking', 'yes', true);
    b.indicator(1, 'admissionDrinking', 'statement', b.lastId);
    const f = fixtureOf(b.build());
    expect(f.assessment.evidence.some((r) => r.kind === 'statement' && !r.admissible)).toBe(true);
    expect(evidenceStrength(f.assessment, f.log, 1, 'dui', generic)).toBeCloseTo(0.2, 9); // weaving 0.4 only
  });

  it('indicators gathered after an unlawful detention are tainted unless attenuating', () => {
    const b = new LogBuilder('C-00023', 'trafficStop');
    b.at(0).start().person(1, 'driver', 'Un Law');
    b.at(10).detain(1); // no suspicion
    b.at(20).indicator(1, 'odorCannabis').indicator(1, 'warrantHit', 'lookup');
    const f = fixtureOf(b.build());
    expect(f.assessment.persons[0]?.detentionLawful).toBe(false);
    expect(evidenceStrength(f.assessment, f.log, 1, 'drugs', generic)).toBe(0);
    // Generic: the warrant hit survives the unlawful stop (2.0 + 2.0 bonus); strict: it does not.
    expect(evidenceStrength(f.assessment, f.log, 1, 'warrant', generic)).toBe(1);
    const s = fixtureOf(b.build(), 'strict');
    expect(evidenceStrength(s.assessment, s.log, 1, 'warrant', strict)).toBe(0);
    // The same indicator after a lawful stop counts.
    const lawful = new LogBuilder('C-00024', 'trafficStop');
    lawful.at(0).start().person(1, 'driver', 'Ok');
    lawful.at(5).indicator(1, 'weaving').indicator(1, 'speeding');
    lawful.at(10).detain(1);
    lawful.at(20).indicator(1, 'odorCannabis');
    const l = fixtureOf(lawful.build());
    expect(evidenceStrength(l.assessment, l.log, 1, 'drugs', generic)).toBeCloseTo(0.5, 9);
  });

  it('a warrant hit adds a 2.0 bonus for the warrant offense only', () => {
    const b = new LogBuilder('C-00025', 'trafficStop');
    b.at(0).start().person(1, 'driver', 'War Rant');
    b.at(5).indicator(1, 'warrantHit', 'lookup');
    const f = fixtureOf(b.build());
    expect(evidenceStrength(f.assessment, f.log, 1, 'warrant', generic)).toBe(1);
    const owner = new LogBuilder('C-00026', 'trafficStop');
    owner.at(0).start().person(1, 'driver', 'Own Er');
    owner.at(5).indicator(1, 'ownerWarrant', 'lookup');
    const o = fixtureOf(owner.build());
    expect(evidenceStrength(o.assessment, o.log, 1, 'warrant', generic)).toBe(0); // pc 0 and no warrantHit
  });

  it('licenseInvalid counts only for the driver; incident-wide indicators count for everyone', () => {
    const b = new LogBuilder('C-00027', 'trafficStop');
    b.at(0).start().person(1, 'driver', 'Dr Iver').person(2, 'passenger', 'Pa Ss');
    b.at(5).indicator(1, 'licenseInvalid', 'lookup').indicator(2, 'licenseInvalid', 'lookup');
    b.indicator(-1, 'stolenVehicle', 'lookup');
    const f = fixtureOf(b.build());
    expect(evidenceStrength(f.assessment, f.log, 1, 'traffic', generic)).toBe(1);
    expect(evidenceStrength(f.assessment, f.log, 2, 'traffic', generic)).toBe(0);
    expect(evidenceStrength(f.assessment, f.log, 2, 'felonyVehicle', generic)).toBeCloseTo(0.75, 9);
  });

  it('callSuspect takes the offense of the call family', () => {
    const b = new LogBuilder('C-00028', 'weapons');
    b.at(0).start().person(1, 'suspect', 'Su Spect');
    b.at(5).indicator(1, 'callSuspect', 'call');
    const f = fixtureOf(b.build());
    expect(evidenceStrength(f.assessment, f.log, 1, 'weapons', generic)).toBeCloseTo(0.4, 9);
    expect(evidenceStrength(f.assessment, f.log, 1, 'property', generic)).toBe(0);
  });

  it('is 0 for a person nothing is known about', () => {
    const f = richFixture();
    expect(evidenceStrength(f.assessment, f.log, 99, 'dui', generic)).toBe(0);
  });
});

describe('convictionChance', () => {
  const c = COURT_CONFIG;
  it('follows base + strength*s + testimony*t + report/100*r', () => {
    expect(convictionChance(0.5, 0.6, 80, false, c)).toBeCloseTo(0.15 + 0.225 + 0.15 + 0.12, 9);
    expect(convictionChance(0, 0, 0, false, c)).toBeCloseTo(0.15, 9);
  });

  it('assumes neutral testimony and the no-report grade when unknown', () => {
    expect(convictionChance(0, null, null, false, c)).toBeCloseTo(0.15 + 0.5 * 0.25 + 0.5 * 0.15, 9);
    expect(convictionChance(0, null, null, false, { ...c, conviction: { ...c.conviction, noReportGrade: 100 } })).toBeCloseTo(0.15 + 0.125 + 0.15, 9);
  });

  it('a missed hearing multiplies by the missed factor', () => {
    const open = convictionChance(0.5, null, 70, false, c);
    expect(convictionChance(0.5, null, 70, true, c)).toBeCloseTo(open * 0.4, 9);
  });

  it('clamps to 0.02..0.98', () => {
    expect(convictionChance(1, 1, 100, false, c)).toBe(0.98);
    const low = { ...c, conviction: { ...c.conviction, base: 0, strength: 0, testimony: 0, report: 0 } };
    expect(convictionChance(0, 0, 0, true, low)).toBe(0.02);
  });

  it('is monotonic in each input', () => {
    expect(convictionChance(0.9, 0.5, 50, false, c)).toBeGreaterThan(convictionChance(0.1, 0.5, 50, false, c));
    expect(convictionChance(0.5, 0.9, 50, false, c)).toBeGreaterThan(convictionChance(0.5, 0.1, 50, false, c));
    expect(convictionChance(0.5, 0.5, 90, false, c)).toBeGreaterThan(convictionChance(0.5, 0.5, 10, false, c));
  });
});

describe('scheduleHearing', () => {
  const H = 3600;
  const D = 86400;
  const hourOf = (t: number): number => Math.floor((t % D) / H);

  it('adds the interpolated delay and rounds up to the next full hour', () => {
    expect(scheduleHearing(10 * H, 0)).toBe(12 * H);
    expect(scheduleHearing(10 * H, 0.5)).toBe(14 * H);
    expect(scheduleHearing(10 * H + 20 * 60, 0)).toBe(13 * H); // 12:20 -> 13:00
    expect(scheduleHearing(10 * H + 1, 0)).toBe(13 * H);
    expect(scheduleHearing(10 * H, 0.9999)).toBe(16 * H);
  });

  it('keeps an exact hour as it is', () => {
    expect(scheduleHearing(9 * H, 0.25)).toBe(12 * H); // 9 + 3 = 12:00
  });

  it('moves a hearing at or after closing to opening time the next day', () => {
    expect(scheduleHearing(13 * H, 0.5)).toBe(D + 9 * H); // lands on 17:00 exactly: closed
    expect(scheduleHearing(14 * H, 0.9999)).toBe(D + 9 * H); // 20:00
    expect(scheduleHearing(21 * H, 0)).toBe(D + 9 * H); // 23:00
  });

  it('moves a hearing before opening to opening time the same day', () => {
    expect(scheduleHearing(0, 0)).toBe(9 * H); // 02:00
    expect(scheduleHearing(3 * H, 0.5)).toBe(9 * H); // 07:00
    expect(scheduleHearing(5 * H, 0.5)).toBe(9 * H); // exactly 09:00 stays
  });

  it('crosses midnight', () => {
    expect(scheduleHearing(22 * H, 0.5)).toBe(D + 9 * H); // 22:00 + 4 h = 02:00 the next day, before opening
  });

  it('works on later game days', () => {
    const day = 12 * D;
    expect(scheduleHearing(day + 10 * H, 0.5)).toBe(day + 14 * H);
    expect(scheduleHearing(day + 16 * H, 0)).toBe(day + D + 9 * H); // 18:00
  });

  it('always lands inside court hours, at least the minimum delay away, within a day or so of the maximum', () => {
    const cfg = COURT_CONFIG;
    for (let created = 0; created < 3 * D; created += 1237) {
      for (const u of [0, 0.13, 0.5, 0.77, 0.9999]) {
        const t = scheduleHearing(created, u, cfg);
        expect(t % H).toBe(0);
        expect(hourOf(t)).toBeGreaterThanOrEqual(cfg.hours[0]);
        expect(hourOf(t)).toBeLessThan(cfg.hours[1]);
        expect(t).toBeGreaterThanOrEqual(created + cfg.delayH[0] * H);
        expect(t).toBeLessThan(created + cfg.delayH[1] * H + D + H);
      }
    }
  });

  it('honours custom hours and delays', () => {
    const cfg = { ...COURT_CONFIG, delayH: [1, 1] as const, hours: [8, 12] as const };
    expect(scheduleHearing(10 * H, 0.7, cfg)).toBe(11 * H);
    expect(scheduleHearing(11 * H, 0.7, cfg)).toBe(D + 8 * H); // 12:00 is closed
  });
});
