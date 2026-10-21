import { EventBus } from '../../src/core/events';
import type { EventMap } from '../../src/core/event-map';
import { TutorialRunner, newTutorialSave, type TutorialPorts, type TutorialProbe, type TutorialSave, type TutorialScript } from '../../src/tutorial';

export const PLAYER = 'A12';

/** Fake ports: probe values are set by the test; createCall hands out ascending ids and counts its calls. */
export class FakePorts implements TutorialPorts {
  probes: Record<TutorialProbe, number> = { speedKmh: 0, driving: 0, lightbar: 0, siren: 0, distanceToCallM: Infinity };
  probeCalls = 0;
  probeCallIds: number[] = [];
  created: { typeId: string; minM: number; maxM: number }[] = [];
  nextCallId = 700;
  failCreate = false;

  playerCallsign(): string {
    return PLAYER;
  }

  probe(id: TutorialProbe, callId: number): number {
    this.probeCalls++;
    this.probeCallIds.push(callId);
    return this.probes[id];
  }

  createCall(typeId: string, minM: number, maxM: number): number {
    this.created.push({ typeId, minM, maxM });
    return this.failCreate ? -1 : this.nextCallId++;
  }
}

export interface Rig {
  bus: EventBus<EventMap>;
  ports: FakePorts;
  runner: TutorialRunner;
  steps: { scriptId: string; index: number; id: string; count: number }[];
  done: { scriptId: string; completed: boolean; skipped: number }[];
  flashes: string[];
  /** Runs `n` fixed steps. */
  tick(n?: number): void;
  /** Forwards an event to the runner, like the integrator's bus bridge. */
  send(topic: string, payload: unknown): void;
}

/** Subscribes the log to the bus. */
export function attach(bus: EventBus<EventMap>): Pick<Rig, 'steps' | 'done' | 'flashes'> {
  const log: Pick<Rig, 'steps' | 'done' | 'flashes'> = { steps: [], done: [], flashes: [] };
  bus.on('tutorial:step', (e) => void log.steps.push(e));
  bus.on('tutorial:done', (e) => void log.done.push(e));
  bus.on('tutorial:flash', (e) => void log.flashes.push(e.text));
  return log;
}

export function makeRig(opts: { save?: TutorialSave; script?: TutorialScript; ports?: FakePorts; bus?: EventBus<EventMap> } = {}): Rig {
  const bus = opts.bus ?? new EventBus<EventMap>();
  const ports = opts.ports ?? new FakePorts();
  const save = opts.save ?? newTutorialSave('firstShift');
  const runner = new TutorialRunner(bus, ports, save, opts.script);
  const log = attach(bus);
  return {
    bus,
    ports,
    runner,
    ...log,
    tick(n = 1) {
      for (let i = 0; i < n; i++) runner.step();
    },
    send(topic, payload) {
      runner.onEvent(topic, payload);
    },
  };
}

/** One entry of the shipped script's walkthrough: how a test completes that step. */
export interface Beat {
  id: string;
  run(r: Rig, callId: number): void;
}

/** The synthetic inputs that complete each firstShift step, in order. `callId` is what the fake createCall returned. */
export const FIRST_SHIFT_BEATS: Beat[] = [
  { id: 'welcome', run: (r) => { r.runner.ack(); r.tick(); } },
  { id: 'enterCar', run: (r) => { r.send('player:mode', { mode: 'driving', vehicle: 9 }); r.tick(); } },
  { id: 'drive', run: (r) => { r.ports.probes.speedKmh = 42; r.tick(15); } },
  { id: 'lights', run: (r) => { r.ports.probes.lightbar = 1; r.tick(15); } },
  { id: 'radioStatus', run: (r) => { r.send('unit:request', { callsign: PLAYER, request: { kind: 'status', status: 'available' }, via: 'radio' }); r.tick(); } },
  { id: 'takeCall', run: (r, id) => { r.send('cad:unitAssigned', { callId: id, callsign: PLAYER, by: 'dispatch' }); r.tick(); } },
  { id: 'driveToCall', run: (r, id) => { r.send('cad:unitStatus', { callsign: PLAYER, status: 'onScene', prev: 'enRoute', callId: id, via: 'auto' }); r.tick(); } },
  { id: 'scene', run: (r, id) => { r.send('cad:callClosed', { callId: id, disposition: 'report' }); r.tick(); } },
  { id: 'report', run: (r) => { r.send('cad:documentSaved', { id: 'IR-1', kind: 'report', final: true }); r.tick(); } },
  { id: 'trafficStop', run: (r) => { r.send('traffic:pulledOver', { eid: 3, vehicleId: 4, x: 1, z: 2, yaw: 0 }); r.tick(); } },
  { id: 'runPlate', run: (r) => { r.send('dispatch:plateResult', { callsign: PLAYER, via: 'key', vehicleId: 4, readback: { plate: 'ABC123' } }); r.tick(); } },
  { id: 'contact', run: (r) => { r.send('cad:documentSaved', { id: 'CT-1', kind: 'citation', final: true }); r.tick(); } },
  { id: 'backup', run: (r) => { r.send('dispatch:backup', { requester: PLAYER, code: 3, units: ['B2'], x: 0, z: 0, location: 'Main St' }); r.tick(); } },
  { id: 'done', run: (r) => { r.runner.ack(); r.tick(); } },
];

/** Drives the first `n` beats (all when omitted). The call id of the run is the fake's first id. */
export function drive(r: Rig, n = FIRST_SHIFT_BEATS.length): void {
  for (const beat of FIRST_SHIFT_BEATS.slice(0, n)) beat.run(r, 700);
}
