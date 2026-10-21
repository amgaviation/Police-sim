import { describe, expect, it } from 'vitest';
import { buildReportChoices } from '../../src/legal/report';
import { getRuleset } from '../../src/legal/ruleset';
import {
  CLAIMED_BASES,
  CONSENT_KINDS,
  INDICATOR_SOURCES,
  SEARCH_TARGETS,
  type ClaimedBasis,
  type ConsentKind,
  type SearchTarget,
} from '../../src/legal/types';
import { drugs, dets, evaluate, LogBuilder } from './helpers';

/** The fixed id lists of the incident log vocabulary (design §4.1): each id is handled, none is silently ignored. */

/** A person stopped on reasonable suspicion of speeding, with the camera on. */
function stop(): LogBuilder {
  return new LogBuilder('C-00001').start().person(1, 'driver').after(1).indicator(1, 'speeding').after(1).detain(1).after(1);
}

describe('CONSENT_KINDS', () => {
  it('lists the seven kinds in the design order', () => {
    expect([...CONSENT_KINDS]).toEqual(['entry', 'searchPremises', 'searchRoom', 'searchPerson', 'searchVehicle', 'pbt', 'sfst']);
  });

  it.each(CONSENT_KINDS.map((k) => [k] as const))('judges a granted %s consent and revokes it on a refusal', (kind: ConsentKind) => {
    const b = stop().consent(1, kind);
    const granted = evaluate(b.build());
    expect(dets(granted, 'consent').map((d) => [d.outcome, d.basis])).toEqual([['lawful', kind]]);
    const refused = evaluate(stop().consent(1, kind, false).build());
    expect(dets(refused, 'consent')).toEqual([]);
  });

  it.each(CONSENT_KINDS.map((k) => [k] as const))('flags an invalid %s consent as unlawful under both rulesets', (kind: ConsentKind) => {
    for (const id of ['generic', 'strict']) {
      const a = evaluate(stop().consent(1, kind, true, false).build(), id);
      expect(dets(a, 'consent').map((d) => d.outcome)).toEqual(['unlawful']);
    }
  });

  it.each(CONSENT_KINDS.map((k) => [k] as const))('offers a report statement for a granted %s consent', (kind: ConsentKind) => {
    const rs = getRuleset('generic');
    const log = stop().consent(1, kind).build();
    const choices = buildReportChoices(log, evaluate(log), rs, 7);
    const mine = choices.find((c) => c.id === `consent:${kind}:1`);
    expect(mine?.truth).toBe('true');
    expect(mine?.text.length).toBeGreaterThan(0);
  });
});

describe('SEARCH_TARGETS', () => {
  /** The consent kind that covers a target (a room or container is covered by room or premises consent). */
  const COVERING: Record<SearchTarget, ConsentKind> = {
    person: 'searchPerson', vehicle: 'searchVehicle', premises: 'searchPremises', room: 'searchRoom', container: 'searchRoom',
  };

  it('lists the five targets', () => {
    expect([...SEARCH_TARGETS]).toEqual(['person', 'vehicle', 'premises', 'room', 'container']);
  });

  it.each(SEARCH_TARGETS.map((t) => [t] as const))('allows a %s search only with covering consent', (target: SearchTarget) => {
    const building = target === 'person' || target === 'vehicle' ? -1 : 3;
    const bare = evaluate(stop().search(1, target, [drugs('t1')], { buildingId: building }).build());
    expect(dets(bare, 'search').map((d) => d.outcome)).toEqual(['unlawful']);
    expect(bare.evidence.map((e) => e.admissible)).toEqual([false]);

    const b = stop().consent(1, COVERING[target], true, true, { buildingId: building }).after(1);
    const covered = evaluate(b.search(1, target, [drugs('t2')], { buildingId: building }).build());
    expect(dets(covered, 'search').map((d) => [d.outcome, d.basis])).toEqual([['lawful', 'consent']]);
    expect(covered.evidence.map((e) => e.admissible)).toEqual([true]);
  });

  it.each(SEARCH_TARGETS.map((t) => [t] as const))('does not let consent to another target cover a %s search', (target: SearchTarget) => {
    const other = target === 'person' ? 'searchVehicle' : 'searchPerson';
    const building = target === 'person' || target === 'vehicle' ? -1 : 3;
    const a = evaluate(stop().consent(1, other, true, true, { buildingId: building }).after(1).search(1, target, [drugs('t3')], { buildingId: building }).build());
    expect(dets(a, 'search').map((d) => d.outcome)).toEqual(['unlawful']);
  });

  it.each(SEARCH_TARGETS.map((t) => [t] as const))('words a %s search in the report', (target: SearchTarget) => {
    const log = stop().search(1, target, []).build();
    const choice = buildReportChoices(log, evaluate(log), getRuleset('generic'), 3).find((c) => c.id.startsWith('search:') && c.truth === 'true');
    expect(choice?.key).toBe(true);
    expect(choice?.text.length).toBeGreaterThan(0);
  });
});

describe('CLAIMED_BASES', () => {
  /** A claimed basis alone never makes a search lawful: the logged facts decide. */
  const NO_FACTS: Record<ClaimedBasis, boolean> = {
    plainView: true, publicArea: true, consent: false, warrant: false, incidentToArrest: false, exigency: false, protectiveSweep: false,
  };

  it('lists the seven bases', () => {
    expect([...CLAIMED_BASES]).toEqual(['plainView', 'consent', 'warrant', 'incidentToArrest', 'exigency', 'protectiveSweep', 'publicArea']);
  });

  it.each(CLAIMED_BASES.map((c) => [c] as const))('judges a %s claim by the facts of the log, not by the claim', (claimed: ClaimedBasis) => {
    const b = new LogBuilder('C-00002', 'disturbance').start().person(1, 'suspect').after(1).entry(3, true, 1).after(1);
    const a = evaluate(b.search(1, 'room', [drugs('c1')], { claimedBasis: claimed, buildingId: 3 }).build());
    const outcome = dets(a, 'search')[0]?.outcome;
    expect(outcome === 'lawful', `${claimed} without supporting facts`).toBe(NO_FACTS[claimed]);
  });

  it('lets the facts back the claims that need one', () => {
    const base = (): LogBuilder => new LogBuilder('C-00003', 'wanted').start().person(1, 'suspect').after(1);
    const consent = base().consent(1, 'entry', true, true, { buildingId: 3 }).after(1).entry(3, false, 1).after(1)
      .consent(1, 'searchRoom', true, true, { buildingId: 3 }).after(1).search(1, 'room', [], { claimedBasis: 'consent', buildingId: 3 }).build();
    expect(dets(evaluate(consent), 'search').map((d) => d.basis)).toEqual(['consent']);
    const warrant = base().warrant('search').after(1).entry(3, false, 1).after(1).search(1, 'room', [], { claimedBasis: 'warrant', buildingId: 3 }).build();
    expect(dets(evaluate(warrant), 'search').map((d) => d.basis)).toEqual(['warrant']);
    const exigency = base().exigency('fire', 3).after(1).entry(3, false, 1).after(1).search(1, 'room', [], { claimedBasis: 'exigency', buildingId: 3 }).build();
    expect(dets(evaluate(exigency), 'search').map((d) => d.basis)).toEqual(['exigency']);
    const arrested = base().consent(1, 'entry', true, true, { buildingId: 3 }).after(1).entry(3, false, 1).after(1).indicator(1, 'warrantHit').after(1).arrest(1).after(1);
    expect(dets(evaluate(arrested.search(1, 'room', [], { claimedBasis: 'protectiveSweep', buildingId: 3 }).build()), 'search').map((d) => d.basis)).toEqual(['protectiveSweep']);
    expect(dets(evaluate(arrested.search(1, 'room', [], { claimedBasis: 'incidentToArrest', buildingId: 3 }).build()), 'search').map((d) => d.basis)).toEqual(['protectiveSweep', 'incidentToArrest']);
  });

  it('refuses plain view from inside an unlawfully entered building', () => {
    const b = new LogBuilder('C-00004', 'disturbance').start().person(1, 'suspect').after(1).entry(4, false, 1).after(1);
    for (const claimed of ['plainView', 'publicArea'] as const) {
      const a = evaluate(b.search(1, 'room', [drugs(`pv-${claimed}`)], { claimedBasis: claimed, buildingId: 4 }).build());
      expect(dets(a, 'search').map((d) => d.outcome)).toContain('unlawful');
    }
  });
});

describe('INDICATOR_SOURCES', () => {
  it('lists the six sources', () => {
    expect([...INDICATOR_SOURCES]).toEqual(['observation', 'lookup', 'statement', 'evidence', 'test', 'call']);
  });

  it.each(INDICATOR_SOURCES.map((s) => [s] as const))('counts a %s indicator toward a lawful stop', (source) => {
    const b = new LogBuilder('C-00005').start().person(1, 'driver').after(1).indicator(1, 'speeding', source).after(1).detain(1);
    expect(dets(evaluate(b.build()), 'detention').map((d) => d.outcome)).toEqual(['lawful']);
  });

  it.each(INDICATOR_SOURCES.map((s) => [s] as const))('treats a %s indicator after an unlawful stop as fruit unless it is a call', (source) => {
    const b = new LogBuilder('C-00006').start().person(1, 'driver').after(1).detain(1, 'command').after(1)
      .indicator(1, 'contrabandPlainView', source).after(1).arrest(1);
    const arrest = dets(evaluate(b.build()), 'arrest')[0];
    expect(arrest?.outcome, `source ${source}`).toBe(source === 'call' ? 'lawful' : 'unlawful');
  });

  it('follows an indicator back to the tainted event it came from', () => {
    const b = new LogBuilder('C-00007').start().person(1, 'driver').after(1).indicator(1, 'weaving').after(1).detain(1).after(1).frisk(1, [drugs('s1')]);
    const friskId = b.lastId;
    const a = evaluate(b.after(1).indicator(1, 'contrabandFound', 'evidence', friskId).after(1).arrest(1).build());
    expect(dets(a, 'arrest').map((d) => d.outcome)).toEqual(['unlawful']);
    const clean = evaluate(new LogBuilder('C-00008').start().person(1, 'driver').after(1).indicator(1, 'weaving').after(1).detain(1).after(1)
      .indicator(1, 'contrabandFound', 'evidence', -1).after(1).arrest(1).build());
    expect(dets(clean, 'arrest').map((d) => d.outcome)).toEqual(['lawful']);
  });
});
