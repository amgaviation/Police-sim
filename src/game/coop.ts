import { findCallType, CALL_TYPES, DISPOSITIONS } from '../cad/data';
import {
  ORDER_KINDS, LIMITS, NetClient,
  CoopMirror,
  type ClientMsg, type MirrorPort, type NetCall, type NetDisposition, type NetUnit, type OrderKind, type PresenceEntry, type RoomEvent,
  type RoomSnapshot, type ServerMsg, type NetRole,
} from '../net';
import type { RemoteUnit } from '../ui/hud/types';
import type { ConsoleCall, ConsolePriority, ConsoleUnit, DispatchConsolePort } from '../ui/dispatch/model';
import type { CoopPanelState } from '../ui/coop/panel';
import { headingOf, type GameSession } from './session';
import { Transform } from '../ecs/components';

/** Presence goes out at 5 Hz. */
export const PRESENCE_INTERVAL_MS = 200;
/** The orders list keeps this many lines. */
const ORDER_LOG = 6;
/** The call type a mirrored call falls back to when this client lacks the sender's type (mods differ). */
const FALLBACK_TYPE = 'noiseComplaint';
const NO_UNITS: readonly NetUnit[] = [];

const clampPriority = (p: number): ConsolePriority => (p <= 1 ? 1 : p >= 4 ? 4 : (Math.round(p) as ConsolePriority));

/** Applies a room event to a plain copy of the room (the console's view); calls are cloned shallowly. */
export function applyRoomEvent(units: Map<string, NetUnit>, calls: Map<number, NetCall>, ev: RoomEvent): void {
  switch (ev.k) {
    case 'joined':
      units.set(ev.unit.callsign, { ...ev.unit });
      return;
    case 'left':
      units.delete(ev.callsign);
      return;
    case 'host':
    case 'order':
    case 'radio':
      return;
    case 'unitStatus': {
      const u = units.get(ev.callsign);
      if (u) {
        u.status = ev.status;
        u.callId = ev.callId;
      }
      return;
    }
    case 'callCreated':
      calls.set(ev.call.id, { ...ev.call, units: [...ev.call.units], notes: [...ev.call.notes] });
      return;
    case 'callAssigned': {
      const c = calls.get(ev.callId);
      if (!c) return;
      if (!c.units.includes(ev.callsign)) c.units.push(ev.callsign);
      c.primary = ev.primary;
      c.status = 'active';
      const u = units.get(ev.callsign);
      if (u) u.callId = ev.callId;
      return;
    }
    case 'callUnassigned': {
      const c = calls.get(ev.callId);
      if (!c) return;
      c.units = c.units.filter((x) => x !== ev.callsign);
      if (c.primary === ev.callsign) c.primary = c.units[0] ?? null;
      if (c.units.length === 0 && c.status === 'active') c.status = 'pending';
      const u = units.get(ev.callsign);
      if (u && u.callId === ev.callId) u.callId = null;
      return;
    }
    case 'callPriority': {
      const c = calls.get(ev.callId);
      if (c) c.priority = ev.priority;
      return;
    }
    case 'callNote': {
      calls.get(ev.callId)?.notes.push(ev.note);
      return;
    }
    case 'callClosed': {
      const c = calls.get(ev.callId);
      if (!c) return;
      c.status = 'closed';
      c.disposition = ev.disposition;
      for (const cs of c.units) {
        const u = units.get(cs);
        if (u && u.callId === ev.callId) u.callId = null;
      }
      return;
    }
    case 'partnered': {
      const a = units.get(ev.a);
      const b = units.get(ev.b);
      if (a) a.partner = ev.b;
      if (b) b.partner = ev.a;
      return;
    }
  }
}

/** Hooks the app gives the co-op session. */
export interface CoopHooks {
  flash(text: string): void;
  /** The connection ended (the session continues offline). */
  disconnected(reason: string): void;
}

/**
 * The co-op layer of one session (design §20.5): drains the client once per frame into the mirror (local CAD) and a plain
 * room copy (the dispatcher console), sends the local officer's intents (status, self assignment, clears, presence at 5 Hz,
 * generated calls of the host) and keeps the remote officers as CAD `resource` units. Presentation and CAD only: each client
 * simulates its own world.
 */
export class CoopSession {
  readonly client: NetClient;
  readonly mirror: CoopMirror;
  readonly role: NetRole;
  readonly self: string;
  readonly seed: number;
  /** The room as the events built it (self included). */
  readonly units = new Map<string, NetUnit>();
  readonly calls = new Map<number, NetCall>();
  readonly orders: string[] = [];
  /** Server rejections shown to the player (newest last). */
  readonly rejections: string[] = [];
  /** Bumps whenever calls or units changed. */
  revision = 0;
  host = '';
  connected = true;
  private readonly session: GameSession;
  private readonly hooks: CoopHooks;
  private readonly inbox: ServerMsg[] = [];
  private readonly offs: (() => void)[] = [];
  private nextPresenceMs = 0;
  private nextRef = 1;
  private applying = false;
  private lastGenerated = -1;
  private readonly sentCalls = new Set<number>();
  private readonly figures = new Map<string, number>();
  private readonly remote: RemoteUnit[] = [];
  private lastX = 0;
  private lastZ = 0;

  constructor(session: GameSession, client: NetClient, hooks: CoopHooks) {
    const welcome = client.welcome;
    if (!welcome) throw new Error('CoopSession: the client has not joined');
    this.session = session;
    this.client = client;
    this.hooks = hooks;
    this.role = welcome.role;
    this.self = welcome.callsign;
    this.seed = welcome.snapshot.seed;
    this.mirror = new CoopMirror(this.self);
    const p8 = session.phase8;
    p8.mode.coopRole = this.role;
    p8.setMode('coop');
    this.applySnapshotState(welcome.snapshot);
    this.updateDispatchFlags();
    this.wireOutbound();
    session.bus.emit('coop:status', { connected: true, unit: this.self, members: this.units.size });
  }

  /** The units in the room other than self. */
  others(): NetUnit[] {
    const out: NetUnit[] = [];
    for (const u of this.units.values()) if (u.callsign !== this.self) out.push(u);
    return out;
  }

  private hasDispatcher(): boolean {
    for (const u of this.units.values()) if (u.role === 'dispatcher') return true;
    return false;
  }

  /** Manual dispatch always; the generator only for the host patrol while no dispatcher is in the room. */
  private updateDispatchFlags(): void {
    const generator = this.connected && this.role === 'patrol' && this.host === this.self && !this.hasDispatcher();
    this.session.phase8.setCoopDispatch(this.connected, generator || !this.connected);
    this.generatorOn = generator;
  }

  private generatorOn = false;

  private applySnapshotState(s: RoomSnapshot): void {
    this.units.clear();
    this.calls.clear();
    for (const u of s.units) this.units.set(u.callsign, { ...u });
    for (const c of s.calls) this.calls.set(c.id, { ...c, units: [...c.units], notes: [...c.notes] });
    this.host = s.host;
    this.revision++;
  }

  // --- Frame ----------------------------------------------------------------------------------------

  /** Once per frame: inbound messages, host generator proposals, presence. */
  update(nowMs: number): void {
    if (!this.connected) return;
    const inbox = this.inbox;
    inbox.length = 0;
    this.client.drain(inbox);
    for (let i = 0; i < inbox.length; i++) this.handle(inbox[i] as ServerMsg);
    inbox.length = 0;
    if (this.client.state === 'closed' || this.client.state === 'failed') {
      this.drop(this.client.reason === '' ? 'Connection lost' : this.client.reason);
      return;
    }
    if (this.role !== 'dispatcher' && nowMs >= this.nextPresenceMs) {
      this.nextPresenceMs = nowMs + PRESENCE_INTERVAL_MS;
      this.sendPresence();
    }
  }

  private handle(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.applySnapshotState(msg.snapshot);
        this.applying = true;
        this.mirror.applySnapshot(msg.snapshot, this.port);
        this.applying = false;
        this.updateDispatchFlags();
        return;
      case 'event':
        this.applyEvent(msg.ev);
        return;
      case 'presence':
        this.applyPresence(msg.units);
        return;
      case 'reject':
      case 'error': {
        const text = `Co-op: ${msg.reason}`;
        this.rejections.push(text);
        if (this.rejections.length > ORDER_LOG) this.rejections.shift();
        this.session.bus.emit('coop:flash', { text });
        return;
      }
      case 'pong':
        return;
    }
  }

  private applyEvent(ev: RoomEvent): void {
    applyRoomEvent(this.units, this.calls, ev);
    this.revision++;
    if (ev.k === 'host') this.host = ev.callsign;
    this.applying = true;
    try {
      this.mirror.applyEvent(ev, this.port);
    } finally {
      this.applying = false;
    }
    if (ev.k === 'joined' || ev.k === 'left' || ev.k === 'host') {
      this.updateDispatchFlags();
      this.session.bus.emit('coop:status', { connected: true, unit: this.self, members: this.units.size });
    }
    if (ev.k === 'radio') {
      const channel: 'car' | 'tac' = ev.channel === 'tac' ? 'tac' : 'car';
      if (ev.from !== this.self) this.session.radio.say(channel, ev.text, ev.from);
    }
  }

  private applyPresence(list: readonly PresenceEntry[]): void {
    for (const p of list) {
      const u = this.units.get(p.callsign);
      if (u) {
        u.x = p.x;
        u.z = p.z;
        u.heading = p.heading;
        u.speed = p.speed;
        u.driving = p.driving;
      }
    }
    this.mirror.applyPresence(list, this.port);
    this.revision++;
  }

  private sendPresence(): void {
    const s = this.session;
    const at = s.playerPosition({ x: 0, z: 0 });
    const v = s.drivenVehicle;
    const heading = v ? headingOf(Transform.qx[v.eid] ?? 0, Transform.qy[v.eid] ?? 0, Transform.qz[v.eid] ?? 0, Transform.qw[v.eid] ?? 1) : s.controller.yaw;
    this.lastX = at.x;
    this.lastZ = at.z;
    this.client.send({ t: 'presence', x: at.x, z: at.z, heading, speed: v ? v.telemetry.groundSpeed : 0, driving: v !== null });
  }

  // --- Mirror port: the local CAD -----------------------------------------------------------------

  private readonly port: MirrorPort = {
    createCall: (c) => {
      const s = this.session;
      const typeId = findCallType(c.typeId) ? c.typeId : FALLBACK_TYPE;
      const spec = { typeId, priority: c.priority, ...(c.narrative !== '' ? { narrative: c.narrative } : {}) };
      // Each client simulates its own city: a point that is water or off the map here falls back to the officer's own position.
      let call = s.dispatcher.createScriptedCall({ ...spec, x: c.x, z: c.z }, s.now());
      if (!call) {
        const at = s.playerPosition({ x: 0, z: 0 });
        call = s.dispatcher.createScriptedCall({ ...spec, x: at.x, z: at.z }, s.now());
      }
      if (!call) return -1;
      this.sentCalls.add(call.id);
      return call.id;
    },
    assign: (local, callsign, self) => {
      const s = this.session;
      if (self) {
        // A unit that is 10-7 (the shift is not started yet) cannot take the call: say so instead of failing silently.
        if (s.cad.unit(s.dispatcher.playerCallsign)?.status === 'outOfService') {
          s.bus.emit('coop:flash', { text: `Dispatch assigned you ${s.cad.call(local)?.number ?? 'a call'}: go 10-8 (available) to respond` });
          return;
        }
        s.dispatcher.request(s.dispatcher.playerCallsign, { kind: 'selfAssign', callId: local }, 'auto');
        return;
      }
      if (s.cad.unit(callsign)) s.cad.assign(local, callsign, s.now(), 'dispatch');
    },
    unassign: (_local, callsign, self) => {
      const s = this.session;
      if (self) s.cad.unassign(s.dispatcher.playerCallsign, s.now());
      else if (s.cad.unit(callsign)) s.cad.unassign(callsign, s.now());
    },
    setPriority: (local, p) => this.session.dispatcher.setCallPriority(local, p, this.session.now()),
    addNote: (local, by, text) => this.session.cad.addNarrative(local, by, text, this.session.now()),
    close: (local, disposition) => {
      const s = this.session;
      if (s.cad.call(local)?.status !== 'closed') s.cad.closeCall(local, disposition, s.now());
    },
    upsertUnit: (u) => this.upsertRemote(u),
    removeUnit: (callsign) => {
      this.session.cad.removeUnit(callsign);
      this.figures.delete(callsign);
    },
    order: (o) => {
      const line = `${o.from}: ${orderText(o.order)}${o.callId !== null ? ` (call ${String(o.callId)})` : ''}${o.text !== '' ? ` — ${o.text}` : ''}`;
      this.orders.push(line);
      if (this.orders.length > ORDER_LOG) this.orders.shift();
      this.session.bus.emit('coop:order', { from: o.from, order: o.order, callId: o.callId, text: o.text, line });
      this.session.radio.say('dispatch', line, o.from);
    },
    radio: (from, channel, text) => {
      void channel;
      void from;
      void text;
      // Radio lines are spoken from the inbound event handler (not for the sender's own echo).
    },
  };

  private upsertRemote(u: NetUnit): void {
    const s = this.session;
    if (u.callsign === this.self) return;
    let cu = s.cad.unit(u.callsign);
    if (!cu) {
      cu = s.cad.addUnit({ callsign: u.callsign, kind: 'resource', officer: u.name, beat: '', fleetIndex: -1 }, s.now());
    }
    s.cad.setUnitPosition(u.callsign, u.x, u.z);
    if (cu.status !== u.status) s.cad.setUnitStatus(u.callsign, u.status, s.now(), 'auto');
    if (u.role === 'patrol') this.figures.set(u.callsign, u.driving ? 1 : 0);
  }

  // --- Outbound intents -----------------------------------------------------------------------------

  private wireOutbound(): void {
    const bus = this.session.bus;
    const pc = this.session.dispatcher.playerCallsign;
    const send = (msg: ClientMsg): void => {
      if (this.connected) this.client.send(msg);
    };
    this.offs.push(
      bus.on('cad:unitStatus', (e) => {
        if (e.callsign !== pc || this.applying || this.role === 'dispatcher') return;
        let net: number | null = null;
        if (e.callId !== null) {
          net = this.mirror.netIdOf(e.callId);
          if (net < 0) return;
        }
        const mine = this.units.get(this.self);
        if (mine && mine.status === e.status && mine.callId === net) return;
        send({ t: 'unitStatus', status: e.status, callId: net });
      }),
      bus.on('cad:unitAssigned', (e) => {
        if (e.callsign !== pc || this.applying || this.role === 'dispatcher') return;
        const net = this.mirror.netIdOf(e.callId);
        if (net < 0 || this.calls.get(net)?.units.includes(this.self)) return;
        send({ t: 'callAssign', callId: net, unit: this.self });
      }),
      bus.on('cad:callClosed', (e) => {
        if (this.applying) return;
        const net = this.mirror.netIdOf(e.callId);
        const nc = this.calls.get(net);
        if (net < 0 || !nc || nc.status === 'closed') return;
        if (!(DISPOSITIONS.some((d) => d.id === e.disposition))) return;
        send({ t: 'callClose', callId: net, disposition: e.disposition as NetDisposition });
      }),
      bus.on('cad:callCreated', (e) => {
        if (this.applying || this.sentCalls.has(e.callId) || this.role !== 'patrol') return;
        const call = this.session.cad.call(e.callId);
        if (!call) return;
        const officer = call.selfInitiated;
        if (!officer && !this.generatorOn) return;
        this.sentCalls.add(e.callId);
        const ref = `L${String(this.nextRef++)}`;
        this.mirror.expectOwn(ref, e.callId);
        send({
          t: 'callCreate',
          ref,
          typeId: call.typeId,
          label: call.nature.slice(0, LIMITS.label),
          priority: clampPriority(call.priority),
          x: call.location.x,
          z: call.location.z,
          address: call.location.text.slice(0, LIMITS.address),
          narrative: (call.narrative[0]?.text ?? '').slice(0, LIMITS.narrative),
          origin: officer ? 'officer' : 'generator',
        });
        this.lastGenerated = e.callId;
      }),
    );
  }

  /** Id of the last call this client proposed as generated (tests). */
  get lastGeneratedCall(): number {
    return this.lastGenerated;
  }

  // --- Actions the UI sends -------------------------------------------------------------------------

  send(msg: ClientMsg): boolean {
    return this.connected ? this.client.send(msg) : false;
  }

  requestPartner(unit: string): void {
    this.send({ t: 'partner', unit });
  }

  sendRadio(text: string): void {
    this.send({ t: 'radio', channel: 'main', text });
    this.session.radio.say('car', text, this.self);
  }

  disconnect(): void {
    this.drop('Disconnected');
  }

  private drop(reason: string): void {
    if (!this.connected) return;
    this.connected = false;
    this.client.close();
    this.session.phase8.setCoopDispatch(false, true);
    this.session.phase8.mode.id = 'freePatrol';
    for (const cs of this.figures.keys()) this.session.cad.removeUnit(cs);
    this.figures.clear();
    this.session.bus.emit('coop:status', { connected: false, unit: this.self, members: 0 });
    this.session.bus.emit('coop:flash', { text: `Co-op ${reason === 'Disconnected' ? 'disconnected' : `ended: ${reason}`}; playing offline` });
    this.hooks.disconnected(reason);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    if (this.connected) {
      this.connected = false;
      this.client.close();
    }
  }

  // --- Views ----------------------------------------------------------------------------------------

  panelState(): CoopPanelState {
    const mine = this.units.get(this.self);
    return { members: [...this.units.values()], self: this.self, partner: mine?.partner ?? null, orders: this.orders };
  }

  /** Remote officers for the minimap and the MDT map (reused list). */
  remoteUnits(): readonly RemoteUnit[] {
    const out = this.remote;
    out.length = 0;
    for (const u of this.units.values()) {
      if (u.callsign === this.self || u.role === 'dispatcher') continue;
      out.push({ callsign: u.callsign, x: u.x, z: u.z });
    }
    return out;
  }

  /** The status line of the HUD chip. */
  chip(): { connected: boolean; unit: string; members: number } {
    return { connected: this.connected, unit: this.self, members: this.units.size };
  }

  /** Last own position sent (tests). */
  get lastPosition(): { x: number; z: number } {
    return { x: this.lastX, z: this.lastZ };
  }

  /** On-foot remote patrol officers for the people renderer. */
  figureUnits(): readonly NetUnit[] {
    if (this.figures.size === 0) return NO_UNITS;
    const out: NetUnit[] = [];
    for (const u of this.units.values()) if (u.callsign !== this.self && u.role === 'patrol' && this.figures.has(u.callsign) && !u.driving) out.push(u);
    return out;
  }
}

function orderText(order: OrderKind): string {
  switch (order) {
    case 'respond':
      return 'respond';
    case 'returnToStation':
      return 'return to station';
    case 'terminatePursuit':
      return 'terminate the pursuit';
    case 'code4':
      return 'code 4';
    case 'backup':
      return 'backup';
  }
}

/**
 * The dispatch console's port over the room (co-op dispatcher and supervisor): calls and units from the room copy, every
 * action a client message. The server validates; rejections come back through `coop:flash`.
 */
export class NetConsolePort implements DispatchConsolePort {
  readonly title: string;
  readonly canCreate: boolean;
  readonly orders: readonly string[];
  readonly dispositions = DISPOSITIONS.map((d) => ({ id: d.id, label: d.label }));
  private readonly coop: CoopSession;
  private readonly clock: () => number;
  private readonly types = CALL_TYPES.filter((t) => t.generated).map((t) => ({ id: t.id, label: t.label }));
  private nextRef = 1;

  constructor(coop: CoopSession, clock: () => number) {
    this.coop = coop;
    this.clock = clock;
    this.title = coop.role === 'dispatcher' ? 'Dispatch (co-op)' : 'Supervisor (co-op)';
    this.canCreate = coop.role === 'dispatcher';
    this.orders = coop.role === 'dispatcher' ? ['respond'] : [...ORDER_KINDS];
  }

  revision(): number {
    return this.coop.revision;
  }

  calls(): readonly ConsoleCall[] {
    const now = this.clock();
    const out: ConsoleCall[] = [];
    for (const c of this.coop.calls.values()) {
      if (c.status === 'closed') continue;
      out.push({
        id: c.id,
        number: `N-${String(c.id).padStart(4, '0')}`,
        nature: c.label,
        priority: clampPriority(c.priority),
        status: c.status,
        address: c.address,
        district: '',
        ageS: Math.max(0, (now - c.createdAtMs) / 1000),
        units: [...c.units],
        x: c.x,
        z: c.z,
        premise: [],
        notes: [c.narrative, ...c.notes.map((n) => `${n.by}: ${n.text}`)].filter((t) => t !== '').slice(-6),
      });
    }
    return out;
  }

  units(): readonly ConsoleUnit[] {
    const out: ConsoleUnit[] = [];
    for (const u of this.coop.units.values()) {
      if (u.role === 'dispatcher') continue;
      out.push({
        callsign: u.callsign,
        label: `${u.name} (${u.role})`,
        status: u.status,
        callId: u.callId,
        x: u.x,
        z: u.z,
        etaS: -1,
        kind: u.callsign === this.coop.self ? 'player' : 'remote',
      });
    }
    return out;
  }

  callTypes(): readonly { id: string; label: string }[] {
    return this.types;
  }

  score(): string | null {
    return null;
  }

  assign(callId: number, callsign: string): void {
    this.coop.send({ t: 'callAssign', callId, unit: callsign });
  }

  unassign(callId: number, callsign: string): void {
    this.coop.send({ t: 'callUnassign', callId, unit: callsign });
  }

  setPriority(callId: number, p: ConsolePriority): void {
    this.coop.send({ t: 'callPriority', callId, priority: p });
  }

  note(callId: number, text: string): void {
    this.coop.send({ t: 'callNote', callId, text: text.slice(0, LIMITS.note) });
  }

  close(callId: number, disposition: string): void {
    if (DISPOSITIONS.some((d) => d.id === disposition)) this.coop.send({ t: 'callClose', callId, disposition: disposition as NetDisposition });
  }

  create(typeId: string, priority: ConsolePriority, x: number, z: number): void {
    const type = findCallType(typeId);
    if (!type) return;
    this.coop.send({
      t: 'callCreate',
      ref: `D${String(this.nextRef++)}`,
      typeId,
      label: type.label.slice(0, LIMITS.label),
      priority,
      x,
      z,
      address: `${Math.round(x)}, ${Math.round(z)}`,
      narrative: type.narratives[0] ?? type.label,
      origin: 'dispatcher',
    });
  }

  order(callsign: string, order: string, callId: number | null): void {
    if (!(ORDER_KINDS as readonly string[]).includes(order)) return;
    this.coop.send({ t: 'order', unit: callsign, order: order as OrderKind, callId, text: '' });
  }
}
