import { describe, expect, it } from 'vitest';
import { evaluateIncident } from '../../src/legal/evaluate';
import { getRuleset, rulesetIds } from '../../src/legal/ruleset';
import { DOCTRINES, type Doctrine, type LegalAssessment, type Outcome } from '../../src/legal/types';
import { CORPUS, scenario } from './corpus';
import { dets, evaluate } from './helpers';

/**
 * Doctrine outcome matrix (Phase 9 §10): for every doctrine the corpus has a lawful and an unlawful determination under
 * each ruleset, or the doctrine is listed in `EXEMPT` with the reason (the engine never emits that outcome for it) and
 * the substitute that shows the behaviour. Then the scenarios where strict and generic disagree.
 */

type Tally = Record<Outcome, number>;

function tally(rulesetId: string): Map<Doctrine, Tally> {
  const map = new Map<Doctrine, Tally>();
  for (const d of DOCTRINES) map.set(d, { lawful: 0, unlawful: 0, questionable: 0 });
  for (const s of CORPUS) {
    for (const det of evaluate(s.log, rulesetId).determinations) {
      const t = map.get(det.doctrine);
      if (t) t[det.outcome]++;
    }
  }
  return map;
}

interface Exemption { lawful?: string; unlawful?: string }

const EXEMPT: Readonly<Partial<Record<Doctrine, Exemption>>> = {
  friskScope: { lawful: 'a scope determination is emitted only when a frisk went beyond its scope; a frisk within scope is judged by the frisk determination alone' },
  exigency: {
    lawful: 'exigency is never a determination of its own: it is the basis of an entry or a search determination (basis "exigency")',
    unlawful: 'exigency is never a determination of its own: a stale exigency makes the search or entry unlawful instead',
  },
  miranda: { lawful: 'only violations are determinations; a warned and waived questioning produces none' },
  force: { lawful: 'only non-justified force is a determination; justified force is a ForceRuling with verdict "justified"' },
  recording: { lawful: 'only violations are determinations; a fully recorded incident produces none' },
  evidence: {
    lawful: 'evidence is judged by EvidenceRulings (admissible / suppressed), not by determinations',
    unlawful: 'evidence is judged by EvidenceRulings (admissible / suppressed), not by determinations',
  },
};

describe.each(rulesetIds())('doctrine matrix: %s', (rulesetId) => {
  const seen = tally(rulesetId);

  it.each(DOCTRINES.map((d) => [d] as const))('%s has a lawful determination or a stated exemption', (doctrine) => {
    const n = seen.get(doctrine)?.lawful ?? -1;
    const reason = EXEMPT[doctrine]?.lawful;
    if (reason) expect(n, `${doctrine} is exempt (${reason}) but now has lawful determinations`).toBe(0);
    else expect(n, `no lawful ${doctrine} determination in the corpus`).toBeGreaterThan(0);
  });

  it.each(DOCTRINES.map((d) => [d] as const))('%s has an unlawful determination or a stated exemption', (doctrine) => {
    const t = seen.get(doctrine);
    const reason = EXEMPT[doctrine]?.unlawful;
    if (reason) expect(t?.unlawful, `${doctrine} is exempt (${reason}) but now has unlawful determinations`).toBe(0);
    else expect(t?.unlawful ?? -1, `no unlawful ${doctrine} determination in the corpus`).toBeGreaterThan(0);
  });

  it('lists exemptions only for doctrines that exist', () => {
    for (const d of Object.keys(EXEMPT)) expect(DOCTRINES as readonly string[]).toContain(d);
  });
});

describe.each(rulesetIds())('substitutes for the exempt doctrines: %s', (rulesetId) => {
  const ev = (id: string): LegalAssessment => evaluate(scenario(id).log, rulesetId);

  it('exigency is the basis of lawful entries and searches, and a stale one is unlawful', () => {
    const lawful = ev('exigency-entry-search');
    expect(dets(lawful, 'entry').map((d) => [d.outcome, d.basis])).toEqual([['lawful', 'exigency']]);
    expect(dets(lawful, 'search').map((d) => [d.outcome, d.basis])).toEqual([['lawful', 'exigency']]);
    const stale = ev('exigency-stale');
    expect(dets(stale, 'search').map((d) => [d.outcome, d.basis])).toEqual([['unlawful', null]]);
    expect(stale.evidence.map((e) => e.admissible)).toEqual([false]);
  });

  it('a warned and waived questioning has no miranda determination and a standing statement', () => {
    const a = ev('miranda-waived');
    expect(dets(a, 'miranda')).toEqual([]);
    expect(a.evidence.filter((e) => e.kind === 'statement').map((e) => e.admissible)).toEqual([true]);
    const bad = ev('miranda-unwarned');
    expect(dets(bad, 'miranda').map((d) => d.outcome)).toEqual(['unlawful']);
    expect(bad.evidence.filter((e) => e.kind === 'statement').map((e) => e.admissible)).toEqual([false]);
  });

  it('justified force is a ForceRuling, excessive and questionable force are determinations', () => {
    expect(ev('force-justified').force.map((f) => f.verdict)).toEqual(['justified']);
    expect(dets(ev('force-justified'), 'force')).toEqual([]);
    expect(dets(ev('force-excessive'), 'force').map((d) => d.outcome)).toEqual(['unlawful']);
    expect(dets(ev('force-questionable'), 'force').map((d) => d.outcome)).toEqual(['questionable']);
  });

  it('a fully recorded incident has no recording determination, an unrecorded one has', () => {
    expect(dets(ev('recording-full'), 'recording')).toEqual([]);
    expect(dets(ev('recording-missing'), 'recording').map((d) => d.outcome)).toEqual(['unlawful']);
    expect(dets(ev('recording-muted'), 'recording').map((d) => d.outcome)).toEqual(['unlawful']);
  });

  it('evidence is admissible when lawfully obtained and suppressed otherwise', () => {
    expect(ev('consent-lawful').evidence.map((e) => e.admissible)).toEqual([true]);
    expect(ev('vehicle-search-no-basis').evidence.map((e) => e.admissible)).toEqual([false]);
    expect(ev('statement-unlawful-stop').evidence.map((e) => e.admissible)).toEqual([false]);
  });

  it('a frisk within its scope has no scope determination', () => {
    expect(dets(ev('frisk-terry-lawful'), 'friskScope')).toEqual([]);
    expect(dets(ev('frisk-scope-property'), 'friskScope').map((d) => d.outcome)).toEqual(['unlawful']);
  });
});

/** Outcomes of one doctrine as plain strings, in event order (force and evidence read their own rulings). */
function outcomes(a: LegalAssessment, what: Doctrine): string[] {
  if (what === 'force') return a.force.map((f) => f.verdict);
  if (what === 'evidence') return a.evidence.map((e) => (e.admissible ? 'admissible' : 'suppressed'));
  return dets(a, what).map((d) => d.outcome);
}

interface Difference {
  scenario: string;
  doctrine: Doctrine;
  generic: string[];
  strict: string[];
  why: string;
}

const DIFFERENCES: readonly Difference[] = [
  { scenario: 'vehicle-sita-warrant', doctrine: 'search', generic: ['lawful'], strict: ['unlawful'], why: 'Gant: a warrant arrest has no evidence of the offense to find in the car' },
  { scenario: 'consent-aggressive-2', doctrine: 'consent', generic: ['lawful'], strict: ['unlawful'], why: 'two aggressive lines: generic tolerates 3, strict 1' },
  { scenario: 'pursuit-speed-moderate', doctrine: 'pursuit', generic: ['lawful'], strict: ['unlawful'], why: 'twenty over the limit: generic margin 25, strict 15' },
  { scenario: 'pursuit-dui', doctrine: 'pursuit', generic: ['lawful'], strict: ['unlawful'], why: 'strict allows pursuits for violent and weapons offenses only' },
  { scenario: 'arrest-pc-traffic', doctrine: 'arrest', generic: ['lawful'], strict: ['unlawful'], why: 'a traffic offense is not arrestable under strict' },
  { scenario: 'test-implied-consent', doctrine: 'test', generic: ['lawful'], strict: ['unlawful'], why: 'no implied consent after arrest under strict' },
  { scenario: 'pre-arrest-search', doctrine: 'search', generic: ['lawful'], strict: ['unlawful'], why: 'strict has no pre-arrest search window' },
  { scenario: 'frisk-plain-feel-drugs', doctrine: 'friskScope', generic: [], strict: ['unlawful'], why: 'plain feel of drugs is allowed under generic only' },
  { scenario: 'frisk-plain-feel-drugs', doctrine: 'evidence', generic: ['admissible'], strict: ['suppressed'], why: 'the drugs are out of scope under strict' },
  { scenario: 'miranda-gunpoint', doctrine: 'miranda', generic: [], strict: ['unlawful'], why: 'gunpoint questioning is custodial under strict' },
  { scenario: 'evidence-inevitable', doctrine: 'evidence', generic: ['admissible'], strict: ['suppressed'], why: 'inevitable discovery is a generic doctrine only' },
  { scenario: 'force-baton-active', doctrine: 'force', generic: ['justified'], strict: ['questionable'], why: 'a baton is above the strict ceiling for an active resister' },
  { scenario: 'force-display', doctrine: 'force', generic: ['justified', 'justified'], strict: ['questionable', 'justified'], why: 'firearm display needs active resistance under strict' },
  { scenario: 'pursuit-family-offense', doctrine: 'pursuit', generic: ['lawful'], strict: ['unlawful'], why: 'a felony vehicle offense is not a pursuit offense under strict' },
];

describe('strict versus generic', () => {
  it.each(DIFFERENCES.map((d) => [d.scenario, d.doctrine, d] as const))('%s: %s differs (%o)', (_id, _doctrine, d) => {
    const log = scenario(d.scenario).log;
    expect(outcomes(evaluate(log, 'generic'), d.doctrine), `generic: ${d.why}`).toEqual(d.generic);
    expect(outcomes(evaluate(log, 'strict'), d.doctrine), `strict: ${d.why}`).toEqual(d.strict);
  });

  it('has at least three scenarios that are lawful under generic and not under strict', () => {
    const generic = getRuleset('generic');
    const strict = getRuleset('strict');
    const found: string[] = [];
    for (const s of CORPUS) {
      const g = evaluateIncident(s.log, generic);
      const st = evaluateIncident(s.log, strict);
      const worse = g.determinations.some((d) => d.outcome === 'lawful' && st.determinations.some((x) => x.eventId === d.eventId && x.doctrine === d.doctrine && x.outcome !== 'lawful'));
      if (worse) found.push(s.id);
    }
    expect(found.length).toBeGreaterThanOrEqual(3);
    expect(found).toEqual(expect.arrayContaining(['vehicle-sita-warrant', 'consent-aggressive-2', 'arrest-pc-traffic']));
  });

  it('has the Gant vehicle search, the consent threshold and the pursuit speed as separate differences', () => {
    const gant = evaluate(scenario('vehicle-sita-warrant').log, 'strict');
    expect(dets(gant, 'search')[0]?.ruleIds).toEqual(['SS-4.2', 'SS-12.1']);
    const consent = evaluate(scenario('consent-aggressive-2').log, 'strict');
    expect(dets(consent, 'consent')[0]?.ruleIds).toEqual(['SS-5.3']);
    const speed = evaluate(scenario('pursuit-speed-moderate').log, 'strict');
    expect(speed.pursuits[0]?.ruleIds).toEqual(['SS-10.3']);
  });

  it('treats a drawn weapon as coercion under both rulesets', () => {
    const log = scenario('consent-weapon-drawn').log;
    expect(outcomes(evaluate(log, 'generic'), 'consent')).toEqual(['unlawful']);
    expect(outcomes(evaluate(log, 'strict'), 'consent')).toEqual(['unlawful']);
    expect(dets(evaluate(log, 'generic'), 'consent')[0]?.ruleIds).toEqual(['GS-5.3']);
    expect(dets(evaluate(log, 'strict'), 'consent')[0]?.ruleIds).toEqual(['SS-5.3']);
  });

  it('judges a drug arrest and its searches the same under both', () => {
    for (const id of ['arrest-pc-drugs', 'vehicle-sita-drugs', 'automobile-exception', 'consent-lawful']) {
      const log = scenario(id).log;
      expect(outcomes(evaluate(log, 'generic'), 'search'), id).toEqual(outcomes(evaluate(log, 'strict'), 'search'));
      expect(outcomes(evaluate(log, 'generic'), 'search'), id).toEqual(['lawful']);
    }
  });
});
