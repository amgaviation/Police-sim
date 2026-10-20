import type { CadTime } from '../../src/cad/types';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { IncidentSystem } from '../../src/incidents/incidentSystem';
import '../../src/incidents/events';
import type { DashProbe, IncidentPorts, OfficerProbe, PursuitProbe, CallInfo } from '../../src/incidents/types';
import type { FoundItem, IncidentEvent, IncidentLog } from '../../src/legal/types';
import '../../src/contact/events';
import '../../src/force/events';
import '../../src/scene/events';
import '../../src/cad/events';
import '../../src/traffic/events';
import '../../src/investigation/events';
import '../../src/indoors/events';
import '../../src/npc/events';

export const DT = 1 / 60;
export const PC = 'A-12';

export type Extract2<K extends IncidentEvent['kind']> = Extract<IncidentEvent, { kind: K }>;

export function item(ref: string, over: Partial<FoundItem> = {}): FoundItem {
  return { ref, item: 'knife', label: 'Folding knife', category: 'weapon', weapon: true, incriminating: true, ...over };
}

export function drugs(ref: string): FoundItem {
  return { ref, item: 'baggie', label: 'Small baggie', category: 'drugs', weapon: false, incriminating: true };
}

/** Mutable state behind the fake ports. */
export class FakeWorld {
  calls = new Map<number, CallInfo>();
  labels = new Map<number, string>();
  roles = new Map<number, string>();
  stop: { personId: number; vehicleId: number; callId: number } | null = null;
  observed: Record<string, number> = {};
  items = new Map<string, FoundItem & { ownerPersonId: number; buildingId: number }>();
  bookings = new Map<string, { personId: number; callId: number; charges: string[] }>();
  buildingCalls = new Map<number, number>();
  publicBuildings = new Set<number>();
  weapon: OfficerProbe['weapon'] = 'none';
  bodycamWorn = false;
  dash: DashProbe = { lights: false, nearCar: false };
  pursuit: PursuitProbe | null = null;
  contact: string | null = null;
}

export function makePorts(w: FakeWorld): IncidentPorts {
  return {
    callInfo: (id) => w.calls.get(id) ?? null,
    personLabel: (id) => w.labels.get(id) ?? `Person ${id}`,
    personRole: (id) => w.roles.get(id) ?? '',
    stopDriver: () => w.stop,
    observedViolations: () => w.observed,
    itemInfo: (id) => w.items.get(id) ?? null,
    booking: (id) => w.bookings.get(id) ?? null,
    buildingIncident: (b) => w.buildingCalls.get(b) ?? 0,
    publicPlace: (b) => w.publicBuildings.has(b),
    officer: (out) => {
      out.x = 0;
      out.z = 0;
      out.building = -1;
      out.inVehicle = false;
      out.weapon = w.weapon;
    },
    bodycamWorn: () => w.bodycamWorn,
    dashcam: (out) => {
      out.lights = w.dash.lights;
      out.nearCar = w.dash.nearCar;
    },
    pursuitProbe: (out) => {
      if (!w.pursuit) return false;
      Object.assign(out, w.pursuit);
      return true;
    },
    activeContactIncident: () => w.contact,
  };
}

export function callInfo(over: Partial<CallInfo> = {}): CallInfo {
  return { typeId: 'trafficStop', family: 'trafficStop', exigency: false, warrant: false, suspects: [], weaponReported: false, district: 'downtown', ...over };
}

/** A real bus, fake ports and a recorder system, stepped by hand. */
export class Rig {
  readonly bus = new EventBus<EventMap>();
  readonly world = new FakeWorld();
  readonly sys: IncidentSystem;
  readonly closed: EventMap['incident:closed'][] = [];
  readonly opened: string[] = [];
  readonly verdicts: EventMap['incident:forceVerdict'][] = [];
  readonly advisories: EventMap['incident:advisory'][] = [];
  readonly flashes: string[] = [];
  readonly reports: EventMap['incident:report'][] = [];
  sim = 100;
  game = 90000;

  constructor(opts: { jurisdiction?: string; callsign?: string | null } = {}) {
    this.sys = new IncidentSystem({
      bus: this.bus,
      ports: makePorts(this.world),
      seed: 4242,
      jurisdiction: opts.jurisdiction ?? 'generic',
      ...(opts.callsign === null ? {} : { callsign: opts.callsign ?? PC }),
    });
    this.wire();
  }

  /** Subscribes the recorders of the incident:* topics (also used after a second system is built on `bus`). */
  wire(): void {
    this.bus.on('incident:closed', (e) => this.closed.push(e));
    this.bus.on('incident:opened', (e) => this.opened.push(e.key));
    this.bus.on('incident:forceVerdict', (e) => this.verdicts.push(e));
    this.bus.on('incident:advisory', (e) => this.advisories.push(e));
    this.bus.on('incident:flash', (e) => this.flashes.push(e.text));
    this.bus.on('incident:report', (e) => this.reports.push(e));
  }

  time(): CadTime {
    return { sim: this.sim, game: this.game };
  }

  /** Runs `n` fixed steps. */
  step(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.sim += DT;
      this.game += DT;
      this.sys.step(DT, this.time());
    }
  }

  /** Runs whole seconds of steps. */
  seconds(s: number): void {
    this.step(Math.round(s / DT));
  }

  log(key: string): IncidentLog {
    const l = this.sys.log(key);
    if (!l) throw new Error(`no log ${key}`);
    return l;
  }

  kinds(key: string): string[] {
    return this.log(key).events.map((e) => e.kind);
  }

  of<K extends IncidentEvent['kind']>(key: string, kind: K): Extract2<K>[] {
    return this.log(key).events.filter((e): e is Extract2<K> => e.kind === kind);
  }

  indicators(key: string): string[] {
    return this.of(key, 'indicator').map((e) => `${e.personId}:${e.indicator}`);
  }
}

/** The contact payload fields every contact topic shares. */
export function cx(callId: number, personId: number, role = 'suspect', incident?: string): { incident: string; callId: number; personId: number; role: string } {
  return { incident: incident ?? `C-${String(callId).padStart(5, '0')}`, callId, personId, role };
}

export function said(
  rig: Rig, callId: number, personId: number, over: Partial<EventMap['contact:said']> = {},
): void {
  rig.bus.emit('contact:said', {
    ...cx(callId, personId), utteranceId: 'u', intent: 'ask', topic: 'questions', fact: 'drinking', consent: null, command: null,
    tone: 'neutral', outcome: null, custody: false, gunpoint: false, sim: rig.sim, ...over,
  });
}

export function fact(
  rig: Rig, callId: number, personId: number, over: Partial<EventMap['contact:fact']> = {},
): void {
  rig.bus.emit('contact:fact', {
    ...cx(callId, personId), topic: 'drinking', value: 'yes', source: 'claim', display: 'Says: had a drink', detail: '', sim: rig.sim, ...over,
  });
}

export function action(
  rig: Rig, callId: number, personId: number, name: string, over: Partial<EventMap['contact:action']> = {},
): void {
  rig.bus.emit('contact:action', {
    ...cx(callId, personId), action: name, ok: true, items: [], vehicleId: -1, result: null, custody: false, sim: rig.sim, ...over,
  });
}

export function consent(
  rig: Rig, callId: number, personId: number, kind: EventMap['contact:consent']['kind'], over: Partial<EventMap['contact:consent']> = {},
): void {
  rig.bus.emit('contact:consent', {
    incident: `C-${String(callId).padStart(5, '0')}`, callId, personId, kind, granted: true, valid: true, buildingId: -1, room: -1, sim: rig.sim, ...over,
  });
}

export function key(callId: number): string {
  return `C-${String(callId).padStart(5, '0')}`;
}
