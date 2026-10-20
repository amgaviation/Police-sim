import type { CadTime } from '../cad/types';
import { callNumber } from '../cad/cadState';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import { hashString, normalizeSeed } from '../core/rng';
import {
  CAM,
  FORCE_LEVELS,
  RESISTANCE_LEVELS,
  evaluateIncident,
  forceVerdict,
  getRuleset,
  buildReportChoices,
  pursuitAdvisory,
  type ClaimedBasis,
  type FoundItem,
  type ForceLevel,
  type IncidentEvent,
  type IncidentLog,
  type IndicatorSource,
  type LegalAssessment,
  type Offense,
  type ReportChoice,
  type Resistance,
  type Ruleset,
  type StartEvent,
} from '../legal';
import type { ContactActionItem } from '../contact/events';
import { INCIDENT_MAPPING, type FactRow, type IncidentMapping } from './mapping';
import { indKey, itemDetail, mergeSorted, newRt, note, rebuild, type Rt } from './logState';
import { emptyIncidentsSave, type IncidentsSave } from './save';
import type { DashProbe, IncidentDeps, IncidentPorts, IncidentRequest, IncidentSource, OfficerProbe, PursuitProbe } from './types';
import './events';

/** Seconds a log counts as "recently active" for camera events and as the `current` incident. */
const RECENT_S = 120;
const MAX_EVENTS = 600;
/** Beyond this many samples of one pursuit only every second sample is kept. */
const SAMPLE_THIN_AT = 240;
const SAMPLE_PERIOD_S = 1;
const RING_MAX = 64;
const RING_S = 300;
/** A field contact / ad hoc incident without events for this long is closed. */
const IDLE_CLOSE_S = 600;
const MAX_CLOSED = 24;
const DAY_S = 86400;
/** A fact and the action that produced it are matched when they are at most this far apart. */
const LINK_S = 5;
/** A live exigency is logged again after this many seconds (the engine lets one lapse after the ruleset window). */
const EXIGENCY_REFRESH_S = 60;
/** A scene `sidearmDrawn` and the force system's display event are one event when this close. */
const DISPLAY_MERGE_S = 0.5;
const MAX_PENDING_PLATES = 16;
/** Event kinds that may be evicted to make room at the event cap. */
const DROPPABLE: readonly string[] = ['pursuitSample', 'cam', 'command', 'service'];

type Draft<E> = E extends IncidentEvent ? Omit<E, 'id' | 't' | 'game' | 'cam'> : never;
type DraftEvent = Draft<IncidentEvent>;

/** A fact whose indicator waits for the action that produced it (the contact emits the fact first). */
interface PendingFact {
  key: string;
  personId: number;
  indicator: string;
  kind: 'test' | 'find';
  test: string;
  detail: string;
  sim: number;
}

interface Sampler {
  key: string;
  callId: number;
  nextSampleSim: number;
  advised: boolean;
}

interface PState {
  agg: number;
  rank: number;
}

const TOOL_LABELS: Readonly<Record<string, string>> = {
  none: 'Presence', hands: 'Hands', ocSpray: 'OC spray', baton: 'Baton', taser: 'TASER', lessLethal: 'Less-lethal launcher',
  firearm: 'Firearm', k9: 'K9', firearmDisplay: 'Firearm display', tackle: 'Tackle', struggle: 'Struggle', cuffResisted: 'Cuffing struggle',
};

const VERDICT_TEXT = { justified: 'within policy', questionable: 'questionable', excessive: 'excessive' } as const;

function asLevel(s: string): ForceLevel {
  return (FORCE_LEVELS as readonly string[]).includes(s) ? (s as ForceLevel) : 'hardHands';
}

function asResistance(s: string): Resistance {
  return (RESISTANCE_LEVELS as readonly string[]).includes(s) ? (s as Resistance) : 'active';
}

function toFound(it: ContactActionItem | FoundItem): FoundItem {
  return { ref: it.ref, item: it.item, label: it.label, category: it.category, weapon: it.weapon, incriminating: it.incriminating };
}

function callIdOfKey(key: string): number {
  const m = /^C-(\d+)$/.exec(key);
  return m?.[1] ? Number(m[1]) : 0;
}

function isFieldKey(key: string): boolean {
  return key.startsWith('FC-') || key.startsWith('FI-');
}

/**
 * Turns bus events into `IncidentLog`s and runs the legal engine on them (Phase 5 design section 9). Event driven: the fixed step only
 * drains requests, tracks the camera bits, samples an active pursuit at 1 Hz, closes idle field contacts and assesses at most one
 * closed incident. Draws no randomness and reads no clock: every time stamp comes from the step or from a payload.
 */
export class IncidentSystem implements IncidentSource {
  private readonly bus: EventBus<EventMap>;
  private readonly ports: IncidentPorts;
  private readonly seed: number;
  private readonly mapping: IncidentMapping;
  private readonly callsign: string | undefined;
  private rs: Ruleset;
  private rsRev = 0;
  private rev = 0;

  private readonly logs = new Map<string, Rt>();
  private readonly aliases = new Map<string, string>();
  private readonly pstate = new Map<string, PState>();
  private readonly pending: PendingFact[] = [];
  private readonly pendingPlates = new Map<number, string[]>();
  private queue: IncidentRequest[] = [];
  private violations: { vehicleId: number; kind: string; sim: number }[] = [];
  private sampler: Sampler | null = null;
  private samplerOffense: Offense | null | undefined = undefined;
  private assessQueue: string[] = [];
  private nextEventId = 1;
  private nextAdhoc = 1;

  private now = 0;
  private simAtStep = 0;
  private gameAtStep = 0;
  private nextIdleCheck = 0;
  private lastKey = '';
  private lastKeySim = -1e9;
  private playerCall = 0;

  private body = false;
  private muted = false;
  private dashManual = false;
  private dashLights = false;
  private dashNear = false;
  private readonly camState = { body: false, muted: false, dash: false, bits: 0 };

  private readonly officerOut: OfficerProbe = { x: 0, z: 0, building: -1, inVehicle: false, weapon: 'none' };
  private readonly dashOut: DashProbe = { lights: false, nearCar: false };
  private readonly pursuitOut: PursuitProbe = { speedMph: 0, limitMph: 0, district: '', wet: false, night: false, lights: false, siren: false };

  private readonly assessCache = new Map<string, { version: number; rsRev: number; value: LegalAssessment }>();
  private readonly choiceCache = new Map<string, { version: number; rsRev: number; value: ReportChoice[] }>();
  private readonly offs: (() => void)[] = [];

  constructor(deps: IncidentDeps) {
    this.bus = deps.bus;
    this.ports = deps.ports;
    this.seed = deps.seed;
    this.mapping = deps.mapping ?? INCIDENT_MAPPING;
    this.callsign = deps.callsign;
    this.rs = getRuleset(deps.jurisdiction ?? 'generic');
    const b = this.bus;
    this.offs.push(
      b.on('scene:materialized', (e) => this.onMaterialized(e)),
      b.on('cad:trafficStop', (e) => this.onTrafficStop(e)),
      b.on('traffic:violation', (e) => this.onViolation(e)),
      b.on('dispatch:plateResult', (e) => this.onPlateResult(e)),
      b.on('dispatch:personResult', (e) => this.onPersonResult(e)),
      b.on('contact:fact', (e) => this.onFact(e)),
      b.on('contact:said', (e) => this.onSaid(e)),
      b.on('contact:consent', (e) => this.onConsent(e)),
      b.on('contact:action', (e) => this.onAction(e)),
      b.on('contact:miranda', (e) => this.onMiranda(e)),
      b.on('contact:event', (e) => this.onContactFlag(e)),
      b.on('npc:fled', (e) => this.onFled(e)),
      b.on('npc:attack', (e) => this.onAttack(e)),
      b.on('scene:command', (e) => this.onSceneCommand(e)),
      b.on('force:used', (e) => this.onForceUsed(e)),
      b.on('force:applied', (e) => this.onForceApplied(e)),
      b.on('force:other', (e) => this.onForceOther(e)),
      b.on('force:intervened', (e) => this.onIntervened(e)),
      b.on('investigation:found', (e) => this.onFound(e)),
      b.on('investigation:plainView', (e) => this.onPlainView(e)),
      b.on('investigation:collected', (e) => this.onCollected(e)),
      b.on('investigation:bodycam', (e) => this.setBody(e.on)),
      b.on('interior:transition', (e) => this.onTransition(e)),
      b.on('scene:service', (e) => this.onService(e)),
      b.on('scene:pursuit', (e) => this.onPursuit(e)),
      b.on('pursuit:order', (e) => this.onPursuitOrder(e)),
      b.on('cad:documentSaved', (e) => this.onDocument(e)),
      b.on('scene:outcome', (e) => this.onOutcome(e)),
      b.on('cad:unitAssigned', (e) => {
        if (e.callsign === this.callsign) this.playerCall = e.callId;
      }),
      b.on('cad:unitStatus', (e) => {
        if (e.callsign === this.callsign) this.playerCall = e.callId ?? 0;
      }),
      b.on('cad:callClosed', (e) => {
        if (this.playerCall === e.callId) this.playerCall = 0;
      }),
    );
  }

  // --- Public API ----------------------------------------------------------------------------

  get ruleset(): Ruleset {
    return this.rs;
  }

  /** Bumps on every change of any log, the camera state or the jurisdiction (UI redraw trigger). */
  get revision(): number {
    return this.rev;
  }

  /** The camera state carried by new events (the same object, updated in place). */
  get cam(): { body: boolean; muted: boolean; dash: boolean; bits: number } {
    return this.camState;
  }

  /** The incident the officer is working (the active contact's, else the player's call, else the last active within 120 s), '' none. */
  get current(): string {
    const contact = this.ports.activeContactIncident();
    if (contact) return this.aliases.get(contact) ?? contact;
    if (this.playerCall > 0) {
      const k = callNumber(this.playerCall);
      const rt = this.logs.get(k);
      if (rt && !rt.log.closed) return k;
    }
    if (this.lastKey !== '' && this.now - this.lastKeySim <= RECENT_S) {
      const rt = this.logs.get(this.lastKey);
      if (rt && !rt.log.closed) return this.lastKey;
    }
    return '';
  }

  /** Queues a request; it is applied at the start of the next step. */
  request(r: IncidentRequest): void {
    this.queue.push(r);
  }

  /** Fixed step (order -660). */
  step(_dt: number, t: CadTime): void {
    this.simAtStep = t.sim;
    this.gameAtStep = t.game;
    if (t.sim > this.now) this.now = t.sim;
    if (this.queue.length > 0) {
      const q = this.queue;
      this.queue = [];
      for (const r of q) this.apply(r);
    }
    if (this.pending.length > 0) this.flushStale();
    this.ports.dashcam(this.dashOut);
    this.dashLights = this.dashOut.lights;
    this.dashNear = this.dashOut.nearCar;
    this.refreshCam();
    if (this.sampler !== null && t.sim >= this.sampler.nextSampleSim) this.sampleStep(t);
    if (t.sim >= this.nextIdleCheck) {
      this.nextIdleCheck = t.sim + 1;
      this.closeIdle();
    }
    if (this.assessQueue.length > 0) this.assessNext();
  }

  /** Open incidents first, then closed ones, each newest first. */
  keys(): string[] {
    const open: string[] = [];
    const closed: Rt[] = [];
    for (const rt of this.logs.values()) {
      if (rt.log.closed) closed.push(rt);
      else open.push(rt.log.key);
    }
    open.reverse();
    closed.reverse();
    closed.sort((a, b) => b.log.closedSim - a.log.closedSim);
    return open.concat(closed.map((rt) => rt.log.key));
  }

  /** The live log (do not mutate). */
  log(key: string): IncidentLog | null {
    return this.rt(key)?.log ?? null;
  }

  /** The legal assessment of the log as it stands (cached; recomputed after any change, so also valid for open logs). */
  assessment(key: string): LegalAssessment | null {
    const rt = this.rt(key);
    if (!rt) return null;
    const hit = this.assessCache.get(rt.log.key);
    if (hit && hit.version === rt.version && hit.rsRev === this.rsRev) return hit.value;
    const value = evaluateIncident(rt.log, this.rs);
    this.assessCache.set(rt.log.key, { version: rt.version, rsRev: this.rsRev, value });
    return value;
  }

  /** Statements of fact for the MDT report (cached per log version). */
  reportChoices(key: string): readonly ReportChoice[] {
    const rt = this.rt(key);
    if (!rt) return [];
    const hit = this.choiceCache.get(rt.log.key);
    if (hit && hit.version === rt.version && hit.rsRev === this.rsRev) return hit.value;
    const a = this.assessment(rt.log.key);
    if (!a) return [];
    const value = buildReportChoices(rt.log, a, this.rs, hashString(rt.log.key, normalizeSeed(this.seed)));
    this.choiceCache.set(rt.log.key, { version: rt.version, rsRev: this.rsRev, value });
    return value;
  }

  keyOfCall(callId: number): string {
    return callNumber(callId);
  }

  /** The total of aggressive officer lines said to the people of an incident (conduct input). */
  aggressiveLines(key: string): number {
    const rt = this.rt(key);
    if (!rt) return 0;
    let n = 0;
    for (const [k, v] of this.pstate) if (k.startsWith(`${rt.log.key}|`)) n += v.agg;
    return n;
  }

  /**
   * Drops closed logs that nothing references: those not in `keep` that closed more than one game day ago, then the oldest
   * unreferenced ones while more than 24 closed logs remain. The integrator calls it once per game minute.
   */
  retain(keep: ReadonlySet<string>, game: number): void {
    const drop = (rt: Rt): void => {
      const key = rt.log.key;
      this.logs.delete(key);
      this.assessCache.delete(key);
      this.choiceCache.delete(key);
      for (const k of [...this.pstate.keys()]) if (k.startsWith(`${key}|`)) this.pstate.delete(k);
      for (const [from, to] of [...this.aliases]) if (to === key) this.aliases.delete(from);
      this.rev++;
    };
    const queued = new Set(this.assessQueue);
    for (const rt of [...this.logs.values()]) {
      const l = rt.log;
      if (l.closed && !keep.has(l.key) && !queued.has(l.key) && game - l.closedGame > DAY_S) drop(rt);
    }
    const closed = [...this.logs.values()].filter((rt) => rt.log.closed);
    if (closed.length <= MAX_CLOSED) return;
    const spare = closed.filter((rt) => !keep.has(rt.log.key) && !queued.has(rt.log.key)).sort((a, b) => a.log.closedSim - b.log.closedSim);
    let over = closed.length - MAX_CLOSED;
    for (const rt of spare) {
      if (over <= 0) break;
      drop(rt);
      over--;
    }
  }

  /**
   * After a load: the call the player's unit is on (CAD knows it; the assignment events are not replayed), so `current`
   * and the force / camera events that carry no incident string keep landing in the right log.
   */
  followCall(callId: number): void {
    this.playerCall = callId;
  }

  serialize(): IncidentsSave {
    const logs: IncidentLog[] = [];
    for (const rt of this.logs.values()) logs.push(structuredClone(rt.log));
    const personState: [string, number, number, number][] = [];
    for (const [k, v] of this.pstate) {
      const cut = k.lastIndexOf('|');
      personState.push([k.slice(0, cut), Number(k.slice(cut + 1)), v.agg, v.rank]);
    }
    return {
      version: 1,
      jurisdiction: this.rs.id,
      nextEventId: this.nextEventId,
      nextAdhoc: this.nextAdhoc,
      logs,
      aliases: [...this.aliases],
      cam: { body: this.body, muted: this.muted, dashManual: this.dashManual },
      violations: this.violations.map((v) => ({ ...v })),
      pursuit: this.sampler ? { ...this.sampler } : null,
      assessQueue: [...this.assessQueue],
      personState,
      queue: this.queue.map((r) => ({ ...r })),
    };
  }

  restore(s: IncidentsSave = emptyIncidentsSave()): void {
    this.logs.clear();
    this.aliases.clear();
    this.pstate.clear();
    this.pending.length = 0;
    this.pendingPlates.clear();
    this.assessCache.clear();
    this.choiceCache.clear();
    this.rs = getRuleset(s.jurisdiction);
    this.rsRev++;
    this.nextEventId = s.nextEventId;
    this.nextAdhoc = s.nextAdhoc;
    let now = 0;
    let game = 0;
    for (const raw of s.logs) {
      const log = structuredClone(raw);
      const rt = newRt(log);
      rebuild(rt);
      this.logs.set(log.key, rt);
      for (const e of log.events) {
        if (e.t > now) now = e.t;
        if (e.game > game) game = e.game;
      }
    }
    for (const [from, to] of s.aliases) this.aliases.set(from, to);
    this.body = s.cam.body;
    this.muted = s.cam.muted;
    this.dashManual = s.cam.dashManual;
    this.violations = s.violations.map((v) => ({ ...v }));
    this.sampler = s.pursuit ? { ...s.pursuit } : null;
    this.samplerOffense = undefined;
    this.assessQueue = [...s.assessQueue];
    for (const [key, pid, agg, rank] of s.personState) this.pstate.set(`${key}|${pid}`, { agg, rank });
    this.queue = s.queue.map((r) => ({ ...r }));
    this.now = now;
    this.simAtStep = now;
    this.gameAtStep = game;
    this.nextIdleCheck = 0;
    this.lastKey = '';
    this.lastKeySim = -1e9;
    this.playerCall = 0;
    // The dash bit is not saved: the camera bits of the latest event of any log say what it was (the next step re-reads the real probe).
    let lastEvent = -1;
    let dash = false;
    for (const rt of this.logs.values()) {
      for (const e of rt.log.events) {
        if (e.id <= lastEvent) continue;
        lastEvent = e.id;
        dash = (e.cam & CAM.dash) !== 0;
      }
    }
    this.dashLights = dash;
    this.dashNear = dash;
    this.camState.body = this.body;
    this.camState.muted = this.muted;
    this.camState.dash = dash;
    this.camState.bits = this.bitsOf(this.body, this.muted, this.camState.dash);
    this.rev++;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }

  // --- Requests ------------------------------------------------------------------------------

  private apply(r: IncidentRequest): void {
    switch (r.kind) {
      case 'mute':
        this.muted = r.on;
        break;
      case 'dashManual':
        this.dashManual = r.on;
        break;
      case 'jurisdiction':
        this.rs = getRuleset(r.id);
        this.rsRev++;
        this.rev++;
        break;
      case 'close': {
        const rt = this.rt(r.key);
        if (rt) this.close(rt, 'closed', '');
        break;
      }
      case 'report': {
        const rt = this.rt(r.key);
        if (!rt) break;
        const rec = { docId: r.docId, assertions: [...r.assertions], sim: this.now, game: this.gameNow() };
        const at = rt.log.reports.findIndex((x) => x.docId === r.docId);
        if (at >= 0) rt.log.reports[at] = rec;
        else rt.log.reports.push(rec);
        rt.version++;
        this.rev++;
        this.bus.emit('incident:report', { key: rt.log.key, docId: r.docId });
        break;
      }
    }
  }

  // --- Time, ids, keys -----------------------------------------------------------------------

  private gameNow(): number {
    return this.gameAtStep + (this.now - this.simAtStep);
  }

  private stamp(hint: number): number {
    if (hint > this.now) this.now = hint;
    return this.now;
  }

  private rt(key: string): Rt | null {
    return this.logs.get(key) ?? this.logs.get(this.aliases.get(key) ?? '') ?? null;
  }

  private bitsOf(body: boolean, muted: boolean, dash: boolean): number {
    return (body ? CAM.body : 0) | (muted ? CAM.muted : 0) | (dash ? CAM.dash : 0);
  }

  /** Resolves a payload's incident to a log key, merging a field contact into the call it was attached to. */
  private canonKey(incident: string, callId: number): string {
    const key = this.aliases.get(incident) ?? incident;
    if (callId > 0 && key.startsWith('FC-')) {
      const callKey = callNumber(callId);
      this.merge(key, callKey, callId);
      return callKey;
    }
    return key;
  }

  /**
   * The log an event belongs to: its `incident`, else its call, else the current incident, else (when `create`) a new ad hoc
   * `FI-<epochDay>-<n>` log. Returns null when there is none and `create` is false.
   */
  private target(incident: string, callId: number, create: boolean): Rt | null {
    let key = incident !== '' ? this.canonKey(incident, callId) : callId > 0 ? callNumber(callId) : this.current;
    if (key === '') {
      if (!create) return null;
      key = `FI-${Math.floor(this.gameNow() / DAY_S)}-${this.nextAdhoc++}`;
    }
    const existing = this.logs.get(key);
    if (existing) return existing;
    return create ? this.open(key, callId > 0 ? callId : callIdOfKey(key)) : null;
  }

  private open(key: string, callId: number): Rt {
    const info = callId > 0 ? this.ports.callInfo(callId) : null;
    const field = callId <= 0;
    const log: IncidentLog = {
      key, callId, typeId: info?.typeId ?? (field ? (key.startsWith('FI-') ? 'fieldIncident' : 'fieldContact') : 'unknown'),
      family: info?.family ?? '', district: info?.district ?? this.ports.officerDistrict?.() ?? '', openedSim: this.now, openedGame: this.gameNow(), closed: false,
      closedSim: -1, closedGame: -1, events: [], people: [], reports: [],
    };
    const rt = newRt(log);
    this.logs.set(key, rt);
    this.push(rt, { kind: 'start', personId: -1, callId, typeId: log.typeId, family: log.family, field } satisfies DraftEvent, 0);
    this.bus.emit('incident:opened', { key });
    this.rev++;
    return rt;
  }

  /** Moves the events of field contact `fc` into call log `callKey` (ids are kept, the merge is sorted by time then id). */
  private merge(fc: string, callKey: string, callId: number): void {
    if (this.aliases.get(fc) === callKey && !this.logs.has(fc)) return;
    this.aliases.set(fc, callKey);
    if (this.lastKey === fc) this.lastKey = callKey;
    for (const [k, v] of [...this.pstate]) {
      if (!k.startsWith(`${fc}|`)) continue;
      this.pstate.delete(k);
      const nk = `${callKey}${k.slice(fc.length)}`;
      const have = this.pstate.get(nk);
      if (have) this.pstate.set(nk, { agg: have.agg + v.agg, rank: Math.max(have.rank, v.rank) });
      else this.pstate.set(nk, v);
    }
    if (this.sampler?.key === fc) this.sampler.key = callKey;
    for (const p of this.pending) if (p.key === fc) p.key = callKey;
    this.assessQueue = this.assessQueue.map((k) => (k === fc ? callKey : k));
    const src = this.logs.get(fc);
    if (!src) return;
    this.logs.delete(fc);
    this.assessCache.delete(fc);
    this.choiceCache.delete(fc);
    const dst = this.logs.get(callKey);
    const info = this.ports.callInfo(callId);
    if (!dst) {
      src.log.key = callKey;
      src.log.callId = callId;
      this.patchStart(src, callId, info);
      this.logs.set(callKey, src);
      rebuild(src);
    } else {
      const moved = src.log.events.filter((e) => e.kind !== 'start' && e.kind !== 'close' && !(e.kind === 'person' && dst.persons.has(e.personId)));
      dst.log.events = mergeSorted(dst.log.events, moved);
      for (const p of src.log.people) if (!dst.log.people.some((x) => x.personId === p.personId)) dst.log.people.push(p);
      dst.log.reports.push(...src.log.reports);
      this.assessQueue = this.assessQueue.filter((k) => k !== callKey || !dst.log.closed);
      rebuild(dst);
    }
    this.rev++;
  }

  private patchStart(rt: Rt, callId: number, info: ReturnType<IncidentPorts['callInfo']>): void {
    const start = rt.log.events.find((e): e is StartEvent => e.kind === 'start');
    if (info) {
      rt.log.typeId = info.typeId;
      rt.log.family = info.family;
      rt.log.district = info.district;
    }
    if (start) {
      start.callId = callId;
      start.typeId = rt.log.typeId;
      start.family = rt.log.family;
      start.field = false;
    }
    rt.version++;
  }

  // --- Appending -----------------------------------------------------------------------------

  /** Appends an event (and the person's `person` event first when it is new to the log). Returns the event id, -1 when dropped. */
  private add(rt: Rt, draft: DraftEvent, hint = 0, roleHint = ''): number {
    if (draft.personId >= 0) this.person(rt, draft.personId, roleHint);
    const first = !rt.camChecked && (draft.kind === 'detention' || draft.kind === 'frisk' || draft.kind === 'search' || draft.kind === 'force');
    const id = this.push(rt, draft, hint);
    if (first && id >= 0 && this.ports.bodycamWorn() && (this.camState.bits & CAM.body) === 0) {
      this.push(rt, { kind: 'advisory', personId: -1, advisory: 'activateBodycam', text: 'Activate your body camera.' }, hint);
      this.bus.emit('incident:flash', { text: 'Bodycam is not recording (U)' });
    }
    return id;
  }

  /**
   * Makes sure the person is in the log (a `person` event first). The role is the scene's, else `roleHint`; a role that is still
   * unknown is filled in later, and `hintWins` replaces a different known role (the stop driver is always the driver).
   */
  private person(rt: Rt, pid: number, roleHint: string, hintWins = false): void {
    if (rt.persons.has(pid)) {
      if (roleHint === '') return;
      const entry = rt.log.people.find((p) => p.personId === pid);
      if (entry && (entry.role === '' || (hintWins && entry.role !== roleHint))) {
        entry.role = roleHint;
        const ev = rt.log.events.find((e) => e.kind === 'person' && e.personId === pid);
        if (ev && ev.kind === 'person') ev.role = roleHint;
        rt.version++;
      }
      return;
    }
    const role = hintWins ? roleHint : this.ports.personRole(pid, rt.log.callId) || roleHint;
    const label = this.ports.personLabel(pid);
    rt.log.people.push({ personId: pid, role, label });
    this.push(rt, { kind: 'person', personId: pid, role, label }, 0);
  }

  private push(rt: Rt, draft: DraftEvent, hint: number): number {
    const events = rt.log.events;
    if (events.length >= MAX_EVENTS && draft.kind !== 'close') {
      // At the cap the oldest camera / sample / command / service event makes room; with none left the new event is dropped.
      const at = events.findIndex((e) => DROPPABLE.includes(e.kind));
      if (at < 0) return -1;
      events.splice(at, 1);
    }
    const t = this.stamp(hint);
    const ev = { ...draft, id: this.nextEventId++, t, game: this.gameNow(), cam: this.camState.bits };
    events.push(ev);
    note(rt, ev);
    rt.version++;
    this.rev++;
    if (ev.kind !== 'cam') {
      this.lastKey = rt.log.key;
      this.lastKeySim = t;
    }
    return ev.id;
  }

  private findEvent(rt: Rt, id: number): IncidentEvent | null {
    const events = rt.log.events;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e && e.id === id) return e;
    }
    return null;
  }

  /** Appends an indicator once per (person, indicator, source event). */
  private indicator(rt: Rt, pid: number, indicator: string, source: IndicatorSource, sourceEvent: number, detail: string, hint = 0, roleHint = ''): number {
    if (rt.indKeys.has(indKey(pid, indicator, sourceEvent))) return -1;
    return this.add(rt, { kind: 'indicator', personId: pid, indicator, source, sourceEvent, detail }, hint, roleHint);
  }

  private ps(key: string, pid: number): PState {
    const k = `${key}|${pid}`;
    let s = this.pstate.get(k);
    if (!s) {
      s = { agg: 0, rank: -1 };
      this.pstate.set(k, s);
    }
    return s;
  }

  // --- Camera --------------------------------------------------------------------------------

  private setBody(on: boolean): void {
    this.body = on;
    this.refreshCam();
  }

  private refreshCam(): void {
    const cs = this.camState;
    const dash = (this.dashLights || this.dashManual) && this.dashNear;
    const bits = this.bitsOf(this.body, this.muted, dash);
    if (bits === cs.bits) return;
    cs.body = this.body;
    cs.muted = this.muted;
    cs.dash = dash;
    cs.bits = bits;
    this.rev++;
    for (const rt of this.logs.values()) {
      if (rt.log.closed || this.now - rt.lastSim > RECENT_S) continue;
      this.push(rt, { kind: 'cam', personId: -1, body: cs.body, muted: cs.muted, dash: cs.dash }, 0);
    }
  }

  // --- Scene, stop, lookups ------------------------------------------------------------------

  private onMaterialized(e: EventMap['scene:materialized']): void {
    const rt = this.target('', e.callId, true);
    if (!rt) return;
    const info = this.ports.callInfo(e.callId);
    if (!info) return;
    if (rt.log.family === '') this.patchStart(rt, e.callId, info);
    if (rt.callFacts) return;
    if (info.exigency) this.add(rt, { kind: 'exigency', personId: -1, reason: 'call' });
    if (info.warrant) {
      this.add(rt, { kind: 'warrant', personId: -1, scope: 'search' });
      this.add(rt, { kind: 'warrant', personId: -1, scope: 'arrest' });
    }
    for (const pid of info.suspects) {
      this.indicator(rt, pid, 'callSuspect', 'call', -1, 'named as a suspect', 0, 'suspect');
      if (info.weaponReported) this.indicator(rt, pid, 'weaponCall', 'call', -1, 'dispatch reported a weapon', 0, 'suspect');
    }
    if (info.weaponReported && info.suspects.length === 0) this.indicator(rt, -1, 'weaponCall', 'call', -1, 'dispatch reported a weapon');
  }

  private onViolation(e: EventMap['traffic:violation']): void {
    this.violations.push({ vehicleId: e.vehicleId, kind: e.kind, sim: this.now });
    if (this.violations.length > RING_MAX) this.violations.shift();
  }

  private onTrafficStop(e: EventMap['cad:trafficStop']): void {
    if (!e.active) return;
    const driver = this.ports.stopDriver();
    const callId = e.callId > 0 ? e.callId : (driver?.callId ?? 0);
    const rt = this.target('', callId, true);
    if (!rt) return;
    const pid = driver ? driver.personId : -1;
    if (pid >= 0) this.person(rt, pid, 'driver', true);
    const replay = this.pendingPlates.get(e.vehicleId);
    if (replay) {
      this.pendingPlates.delete(e.vehicleId);
      for (const ind of replay) this.indicator(rt, -1, ind, 'lookup', -1, 'plate run');
    }
    const kinds: string[] = [];
    for (const v of this.violations) {
      if (v.vehicleId === e.vehicleId && this.now - v.sim <= RING_S && !kinds.includes(v.kind)) kinds.push(v.kind);
    }
    const seen = this.ports.observedViolations(e.vehicleId);
    for (const kind of Object.keys(seen).sort()) {
      if (seen[kind] !== undefined && !kinds.includes(kind)) kinds.push(kind);
    }
    for (const kind of kinds) {
      const ind = this.mapping.violations[kind];
      if (ind) this.indicator(rt, pid, ind, 'observation', -1, kind);
    }
    if (pid >= 0 && !rt.detained.has(pid)) this.add(rt, { kind: 'detention', personId: pid, how: 'trafficStop' });
  }

  private hitIndicators(rows: IncidentMapping['plateHits'], hits: readonly string[]): string[] {
    const out: string[] = [];
    for (const hit of hits) {
      for (const row of rows) {
        if (hit.startsWith(row.prefix)) {
          if (!out.includes(row.indicator)) out.push(row.indicator);
          break;
        }
      }
    }
    return out;
  }

  private onPlateResult(e: EventMap['dispatch:plateResult']): void {
    if (this.callsign !== undefined && e.callsign !== this.callsign) return;
    const inds = this.hitIndicators(this.mapping.plateHits, e.readback.hits);
    if (inds.length === 0) return;
    const driver = this.ports.stopDriver();
    let rt: Rt | null = null;
    if (driver && driver.vehicleId === e.vehicleId) rt = this.target('', driver.callId, false);
    rt ??= this.target('', 0, false);
    if (!rt) {
      if (e.vehicleId >= 0) {
        if (this.pendingPlates.size >= MAX_PENDING_PLATES) this.pendingPlates.delete(this.pendingPlates.keys().next().value as number);
        this.pendingPlates.set(e.vehicleId, inds);
      }
      return;
    }
    for (const ind of inds) this.indicator(rt, -1, ind, 'lookup', -1, e.readback.plate);
  }

  private onPersonResult(e: EventMap['dispatch:personResult']): void {
    if (this.callsign !== undefined && e.callsign !== this.callsign) return;
    const inds = this.hitIndicators(this.mapping.personHits, e.readback.hits);
    if (inds.length === 0) return;
    const rt = this.target('', 0, false);
    if (!rt) return;
    for (const ind of inds) this.indicator(rt, e.readback.personId, ind, 'lookup', -1, e.readback.name);
  }

  // --- Contact -------------------------------------------------------------------------------

  private factMatches(row: FactRow, e: EventMap['contact:fact'], role: string): boolean {
    if (row.topic !== e.topic || row.source !== e.source) return false;
    if (row.detail !== undefined && row.detail !== e.detail) return false;
    if (row.displayPrefix !== undefined && !e.display.startsWith(row.displayPrefix)) return false;
    if (row.valueIn !== undefined && !row.valueIn.includes(e.value)) return false;
    if (row.roles !== undefined && !row.roles.includes(role)) return false;
    return true;
  }

  private onFact(e: EventMap['contact:fact']): void {
    if (e.personId < 0 || (e.source !== 'claim' && e.source !== 'evidence')) return;
    const rt = this.target(e.incident, e.callId, true);
    if (!rt) return;
    const pid = e.personId;
    const role = e.role !== '' ? e.role : (rt.log.people.find((p) => p.personId === pid)?.role ?? '');
    let statement = -1;
    if (e.source === 'claim') {
      statement = this.add(rt, {
        kind: 'statement', personId: pid, fact: e.topic, value: e.value, display: e.display, custody: rt.custody.get(pid) ?? false,
      }, e.sim, e.role);
    }
    for (const row of this.mapping.facts) {
      if (!this.factMatches(row, e, role)) continue;
      if (row.source === 'claim') {
        this.indicator(rt, pid, row.indicator, 'statement', statement, e.display, e.sim, e.role);
      } else if (row.test !== undefined) {
        this.pending.push({ key: rt.log.key, personId: pid, indicator: row.indicator, kind: 'test', test: row.test, detail: e.display, sim: e.sim });
      } else if (row.detail !== undefined) {
        this.indicator(rt, pid, row.indicator, 'observation', -1, e.display, e.sim, e.role);
      } else {
        this.pending.push({ key: rt.log.key, personId: pid, indicator: row.indicator, kind: 'find', test: '', detail: e.display, sim: e.sim });
      }
    }
  }

  private takePending(key: string, pid: number, kind: 'test' | 'find', test: string): PendingFact[] {
    const out: PendingFact[] = [];
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      if (p && p.key === key && p.personId === pid && p.kind === kind && p.test === test) {
        out.push(p);
        this.pending.splice(i, 1);
        i--;
      }
    }
    return out;
  }

  private emitPending(rt: Rt, list: readonly PendingFact[], sourceEvent: number): void {
    for (const p of list) {
      this.indicator(rt, p.personId, p.indicator, p.kind === 'test' ? 'test' : 'evidence', sourceEvent, p.detail, p.sim);
    }
  }

  /** Indicators whose action never arrived in the same step: link them to a matching event within 5 s, else to none. */
  private flushStale(): void {
    const list = this.pending.splice(0, this.pending.length);
    for (const p of list) {
      const rt = this.rt(p.key);
      if (!rt) continue;
      const ref = p.kind === 'test' ? rt.tests.get(`${p.personId}|${p.test}`) : rt.finds.get(p.personId);
      const linked = ref !== undefined && this.now - ref.t <= LINK_S ? ref.id : -1;
      this.emitPending(rt, [p], linked);
    }
  }

  private command(rt: Rt, pid: number, command: string, outcome: string, hint: number, roleHint: string): void {
    this.add(rt, { kind: 'command', personId: pid, command, outcome }, hint, roleHint);
    if (outcome === 'comply' && this.mapping.detainingCommands.includes(command) && !rt.detained.has(pid)) {
      this.add(rt, { kind: 'detention', personId: pid, how: 'command' }, hint, roleHint);
    }
  }

  private onSaid(e: EventMap['contact:said']): void {
    if (e.personId < 0) return;
    const rt = this.target(e.incident, e.callId, true);
    if (!rt) return;
    const pid = e.personId;
    const state = this.ps(rt.log.key, pid);
    if (e.tone === 'aggressive') state.agg++;
    rt.custody.set(pid, e.custody);
    if (e.intent === 'ask') {
      this.add(rt, { kind: 'question', personId: pid, fact: e.fact ?? '', utterance: e.utteranceId, custody: e.custody, gunpoint: e.gunpoint }, e.sim, e.role);
    } else if (e.intent === 'command' && e.command !== null) {
      this.command(rt, pid, e.command, e.outcome ?? '', e.sim, e.role);
    }
  }

  private onSceneCommand(e: EventMap['scene:command']): void {
    if (e.personId < 0) return;
    const rt = this.target('', e.callId, true);
    if (rt) this.command(rt, e.personId, e.command, e.outcome, e.sim, '');
  }

  private onConsent(e: EventMap['contact:consent']): void {
    if (e.personId < 0) return;
    const rt = this.target(e.incident, e.callId, true);
    if (!rt) return;
    this.ports.officer(this.officerOut);
    this.add(rt, {
      kind: 'consent', personId: e.personId, consent: e.kind, granted: e.granted, valid: e.valid,
      weaponDrawn: this.officerOut.weapon !== 'none', aggressiveLines: this.ps(rt.log.key, e.personId).agg, buildingId: e.buildingId,
    }, e.sim);
  }

  private onMiranda(e: EventMap['contact:miranda']): void {
    if (e.personId < 0) return;
    const rt = this.target(e.incident, e.callId, true);
    if (rt) this.add(rt, { kind: 'miranda', personId: e.personId, result: e.result, custody: e.custody }, e.sim);
  }

  private onContactFlag(e: EventMap['contact:event']): void {
    if (e.flag !== 'falseIdentity' || e.personId < 0) return;
    const rt = this.target(e.incident, e.callId, true);
    if (rt) this.indicator(rt, e.personId, 'falseIdentity', 'evidence', -1, 'identity claims contradict', 0, e.role);
  }

  private onAction(e: EventMap['contact:action']): void {
    if (e.personId < 0) return;
    const rt = this.target(e.incident, e.callId, true);
    if (!rt) return;
    const pid = e.personId;
    const hint = e.sim;
    switch (e.action) {
      case 'frisk': {
        if (!e.ok) break;
        const id = this.add(rt, { kind: 'frisk', personId: pid, found: e.items.map(toFound) }, hint, e.role);
        this.emitPending(rt, this.takePending(rt.log.key, pid, 'find', ''), id);
        break;
      }
      case 'searchPerson':
      case 'searchVehicle': {
        if (!e.ok) break;
        const id = this.add(rt, {
          kind: 'search', personId: pid, target: e.action === 'searchPerson' ? 'person' : 'vehicle', claimedBasis: null,
          found: e.items.map(toFound), buildingId: -1, vehicleId: e.vehicleId,
        }, hint, e.role);
        this.emitPending(rt, this.takePending(rt.log.key, pid, 'find', ''), id);
        break;
      }
      case 'visualCheck': {
        this.takePending(rt.log.key, pid, 'find', '');
        for (const it of e.items) {
          if (!it.incriminating) continue;
          const ind = it.weapon ? this.mapping.plainView.weapon : this.mapping.plainView.default;
          this.indicator(rt, pid, ind, 'observation', -1, itemDetail(it.label, it.ref), hint, e.role);
        }
        break;
      }
      case 'pbt': {
        if (e.result === null) break;
        const id = this.add(rt, { kind: 'test', personId: pid, test: 'pbt', result: e.result === 'over' ? 'over' : 'under' }, hint, e.role);
        this.emitPending(rt, this.takePending(rt.log.key, pid, 'test', 'pbt'), id);
        break;
      }
      case 'sfstResult': {
        if (e.result === null) break;
        const id = this.add(rt, { kind: 'test', personId: pid, test: 'sfst', result: e.result === 'fail' ? 'fail' : 'pass' }, hint, e.role);
        this.emitPending(rt, this.takePending(rt.log.key, pid, 'test', 'sfst'), id);
        break;
      }
      case 'cuff':
        if (!e.ok) break;
        if (!rt.detained.has(pid)) this.add(rt, { kind: 'detention', personId: pid, how: 'cuffed' }, hint, e.role);
        if (!rt.arrested.has(pid)) this.add(rt, { kind: 'arrest', personId: pid, how: 'cuff' }, hint, e.role);
        break;
      case 'uncuff':
      case 'release':
      case 'warnRelease':
      case 'writeCitation': {
        if (!e.ok) break;
        const how = e.action === 'uncuff' ? 'uncuff' : e.action === 'release' ? 'release' : e.action === 'warnRelease' ? 'warn' : 'citation';
        this.add(rt, { kind: 'release', personId: pid, how }, hint, e.role);
        break;
      }
      case 'seize':
        for (const it of e.items) this.add(rt, { kind: 'seizure', personId: pid, item: toFound(it), fromEvent: rt.found.get(it.ref) ?? -1 }, hint, e.role);
        break;
      default:
        break;
    }
  }

  // --- NPC -----------------------------------------------------------------------------------

  private onFled(e: EventMap['npc:fled']): void {
    if (e.personId < 0) return;
    const rt = this.target('', e.callId, e.callId > 0);
    if (rt) this.indicator(rt, e.personId, 'flight', 'observation', -1, 'ran from the officer');
  }

  private onAttack(e: EventMap['npc:attack']): void {
    if (e.personId < 0) return;
    const ind = this.mapping.attack[e.kind];
    if (!ind) return;
    const rt = this.target('', e.callId, e.callId > 0);
    if (rt) this.indicator(rt, e.personId, ind, 'observation', -1, e.kind);
  }

  // --- Force ---------------------------------------------------------------------------------

  private onForceUsed(e: EventMap['force:used']): void {
    const row = this.mapping.forceUsed[e.kind];
    if (!row || e.personId < 0) return;
    const rt = this.target('', e.callId, true);
    if (!rt) return;
    const state = this.ps(rt.log.key, e.personId);
    // A tackle carries the resistance sampled before the takedown; a struggle or cuff implies at least active resistance.
    const known = e.kind !== 'struggle' && e.kind !== 'cuff' && state.rank >= 0;
    const resistance: Resistance = e.resistance ?? (known ? (RESISTANCE_LEVELS[state.rank] ?? 'active') : 'active');
    const id = this.add(rt, {
      kind: 'force', personId: e.personId, forceId: -1, tool: row[1], level: row[0], resistance, hit: true, injury: 0, fatal: false,
      cycle: 0, riskFactors: [], distance: 0, restrained: false,
    });
    if (e.kind === 'sidearmDrawn' && id >= 0) rt.display = { id, personId: e.personId, t: this.now };
    if (e.kind === 'tackle' && id >= 0) {
      state.rank = RESISTANCE_LEVELS.indexOf(resistance);
      const v = forceVerdict({ level: row[0], tool: row[1], resistance, cycle: 0, riskFactors: [], restrained: false }, this.rs);
      const text = `${TOOL_LABELS[row[1]] ?? row[1]} on ${resistance} resistance: ${VERDICT_TEXT[v.verdict]} (${v.ruleIds.join(', ')})`;
      this.bus.emit('incident:forceVerdict', { key: rt.log.key, eventId: id, verdict: v.verdict, text });
    }
  }

  private onForceApplied(e: EventMap['force:applied']): void {
    if (e.personId < 0) return;
    const rt = this.target('', e.callId, true);
    if (!rt) return;
    const level = asLevel(e.level);
    const resistance = asResistance(e.resistance);
    const draft: DraftEvent = {
      kind: 'force', personId: e.personId, forceId: e.seq, tool: e.tool, level, resistance, hit: e.hit, injury: e.injury, fatal: e.fatal,
      cycle: e.cycle, riskFactors: [...e.riskFactors], distance: e.distance, restrained: e.restrained,
    };
    let id = -1;
    const d = rt.display;
    if (e.tool === 'firearmDisplay' && d && d.personId === e.personId && Math.abs(this.stamp(e.sim) - d.t) <= DISPLAY_MERGE_S) {
      const ev = this.findEvent(rt, d.id);
      if (ev && ev.kind === 'force') {
        Object.assign(ev, draft);
        rt.version++;
        this.rev++;
        id = ev.id;
      }
    }
    rt.display = null;
    if (id < 0) id = this.add(rt, draft, e.sim);
    this.ps(rt.log.key, e.personId).rank = RESISTANCE_LEVELS.indexOf(resistance);
    const v = forceVerdict({ level, tool: e.tool, resistance, cycle: e.cycle, riskFactors: e.riskFactors, restrained: e.restrained }, this.rs);
    const label = TOOL_LABELS[e.tool] ?? e.tool;
    const text = `${label} on ${resistance} resistance: ${VERDICT_TEXT[v.verdict]} (${v.ruleIds.join(', ')})`;
    this.bus.emit('incident:forceVerdict', { key: rt.log.key, eventId: id, verdict: v.verdict, text });
  }

  private onForceOther(e: EventMap['force:other']): void {
    if (e.personId < 0) return;
    const rt = this.target('', e.callId, true);
    if (!rt) return;
    this.add(rt, {
      kind: 'otherForce', personId: e.personId, officer: e.officer, level: asLevel(e.level), resistance: asResistance(e.resistance),
      distanceToOfficer: e.distanceToOfficer, seq: e.seq, restrained: e.restrained,
    }, e.sim);
  }

  private onIntervened(e: EventMap['force:intervened']): void {
    if (e.personId < 0) return;
    const rt = this.target('', e.callId, true);
    if (!rt) return;
    this.add(rt, { kind: 'intervene', personId: e.personId, otherEvent: rt.otherSeq.get(e.otherSeq) ?? rt.lastOther }, e.sim);
  }

  // --- Investigation, interiors, services ----------------------------------------------------

  /** Logs the call's exigency while it is live (it can start mid-call: a welfare call nobody answers, a fight); refreshed at most every `EXIGENCY_REFRESH_S`. */
  private refreshExigency(rt: Rt, buildingId: number): void {
    if (rt.log.callId <= 0 || (rt.exigencySim >= 0 && this.now - rt.exigencySim < EXIGENCY_REFRESH_S)) return;
    if (this.ports.callInfo(rt.log.callId)?.exigency) this.add(rt, { kind: 'exigency', personId: -1, reason: 'emergency in progress', buildingId });
  }

  private onFound(e: EventMap['investigation:found']): void {
    const info = this.ports.itemInfo(e.itemId);
    if (!info) return;
    const rt = this.target('', e.callId, true);
    if (!rt) return;
    this.refreshExigency(rt, info.buildingId);
    const basis: ClaimedBasis | null = e.basis;
    this.add(rt, {
      kind: 'search', personId: info.ownerPersonId, target: 'container', claimedBasis: basis, found: [toFound(info)], buildingId: info.buildingId, vehicleId: -1,
    });
  }

  private onPlainView(e: EventMap['investigation:plainView']): void {
    const info = this.ports.itemInfo(e.itemId);
    const rt = this.target('', e.callId, true);
    if (!rt) return;
    const weapon = info?.weapon === true;
    const ind = weapon ? this.mapping.plainView.weapon : this.mapping.plainView.default;
    const building = info?.buildingId ?? -1;
    const entry = building >= 0 ? (rt.entries.get(building) ?? -1) : -1;
    this.indicator(rt, info?.ownerPersonId ?? -1, ind, 'observation', entry, itemDetail(e.label, e.itemId));
  }

  private onCollected(e: EventMap['investigation:collected']): void {
    const info = this.ports.itemInfo(e.itemId);
    const rt = this.target('', e.callId, true);
    if (!rt) return;
    const item: FoundItem = info ? toFound(info) : { ref: e.itemId, item: e.itemId, label: e.label, category: '', weapon: false, incriminating: false };
    this.add(rt, { kind: 'seizure', personId: info?.ownerPersonId ?? -1, item, fromEvent: rt.found.get(e.itemId) ?? -1 });
  }

  private onTransition(e: EventMap['interior:transition']): void {
    if (!e.entering || e.phase !== 'done') return;
    const callId = this.ports.buildingIncident(e.buildingId);
    if (callId <= 0) return;
    const rt = this.target('', callId, true);
    if (!rt || rt.entries.has(e.buildingId)) return;
    this.refreshExigency(rt, e.buildingId);
    this.add(rt, { kind: 'entry', personId: -1, buildingId: e.buildingId, publicPlace: this.ports.publicPlace(e.buildingId) });
  }

  private onService(e: EventMap['scene:service']): void {
    const rt = this.target('', e.callId, true);
    if (rt) this.add(rt, { kind: 'service', personId: -1, service: e.kind, phase: e.phase });
  }

  // --- Pursuit -------------------------------------------------------------------------------

  private onPursuit(e: EventMap['scene:pursuit']): void {
    const callId = e.ownerCallId !== undefined && e.ownerCallId > 0 ? e.ownerCallId : e.callId;
    const rt = this.target('', callId, true);
    if (!rt) return;
    let pid = e.personId ?? -1;
    if (e.active) {
      if (pid < 0 && e.kind === 'vehicle') pid = this.ports.stopDriver()?.personId ?? -1;
      this.add(rt, { kind: 'pursuitStart', personId: pid, pursuit: e.kind, pursuitCallId: e.callId });
      if (e.kind === 'vehicle') {
        this.sampler = { key: rt.log.key, callId: e.callId, nextSampleSim: this.now + SAMPLE_PERIOD_S, advised: false };
        this.samplerOffense = undefined;
      }
    } else {
      if (pid < 0 && rt.pursuit) pid = rt.pursuit.personId;
      this.add(rt, { kind: 'pursuitEnd', personId: pid, reason: e.endReason ?? 'ended' });
      if (e.kind === 'vehicle' && this.sampler?.key === rt.log.key) this.sampler = null;
    }
  }

  /**
   * Phase 6: the supervisor ordered `terminate` on the pursuit being sampled: the order is the termination advisory
   * (once per pursuit; no `incident:advisory`, the pursuit module radios it itself). Other orders are ignored.
   */
  private onPursuitOrder(e: EventMap['pursuit:order']): void {
    const s = this.sampler;
    if (e.order !== 'terminate' || s === null || s.callId !== e.callId || s.advised) return;
    const rt = this.logs.get(s.key);
    const start = rt?.pursuit;
    if (!rt || !start) return;
    s.advised = true;
    this.add(rt, { kind: 'advisory', personId: start.personId, advisory: 'terminatePursuit', text: e.text });
  }

  private sampleStep(t: CadTime): void {
    const s = this.sampler;
    if (s === null) return;
    const rt = this.logs.get(s.key);
    const start = rt?.pursuit;
    if (!rt || !start) {
      this.sampler = null;
      return;
    }
    s.nextSampleSim += SAMPLE_PERIOD_S;
    if (s.nextSampleSim <= t.sim) s.nextSampleSim = t.sim + SAMPLE_PERIOD_S;
    const p = this.pursuitOut;
    if (!this.ports.pursuitProbe(p)) return;
    if (rt.samples.length >= SAMPLE_THIN_AT && Math.floor(t.sim) % 2 !== 0) return;
    this.add(rt, {
      kind: 'pursuitSample', personId: start.personId, speedMph: p.speedMph, limitMph: p.limitMph, district: p.district, wet: p.wet,
      night: p.night, lights: p.lights, siren: p.siren,
    });
    if (s.advised) return;
    if (this.samplerOffense === undefined) {
      const ruling = this.assessment(rt.log.key)?.pursuits.find((r) => r.startEventId === start.id);
      this.samplerOffense = ruling ? ruling.offense : null;
    }
    const reason = pursuitAdvisory({ start, samples: rt.samples, end: null, advisory: null, offense: this.samplerOffense, nowT: t.sim }, this.rs);
    if (reason === null) return;
    s.advised = true;
    const text = `Supervisor to ${this.callsign ?? 'unit'}: terminate the pursuit — ${reason}.`;
    this.add(rt, { kind: 'advisory', personId: start.personId, advisory: 'terminatePursuit', text });
    this.bus.emit('incident:advisory', { key: rt.log.key, advisory: 'terminatePursuit', text });
  }

  // --- Documents, closing --------------------------------------------------------------------

  /** The key of the incident whose log has a `charges` event for this document, null none. */
  keyOfDoc(docId: string): string | null {
    for (const [key, rt] of this.logs) {
      for (const ev of rt.log.events) if (ev.kind === 'charges' && ev.docId === docId) return key;
    }
    return null;
  }

  private onDocument(e: EventMap['cad:documentSaved']): void {
    if (!e.final) return;
    if (e.kind === 'citation') {
      const c = this.ports.citation?.(e.id);
      if (!c || c.personId < 0) return;
      const rt = this.target('', c.callId, false);
      if (rt) this.add(rt, { kind: 'charges', personId: c.personId, statutes: [...c.statutes], docId: e.id });
      return;
    }
    if (e.kind !== 'booking') return;
    const b = this.ports.booking(e.id);
    if (!b || b.personId < 0) return;
    const rt = this.target('', b.callId, false);
    if (!rt) return;
    if (!rt.arrested.has(b.personId)) this.add(rt, { kind: 'arrest', personId: b.personId, how: 'booking' });
    this.add(rt, { kind: 'charges', personId: b.personId, statutes: [...b.charges], docId: e.id });
  }

  private onOutcome(e: EventMap['scene:outcome']): void {
    const rt = this.logs.get(callNumber(e.outcome.callId));
    if (rt) this.close(rt, e.outcome.disposition, e.outcome.outcomeId);
  }

  private close(rt: Rt, disposition: string, outcomeId: string): void {
    if (rt.log.closed) return;
    this.push(rt, { kind: 'close', personId: -1, disposition, outcomeId }, 0);
    const l = rt.log;
    l.closed = true;
    l.closedSim = this.now;
    l.closedGame = this.gameNow();
    this.assessQueue.push(l.key);
    if (this.sampler?.key === l.key) this.sampler = null;
    rt.version++;
    this.rev++;
  }

  private closeIdle(): void {
    for (const rt of this.logs.values()) {
      const l = rt.log;
      if (l.closed || !isFieldKey(l.key) || this.now - rt.lastSim <= IDLE_CLOSE_S) continue;
      const active = this.ports.activeContactIncident();
      if (active !== null && (active === l.key || this.aliases.get(active) === l.key)) continue;
      this.close(rt, 'ended', '');
    }
  }

  private assessNext(): void {
    const key = this.assessQueue.shift();
    if (key === undefined) return;
    const rt = this.logs.get(key);
    if (!rt) return;
    const a = this.assessment(key);
    if (!a) return;
    this.bus.emit('incident:closed', {
      key, callId: rt.log.callId, score: a.summary.score, unlawful: a.summary.unlawful, excessiveForce: a.summary.excessiveForce,
    });
  }
}
