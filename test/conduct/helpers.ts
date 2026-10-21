import { EventBus } from '../../src/core/events';
import type { EventMap } from '../../src/core/event-map';
import { createRng } from '../../src/core/rng';
import { ConductState } from '../../src/conduct/conductState';
import type { ConductConfigs } from '../../src/conduct/data';
import type { ConductDeps, IncidentSource } from '../../src/conduct/types';
import type {
  Determination, Doctrine, ForceEvent, ForceRuling, IncidentLog, LegalAssessment, Outcome, ReportChoice,
} from '../../src/legal/types';
import { LogBuilder } from '../legal/helpers';

export { LogBuilder };

export function emptyAssessment(key = 'C-00001'): LegalAssessment {
  return {
    rulesetId: 'generic', key, determinations: [], evidence: [], force: [], pursuits: [], persons: [],
    summary: { unlawful: 0, questionable: 0, suppressed: 0, excessiveForce: 0, questionableForce: 0, score: 100 },
  };
}

let detSeq = 1;

export function det(doctrine: Doctrine, outcome: Outcome, eventIds: number[], personId = 1): Determination {
  return {
    id: `d${detSeq++}`, doctrine, eventId: eventIds[0] ?? -1, personId, t: 0, outcome, ruleIds: [], reason: '', basis: null, eventIds,
  };
}

export function ruling(eventId: number, verdict: ForceRuling['verdict'], opts: Partial<ForceRuling> = {}): ForceRuling {
  return {
    eventId, personId: 1, level: 'taser', tool: 'taser', resistance: 'active', maxAllowed: 'taser', verdict, factors: [], ruleIds: [], other: false,
    ...opts,
  };
}

/** Builds an assessment from determinations / force rulings and fixes the summary counts. */
export function assess(key: string, parts: { dets?: Determination[]; force?: ForceRuling[]; persons?: LegalAssessment['persons'] } = {}): LegalAssessment {
  const a = emptyAssessment(key);
  a.determinations = parts.dets ?? [];
  a.force = parts.force ?? [];
  a.persons = parts.persons ?? [];
  const own = a.force.filter((f) => !f.other);
  a.summary.unlawful = a.determinations.filter((d) => d.outcome === 'unlawful').length;
  a.summary.questionable = a.determinations.filter((d) => d.outcome === 'questionable').length;
  a.summary.excessiveForce = own.filter((f) => f.verdict === 'excessive').length;
  a.summary.questionableForce = own.filter((f) => f.verdict === 'questionable').length;
  return a;
}

export function person(personId: number, arrested: boolean, lawful: boolean | null): LegalAssessment['persons'][number] {
  return {
    personId, detained: true, detentionLawful: true, arrested, arrestLawful: lawful, arrestOffense: null, pcAtArrest: {}, rsAtDetention: 0,
    suppressedStatements: 0,
  };
}

/** The force event with `id` of a built log (mutable). */
export function forceEvent(log: IncidentLog, id: number): ForceEvent {
  const e = log.events.find((x) => x.id === id);
  if (!e || e.kind !== 'force') throw new Error(`no force event ${id}`);
  return e;
}

/** A log with a restrained suspect hit by the TASER: the standard excessive-force incident. */
export function forceLog(key = 'C-00001', opts: { cam?: boolean; level?: ForceEvent['level']; injury?: number } = {}): { log: IncidentLog; forceId: number } {
  const b = new LogBuilder(key, 'disturbance');
  if (opts.cam === false) b.cam(false);
  b.start().person(1, 'suspect', 'Mr. Doe').after(1).detain(1, 'command').after(1).force(1, opts.level ?? 'taser', 'active', { restrained: true });
  const forceId = b.lastId;
  const log = b.build();
  if (opts.injury !== undefined) forceEvent(log, forceId).injury = opts.injury;
  return { log, forceId };
}

export function choice(id: string, truth: ReportChoice['truth'], opts: Partial<ReportChoice> = {}): ReportChoice {
  return { id, group: null, text: `text ${id}`, personId: 1, truth, key: false, eventId: -1, ...opts };
}

/** In-memory IncidentSource. */
export class FakeIncidents implements IncidentSource {
  logs = new Map<string, IncidentLog>();
  assessments = new Map<string, LegalAssessment>();
  choices = new Map<string, ReportChoice[]>();

  add(log: IncidentLog, a: LegalAssessment, choices: ReportChoice[] = []): this {
    this.logs.set(log.key, log);
    this.assessments.set(log.key, a);
    this.choices.set(log.key, choices);
    return this;
  }

  log(key: string): IncidentLog | null {
    return this.logs.get(key) ?? null;
  }

  assessment(key: string): LegalAssessment | null {
    return this.assessments.get(key) ?? null;
  }

  reportChoices(key: string): readonly ReportChoice[] {
    return this.choices.get(key) ?? [];
  }
}

export interface Harness {
  state: ConductState;
  bus: EventBus<EventMap>;
  incidents: FakeIncidents;
  injuries: Map<number, number>;
  events: { topic: string; payload: unknown }[];
  game: number;
  step(game?: number): void;
}

const TOPICS = ['conduct:ia', 'conduct:iaResolved', 'conduct:report', 'conduct:commendation', 'conduct:discipline', 'conduct:status', 'conduct:trust', 'conduct:points'] as const;

export function harness(opts: { seed?: number; configs?: Partial<ConductConfigs>; district?: string } = {}): Harness {
  const bus = new EventBus<EventMap>();
  const incidents = new FakeIncidents();
  const injuries = new Map<number, number>();
  const events: { topic: string; payload: unknown }[] = [];
  for (const topic of TOPICS) bus.on(topic, (payload) => events.push({ topic, payload }));
  const deps: ConductDeps = {
    bus, rng: createRng(opts.seed ?? 7).stream('conduct'), incidents, districtOf: () => opts.district ?? 'downtown',
    injuryOf: (id) => injuries.get(id) ?? 0, ...(opts.configs ? { configs: opts.configs } : {}),
  };
  const state = new ConductState(deps);
  const h: Harness = {
    state, bus, incidents, injuries, events, game: 100_000,
    step(game) {
      if (game !== undefined) h.game = game;
      state.step(1 / 60, { sim: h.game / 30, game: h.game });
    },
  };
  h.step();
  return h;
}

export function topics(h: Harness, topic: string): unknown[] {
  return h.events.filter((e) => e.topic === topic).map((e) => e.payload);
}

/** Appends a service event at sim time `t` (the log builder has none). */
export function addService(log: IncidentLog, t: number, service: string, phase: 'requested' | 'arrived'): IncidentLog {
  const id = Math.max(0, ...log.events.map((e) => e.id)) + 1;
  log.events.push({ id, t, game: 1000 + t, personId: -1, cam: 1, kind: 'service', service, phase });
  log.events.sort((a, b) => a.t - b.t || a.id - b.id);
  return log;
}
