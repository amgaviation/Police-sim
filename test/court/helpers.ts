import type { CadTime } from '../../src/cad/types';
import { EventBus } from '../../src/core/events';
import type { EventMap } from '../../src/core/event-map';
import { createRng, type Rng } from '../../src/core/rng';
import type { CourtDeps, IncidentSource } from '../../src/court';
import { buildReportChoices, evaluateIncident, getRuleset } from '../../src/legal';
import type { IncidentLog, LegalAssessment, ReportChoice, ReportRecord, Ruleset } from '../../src/legal';
import { LogBuilder, drugs } from '../legal/helpers';

export { LogBuilder, drugs };

export const SEED = 4242;

export interface Fixture {
  log: IncidentLog;
  rs: Ruleset;
  assessment: LegalAssessment;
  choices: ReportChoice[];
  /** Event ids by name. */
  ids: Record<string, number>;
}

/** Evaluates a log and builds its report choices. */
export function fixtureOf(log: IncidentLog, rulesetId = 'generic', ids: Record<string, number> = {}): Fixture {
  const rs = getRuleset(rulesetId);
  const assessment = evaluateIncident(log, rs);
  return { log, rs, assessment, choices: buildReportChoices(log, assessment, rs, SEED), ids };
}

/** Attaches a report to a fixture's log (the fixture is re-evaluated; choices are unchanged). */
export function withReport(f: Fixture, assertions: string[], game = 5000): Fixture {
  const report: ReportRecord = { docId: 'DOC-1', assertions, sim: 100, game };
  return { ...f, log: { ...f.log, reports: [...f.log.reports, report] } };
}

/**
 * A busy traffic stop: lawful stop on weaving + odor, an unlawful frisk, a consent vehicle search, a failed field test and
 * a lawful arrest (pc 2.0 for dui), an unwarned custodial question, TASER on an active subject (on camera) and a strike
 * on a passive subject while the camera is muted.
 */
export function richFixture(rulesetId = 'generic'): Fixture {
  const b = new LogBuilder('C-00007', 'trafficStop');
  const ids: Record<string, number> = {};
  b.at(0).start().person(1, 'driver', 'Sam Rivera');
  b.at(5).indicator(1, 'weaving').indicator(1, 'odorAlcohol');
  b.at(10).detain(1);
  ids.detain = b.lastId;
  b.at(12).frisk(1);
  ids.frisk = b.lastId;
  b.at(20).consent(1, 'searchVehicle', true, true);
  b.at(25).search(1, 'vehicle', [drugs('d1')], { claimedBasis: 'consent' });
  ids.search = b.lastId;
  b.at(28).consent(1, 'sfst', true, true);
  b.at(30).test(1, 'sfst', 'fail');
  b.indicator(1, 'sfstFail', 'test', b.lastId);
  b.at(40).arrest(1);
  ids.arrest = b.lastId;
  b.at(50).question(1, 'drinking', true);
  ids.question = b.lastId;
  b.statement(1, 'drinking', 'two beers', true);
  b.at(60).force(1, 'taser', 'active');
  ids.taser = b.lastId;
  b.at(70).cam(true, true);
  b.at(75).force(1, 'hardHands', 'passive');
  ids.strike = b.lastId;
  b.at(90);
  return fixtureOf(b.build(), rulesetId, ids);
}

/** A stop that ends in an arrest and nothing else (few candidate questions). */
export function arrestOnlyFixture(): Fixture {
  const b = new LogBuilder('C-00002', 'trafficStop');
  const ids: Record<string, number> = {};
  b.at(0).start().person(1, 'driver', 'Pat Lee');
  b.at(5).indicator(1, 'bacOver').indicator(1, 'weaving').indicator(1, 'odorAlcohol');
  b.at(10).detain(1);
  b.at(20).arrest(1);
  ids.arrest = b.lastId;
  return fixtureOf(b.build(), 'generic', ids);
}

/** A lawful stop (weaving) whose arrest has no probable cause. */
export function unlawfulArrestFixture(): Fixture {
  const b = new LogBuilder('C-00003', 'trafficStop');
  const ids: Record<string, number> = {};
  b.at(0).start().person(1, 'driver', 'Kim Ortiz');
  b.at(5).indicator(1, 'weaving');
  b.at(10).detain(1);
  b.at(20).arrest(1);
  ids.arrest = b.lastId;
  return fixtureOf(b.build(), 'generic', ids);
}

/** A lawful arrest followed by a lawful search incident to arrest that finds drugs. */
export function lawfulSearchFixture(): Fixture {
  const b = new LogBuilder('C-00004', 'trafficStop');
  const ids: Record<string, number> = {};
  b.at(0).start().person(1, 'driver', 'Lee Park');
  b.at(5).indicator(1, 'bacOver').indicator(1, 'odorAlcohol');
  b.at(10).detain(1);
  b.at(20).arrest(1);
  b.at(30).search(1, 'person', [drugs('d9')]);
  ids.search = b.lastId;
  return fixtureOf(b.build(), 'generic', ids);
}

/** An unlawful stop (nothing supports it), then a consent search finds drugs: fruit of the stop, no arrest. */
export function suppressedFixture(): Fixture {
  const b = new LogBuilder('C-00005', 'trafficStop');
  const ids: Record<string, number> = {};
  b.at(0).start().person(1, 'driver', 'Jo Hart');
  b.at(10).detain(1);
  b.at(20).consent(1, 'searchVehicle', true, true);
  b.at(25).search(1, 'vehicle', [drugs('d2')], { claimedBasis: 'consent' });
  ids.search = b.lastId;
  b.indicator(1, 'contrabandFound', 'evidence', b.lastId);
  return fixtureOf(b.build(), 'generic', ids);
}

/** An incident source over fixtures, keyed by log key. */
export function sourceOf(...fixtures: Fixture[]): IncidentSource & { fixtures: Fixture[] } {
  const by = (key: string): Fixture | undefined => fixtures.find((f) => f.log.key === key);
  return {
    fixtures,
    log: (key) => by(key)?.log ?? null,
    assessment: (key) => by(key)?.assessment ?? null,
    reportChoices: (key) => by(key)?.choices ?? [],
  };
}

/** An Rng whose `next` plays back scripted values (then 0.5) and counts draws; everything else is a real stream. */
export interface ScriptedRng extends Rng {
  draws: number;
  script: number[];
}

export function scriptedRng(...values: number[]): ScriptedRng {
  const base = createRng('scripted');
  const rng: ScriptedRng = {
    draws: 0,
    script: [...values],
    get seed() { return base.seed; },
    next() {
      const v = this.script.length > 0 ? (this.script.shift() as number) : 0.5;
      this.draws++;
      return v;
    },
    nextInt: (a, b) => base.nextInt(a, b),
    nextFloat: (a, b) => base.nextFloat(a, b),
    chance: (p) => base.chance(p),
    pick: (arr) => base.pick(arr),
    shuffle: (arr) => base.shuffle(arr),
    gaussian: (m, s) => base.gaussian(m, s),
    stream: (name) => base.stream(name),
    state: () => base.state(),
    restore: (s) => base.restore(s),
  };
  return rng;
}

export type Topic = 'court:subpoena' | 'court:reminder' | 'court:session' | 'court:verdict' | 'court:flash';

export interface Harness {
  bus: EventBus<EventMap>;
  deps: CourtDeps;
  events: { topic: string; payload: unknown }[];
  of(topic: Topic): unknown[];
}

export function harness(source: IncidentSource, rng: Rng, grade: number | null = null, rulesetId = 'generic'): Harness {
  const bus = new EventBus<EventMap>();
  const events: { topic: string; payload: unknown }[] = [];
  for (const t of ['court:subpoena', 'court:reminder', 'court:session', 'court:verdict', 'court:flash'] as const) {
    bus.on(t, (payload) => events.push({ topic: t, payload }));
  }
  return {
    bus, events,
    deps: { bus, rng, seed: SEED, incidents: source, ruleset: () => getRuleset(rulesetId), reportGrade: () => grade },
    of: (topic) => events.filter((e) => e.topic === topic).map((e) => e.payload),
  };
}

export const HOUR = 3600;
export const time = (game: number): CadTime => ({ sim: game, game });
