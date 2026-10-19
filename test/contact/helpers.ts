import '../../src/cad/events';
import '../../src/contact/events';
import { CadState } from '../../src/cad/cadState';
import type { CadTime, UnitRequest } from '../../src/cad/types';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { createRng } from '../../src/core/rng';
import { ContactManager } from '../../src/contact/contactManager';
import type { ContactEventEvent, ContactLineEvent } from '../../src/contact/events';
import type { ContactSave, ContactSaveEntry, ContactTarget, IncidentInfo, Presence } from '../../src/contact/types';
import type { DialogueResult, IdentityClaim, IncidentTruth, SubjectMemory } from '../../src/dialogue';
import { NpcSystem } from '../../src/npc/npcSystem';
import type { ActorSpawn } from '../../src/npc/types';
import { Population } from '../../src/people/population';
import { CALENDAR } from '../../src/records/calendar';
import { RecordsDb } from '../../src/records/db';
import { laneRef } from '../../src/world/roadGraph';
import { fakeCtx } from '../records/helpers';
import { cityOf, spotIn, DOWNTOWN } from '../npc/helpers';
import { makeHarness, type Harness } from '../traffic/helpers';
import { at, newCall } from '../cad/helpers';

export const SEED = 77;
export const DT = 1 / 60;
export const NOON = 12 * 3600;

export interface ContactRig {
  readonly mgr: ContactManager;
  readonly npc: NpcSystem;
  readonly people: Population;
  readonly records: RecordsDb;
  readonly cad: CadState;
  readonly bus: EventBus<EventMap>;
  readonly traffic: Harness;
  /** Unit requests the contact manager sent to the dispatcher. */
  readonly requests: UnitRequest[];
  readonly events: ContactEventEvent[];
  readonly lines: ContactLineEvent[];
  readonly emitted: { topic: string; payload: unknown }[];
  readonly officer: { x: number; z: number; yaw: number };
  readonly presence: { value: Presence };
  readonly stop: { vehicleId: number };
  /** The officer's level reported through `officerPosition` (undefined: not reported). */
  readonly level: { building: number | undefined };
  /** What `premises()` returns for every person (null: none). */
  readonly premises: { value: { buildingId: number; authority: boolean; room: number } | null };
  readonly interpreter: { available: boolean };
  readonly clock: { sim: number; game: number };
  readonly spot: { x: number; z: number };
  /** Makes a second manager over the same world (for seed searches); the first stays registered on the bus. */
  manager(seed: number): ContactManager;
  time(): CadTime;
  step(steps?: number): void;
  /** Steps for `seconds` of sim time. */
  advance(seconds: number): void;
  spawn(personId: number, over?: Partial<ActorSpawn>): number;
  place(vehicleId: number): void;
}

export const TRUTH: IncidentTruth = {
  destination: 'home',
  origin: 'work',
  account: 'We were just talking and it got loud.',
  suspectWhereabouts: 'They ran that way.',
  reason: 'a noise complaint',
};

export function incident(key: string, over: Partial<IncidentInfo> = {}): IncidentInfo {
  return { key, callId: 0, role: 'suspect', truth: TRUTH, guilty: false, vehicleId: -1, stop: false, ...over };
}

let harness: Harness | null = null;

/** One traffic harness (rapier world) for the whole test file. */
export async function sharedHarness(): Promise<Harness> {
  harness ??= await makeHarness(cityOf(SEED).graph, SEED, cityOf(SEED));
  return harness;
}

export async function makeRig(start = NOON): Promise<ContactRig> {
  const city = cityOf(SEED);
  const traffic = await sharedHarness();
  const spot = spotIn(city, DOWNTOWN);
  if (!spot) throw new Error('no downtown spot');
  const bus = new EventBus<EventMap>((topic, error) => {
    throw new Error(`${topic}: ${String(error)}`);
  });
  const clock = { sim: 0, game: start };
  const records = new RecordsDb(SEED, fakeCtx(CALENDAR.startEpochDay));
  const people = new Population({ seed: SEED, records, now: () => clock.game });
  const npc = new NpcSystem({
    seed: SEED,
    rng: createRng(SEED).stream('npc'),
    city,
    people,
    traffic: traffic.sys,
    world: traffic.world,
    bus,
    now: () => clock.game,
  });
  npc.setDensityScale(0);
  const cad = new CadState(bus);
  const requests: UnitRequest[] = [];
  const events: ContactEventEvent[] = [];
  const lines: ContactLineEvent[] = [];
  const emitted: { topic: string; payload: unknown }[] = [];
  bus.on('contact:event', (e) => events.push({ ...e }));
  bus.on('contact:line', (e) => lines.push({ ...e }));
  for (const topic of ['contact:caged', 'contact:openForm', 'contact:needsCall', 'contact:consent'] as const) {
    bus.on(topic, (payload) => emitted.push({ topic, payload }));
  }
  (bus as unknown as { on(topic: string, h: (p: unknown) => void): void }).on('force:used', (p) => emitted.push({ topic: 'force:used', payload: p }));
  const officer = { x: spot.x, z: spot.z, yaw: 0 };
  const presence = { value: { lights: false, siren: false, backup: 0, weapon: 'none' } as Presence };
  const stop = { vehicleId: -1 };
  const level: { building: number | undefined } = { building: undefined };
  const premises: { value: { buildingId: number; authority: boolean; room: number } | null } = { value: null };
  const interpreter = { available: false };
  const focus = { x: spot.x, z: spot.z, yaw: 0, speed: 0, onFoot: true, weapon: 'none' as const, lights: false, backup: 0 };

  function build(seed: number): ContactManager {
    return new ContactManager({
      seed: SEED,
      bus,
      cad,
      records,
      people,
      npc,
      rng: createRng(seed).stream('contact'),
      playerCallsign: '1A12',
      request: (r) => requests.push(r),
      officer: () => ({ name: 'Officer Hart', badge: '4071' }),
      presence: () => presence.value,
      officerPosition: (out) => {
        out.x = officer.x;
        out.z = officer.z;
        out.yaw = officer.yaw;
        if (level.building !== undefined) out.building = level.building;
      },
      premises: () => premises.value,
      trustAt: () => 0.5,
      districtOf: () => 'downtown',
      stopVehicleId: () => stop.vehicleId,
      interpreterAvailable: () => interpreter.available,
    });
  }

  const mgr = build(SEED);
  const rig: ContactRig = {
    mgr,
    npc,
    people,
    records,
    cad,
    bus,
    traffic,
    requests,
    events,
    lines,
    emitted,
    officer,
    presence,
    stop,
    level,
    premises,
    interpreter,
    clock,
    spot,
    manager: build,
    time: () => ({ sim: clock.sim, game: clock.game }),
    step(steps = 1): void {
      for (let i = 0; i < steps; i++) {
        clock.sim += DT;
        clock.game += DT * 30;
        npc.step(DT, clock.sim, focus);
        mgr.step(DT, { sim: clock.sim, game: clock.game });
      }
    },
    advance(seconds: number): void {
      rig.step(Math.ceil(seconds / DT));
    },
    spawn(personId: number, over: Partial<ActorSpawn> = {}): number {
      const id = npc.spawnActor({
        personId,
        x: spot.x + 1.5,
        z: spot.z,
        yaw: 0,
        profile: 'suspectCalm',
        role: 'suspect',
        callId: 0,
        hidden: false,
        body: 'human',
        weapon: null,
        vehicleId: -1,
        ...over,
      });
      if (id === 0) throw new Error('actor pool full');
      return id;
    },
    place(vehicleId: number): void {
      const city2 = cityOf(SEED);
      const near = city2.graph.edgesNear(spot.x, spot.z, 40, []);
      for (const eid of near) {
        const e = city2.graph.edges[eid];
        if (!e) continue;
        const slot = traffic.sys.spawnAt(laneRef(e.id, 0, 0), e.length * 0.5, { vehicleId, speed: 0 });
        if (slot >= 0) return;
      }
      throw new Error('no road for the test vehicle');
    },
  };
  return rig;
}

let seq = 0;
/** A unique incident key per call (several tests share one people store). */
export function key(prefix = 'T'): string {
  seq++;
  return `${prefix}-${seq}`;
}

export function at0(): CadTime {
  return at(0);
}

export { newCall };

/** Ids that satisfy `ok`, scanning the population from `from`. */
export function findPerson(_rig: ContactRig, ok: (id: number) => boolean, from = 0, to = 99000): number {
  for (let id = from; id < to; id++) if (ok(id)) return id;
  throw new Error('no matching person');
}

export function entryOf(save: ContactSave, personId: number): ContactSaveEntry {
  const e = save.contacts.find((x) => x.personId === personId);
  if (!e) throw new Error('no contact entry');
  return e;
}

/**
 * Test hook: patch the saved state of a contact and restore it (deterministic memory, consent or pending answers).
 * Returns the patched entry.
 */
export function patch(mgr: ContactManager, personId: number, fn: (e: ContactSaveEntry) => void): ContactSaveEntry {
  const save = JSON.parse(JSON.stringify(mgr.serialize())) as ContactSave;
  const e = entryOf(save, personId);
  fn(e);
  mgr.restore(save);
  return e;
}

export function claimOf(first: string, last: string, dob: number, over: Partial<IdentityClaim> = {}): IdentityClaim {
  return { kind: 'invented', personId: -1, first, middle: '', last, dob, address: '1 Test Street', document: 'none', dlNumber: '', ...over };
}

/** A synthetic answer that is delivered on the next step. */
export function answer(memory: SubjectMemory, over: Partial<DialogueResult> = {}): DialogueResult {
  return {
    lineKey: 'ask.truth',
    text: 'Okay.',
    delayS: 0,
    understood: true,
    statement: null,
    identity: null,
    consent: null,
    escalate: null,
    calmed: false,
    memory,
    ...over,
  };
}

/** Queues `result` as a due answer of the contact of `personId` and steps once to deliver it. */
export function inject(rig: ContactRig, personId: number, result: (memory: SubjectMemory) => DialogueResult): void {
  patch(rig.mgr, personId, (e) => {
    e.pending.push({ dueSim: 0, result: result(e.memory) });
  });
  rig.step();
}

export type { ContactTarget };
