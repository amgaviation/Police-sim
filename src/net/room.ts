/**
 * Authoritative co-op room (Phase 8 §8.2). Pure state machine: the server feeds it parsed client messages and
 * broadcasts the events it returns. Every rejected message leaves the state (and `rev`) unchanged. Time comes in as
 * `nowMs`; no clock, no randomness.
 */
import { LIMITS, PROTOCOL_VERSION, ROLE_LIMITS, validateClientMsg } from './protocol.ts';
import type {
  ClientMsg,
  NetCall,
  NetNote,
  NetUnit,
  NetUnitStatus,
  PresenceEntry,
  RejectCode,
  RoomEvent,
  RoomSnapshot,
  ServerMsg,
} from './protocol.ts';

export interface RoomOptions {
  name: string;
  seed: number;
  /** Total members (default 6 = 4 patrol + dispatcher + supervisor). */
  maxMembers?: number;
}

/** Token bucket: `capacity` burst, `refillPerS` tokens per second. */
export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerS: number;
  private tokens: number;
  private lastMs: number | null = null;
  constructor(capacity: number, refillPerS: number) {
    this.capacity = capacity;
    this.refillPerS = refillPerS;
    this.tokens = capacity;
  }
  /** Consume one token; false when the bucket is empty. */
  take(nowMs: number): boolean {
    if (this.lastMs !== null && nowMs > this.lastMs) {
      this.tokens = Math.min(this.capacity, this.tokens + ((nowMs - this.lastMs) / 1000) * this.refillPerS);
    }
    if (this.lastMs === null || nowMs > this.lastMs) this.lastMs = nowMs;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export interface HandleResult {
  events: RoomEvent[];
  reject: { code: RejectCode; reason: string } | null;
  /** Messages for the sender only (welcome, pong). */
  direct: ServerMsg[];
}

const TRANSITIONS: Readonly<Record<NetUnitStatus, readonly NetUnitStatus[]>> = {
  available: ['enRoute', 'onScene', 'busy', 'outOfService'],
  enRoute: ['onScene', 'available', 'busy', 'outOfService'],
  onScene: ['busy', 'available', 'transporting', 'enRoute', 'outOfService'],
  busy: ['available', 'onScene', 'enRoute', 'transporting', 'outOfService'],
  transporting: ['available', 'onScene', 'busy', 'outOfService'],
  outOfService: ['available'],
};

/** Unit status transition table (any -> outOfService; outOfService -> available only). Staying in the same status is
 *  allowed (it only updates the call link). */
export function canTransition(from: NetUnitStatus, to: NetUnitStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

const PRESENCE_MIN_GAP_MS = 80;
const OFFICER_CALL_RADIUS_M = 150;
const GENERATOR_GAP_MS = 10000;
/** Position jitter a presence may exceed the speed limit by (m): the step must stay within `maxSpeedMps * dt + slack`. */
const PRESENCE_SLACK_M = 10;
const DEFAULT_MAX_MEMBERS = 6;
/** Open calls one member may have created at a time (generated calls are limited by their own gap): one client cannot fill the shared CAD. */
const MAX_OPEN_OFFICER_CALLS = 3;
const MAX_OPEN_DISPATCHER_CALLS = 20;

interface Member {
  id: string;
  unit: NetUnit;
  limiter: RateLimiter;
  lastPresenceMs: number | null;
  partnerWish: string | null;
}

const NO_EVENTS: readonly RoomEvent[] = [];

function ok(events: RoomEvent[] = [], direct: ServerMsg[] = []): HandleResult {
  return { events, reject: null, direct };
}
function rej(code: RejectCode, reason: string): HandleResult {
  return { events: [], reject: { code, reason }, direct: [] };
}

function cloneUnit(u: NetUnit): NetUnit {
  return { ...u };
}
function cloneCall(c: NetCall): NetCall {
  return { ...c, units: c.units.slice(), notes: c.notes.map((n) => ({ ...n })) };
}

export class Room {
  private readonly name: string;
  private readonly maxMembers: number;
  private seedValue: number;
  private revValue = 0;
  private hostCallsign = '';
  private readonly members = new Map<string, Member>();
  private readonly byCallsign = new Map<string, Member>();
  private readonly calls = new Map<number, NetCall>();
  private readonly closedOrder: number[] = [];
  private nextCallId = 1;
  private lastGeneratorMs: number | null = null;

  constructor(opts: RoomOptions) {
    this.name = opts.name;
    this.seedValue = opts.seed;
    this.maxMembers = opts.maxMembers ?? DEFAULT_MAX_MEMBERS;
  }

  /** Open calls (id order) plus the last `LIMITS.closedKept` closed ones; all copies. */
  get snapshot(): RoomSnapshot {
    const units: NetUnit[] = [];
    for (const m of this.members.values()) units.push(cloneUnit(m.unit));
    const calls: NetCall[] = [];
    for (const c of this.calls.values()) if (c.status !== 'closed') calls.push(cloneCall(c));
    for (const id of this.closedOrder) {
      const c = this.calls.get(id);
      if (c) calls.push(cloneCall(c));
    }
    return { room: this.name, seed: this.seedValue, rev: this.revValue, host: this.hostCallsign, units, calls };
  }
  /** +1 per applied event. */
  get rev(): number {
    return this.revValue;
  }
  get size(): number {
    return this.members.size;
  }
  /** Callsign of the host ('' while empty). */
  get host(): string {
    return this.hostCallsign;
  }
  /** Callsign of a member id, or null. */
  callsignOf(memberId: string): string | null {
    return this.members.get(memberId)?.unit.callsign ?? null;
  }

  /** Wrap the events returned by the latest `join` / `handle` / `leave` call into `event` messages carrying their
   *  revision numbers. Call it right after that call, before any other mutation. */
  stamp(events: readonly RoomEvent[]): ServerMsg[] {
    const first = this.revValue - events.length + 1;
    return events.map((ev, i): ServerMsg => ({ t: 'event', rev: first + i, ev }));
  }

  /** Role limit -> 'full'; protocol version -> 'version'. Callsigns: patrol N1..N4 (lowest free), DISPATCH, S1. The
   *  first member becomes host and fixes the seed (hello.seed or the room's). */
  join(
    memberId: string,
    hello: Extract<ClientMsg, { t: 'hello' }>,
    _nowMs: number,
  ): HandleResult & { callsign: string | null } {
    const fail = (code: RejectCode, reason: string): HandleResult & { callsign: string | null } => ({
      ...rej(code, reason),
      callsign: null,
    });
    const v = validateClientMsg(hello);
    if (!v.ok) return fail(v.code, v.reason);
    if (hello.v !== PROTOCOL_VERSION) return fail('version', `protocol version ${PROTOCOL_VERSION} required`);
    if (this.members.has(memberId)) return fail('illegalState', 'already joined');
    if (this.members.size >= this.maxMembers) return fail('full', 'room is full');
    let inRole = 0;
    for (const m of this.members.values()) if (m.unit.role === hello.role) inRole++;
    if (inRole >= ROLE_LIMITS[hello.role]) return fail('full', `no free ${hello.role} slot`);
    const callsign = this.freeCallsign(hello.role);
    if (callsign === null) return fail('full', `no free ${hello.role} slot`);

    if (this.members.size === 0) {
      this.hostCallsign = callsign;
      this.seedValue = hello.seed ?? this.seedValue;
    }
    const unit: NetUnit = {
      callsign,
      role: hello.role,
      name: hello.name,
      status: 'available',
      callId: null,
      x: 0,
      z: 0,
      heading: 0,
      speed: 0,
      driving: false,
      partner: null,
    };
    const member: Member = { id: memberId, unit, limiter: new RateLimiter(40, 20), lastPresenceMs: null, partnerWish: null };
    this.members.set(memberId, member);
    this.byCallsign.set(callsign, member);
    const events: RoomEvent[] = [];
    this.emit(events, { k: 'joined', unit: cloneUnit(unit) });
    // Only a patrol unit can generate calls, so a patrol who joins a room hosted by a supervisor / dispatcher takes over.
    if (hello.role === 'patrol' && this.members.size > 1 && this.byCallsign.get(this.hostCallsign)?.unit.role !== 'patrol') {
      this.hostCallsign = callsign;
      this.emit(events, { k: 'host', callsign });
    }
    const welcome: ServerMsg = { t: 'welcome', v: PROTOCOL_VERSION, callsign, role: hello.role, snapshot: this.snapshot };
    return { ...ok(events, [welcome]), callsign };
  }

  /** Remove a member: unassign its unit from calls, emit 'left' and, when it was the host, the new host. */
  leave(memberId: string): RoomEvent[] {
    const m = this.members.get(memberId);
    if (!m) return NO_EVENTS.slice();
    const events: RoomEvent[] = [];
    const cs = m.unit.callsign;
    for (const c of this.calls.values()) {
      if (c.status !== 'closed' && c.units.includes(cs)) this.detach(c, cs, events, false);
    }
    this.members.delete(memberId);
    this.byCallsign.delete(cs);
    for (const o of this.members.values()) {
      if (o.partnerWish === cs) o.partnerWish = null;
      if (o.unit.partner === cs) o.unit.partner = null;
    }
    this.emit(events, { k: 'left', callsign: cs });
    if (this.hostCallsign === cs) {
      let next: Member | null = null;
      for (const o of this.members.values()) {
        if (next === null) next = o;
        if (o.unit.role === 'patrol') {
          next = o;
          break;
        }
      }
      this.hostCallsign = next ? next.unit.callsign : '';
      if (next) this.emit(events, { k: 'host', callsign: this.hostCallsign });
    }
    return events;
  }

  /** Apply one validated client message from a member. */
  handle(memberId: string, msg: ClientMsg, nowMs: number): HandleResult {
    const m = this.members.get(memberId);
    if (!m) return rej('notFound', 'not a member of this room');
    if (!m.limiter.take(nowMs)) return rej('rate', 'rate limit exceeded');
    const v = validateClientMsg(msg);
    if (!v.ok) return rej(v.code, v.reason);
    switch (msg.t) {
      case 'hello':
        return rej('illegalState', 'already joined');
      case 'ping':
        return ok([], [{ t: 'pong', n: msg.n }]);
      case 'presence':
        return this.onPresence(m, msg, nowMs);
      case 'unitStatus':
        return this.onUnitStatus(m, msg);
      case 'callCreate':
        return this.onCallCreate(m, msg, nowMs);
      case 'callAssign':
        return this.onAssign(m, msg);
      case 'callUnassign':
        return this.onUnassign(m, msg);
      case 'callPriority':
        return this.onPriority(m, msg);
      case 'callNote':
        return this.onNote(m, msg, nowMs);
      case 'callClose':
        return this.onClose(m, msg);
      case 'order':
        return this.onOrder(m, msg);
      case 'partner':
        return this.onPartner(m, msg);
      case 'radio': {
        const events: RoomEvent[] = [];
        this.emit(events, { k: 'radio', from: m.unit.callsign, channel: msg.channel, text: msg.text });
        return ok(events);
      }
    }
  }

  /** Batched presence of every unit that has reported a position (the dispatcher has none). */
  presence(): ServerMsg {
    const units: PresenceEntry[] = [];
    for (const m of this.members.values()) {
      if (m.lastPresenceMs === null) continue;
      const u = m.unit;
      units.push({ callsign: u.callsign, x: u.x, z: u.z, heading: u.heading, speed: u.speed, driving: u.driving });
    }
    return { t: 'presence', units };
  }

  // -------------------------------------------------------------------------------------------------------------------

  private emit(events: RoomEvent[], ev: RoomEvent): void {
    events.push(ev);
    this.revValue++;
  }

  private freeCallsign(role: NetUnit['role']): string | null {
    if (role === 'dispatcher') return this.byCallsign.has('DISPATCH') ? null : 'DISPATCH';
    if (role === 'supervisor') return this.byCallsign.has('S1') ? null : 'S1';
    for (let i = 1; i <= ROLE_LIMITS.patrol; i++) {
      const cs = `N${i}`;
      if (!this.byCallsign.has(cs)) return cs;
    }
    return null;
  }

  private openCallCount(): number {
    let n = 0;
    for (const c of this.calls.values()) if (c.status !== 'closed') n++;
    return n;
  }

  /** Open calls a member created and that are not host-generated. */
  private openCallsBy(callsign: string): number {
    let n = 0;
    for (const c of this.calls.values()) if (c.status !== 'closed' && c.createdBy === callsign && c.origin !== 'generator') n++;
    return n;
  }

  private hasDispatcher(): boolean {
    for (const m of this.members.values()) if (m.unit.role === 'dispatcher') return true;
    return false;
  }

  private openCallOf(callsign: string): NetCall | null {
    for (const c of this.calls.values()) if (c.status !== 'closed' && c.units.includes(callsign)) return c;
    return null;
  }

  /** Remove `callsign` from an open call. A unit that was enRoute / onScene on it becomes available. */
  private detach(call: NetCall, callsign: string, events: RoomEvent[], unitStays: boolean): void {
    call.units = call.units.filter((u) => u !== callsign);
    if (call.primary === callsign) call.primary = call.units[0] ?? null;
    if (call.units.length === 0 && call.status === 'active') call.status = 'pending';
    this.emit(events, { k: 'callUnassigned', callId: call.id, callsign });
    const m = this.byCallsign.get(callsign);
    if (!m || !unitStays) return;
    this.releaseUnit(m, call.id, events);
  }

  /** Clear the unit's link to `callId`; enRoute / onScene units go back to available. */
  private releaseUnit(m: Member, callId: number, events: RoomEvent[]): void {
    const u = m.unit;
    if (u.callId !== callId) return;
    u.callId = null;
    if (u.status === 'enRoute' || u.status === 'onScene') u.status = 'available';
    this.emit(events, { k: 'unitStatus', callsign: u.callsign, status: u.status, callId: null });
  }

  private onPresence(m: Member, msg: Extract<ClientMsg, { t: 'presence' }>, nowMs: number): HandleResult {
    const u = m.unit;
    if (u.role === 'dispatcher') return rej('forbidden', 'the dispatcher has no position');
    if (m.lastPresenceMs !== null) {
      if (nowMs - m.lastPresenceMs < PRESENCE_MIN_GAP_MS) return rej('rate', 'presence too frequent');
      const dist = Math.hypot(msg.x - u.x, msg.z - u.z);
      const dt = (nowMs - m.lastPresenceMs) / 1000;
      if (dist > LIMITS.maxSpeedMps * dt + PRESENCE_SLACK_M) {
        return rej('invalidValue', 'implausible movement');
      }
    }
    u.x = msg.x;
    u.z = msg.z;
    u.heading = msg.heading;
    u.speed = msg.speed;
    u.driving = msg.driving;
    m.lastPresenceMs = nowMs;
    return ok();
  }

  private onUnitStatus(m: Member, msg: Extract<ClientMsg, { t: 'unitStatus' }>): HandleResult {
    const u = m.unit;
    if (u.role === 'dispatcher') return rej('forbidden', 'the dispatcher has no unit status');
    if (!canTransition(u.status, msg.status)) return rej('illegalState', `cannot go from ${u.status} to ${msg.status}`);
    if (msg.callId !== null) {
      const call = this.calls.get(msg.callId);
      if (!call) return rej('notFound', 'unknown call');
      if (call.status === 'closed') return rej('illegalState', 'call is closed');
      if (!call.units.includes(u.callsign)) return rej('illegalState', 'unit is not assigned to that call');
    } else if (msg.status === 'enRoute' || msg.status === 'onScene') {
      return rej('illegalState', `${msg.status} needs a call`);
    }
    if (u.status === msg.status && u.callId === msg.callId) return ok();
    u.status = msg.status;
    u.callId = msg.callId;
    const events: RoomEvent[] = [];
    this.emit(events, { k: 'unitStatus', callsign: u.callsign, status: u.status, callId: u.callId });
    return ok(events);
  }

  private onCallCreate(m: Member, msg: Extract<ClientMsg, { t: 'callCreate' }>, nowMs: number): HandleResult {
    const u = m.unit;
    let generated = false;
    if (u.role === 'patrol') {
      if (msg.origin === 'dispatcher') return rej('forbidden', 'patrol units cannot create dispatcher calls');
      if (msg.origin === 'officer') {
        if (m.lastPresenceMs === null) return rej('illegalState', 'no position reported yet');
        if (Math.hypot(msg.x - u.x, msg.z - u.z) > OFFICER_CALL_RADIUS_M) {
          return rej('invalidValue', `officer calls must be within ${OFFICER_CALL_RADIUS_M} m of the unit`);
        }
      } else {
        if (this.hostCallsign !== u.callsign) return rej('forbidden', 'only the host generates calls');
        if (this.hasDispatcher()) return rej('forbidden', 'a dispatcher is present');
        if (this.lastGeneratorMs !== null && nowMs - this.lastGeneratorMs < GENERATOR_GAP_MS) {
          return rej('rate', 'generated calls are limited to one per 10 s');
        }
        generated = true;
      }
    } else if (u.role === 'dispatcher' && msg.origin === 'generator') {
      // The dispatcher's client is the room's call source: its generated calls are paced like the host's.
      if (this.lastGeneratorMs !== null && nowMs - this.lastGeneratorMs < GENERATOR_GAP_MS) {
        return rej('rate', 'generated calls are limited to one per 10 s');
      }
      generated = true;
    } else if (msg.origin !== 'dispatcher') {
      return rej('forbidden', 'only patrol units create officer or generated calls');
    }
    if (this.openCallCount() >= LIMITS.maxOpenCalls) return rej('illegalState', 'too many open calls');
    if (!generated) {
      const cap = u.role === 'patrol' ? MAX_OPEN_OFFICER_CALLS : MAX_OPEN_DISPATCHER_CALLS;
      if (this.openCallsBy(u.callsign) >= cap) return rej('illegalState', `you already have ${cap} open calls; close one first`);
    }
    if (generated) this.lastGeneratorMs = nowMs;
    const call: NetCall = {
      id: this.nextCallId++,
      ref: msg.ref,
      typeId: msg.typeId,
      label: msg.label,
      priority: msg.priority,
      x: msg.x,
      z: msg.z,
      address: msg.address,
      narrative: msg.narrative,
      status: 'pending',
      units: [],
      primary: null,
      notes: [],
      createdBy: u.callsign,
      origin: msg.origin,
      createdAtMs: nowMs,
      disposition: null,
    };
    this.calls.set(call.id, call);
    const events: RoomEvent[] = [];
    this.emit(events, { k: 'callCreated', call: cloneCall(call) });
    return ok(events);
  }

  /** Shared target checks of callAssign / callUnassign: patrol only itself; nobody addresses the dispatcher. */
  private targetOf(m: Member, unit: string): Member | HandleResult {
    if (m.unit.role === 'patrol' && unit !== m.unit.callsign) return rej('forbidden', 'patrol units act on themselves only');
    const target = this.byCallsign.get(unit);
    if (!target) return rej('notFound', 'unknown unit');
    if (target.unit.role === 'dispatcher') return rej('forbidden', 'the dispatcher cannot be assigned');
    return target;
  }

  private onAssign(m: Member, msg: Extract<ClientMsg, { t: 'callAssign' }>): HandleResult {
    const target = this.targetOf(m, msg.unit);
    if (!('unit' in target)) return target;
    const call = this.calls.get(msg.callId);
    if (!call) return rej('notFound', 'unknown call');
    if (call.status === 'closed') return rej('illegalState', 'call is closed');
    if (call.units.includes(msg.unit)) return rej('illegalState', 'unit already assigned');
    const events: RoomEvent[] = [];
    const previous = this.openCallOf(msg.unit);
    if (previous) this.detach(previous, msg.unit, events, true);
    call.units.push(msg.unit);
    call.primary ??= msg.unit;
    call.status = 'active';
    target.unit.callId = call.id;
    this.emit(events, { k: 'callAssigned', callId: call.id, callsign: msg.unit, primary: call.primary });
    return ok(events);
  }

  private onUnassign(m: Member, msg: Extract<ClientMsg, { t: 'callUnassign' }>): HandleResult {
    const target = this.targetOf(m, msg.unit);
    if (!('unit' in target)) return target;
    const call = this.calls.get(msg.callId);
    if (!call) return rej('notFound', 'unknown call');
    if (call.status === 'closed') return rej('illegalState', 'call is closed');
    if (!call.units.includes(msg.unit)) return rej('illegalState', 'unit is not assigned');
    const events: RoomEvent[] = [];
    this.detach(call, msg.unit, events, true);
    return ok(events);
  }

  private onPriority(m: Member, msg: Extract<ClientMsg, { t: 'callPriority' }>): HandleResult {
    if (m.unit.role === 'patrol') return rej('forbidden', 'patrol units cannot change priority');
    const call = this.calls.get(msg.callId);
    if (!call) return rej('notFound', 'unknown call');
    if (call.status === 'closed') return rej('illegalState', 'call is closed');
    call.priority = msg.priority;
    const events: RoomEvent[] = [];
    this.emit(events, { k: 'callPriority', callId: call.id, priority: msg.priority });
    return ok(events);
  }

  private onNote(m: Member, msg: Extract<ClientMsg, { t: 'callNote' }>, nowMs: number): HandleResult {
    const call = this.calls.get(msg.callId);
    if (!call) return rej('notFound', 'unknown call');
    if (m.unit.role === 'patrol' && !call.units.includes(m.unit.callsign)) {
      return rej('forbidden', 'only assigned units add notes');
    }
    if (call.status === 'closed') return rej('illegalState', 'call is closed');
    if (call.notes.length >= LIMITS.notesPerCall) return rej('illegalState', 'note limit reached');
    const note: NetNote = { by: m.unit.callsign, text: msg.text, atMs: nowMs };
    call.notes.push(note);
    const events: RoomEvent[] = [];
    this.emit(events, { k: 'callNote', callId: call.id, note: { ...note } });
    return ok(events);
  }

  private onClose(m: Member, msg: Extract<ClientMsg, { t: 'callClose' }>): HandleResult {
    const call = this.calls.get(msg.callId);
    if (!call) return rej('notFound', 'unknown call');
    if (m.unit.role === 'patrol' && call.primary !== m.unit.callsign && !call.units.includes(m.unit.callsign)) {
      return rej('forbidden', 'only the primary or assigned units close a call');
    }
    if (call.status === 'closed') return rej('illegalState', 'call is closed');
    call.status = 'closed';
    call.disposition = msg.disposition;
    const events: RoomEvent[] = [];
    this.emit(events, { k: 'callClosed', callId: call.id, disposition: msg.disposition });
    for (const cs of call.units) {
      const um = this.byCallsign.get(cs);
      if (um) this.releaseUnit(um, call.id, events);
    }
    this.closedOrder.push(call.id);
    while (this.closedOrder.length > LIMITS.closedKept) {
      const old = this.closedOrder.shift();
      if (old !== undefined) this.calls.delete(old);
    }
    return ok(events);
  }

  private onOrder(m: Member, msg: Extract<ClientMsg, { t: 'order' }>): HandleResult {
    const role = m.unit.role;
    if (role === 'patrol') return rej('forbidden', 'patrol units cannot give orders');
    if (role === 'dispatcher' && msg.order !== 'respond') return rej('forbidden', 'dispatchers may only order respond');
    const target = this.byCallsign.get(msg.unit);
    if (!target) return rej('notFound', 'unknown unit');
    if (target.unit.role === 'dispatcher') return rej('forbidden', 'the dispatcher cannot be ordered');
    if (msg.order === 'respond' && msg.callId === null) return rej('invalidValue', 'respond needs a call');
    if (msg.callId !== null) {
      const call = this.calls.get(msg.callId);
      if (!call) return rej('notFound', 'unknown call');
      if (call.status === 'closed') return rej('illegalState', 'call is closed');
    }
    const events: RoomEvent[] = [];
    this.emit(events, {
      k: 'order',
      to: msg.unit,
      from: m.unit.callsign,
      order: msg.order,
      callId: msg.callId,
      text: msg.text,
    });
    return ok(events);
  }

  private onPartner(m: Member, msg: Extract<ClientMsg, { t: 'partner' }>): HandleResult {
    if (m.unit.role !== 'patrol') return rej('forbidden', 'only patrol units partner up');
    const other = this.byCallsign.get(msg.unit);
    if (!other) return rej('notFound', 'unknown unit');
    if (other.unit.role !== 'patrol') return rej('forbidden', 'partner must be another patrol unit');
    if (other === m) return rej('invalidValue', 'cannot partner with yourself');
    if (m.unit.partner !== null || other.unit.partner !== null) return rej('illegalState', 'already partnered');
    const events: RoomEvent[] = [];
    if (other.partnerWish === m.unit.callsign) {
      m.unit.partner = other.unit.callsign;
      other.unit.partner = m.unit.callsign;
      m.partnerWish = null;
      other.partnerWish = null;
      this.emit(events, { k: 'partnered', a: other.unit.callsign, b: m.unit.callsign });
    } else {
      m.partnerWish = other.unit.callsign;
    }
    return ok(events);
  }
}
