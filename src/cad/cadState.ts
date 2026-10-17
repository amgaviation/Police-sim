/**
 * CadState (design §6.4): calls, units (statuses, assignments, AVL), narratives, the traffic-stop
 * context and the document store, as one plain-data object. The dispatcher owns the behaviour; this
 * class only records and announces. Sim-path methods never throw: unknown ids are ignored (or
 * return false).
 */
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import { findCallType } from './data';
import { DocumentStore, emptyCounters, isDocumentsSave, type CadDocument, type DocumentsSave } from './documents';
import type { AssignedBy, CadCallChange } from './events';
import {
  isArrayOf,
  isBool,
  isCadTime,
  isInt,
  isIntArray,
  isNullOr,
  isNum,
  isObj,
  isOneOf,
  isStr,
  isStrArray,
} from './guards';
import {
  CALL_STATUSES,
  CALLER_KINDS,
  STOP_OUTCOMES,
  UNIT_STATUSES,
  type CadCall,
  type CadLocation,
  type CadTime,
  type CadUnit,
  type CallerInfo,
  type NarrativeEntry,
  type Priority,
  type RequestVia,
  type TrafficStopInfo,
  type UnitKind,
  type UnitStatus,
} from './types';

export interface NewCall {
  readonly typeId: string;
  readonly priority: Priority;
  readonly location: CadLocation;
  readonly caller: CallerInfo;
  /** First narrative line (source 'CAD'). */
  readonly narrative: string;
  readonly selfInitiated?: boolean;
  readonly persons?: readonly number[];
  readonly vehicles?: readonly number[];
}

export interface NewUnit {
  readonly callsign: string;
  readonly kind: UnitKind;
  readonly officer: string;
  readonly beat: string;
  readonly fleetIndex: number;
}

export interface CadSave {
  version: 1;
  nextCallId: number;
  calls: CadCall[];
  units: CadUnit[];
  docs: DocumentsSave;
  trafficStop: TrafficStopInfo | null;
}

/** Older closed calls are dropped from state and saves (their documents are kept). */
export const MAX_CLOSED_CALLS = 200;

/** Allowed unit status transitions; anything else is refused. */
export const STATUS_TRANSITIONS: Readonly<Record<UnitStatus, readonly UnitStatus[]>> = {
  available: ['enRoute', 'onScene', 'busy', 'outOfService'],
  enRoute: ['onScene', 'available', 'busy'],
  onScene: ['busy', 'transporting', 'available', 'enRoute'],
  busy: ['available', 'onScene', 'enRoute', 'transporting'],
  transporting: ['available', 'onScene', 'busy'],
  outOfService: ['available'],
};

export function canTransition(from: UnitStatus, to: UnitStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/** Whether a unit in `status` may be assigned to a call (assignment puts it en route). */
export function canAssign(status: UnitStatus): boolean {
  return status === 'enRoute' || canTransition(status, 'enRoute');
}

/** "C-00042". */
export function callNumber(id: number): string {
  return `C-${String(id).padStart(5, '0')}`;
}

export function emptyCadSave(): CadSave {
  return {
    version: 1,
    nextCallId: 1,
    calls: [],
    units: [],
    docs: { counters: emptyCounters(), items: [] },
    trafficStop: null,
  };
}

function time(t: CadTime): CadTime {
  return { sim: t.sim, game: t.game };
}

/** Mutable keys of the traffic-stop context that `updateTrafficStop` may change. */
const STOP_PATCH_KEYS = ['callId', 'x', 'z', 'driverId', 'plateRun', 'vinChecked', 'vinResult', 'citations', 'outcome'] as const;

export class CadState {
  readonly docs: DocumentStore;

  private readonly bus: EventBus<EventMap> | null;
  private callList: CadCall[] = [];
  private readonly callMap = new Map<number, CadCall>();
  private unitList: CadUnit[] = [];
  private readonly unitMap = new Map<string, CadUnit>();
  private stop: TrafficStopInfo | null = null;
  private nextCallId = 1;
  private rev = 0;
  private avlRev = 0;

  constructor(bus?: EventBus<EventMap>) {
    this.bus = bus ?? null;
    this.docs = new DocumentStore(bus, (doc) => this.onDocument(doc));
  }

  /** Bumps on every change except AVL positions (UI throttling). */
  get revision(): number {
    return this.rev;
  }

  /** Bumps on `setUnitPosition`. */
  get avlRevision(): number {
    return this.avlRev;
  }

  get trafficStop(): TrafficStopInfo | null {
    return this.stop;
  }

  // --- Units ----------------------------------------------------------------------------------

  /** Adds an available unit; an existing callsign is returned unchanged. */
  addUnit(u: NewUnit, t: CadTime): CadUnit {
    const existing = this.unitMap.get(u.callsign);
    if (existing) return existing;
    const unit: CadUnit = {
      callsign: u.callsign,
      kind: u.kind,
      officer: u.officer,
      beat: u.beat,
      fleetIndex: u.fleetIndex,
      status: 'available',
      callId: null,
      statusSince: time(t),
      x: 0,
      z: 0,
      emergency: false,
    };
    this.unitList.push(unit);
    this.unitMap.set(unit.callsign, unit);
    this.rev++;
    return unit;
  }

  unit(callsign: string): CadUnit | null {
    return this.unitMap.get(callsign) ?? null;
  }

  units(): readonly CadUnit[] {
    return this.unitList;
  }

  playerUnit(): CadUnit | null {
    for (const u of this.unitList) if (u.kind === 'player') return u;
    return null;
  }

  /**
   * Changes a unit's status if the transition table allows it (false = refused, no event). Going
   * `available` or `outOfService` takes the unit off its call (a call left without units returns to
   * pending). Setting the current status again is accepted without an event.
   */
  setUnitStatus(callsign: string, status: UnitStatus, t: CadTime, via: RequestVia): boolean {
    const unit = this.unitMap.get(callsign);
    if (!unit || !isOneOf(status, UNIT_STATUSES)) return false;
    if (unit.status === status) return true;
    if (!canTransition(unit.status, status)) return false;
    if (status === 'available' || status === 'outOfService') this.detach(unit);
    this.changeStatus(unit, status, t, via);
    return true;
  }

  /** AVL update; allocation-free, bumps only `avlRevision`. */
  setUnitPosition(callsign: string, x: number, z: number): void {
    const unit = this.unitMap.get(callsign);
    if (!unit) return;
    unit.x = x;
    unit.z = z;
    this.avlRev++;
  }

  setEmergency(callsign: string, on: boolean, _t: CadTime): void {
    const unit = this.unitMap.get(callsign);
    if (!unit || unit.emergency === on) return;
    unit.emergency = on;
    this.rev++;
  }

  // --- Calls ----------------------------------------------------------------------------------

  /** New pending call (id from 1, number C-00001) with its first narrative line; emits cad:callCreated. */
  createCall(c: NewCall, t: CadTime): CadCall {
    const id = this.nextCallId++;
    const call: CadCall = {
      id,
      number: callNumber(id),
      typeId: c.typeId,
      priority: c.priority,
      nature: findCallType(c.typeId)?.label ?? c.typeId,
      location: { ...c.location },
      caller: { ...c.caller },
      narrative: [{ sim: t.sim, game: t.game, source: 'CAD', text: c.narrative }],
      status: 'pending',
      units: [],
      primary: null,
      offeredTo: null,
      offerExpires: 0,
      created: time(t),
      dispatched: null,
      firstOnScene: null,
      closed: null,
      disposition: null,
      selfInitiated: c.selfInitiated ?? false,
      persons: c.persons ? [...c.persons] : [],
      vehicles: c.vehicles ? [...c.vehicles] : [],
      documents: [],
    };
    this.callList.push(call);
    this.callMap.set(id, call);
    this.rev++;
    this.bus?.emit('cad:callCreated', { callId: id, typeId: call.typeId, priority: call.priority, selfInitiated: call.selfInitiated });
    return call;
  }

  call(id: number): CadCall | null {
    return this.callMap.get(id) ?? null;
  }

  /** Every call kept (open and the last MAX_CLOSED_CALLS closed), by id. */
  calls(): readonly CadCall[] {
    return this.callList;
  }

  /** Pending and active calls: P1 first, then oldest. */
  openCalls(): CadCall[] {
    const open = this.callList.filter((c) => c.status !== 'closed');
    open.sort((a, b) => a.priority - b.priority || a.created.sim - b.created.sim || a.id - b.id);
    return open;
  }

  addNarrative(callId: number, source: string, text: string, t: CadTime): void {
    const call = this.callMap.get(callId);
    if (!call) return;
    const entry: NarrativeEntry = { sim: t.sim, game: t.game, source, text };
    call.narrative.push(entry);
    this.changed(call, 'narrative');
  }

  setPriority(callId: number, p: Priority, _t: CadTime): void {
    const call = this.callMap.get(callId);
    if (!call || call.status === 'closed' || call.priority === p || ![1, 2, 3, 4].includes(p)) return;
    call.priority = p;
    this.changed(call, 'priority');
  }

  /** Offers the call to `callsign` until sim time `expiresSim`; null withdraws the offer. */
  offer(callId: number, callsign: string | null, expiresSim: number, _t: CadTime): void {
    const call = this.callMap.get(callId);
    if (!call || call.status === 'closed') return;
    call.offeredTo = callsign;
    call.offerExpires = callsign === null ? 0 : expiresSim;
    this.changed(call, 'offer');
  }

  /**
   * Assigns a unit: it leaves its previous call, the call becomes active (units, primary, dispatched
   * time), the unit goes en route (`cad:unitStatus` via 'auto'), then `cad:unitAssigned`. Refused
   * (false, nothing changes) when the unit's status may not go en route (out of service, transporting).
   */
  assign(callId: number, callsign: string, t: CadTime, by: AssignedBy): boolean {
    const call = this.callMap.get(callId);
    const unit = this.unitMap.get(callsign);
    if (!call || !unit || call.status === 'closed') return false;
    if (unit.callId === callId && call.units.includes(callsign)) return true;
    if (!canAssign(unit.status)) return false;
    this.detach(unit);
    call.units.push(callsign);
    call.primary ??= callsign;
    call.status = 'active';
    call.dispatched ??= time(t);
    if (call.offeredTo === callsign) {
      call.offeredTo = null;
      call.offerExpires = 0;
    }
    unit.callId = callId;
    this.rev++;
    this.changeStatus(unit, 'enRoute', t, 'auto');
    this.bus?.emit('cad:unitAssigned', { callId, callsign, by });
    return true;
  }

  /** Takes a unit off its call (the call returns to pending when left without units); the unit goes available. */
  unassign(callsign: string, t: CadTime): void {
    const unit = this.unitMap.get(callsign);
    if (!unit || unit.callId === null) return;
    this.detach(unit);
    if (unit.status !== 'outOfService') this.changeStatus(unit, 'available', t, 'auto');
  }

  /**
   * Closes a call with a disposition: every assigned unit is released and set available (unless out of
   * service), then `cad:callClosed`. The call keeps its unit list as a record.
   */
  closeCall(callId: number, disposition: string, t: CadTime): void {
    const call = this.callMap.get(callId);
    if (!call || call.status === 'closed') return;
    call.status = 'closed';
    call.closed = time(t);
    call.disposition = disposition;
    call.offeredTo = null;
    call.offerExpires = 0;
    this.rev++;
    for (const callsign of call.units) {
      const unit = this.unitMap.get(callsign);
      if (!unit || unit.callId !== callId) continue;
      unit.callId = null;
      if (unit.status !== 'outOfService') this.changeStatus(unit, 'available', t, 'auto');
    }
    this.bus?.emit('cad:callClosed', { callId, disposition });
    this.trimClosed();
  }

  // --- Traffic stop ---------------------------------------------------------------------------

  /** Replaces the traffic-stop context; emits cad:trafficStop on activation and when an active stop ends. */
  setTrafficStop(info: TrafficStopInfo | null, _t: CadTime): void {
    const prev = this.stop;
    const wasActive = prev?.outcome === 'active';
    this.stop = info ? { ...info, started: time(info.started), citations: [...info.citations] } : null;
    this.rev++;
    const next = this.stop;
    if (next?.outcome === 'active') {
      this.bus?.emit('cad:trafficStop', { active: true, callId: next.callId, vehicleId: next.vehicleId });
    } else if (wasActive && prev) {
      const ended = next ?? prev;
      this.bus?.emit('cad:trafficStop', { active: false, callId: ended.callId, vehicleId: ended.vehicleId });
    }
  }

  /** Patches the mutable fields of the current stop (vehicle, plate, start and true driver are fixed). */
  updateTrafficStop(patch: Partial<TrafficStopInfo>, _t: CadTime): void {
    const stop = this.stop;
    if (!stop) return;
    const wasActive = stop.outcome === 'active';
    const target = stop as unknown as Record<string, unknown>;
    const source = patch as Record<string, unknown>;
    for (const key of STOP_PATCH_KEYS) {
      const value = source[key];
      if (value === undefined) continue;
      if (key === 'outcome' && !isOneOf(value, STOP_OUTCOMES)) continue;
      target[key] = Array.isArray(value) ? [...(value as unknown[])] : value;
    }
    this.rev++;
    const active = stop.outcome === 'active';
    if (active !== wasActive) {
      this.bus?.emit('cad:trafficStop', { active, callId: stop.callId, vehicleId: stop.vehicleId });
    }
  }

  // --- Persistence ----------------------------------------------------------------------------

  serialize(): CadSave {
    return {
      version: 1,
      nextCallId: this.nextCallId,
      calls: structuredClone(this.callList),
      units: structuredClone(this.unitList),
      docs: this.docs.serialize(),
      trafficStop: this.stop ? structuredClone(this.stop) : null,
    };
  }

  /** Replaces everything (no events); bumps both revisions. */
  restore(save: CadSave): void {
    this.callList = structuredClone(save.calls);
    this.callMap.clear();
    for (const c of this.callList) this.callMap.set(c.id, c);
    this.unitList = structuredClone(save.units);
    this.unitMap.clear();
    for (const u of this.unitList) this.unitMap.set(u.callsign, u);
    let next = save.nextCallId;
    for (const c of this.callList) next = Math.max(next, c.id + 1);
    this.nextCallId = next;
    this.stop = save.trafficStop ? structuredClone(save.trafficStop) : null;
    this.docs.restore(save.docs);
    this.rev++;
    this.avlRev++;
  }

  // --- Internals ------------------------------------------------------------------------------

  private changed(call: CadCall, change: CadCallChange): void {
    this.rev++;
    this.bus?.emit('cad:callUpdated', { callId: call.id, change });
  }

  /** Removes the unit from its call without a status change. */
  private detach(unit: CadUnit): void {
    const callId = unit.callId;
    if (callId === null) return;
    unit.callId = null;
    this.rev++;
    const call = this.callMap.get(callId);
    if (!call || call.status === 'closed') return;
    const i = call.units.indexOf(unit.callsign);
    if (i >= 0) call.units.splice(i, 1);
    if (call.primary === unit.callsign) call.primary = call.units[0] ?? null;
    if (call.units.length === 0) call.status = 'pending';
    this.changed(call, 'units');
  }

  private changeStatus(unit: CadUnit, status: UnitStatus, t: CadTime, via: RequestVia): void {
    const prev = unit.status;
    if (prev === status) return;
    unit.status = status;
    unit.statusSince = time(t);
    this.rev++;
    if (status === 'onScene' && unit.callId !== null) {
      const call = this.callMap.get(unit.callId);
      if (call && call.firstOnScene === null) call.firstOnScene = time(t);
    }
    this.bus?.emit('cad:unitStatus', { callsign: unit.callsign, status, prev, callId: unit.callId, via });
  }

  /** Drops the oldest closed calls (by close time, then id) beyond MAX_CLOSED_CALLS. */
  private trimClosed(): void {
    let closed = 0;
    for (const c of this.callList) if (c.status === 'closed') closed++;
    while (closed > MAX_CLOSED_CALLS) {
      let oldest = -1;
      for (let i = 0; i < this.callList.length; i++) {
        const c = this.callList[i];
        if (!c || c.closed === null || c.status !== 'closed') continue;
        const o = oldest >= 0 ? this.callList[oldest] : undefined;
        if (!o || o.closed === null || c.closed.sim < o.closed.sim || (c.closed.sim === o.closed.sim && c.id < o.id)) oldest = i;
      }
      if (oldest < 0) return;
      const [removed] = this.callList.splice(oldest, 1);
      if (removed) this.callMap.delete(removed.id);
      closed--;
    }
  }

  /** Links a document to its call (and unlinks it from any other call, e.g. after a draft was re-linked). */
  private onDocument(doc: CadDocument): void {
    this.rev++;
    for (const c of this.callList) {
      if (c.id === doc.callId) continue;
      const i = c.documents.indexOf(doc.id);
      if (i >= 0) c.documents.splice(i, 1);
    }
    if (doc.callId === null) return;
    const call = this.callMap.get(doc.callId);
    if (call && !call.documents.includes(doc.id)) call.documents.push(doc.id);
  }
}

// --- Save validation ----------------------------------------------------------------------------

function isLocation(x: unknown): x is CadLocation {
  return isObj(x) && isNum(x.x) && isNum(x.z) && isInt(x.edge) && isStr(x.text) && isStr(x.street) &&
    isStr(x.cross) && isStr(x.near) && isStr(x.district);
}

function isCaller(x: unknown): x is CallerInfo {
  return isObj(x) && isOneOf(x.kind, CALLER_KINDS) && isStr(x.name) && isStr(x.phone) && isInt(x.personId);
}

function isNarrative(x: unknown): x is NarrativeEntry {
  return isObj(x) && isNum(x.sim) && isNum(x.game) && isStr(x.source) && isStr(x.text);
}

const isCallId = (v: unknown): v is number => isInt(v, 1);

function isPriority(x: unknown): x is Priority {
  return x === 1 || x === 2 || x === 3 || x === 4;
}

function isCall(x: unknown): x is CadCall {
  return isObj(x) && isInt(x.id, 1) && isStr(x.number) && isStr(x.typeId) && isPriority(x.priority) &&
    isStr(x.nature) && isLocation(x.location) && isCaller(x.caller) && isArrayOf(x.narrative, isNarrative) &&
    isOneOf(x.status, CALL_STATUSES) && isStrArray(x.units) && isNullOr(x.primary, isStr) &&
    isNullOr(x.offeredTo, isStr) && isNum(x.offerExpires) && isCadTime(x.created) &&
    isNullOr(x.dispatched, isCadTime) && isNullOr(x.firstOnScene, isCadTime) && isNullOr(x.closed, isCadTime) &&
    isNullOr(x.disposition, isStr) && isBool(x.selfInitiated) && isIntArray(x.persons) &&
    isIntArray(x.vehicles) && isStrArray(x.documents);
}

function isUnit(x: unknown): x is CadUnit {
  return isObj(x) && isStr(x.callsign) && x.callsign.length > 0 && isOneOf(x.kind, ['player', 'ai'] as const) &&
    isStr(x.officer) && isStr(x.beat) && isInt(x.fleetIndex) && isOneOf(x.status, UNIT_STATUSES) &&
    isNullOr(x.callId, isCallId) && isCadTime(x.statusSince) && isNum(x.x) && isNum(x.z) && isBool(x.emergency);
}

function isTrafficStop(x: unknown): x is TrafficStopInfo {
  return isObj(x) && isInt(x.callId) && isInt(x.vehicleId) && isStr(x.plate) && isNum(x.x) && isNum(x.z) &&
    isCadTime(x.started) && isInt(x.driverId) && isInt(x.trueDriverId) && isBool(x.plateRun) &&
    isBool(x.vinChecked) && isStr(x.vinResult) && isStrArray(x.citations) && isOneOf(x.outcome, STOP_OUTCOMES);
}

/** Structural check of a CAD save block (statuses, kinds, priorities, finite numbers, unique ids). */
export function isCadSave(x: unknown): x is CadSave {
  if (!isObj(x) || x.version !== 1 || !isInt(x.nextCallId, 1)) return false;
  if (!isArrayOf(x.calls, isCall) || !isArrayOf(x.units, isUnit)) return false;
  if (!isDocumentsSave(x.docs) || !isNullOr(x.trafficStop, isTrafficStop)) return false;
  const callIds = new Set<number>();
  for (const c of x.calls) {
    if (callIds.has(c.id) || c.id >= x.nextCallId) return false;
    callIds.add(c.id);
  }
  const callsigns = new Set<string>();
  for (const u of x.units) {
    if (callsigns.has(u.callsign)) return false;
    callsigns.add(u.callsign);
  }
  return true;
}
