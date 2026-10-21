import { evaluateIncident } from '../../src/legal/evaluate';
import { getRuleset } from '../../src/legal/ruleset';
import {
  CAM,
  type ClaimedBasis,
  type ConsentKind,
  type Determination,
  type Doctrine,
  type ForceLevel,
  type FoundItem,
  type IncidentEvent,
  type IncidentLog,
  type IndicatorSource,
  type LegalAssessment,
  type Resistance,
  type Ruleset,
  type SearchTarget,
} from '../../src/legal/types';

/** The force tool id (src/force FORCE_TOOLS) a level is normally applied with. */
const TOOL_OF: Readonly<Record<ForceLevel, string>> = {
  presence: 'none', verbal: 'none', softHands: 'hands', hardHands: 'hands', ocSpray: 'ocSpray', baton: 'baton', taser: 'taser',
  k9: 'k9', lessLethal: 'lessLethal', firearm: 'firearm',
};

/** Event specs without the base fields the builder fills in. */
type Spec<K extends IncidentEvent['kind']> = Omit<Extract<IncidentEvent, { kind: K }>, 'id' | 't' | 'game' | 'personId' | 'cam'>;

/** Builds valid incident logs: ids in call order, current time and camera bits stamped on every event. */
export class LogBuilder {
  private readonly key: string;
  private readonly family: string;
  private readonly events: IncidentEvent[] = [];
  private readonly people: { personId: number; role: string; label: string }[] = [];
  private time = 0;
  private bits: number = CAM.body;
  private nextId = 1;

  constructor(key = 'C-00001', family = 'trafficStop') {
    this.key = key;
    this.family = family;
  }

  /** Id of the most recently added event. */
  get lastId(): number {
    return this.nextId - 1;
  }

  at(t: number): this {
    this.time = t;
    return this;
  }

  /** Advances the clock. */
  after(dt: number): this {
    this.time += dt;
    return this;
  }

  private add<K extends IncidentEvent['kind']>(pid: number, spec: Spec<K> & { kind: K }): this {
    const e = { id: this.nextId++, t: this.time, game: 1000 + this.time, personId: pid, cam: this.bits, ...spec } as unknown as IncidentEvent;
    this.events.push(e);
    return this;
  }

  start(): this {
    return this.add(-1, { kind: 'start', callId: 1, typeId: 'test', family: this.family, field: false });
  }

  person(pid: number, role: string, label = `Person ${pid}`): this {
    this.people.push({ personId: pid, role, label });
    return this.add(pid, { kind: 'person', role, label });
  }

  indicator(pid: number, indicator: string, source: IndicatorSource = 'observation', sourceEvent = -1): this {
    return this.add(pid, { kind: 'indicator', indicator, source, sourceEvent, detail: '' });
  }

  detain(pid: number, how: 'trafficStop' | 'command' | 'cuffed' | 'takedown' | 'other' = 'trafficStop'): this {
    return this.add(pid, { kind: 'detention', how });
  }

  consent(
    pid: number, consent: ConsentKind, granted = true, valid = true,
    opts: { weaponDrawn?: boolean; aggressiveLines?: number; buildingId?: number } = {},
  ): this {
    return this.add(pid, {
      kind: 'consent', consent, granted, valid, weaponDrawn: opts.weaponDrawn ?? false,
      aggressiveLines: opts.aggressiveLines ?? 0, buildingId: opts.buildingId ?? -1,
    });
  }

  frisk(pid: number, found: FoundItem[] = []): this {
    return this.add(pid, { kind: 'frisk', found });
  }

  search(
    pid: number, target: SearchTarget, found: FoundItem[] = [],
    opts: { claimedBasis?: ClaimedBasis | null; buildingId?: number; vehicleId?: number } = {},
  ): this {
    return this.add(pid, {
      kind: 'search', target, claimedBasis: opts.claimedBasis ?? null, found, buildingId: opts.buildingId ?? -1, vehicleId: opts.vehicleId ?? -1,
    });
  }

  seize(pid: number, item: FoundItem, fromEvent: number): this {
    return this.add(pid, { kind: 'seizure', item, fromEvent });
  }

  test(pid: number, test: 'pbt' | 'sfst', result: 'over' | 'under' | 'fail' | 'pass' = 'over'): this {
    return this.add(pid, { kind: 'test', test, result });
  }

  arrest(pid: number, how: 'cuff' | 'booking' = 'cuff'): this {
    return this.add(pid, { kind: 'arrest', how });
  }

  release(pid: number, how: 'release' | 'warn' | 'citation' | 'uncuff' = 'release'): this {
    return this.add(pid, { kind: 'release', how });
  }

  question(pid: number, fact: string, custody = false, gunpoint = false): this {
    return this.add(pid, { kind: 'question', fact, utterance: `Tell me about ${fact}`, custody, gunpoint });
  }

  statement(pid: number, fact: string, value = 'yes', custody = false): this {
    return this.add(pid, { kind: 'statement', fact, value, display: `${fact}: ${value}`, custody });
  }

  miranda(pid: number, result: 'waived' | 'invoked' | 'misunderstood', custody = true): this {
    return this.add(pid, { kind: 'miranda', result, custody });
  }

  force(
    pid: number, level: ForceLevel, resistance: Resistance,
    opts: { tool?: string; cycle?: number; riskFactors?: string[]; restrained?: boolean } = {},
  ): this {
    return this.add(pid, {
      kind: 'force', forceId: this.nextId, tool: opts.tool ?? TOOL_OF[level], level, resistance, hit: true, injury: 0, fatal: false,
      cycle: opts.cycle ?? 1, riskFactors: opts.riskFactors ?? [], distance: 2, restrained: opts.restrained ?? false,
    });
  }

  other(pid: number, level: ForceLevel, resistance: Resistance, distanceToOfficer: number, opts: { officer?: string; restrained?: boolean } = {}): this {
    return this.add(pid, {
      kind: 'otherForce', officer: opts.officer ?? 'Partner', level, resistance, distanceToOfficer, seq: 1, restrained: opts.restrained ?? false,
    });
  }

  intervene(otherEvent: number, pid = -1): this {
    return this.add(pid, { kind: 'intervene', otherEvent });
  }

  entry(buildingId: number, publicPlace = false, pid = -1): this {
    return this.add(pid, { kind: 'entry', buildingId, publicPlace });
  }

  exigency(reason = 'screaming inside', buildingId?: number): this {
    return this.add(-1, buildingId === undefined ? { kind: 'exigency', reason } : { kind: 'exigency', reason, buildingId });
  }

  warrant(scope: 'arrest' | 'search'): this {
    return this.add(-1, { kind: 'warrant', scope });
  }

  pursuit(pid: number, pursuit: 'vehicle' | 'foot' = 'vehicle'): this {
    return this.add(pid, { kind: 'pursuitStart', pursuit, pursuitCallId: 7 });
  }

  sample(
    pid: number, speedMph: number,
    opts: { limitMph?: number; district?: string; wet?: boolean; night?: boolean; lights?: boolean; siren?: boolean } = {},
  ): this {
    return this.add(pid, {
      kind: 'pursuitSample', speedMph, limitMph: opts.limitMph ?? 35, district: opts.district ?? 'suburbs', wet: opts.wet ?? false,
      night: opts.night ?? false, lights: opts.lights ?? true, siren: opts.siren ?? true,
    });
  }

  pursuitEnd(pid: number, reason: string): this {
    return this.add(pid, { kind: 'pursuitEnd', reason });
  }

  advisory(advisory: 'terminatePursuit' | 'activateBodycam' = 'terminatePursuit', pid = -1): this {
    return this.add(pid, { kind: 'advisory', advisory, text: advisory });
  }

  command(pid: number, command: string, outcome = 'complied'): this {
    return this.add(pid, { kind: 'command', command, outcome });
  }

  charges(pid: number, statutes: string[], docId = 'B-0001'): this {
    return this.add(pid, { kind: 'charges', statutes, docId });
  }

  service(service: string, phase: 'requested' | 'arrived' = 'requested', pid = -1): this {
    return this.add(pid, { kind: 'service', service, phase });
  }

  close(disposition = 'report', outcomeId = 'done'): this {
    return this.add(-1, { kind: 'close', disposition, outcomeId });
  }

  /** Sets the camera bits for later events and records a camera event. */
  cam(body: boolean, muted = false, dash = false): this {
    this.bits = (body ? CAM.body : 0) | (muted ? CAM.muted : 0) | (dash ? CAM.dash : 0);
    return this.add(-1, { kind: 'cam', body, muted, dash });
  }

  /** Sets the camera bits without recording a camera event. */
  bitsOnly(bits: number): this {
    this.bits = bits;
    return this;
  }

  build(): IncidentLog {
    const events = [...this.events].sort((a, b) => a.t - b.t || a.id - b.id);
    return {
      key: this.key, callId: 1, typeId: 'test', family: this.family, district: 'suburbs', openedSim: 0, openedGame: 1000,
      closed: true, closedSim: this.time, closedGame: 1000 + this.time, events, people: [...this.people], reports: [],
    };
  }
}

export function item(ref: string, category: string, label = `${category} ${ref}`): FoundItem {
  return { ref, item: category, label, category, weapon: category === 'weapon', incriminating: true };
}

export const drugs = (ref = 'i1'): FoundItem => item(ref, 'drugs', 'Baggie of pills');
export const gun = (ref = 'g1'): FoundItem => item(ref, 'weapon', 'Handgun');

export function evaluate(log: IncidentLog, rulesetId = 'generic'): LegalAssessment {
  return evaluateIncident(log, getRuleset(rulesetId));
}

export function both(log: IncidentLog): { generic: LegalAssessment; strict: LegalAssessment } {
  return { generic: evaluate(log, 'generic'), strict: evaluate(log, 'strict') };
}

export function dets(a: LegalAssessment, doctrine: Doctrine): Determination[] {
  return a.determinations.filter((d) => d.doctrine === doctrine);
}

/** The only determination of a doctrine (fails the test when there is not exactly one). */
export function one(a: LegalAssessment, doctrine: Doctrine): Determination {
  const list = dets(a, doctrine);
  if (list.length !== 1 || !list[0]) throw new Error(`expected exactly one ${doctrine} determination, got ${list.length}`);
  return list[0];
}

export function rulesetCopy(id: string, change: (rs: Ruleset) => void): Ruleset {
  const rs = structuredClone(getRuleset(id));
  change(rs);
  return rs;
}
