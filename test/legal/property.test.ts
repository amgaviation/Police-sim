import { describe, expect, it } from 'vitest';
import { createRng, type Rng } from '../../src/core/rng';
import { evaluateIncident } from '../../src/legal/evaluate';
import { buildReportChoices } from '../../src/legal/report';
import { getRuleset, rulesetIds } from '../../src/legal/ruleset';
import {
  CAM,
  CLAIMED_BASES,
  CONSENT_KINDS,
  FORCE_LEVELS,
  INCIDENT_EVENT_KINDS,
  INDICATOR_SOURCES,
  INDICATORS,
  RESISTANCE_LEVELS,
  SEARCH_TARGETS,
  type FoundItem,
  type IncidentEvent,
  type IncidentEventKind,
  type IncidentLog,
  type LegalAssessment,
} from '../../src/legal/types';

/**
 * Property tests (Phase 9 §10): 200 seeded random incident logs per ruleset. The generator emits well-formed events of
 * every kind with ids and times that only grow and persons 1..3 (plus -1, the incident as a whole).
 */

const LOGS_PER_RULESET = 200;
const ROLES = ['driver', 'passenger', 'suspect', 'victim', 'witness', 'subject'] as const;
const FACTS = ['account', 'drinking', 'drugs', 'weapons', 'vehicleContents', 'origin', 'identity', 'height'] as const;
const CATEGORIES = ['drugs', 'weapon', 'property', 'paraphernalia', 'document'] as const;
const TOOLS = ['none', 'hands', 'ocSpray', 'baton', 'taser', 'k9', 'lessLethal', 'firearm', 'firearmDisplay'] as const;
const RISKS = ['elderly', 'pregnant', 'elevated', 'running', 'restrained', 'juvenile', 'hot'] as const;
const DISTRICTS = ['downtown', 'suburbs', 'campus', 'harbor', 'park', 'unknown'] as const;
const STATUTES = ['TR-301', 'TR-360', 'PC-260', 'PC-262', 'PC-221'] as const;

/** Kinds drawn after the opening `start` and `person` events, with weights that keep every kind common enough. */
const KIND_WEIGHTS: Readonly<Record<Exclude<IncidentEventKind, 'start'>, number>> = {
  person: 1, indicator: 10, detention: 5, command: 2, question: 5, statement: 5, miranda: 2, consent: 4, frisk: 3, search: 5,
  seizure: 3, test: 2, arrest: 4, charges: 1, release: 2, force: 5, otherForce: 3, intervene: 2, entry: 3, exigency: 2, warrant: 1,
  service: 1, pursuitStart: 2, pursuitSample: 6, pursuitEnd: 2, advisory: 2, cam: 3, close: 1,
};
const WEIGHTED_KINDS: IncidentEventKind[] = [];
for (const [kind, weight] of Object.entries(KIND_WEIGHTS)) for (let i = 0; i < weight; i++) WEIGHTED_KINDS.push(kind as IncidentEventKind);

function pick<T>(rng: Rng, list: readonly T[]): T {
  const v = list[rng.nextInt(0, list.length - 1)];
  if (v === undefined) throw new Error('pick from an empty list');
  return v;
}

interface Gen {
  rng: Rng;
  persons: number[];
  nextId: number;
  nextRef: number;
  bits: number;
  ids: number[];
}

function person(g: Gen): number {
  return pick(g.rng, g.persons);
}

/** A person, or -1 (the incident as a whole) one time in `oneIn`. */
function personOrAll(g: Gen, oneIn: number): number {
  return g.rng.nextInt(1, oneIn) === 1 ? -1 : person(g);
}

function earlierId(g: Gen): number {
  return g.ids.length > 0 && g.rng.chance(0.85) ? pick(g.rng, g.ids) : -1;
}

function found(g: Gen): FoundItem[] {
  const out: FoundItem[] = [];
  const n = g.rng.nextInt(0, 2);
  for (let i = 0; i < n; i++) {
    const category = pick(g.rng, CATEGORIES);
    out.push({ ref: `r${g.nextRef++}`, item: category, label: `${category} item`, category, weapon: category === 'weapon', incriminating: g.rng.chance(0.8) });
  }
  return out;
}

/** One event of `kind`; the caller stamps id, time, game time and camera bits. */
function payload(g: Gen, kind: Exclude<IncidentEventKind, never>): { personId: number; spec: Record<string, unknown> } {
  const r = g.rng;
  switch (kind) {
    case 'start': return { personId: -1, spec: { callId: 1, typeId: 'test', family: pick(r, ['trafficStop', 'domestic', 'violent', 'dui', 'pursuit', 'wanted', 'unknown']), field: r.chance(0.5) } };
    case 'person': return { personId: person(g), spec: { role: pick(r, ROLES), label: 'Someone' } };
    case 'indicator': return { personId: personOrAll(g, 5), spec: { indicator: r.chance(0.04) ? 'notAnIndicator' : pick(r, INDICATORS), source: pick(r, INDICATOR_SOURCES), sourceEvent: earlierId(g), detail: '' } };
    case 'detention': return { personId: person(g), spec: { how: pick(r, ['trafficStop', 'command', 'cuffed', 'takedown', 'other']) } };
    case 'command': return { personId: person(g), spec: { command: 'stepOut', outcome: pick(r, ['complied', 'refused', 'fled']) } };
    case 'question': return { personId: person(g), spec: { fact: pick(r, FACTS), utterance: 'Tell me', custody: r.chance(0.4), gunpoint: r.chance(0.15) } };
    case 'statement': return { personId: person(g), spec: { fact: pick(r, FACTS), value: 'yes', display: 'a statement', custody: r.chance(0.4) } };
    case 'miranda': return { personId: person(g), spec: { result: pick(r, ['waived', 'invoked', 'misunderstood']), custody: r.chance(0.7) } };
    case 'consent': return { personId: person(g), spec: { consent: pick(r, CONSENT_KINDS), granted: r.chance(0.8), valid: r.chance(0.9), weaponDrawn: r.chance(0.1), aggressiveLines: r.nextInt(0, 4), buildingId: r.chance(0.5) ? -1 : r.nextInt(1, 3) } };
    case 'frisk': return { personId: person(g), spec: { found: found(g) } };
    case 'search': return { personId: person(g), spec: { target: pick(r, SEARCH_TARGETS), claimedBasis: r.chance(0.4) ? null : pick(r, CLAIMED_BASES), found: found(g), buildingId: r.chance(0.5) ? -1 : r.nextInt(1, 3), vehicleId: r.chance(0.5) ? -1 : 4 } };
    case 'seizure': {
      const item = found(g)[0] ?? { ref: `r${g.nextRef++}`, item: 'drugs', label: 'drugs item', category: 'drugs', weapon: false, incriminating: true };
      return { personId: person(g), spec: { item, fromEvent: earlierId(g) } };
    }
    case 'test': return { personId: person(g), spec: { test: pick(r, ['pbt', 'sfst']), result: pick(r, ['over', 'under', 'fail', 'pass']) } };
    case 'arrest': return { personId: person(g), spec: { how: pick(r, ['cuff', 'booking']) } };
    case 'charges': return { personId: person(g), spec: { statutes: [pick(r, STATUTES)], docId: 'B-0001' } };
    case 'release': return { personId: person(g), spec: { how: pick(r, ['release', 'warn', 'citation', 'uncuff']) } };
    case 'force': return {
      personId: person(g),
      spec: {
        forceId: g.nextId, tool: pick(r, TOOLS), level: pick(r, FORCE_LEVELS), resistance: pick(r, RESISTANCE_LEVELS), hit: r.chance(0.8), injury: r.nextInt(0, 3),
        fatal: r.chance(0.02), cycle: r.nextInt(1, 5), riskFactors: RISKS.filter(() => r.chance(0.15)), distance: r.nextFloat(0.5, 20), restrained: r.chance(0.15),
      },
    };
    case 'otherForce': return { personId: person(g), spec: { officer: pick(r, ['Partner', 'Officer Lee']), level: pick(r, FORCE_LEVELS), resistance: pick(r, RESISTANCE_LEVELS), distanceToOfficer: r.nextFloat(0, 30), seq: r.nextInt(1, 9), restrained: r.chance(0.15) } };
    case 'intervene': return { personId: personOrAll(g, 2), spec: { otherEvent: earlierId(g) } };
    case 'entry': return { personId: personOrAll(g, 2), spec: { buildingId: r.nextInt(1, 3), publicPlace: r.chance(0.3) } };
    case 'exigency': return r.chance(0.5)
      ? { personId: -1, spec: { reason: 'screaming inside' } }
      : { personId: -1, spec: { reason: 'screaming inside', buildingId: r.nextInt(1, 3) } };
    case 'warrant': return { personId: -1, spec: { scope: pick(r, ['arrest', 'search']) } };
    case 'service': return { personId: -1, spec: { service: pick(r, ['ems', 'fire', 'k9']), phase: pick(r, ['requested', 'arrived']) } };
    case 'pursuitStart': return { personId: person(g), spec: { pursuit: pick(r, ['vehicle', 'vehicle', 'foot']), pursuitCallId: 7 } };
    case 'pursuitSample': return {
      personId: person(g),
      spec: { speedMph: r.nextFloat(10, 110), limitMph: pick(r, [25, 35, 45, 65]), district: pick(r, DISTRICTS), wet: r.chance(0.3), night: r.chance(0.3), lights: r.chance(0.9), siren: r.chance(0.9) },
    };
    case 'pursuitEnd': return { personId: person(g), spec: { reason: pick(r, ['arrest', 'lost', 'terminated', 'handoff', 'crash']) } };
    case 'advisory': return { personId: personOrAll(g, 2), spec: { advisory: pick(r, ['terminatePursuit', 'activateBodycam']), text: 'advisory' } };
    case 'cam': {
      const body = r.chance(0.7);
      const muted = r.chance(0.2);
      const dash = r.chance(0.5);
      g.bits = (body ? CAM.body : 0) | (muted ? CAM.muted : 0) | (dash ? CAM.dash : 0);
      return { personId: -1, spec: { body, muted, dash } };
    }
    case 'close': return { personId: -1, spec: { disposition: 'report', outcomeId: 'done' } };
  }
}

/** A random well-formed incident log of `size` events (the opening start and person events included). */
function randomLog(rng: Rng, index: number, size: number): IncidentLog {
  const nPersons = rng.nextInt(1, 3);
  const g: Gen = { rng, persons: Array.from({ length: nPersons }, (_, i) => i + 1), nextId: 1, nextRef: 1, bits: CAM.body, ids: [], };
  const events: IncidentEvent[] = [];
  let t = 0;
  const push = (kind: IncidentEventKind, forced?: { personId: number; spec: Record<string, unknown> }): void => {
    const { personId, spec } = forced ?? payload(g, kind);
    const id = g.nextId++;
    events.push({ id, t, game: 1000 + t, personId, cam: g.bits, kind, ...spec } as unknown as IncidentEvent);
    g.ids.push(id);
  };
  push('start');
  const people = g.persons.map((personId) => ({ personId, role: pick(rng, ROLES), label: `Person ${personId}` }));
  for (const p of people) {
    t += rng.nextFloat(0, 2);
    push('person', { personId: p.personId, spec: { role: p.role, label: p.label } });
  }
  while (events.length < size) {
    t += rng.chance(0.2) ? 0 : rng.nextFloat(0.2, 14);
    push(pick(rng, WEIGHTED_KINDS));
  }
  const closed = rng.chance(0.5);
  return {
    key: `P-${String(index).padStart(5, '0')}`, callId: 1, typeId: 'test', family: pick(rng, ['trafficStop', 'domestic', 'violent', 'dui', 'pursuit', 'wanted', 'unknown']),
    district: pick(rng, DISTRICTS), openedSim: 0, openedGame: 1000, closed, closedSim: closed ? t : -1, closedGame: closed ? 1000 + t : -1,
    events, people, reports: [],
  };
}

function logsFor(rulesetId: string): IncidentLog[] {
  const rng = createRng('legal-prop').stream(rulesetId);
  return Array.from({ length: LOGS_PER_RULESET }, (_, i) => randomLog(rng, i, rng.nextInt(4, 70)));
}

function eventIds(log: IncidentLog): Set<number> {
  return new Set(log.events.map((e) => e.id));
}

/** Every event id a ruling of the assessment points at. */
function referencedIds(a: LegalAssessment): number[] {
  return [
    ...a.determinations.flatMap((d) => [d.eventId, ...d.eventIds]),
    ...a.evidence.map((e) => e.eventId),
    ...a.force.map((f) => f.eventId),
    ...a.pursuits.map((p) => p.startEventId),
  ];
}

describe('the random log generator', () => {
  const logs = logsFor('generic');

  it('is deterministic for a seed and differs between seeds', () => {
    expect(logsFor('generic')).toEqual(logs);
    expect(logsFor('strict')).not.toEqual(logs);
  });

  it('emits well-formed events: ids and times only grow, persons are 1..3 or -1', () => {
    expect(logs).toHaveLength(LOGS_PER_RULESET);
    for (const log of logs) {
      let prevId = 0;
      let prevT = -1;
      for (const e of log.events) {
        expect(e.id).toBe(prevId + 1);
        expect(e.t).toBeGreaterThanOrEqual(prevT);
        expect(e.game).toBe(1000 + e.t);
        expect([-1, 1, 2, 3]).toContain(e.personId);
        prevId = e.id;
        prevT = e.t;
      }
      expect(log.events[0]?.kind).toBe('start');
      expect(log.people.length).toBeGreaterThanOrEqual(1);
      expect(log.people.length).toBeLessThanOrEqual(3);
    }
  });

  it('emits every kind of INCIDENT_EVENT_KINDS, and every consent kind, search target and claimed basis', () => {
    const kinds = new Set<string>();
    const consents = new Set<string>();
    const targets = new Set<string>();
    const bases = new Set<string>();
    const sources = new Set<string>();
    for (const log of logs) {
      for (const e of log.events) {
        kinds.add(e.kind);
        if (e.kind === 'consent') consents.add(e.consent);
        if (e.kind === 'search') {
          targets.add(e.target);
          if (e.claimedBasis) bases.add(e.claimedBasis);
        }
        if (e.kind === 'indicator') sources.add(e.source);
      }
    }
    expect([...kinds].sort()).toEqual([...INCIDENT_EVENT_KINDS].sort());
    expect([...consents].sort()).toEqual([...CONSENT_KINDS].sort());
    expect([...targets].sort()).toEqual([...SEARCH_TARGETS].sort());
    expect([...bases].sort()).toEqual([...CLAIMED_BASES].sort());
    expect([...sources].sort()).toEqual([...INDICATOR_SOURCES].sort());
  });
});

describe.each(rulesetIds())('evaluateIncident properties: %s', (rulesetId) => {
  const rs = getRuleset(rulesetId);
  const logs = logsFor(rulesetId);
  const rules = new Set(rs.rules.map((r) => r.id));

  it('never throws and is deterministic', () => {
    for (const log of logs) {
      let first: LegalAssessment | null = null;
      expect(() => {
        first = evaluateIncident(log, rs);
      }, log.key).not.toThrow();
      expect(evaluateIncident(log, rs), log.key).toEqual(first);
    }
  });

  it('does not modify the log', () => {
    for (const log of logs.slice(0, 40)) {
      const before = structuredClone(log);
      evaluateIncident(log, rs);
      expect(log, log.key).toEqual(before);
    }
  });

  it('references only event ids and rule ids that exist', () => {
    for (const log of logs) {
      const a = evaluateIncident(log, rs);
      const ids = eventIds(log);
      expect(a.rulesetId).toBe(rulesetId);
      expect(a.key).toBe(log.key);
      for (const id of referencedIds(a)) expect(ids.has(id), `${log.key}: event ${id}`).toBe(true);
      const cited = [
        ...a.determinations.flatMap((d) => d.ruleIds),
        ...a.evidence.flatMap((e) => e.ruleIds),
        ...a.force.flatMap((f) => f.ruleIds),
        ...a.pursuits.flatMap((p) => p.ruleIds),
      ];
      for (const id of cited) expect(rules.has(id), `${log.key}: rule ${id}`).toBe(true);
      for (const d of a.determinations) {
        expect(d.eventIds.length).toBeGreaterThan(0);
        expect(d.reason.length).toBeGreaterThan(0);
        expect(d.ruleIds.length).toBeGreaterThan(0);
        expect([-1, 1, 2, 3]).toContain(d.personId);
      }
      expect(new Set(a.determinations.map((d) => d.id)).size).toBe(a.determinations.length);
    }
  });

  it('has summary counts that equal recounts of the arrays', () => {
    for (const log of logs) {
      const a = evaluateIncident(log, rs);
      const judged = a.determinations.filter((d) => d.doctrine !== 'force' && d.doctrine !== 'recording');
      const recording = a.determinations.filter((d) => d.doctrine === 'recording');
      const own = a.force.filter((f) => !f.other);
      const unlawful = judged.filter((d) => d.outcome === 'unlawful').length;
      const questionable = judged.filter((d) => d.outcome === 'questionable').length;
      const excessive = own.filter((f) => f.verdict === 'excessive').length;
      const questionableForce = own.filter((f) => f.verdict === 'questionable').length;
      const recordingUnlawful = recording.filter((d) => d.outcome === 'unlawful').length;
      const raw = 100 - 15 * unlawful - 8 * recordingUnlawful - 10 * questionable - 10 * questionableForce - 30 * excessive;
      expect(a.summary, log.key).toEqual({
        unlawful, questionable, suppressed: a.evidence.filter((e) => !e.admissible).length, excessiveForce: excessive, questionableForce,
        score: Math.max(0, Math.min(100, Math.round(raw))),
      });
      expect(a.summary.score).toBeGreaterThanOrEqual(0);
      expect(a.summary.score).toBeLessThanOrEqual(100);
    }
  });

  it('taints every suppressed evidence ruling to an event of the log and keeps admissible ones clean', () => {
    let suppressed = 0;
    for (const log of logs) {
      const a = evaluateIncident(log, rs);
      const ids = eventIds(log);
      for (const e of a.evidence) {
        if (e.admissible) {
          expect(e.taintedBy, `${log.key} admissible ${e.ref}`).toBe(-1);
        } else {
          suppressed++;
          expect(ids.has(e.taintedBy), `${log.key}: ${e.ref} tainted by ${e.taintedBy}`).toBe(true);
          expect(e.taintedBy).toBeLessThanOrEqual(e.eventId);
          expect(e.ruleIds.length).toBeGreaterThan(0);
        }
      }
    }
    expect(suppressed).toBeGreaterThan(20);
  });

  it('never rules on an event outside an evaluated prefix', () => {
    const rng = createRng('legal-prop').stream(`prefix:${rulesetId}`);
    for (const log of logs) {
      const cut = rng.nextInt(0, log.events.length);
      const prefix: IncidentLog = { ...log, events: log.events.slice(0, cut) };
      const a = evaluateIncident(prefix, rs);
      const ids = eventIds(prefix);
      for (const id of referencedIds(a)) expect(ids.has(id), `${log.key} prefix ${cut}: event ${id}`).toBe(true);
      for (const e of a.evidence) if (!e.admissible) expect(ids.has(e.taintedBy)).toBe(true);
    }
  });

  it('rules on a longer prefix at least as many events as a shorter one for determinations without a later cause', () => {
    // Determinations about an event are fixed when the event happens; only recording, pursuits and inevitable
    // discovery look ahead. Detentions, frisks and consents never change with later events.
    const stable = new Set(['detention', 'frisk', 'consent', 'arrest', 'test']);
    for (const log of logs.slice(0, 60)) {
      const half: IncidentLog = { ...log, events: log.events.slice(0, Math.floor(log.events.length / 2)) };
      const a = evaluateIncident(half, rs);
      const b = evaluateIncident(log, rs);
      for (const d of a.determinations) {
        if (!stable.has(d.doctrine)) continue;
        const same = b.determinations.find((x) => x.doctrine === d.doctrine && x.eventId === d.eventId);
        expect(same?.outcome, `${log.key}: ${d.doctrine} #${d.eventId}`).toBe(d.outcome);
      }
    }
  });

  it('does not depend on the identity of the ruleset object', () => {
    for (const log of logs.slice(0, 40)) expect(evaluateIncident(log, structuredClone(rs)), log.key).toEqual(evaluateIncident(log, rs));
  });

  it('is not changed by events that never judge (commands, services, charges, the close) appended at the same time', () => {
    for (const log of logs.slice(0, 80)) {
      const last = log.events[log.events.length - 1];
      if (!last) continue;
      const base = { t: last.t, game: last.game, personId: -1, cam: last.cam };
      const extra: IncidentEvent[] = [
        { ...base, id: last.id + 1, kind: 'command', command: 'stepOut', outcome: 'complied' },
        { ...base, id: last.id + 2, kind: 'service', service: 'ems', phase: 'requested' },
        { ...base, id: last.id + 3, kind: 'charges', statutes: ['PC-260'], docId: 'B-0009' },
        { ...base, id: last.id + 4, kind: 'close', disposition: 'report', outcomeId: 'done' },
      ];
      const longer: IncidentLog = { ...log, events: [...log.events, ...extra] };
      expect(evaluateIncident(longer, rs), log.key).toEqual(evaluateIncident(log, rs));
    }
  });

  it('is not changed by shifting every time of the incident', () => {
    const shape = (a: LegalAssessment): unknown => ({
      d: a.determinations.map((d) => [d.doctrine, d.eventId, d.eventIds, d.outcome, d.ruleIds, d.basis]),
      e: a.evidence.map((e) => [e.eventId, e.admissible, e.taintedBy, e.ruleIds]),
      f: a.force, p: a.pursuits.map((x) => [x.startEventId, x.outcome, x.ruleIds, Math.round(x.overLimitS * 1e6), Math.round(x.durationS * 1e6)]), s: a.summary, persons: a.persons,
    });
    for (const log of logs.slice(0, 60)) {
      const shifted: IncidentLog = {
        ...log, openedSim: log.openedSim + 5000, openedGame: log.openedGame + 5000,
        events: log.events.map((e) => ({ ...e, t: e.t + 5000, game: e.game + 5000 })),
      };
      expect(shape(evaluateIncident(shifted, rs)), log.key).toEqual(shape(evaluateIncident(log, rs)));
    }
  });

  it('builds deterministic report choices whose key choices are all true', () => {
    for (const log of logs) {
      const a = evaluateIncident(log, rs);
      const choices = buildReportChoices(log, a, rs, 4242);
      expect(buildReportChoices(log, a, rs, 4242), log.key).toEqual(choices);
      const ids = eventIds(log);
      const seen = new Set<string>();
      const trueInGroup = new Map<string, number>();
      for (const c of choices) {
        if (c.key) expect(c.truth, `${log.key}: key choice ${c.id}`).toBe('true');
        expect(c.eventId === -1 || ids.has(c.eventId), `${log.key}: ${c.id} event ${c.eventId}`).toBe(true);
        expect(c.text.length).toBeGreaterThan(0);
        expect(seen.has(c.id), `${log.key}: duplicate choice id ${c.id}`).toBe(false);
        seen.add(c.id);
        if (c.group !== null && c.truth === 'true') trueInGroup.set(c.group, (trueInGroup.get(c.group) ?? 0) + 1);
      }
      for (const [group, n] of trueInGroup) expect(n, `${log.key}: group ${group}`).toBe(1);
    }
  });

  it('keeps report distractors seed-dependent only for the distractors', () => {
    for (const log of logs.slice(0, 40)) {
      const a = evaluateIncident(log, rs);
      const one = buildReportChoices(log, a, rs, 1);
      const two = buildReportChoices(log, a, rs, 2);
      const truths = (list: typeof one): string[] => list.filter((c) => c.truth === 'true').map((c) => c.id);
      expect(truths(two), log.key).toEqual(truths(one));
      expect(two.filter((c) => c.key).map((c) => c.id), log.key).toEqual(one.filter((c) => c.key).map((c) => c.id));
    }
  });

  it('evaluates a 600-event log in under 5 ms', () => {
    const rng = createRng('legal-prop').stream(`big:${rulesetId}`);
    const big = Array.from({ length: 6 }, (_, i) => randomLog(rng, 900 + i, 600));
    for (const log of big) {
      expect(log.events.length).toBeGreaterThanOrEqual(600);
      for (let i = 0; i < 10; i++) evaluateIncident(log, rs);
      let best = Infinity;
      for (let run = 0; run < 5; run++) {
        const start = performance.now();
        for (let i = 0; i < 10; i++) evaluateIncident(log, rs);
        best = Math.min(best, (performance.now() - start) / 10);
      }
      expect(best, `${log.key} took ${best.toFixed(2)} ms`).toBeLessThan(5);
    }
  });
});
