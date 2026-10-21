import { describe, expect, it } from 'vitest';
import { evaluateIncident } from '../../src/legal/evaluate';
import { getRuleset, rulesetIds } from '../../src/legal/ruleset';
import type { LegalAssessment, Ruleset } from '../../src/legal/types';
import { CORPUS, scenario } from './corpus';

/**
 * Rule coverage (Phase 9 §10): for every shipped ruleset each `rules[].id` appears in the `ruleIds` of at least one
 * determination, evidence, force or pursuit ruling of the corpus evaluated with that ruleset. A rule the engine cannot
 * produce is a bug, unless it is listed in `UNREACHABLE` with the reason and the data fact that makes it so.
 */

interface Unreachable {
  reason: string;
  /** The ruleset data the exemption depends on: when it stops being true the rule must be covered again. */
  holds: (rs: Ruleset) => boolean;
}

const UNREACHABLE: Readonly<Record<string, Readonly<Record<string, Unreachable>>>> = {
  generic: {
    'GS-8.6': {
      reason: "force.displayFirearmMin is 'compliant' (phase 5 design §5.3): no resistance ranks below it, so pointing a firearm is never questionable",
      holds: (rs) => rs.force.displayFirearmMin === 'compliant',
    },
  },
  strict: {
    'SS-12.3': {
      reason: 'evidence.inevitableDiscovery is false: the strict code never admits evidence on inevitable discovery',
      holds: (rs) => !rs.evidence.inevitableDiscovery,
    },
  },
};

function rulingRuleIds(a: LegalAssessment): string[] {
  return [
    ...a.determinations.flatMap((d) => d.ruleIds),
    ...a.evidence.flatMap((e) => e.ruleIds),
    ...a.force.flatMap((f) => f.ruleIds),
    ...a.pursuits.flatMap((p) => p.ruleIds),
  ];
}

/** Rule id -> ids of the scenarios whose rulings cite it. */
function coverage(rs: Ruleset): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const s of CORPUS) {
    for (const id of new Set(rulingRuleIds(evaluateIncident(s.log, rs)))) {
      const list = map.get(id);
      if (list) list.push(s.id);
      else map.set(id, [s.id]);
    }
  }
  return map;
}

describe('corpus', () => {
  it('has unique scenario ids that match the incident keys', () => {
    const ids = CORPUS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of CORPUS) {
      expect(s.log.key).toBe(s.id);
      expect(s.note.length).toBeGreaterThan(10);
      expect(s.log.events[0]?.kind).toBe('start');
    }
    expect(CORPUS.length).toBeGreaterThanOrEqual(80);
    expect(() => scenario('no-such-scenario')).toThrow(/no scenario/);
  });

  it('has events in order of time then id, with unique ids', () => {
    for (const s of CORPUS) {
      const events = s.log.events;
      for (let i = 1; i < events.length; i++) {
        const prev = events[i - 1];
        const e = events[i];
        expect(e && prev && (e.t > prev.t || (e.t === prev.t && e.id > prev.id)), `${s.id} event ${i}`).toBe(true);
      }
    }
  });
});

describe('ruleset shipped files', () => {
  it('ships the generic and strict rulesets (a new ruleset needs its own corpus review)', () => {
    expect(rulesetIds()).toEqual(['generic', 'strict']);
  });

  it('keeps every exemption tied to a ruleset that ships and a rule it defines', () => {
    for (const [rulesetId, rules] of Object.entries(UNREACHABLE)) {
      const rs = getRuleset(rulesetId);
      expect(rs.id).toBe(rulesetId);
      for (const ruleId of Object.keys(rules)) expect(rs.rules.map((r) => r.id)).toContain(ruleId);
    }
  });
});

describe.each(rulesetIds())('rule coverage: %s', (rulesetId) => {
  const rs = getRuleset(rulesetId);
  const covered = coverage(rs);
  const exempt = UNREACHABLE[rulesetId] ?? {};

  it('cites only rule ids the ruleset defines', () => {
    const known = new Set(rs.rules.map((r) => r.id));
    for (const id of covered.keys()) expect(known.has(id), `${rulesetId} ruling cites unknown rule ${id}`).toBe(true);
  });

  it.each(rs.rules.map((r) => [r.id, r.title] as const))('rule %s (%s) is produced by the corpus', (id) => {
    const reason = exempt[id];
    if (reason) {
      expect(reason.holds(rs), `exemption of ${id} no longer holds: ${reason.reason}`).toBe(true);
      expect(covered.get(id), `${id} is exempt (${reason.reason}) but a scenario now produces it`).toBeUndefined();
      return;
    }
    expect(covered.get(id)?.length ?? 0, `no corpus scenario produces ${id}`).toBeGreaterThan(0);
  });

  it('lists every rule as covered or exempt, nothing else', () => {
    const uncovered = rs.rules.map((r) => r.id).filter((id) => !covered.has(id));
    expect(uncovered.sort()).toEqual(Object.keys(exempt).sort());
  });
});

describe('intentionally unreachable rules', () => {
  it('generic never questions a firearm display (the minimum is "compliant")', () => {
    const a = evaluateIncident(scenario('force-display').log, getRuleset('generic'));
    expect(a.force.map((f) => f.verdict)).toEqual(['justified', 'justified']);
    expect(a.force.flatMap((f) => f.ruleIds)).toEqual(['GS-8.1', 'GS-8.1']);
  });

  it('strict questions the same display of a firearm at a compliant subject (SS-8.6)', () => {
    const a = evaluateIncident(scenario('force-display').log, getRuleset('strict'));
    expect(a.force.map((f) => f.verdict)).toEqual(['questionable', 'justified']);
    expect(a.force[0]?.factors).toEqual(['display']);
    expect(a.force[0]?.ruleIds).toEqual(['SS-8.6']);
  });

  it('strict never admits evidence on inevitable discovery; generic does (GS-12.3)', () => {
    const log = scenario('evidence-inevitable').log;
    const generic = evaluateIncident(log, getRuleset('generic'));
    const strict = evaluateIncident(log, getRuleset('strict'));
    expect(generic.evidence.map((e) => [e.admissible, e.ruleIds])).toEqual([[true, ['GS-12.3']]]);
    expect(strict.evidence.map((e) => [e.admissible, e.ruleIds, e.taintedBy > 0])).toEqual([[false, ['SS-12.1'], true]]);
  });
});
