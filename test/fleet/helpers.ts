import { EventBus } from '../../src/core/events';
import type { EventMap } from '../../src/core/event-map';
import { createRng } from '../../src/core/rng';
import type { CadTime } from '../../src/cad/types';
import { FleetSystem, type FleetDeps, type FleetVehiclePort } from '../../src/fleet/fleetSystem';
import type { FleetSave } from '../../src/fleet/save';
import { PRONOUN_PRESETS } from '../../src/uniform/pronouns';
import type { SerializedVehicle, VehicleCondition } from '../../src/vehicles/drivableVehicle';
import { vehicleModel } from '../../src/vehicles/model';

export function condition(over: Partial<VehicleCondition> = {}): VehicleCondition {
  return {
    modelId: 'patrol_sedan',
    fuelFraction: 1,
    fuelL: 60,
    oilFraction: 1,
    tread: [1, 1, 1, 1],
    flats: [false, false, false, false],
    zones: [0, 0, 0, 0],
    engineHealth: 1,
    engineFailed: false,
    odometerKm: 0,
    ...over,
  };
}

/** A vehicle with mutable condition and the four service calls recorded. */
export class FakePort implements FleetVehiclePort {
  readonly eid: number;
  readonly model: { id: string; fuel: { capacityL: number } };
  cond: VehicleCondition;
  readonly calls: string[] = [];

  constructor(eid: number, modelId = 'patrol_sedan', over: Partial<VehicleCondition> = {}) {
    this.eid = eid;
    this.model = { id: modelId, fuel: { capacityL: vehicleModel(modelId).fuel.capacityL } };
    this.cond = condition({ modelId, ...over });
  }

  condition(out?: VehicleCondition): VehicleCondition {
    const c = out ?? condition();
    c.modelId = this.cond.modelId;
    c.fuelFraction = this.cond.fuelFraction;
    c.fuelL = this.cond.fuelL;
    c.oilFraction = this.cond.oilFraction;
    c.engineHealth = this.cond.engineHealth;
    c.engineFailed = this.cond.engineFailed;
    c.odometerKm = this.cond.odometerKm;
    for (let i = 0; i < 4; i++) {
      c.tread[i] = this.cond.tread[i] ?? 1;
      c.flats[i] = this.cond.flats[i] ?? false;
      c.zones[i] = this.cond.zones[i] ?? 0;
    }
    return c;
  }

  refuel(): void {
    this.calls.push('refuel');
    this.cond.fuelFraction = 1;
  }

  changeOil(): void {
    this.calls.push('oil');
    this.cond.oilFraction = 1;
  }

  replaceTires(): void {
    this.calls.push('tires');
    this.cond.tread = [1, 1, 1, 1];
    this.cond.flats = [false, false, false, false];
  }

  repair(): void {
    this.calls.push('repair');
    this.cond.zones = [0, 0, 0, 0];
    this.cond.engineHealth = 1;
    this.cond.engineFailed = false;
    this.cond.flats = [false, false, false, false];
  }
}

export interface Rig {
  bus: EventBus<EventMap>;
  fleet: FleetSystem;
  ports: Map<string, FakePort>;
  deps: FleetDeps;
  /** Mutable damage context returned for every eid. */
  context: { pursuit: boolean; emergency: boolean; callId: number };
  events: { topic: string; payload: unknown }[];
}

const TOPICS = ['fleet:damage', 'fleet:incident', 'fleet:charge', 'fleet:service', 'fleet:inspection', 'fleet:shiftEnd', 'fleet:flash'] as const;

export function time(sim: number, game = sim * 30): CadTime {
  return { sim, game };
}

export function rig(save?: FleetSave, ports = new Map<string, FakePort>()): Rig {
  const bus = new EventBus<EventMap>();
  const context = { pursuit: false, emergency: false, callId: 0 };
  const events: { topic: string; payload: unknown }[] = [];
  for (const topic of TOPICS) bus.on(topic, (payload) => events.push({ topic, payload }));
  const deps: FleetDeps = {
    bus,
    rng: createRng(7).stream('fleet'),
    vehicleOf: (id) => ports.get(id) ?? null,
    damageContext: () => context,
    officer: () => ({ name: 'Alex Rivera', badge: '4471', pronouns: PRONOUN_PRESETS.they }),
  };
  return { bus, fleet: new FleetSystem(deps, save), ports, deps, context, events };
}

/** Spawns a fake vehicle for `unitId` and binds it. */
export function spawn(r: Rig, unitId: string, eid: number, modelId = 'patrol_sedan', over: Partial<VehicleCondition> = {}): FakePort {
  const port = new FakePort(eid, modelId, over);
  r.ports.set(unitId, port);
  r.fleet.bindVehicle(unitId, eid);
  return port;
}

export function topics(r: Rig, topic: string): unknown[] {
  return r.events.filter((e) => e.topic === topic).map((e) => e.payload);
}

export function storedVehicle(modelId = 'patrol_sedan'): SerializedVehicle {
  return {
    modelId, x: 1, y: 0.5, z: 2, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, fuelL: 30,
    brakeTempC: [20, 20], zones: [0.1, 0, 0, 0], engineHealth: 0.9, engineFailed: false, tireFlat: [false, false, false, false],
    headlights: false, lightbar: false, reversing: false,
    wear: { oilL: 2, tread: [0.8, 0.8, 0.7, 0.7], odometerM: 1200 },
  };
}
