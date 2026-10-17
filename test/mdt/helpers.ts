import { CadState } from '../../src/cad/cadState';
import type { CadLocation, CadTime, Priority, TrafficStopInfo, UnitRequest } from '../../src/cad/types';
import { RecordsDb } from '../../src/records/db';
import { driverOf, mountedPlate, observedVehicle } from '../../src/records/vehicle';
import type { MdtDeps } from '../../src/ui/mdt';
import type { RoadGraph } from '../../src/world/roadGraph';
import { fakeCtx } from '../records/helpers';
import { buildGraph } from '../world/helpers';

export const SEED = 42;

/** Sim 0 = 14:00 game time; game runs 30x. */
export function at(sim: number): CadTime {
  return { sim, game: 50400 + sim * 30 };
}

/** 2 x 2 block grid, 200 m blocks, around the origin. */
export function smallGraph(): RoadGraph {
  return buildGraph(
    [[-200, -200], [0, -200], [200, -200], [-200, 0], [0, 0], [200, 0]],
    [{ from: 0, to: 1 }, { from: 1, to: 2 }, { from: 3, to: 4 }, { from: 4, to: 5 }, { from: 0, to: 3 }, { from: 1, to: 4 }, { from: 2, to: 5 }],
  );
}

export function location(text = '248 N Oak Street', x = 0, z = -100): CadLocation {
  return { x, z, edge: 5, text, street: 'Oak Street', cross: '2nd Street', near: '200 block of N Oak Street', district: 'Suburbs' };
}

export function addRoster(cad: CadState): void {
  cad.addUnit({ callsign: '12', kind: 'player', officer: 'Officer Doe', beat: 'downtown', fleetIndex: -1 }, at(0));
  cad.addUnit({ callsign: '21', kind: 'ai', officer: 'Officer Reyes', beat: 'downtown', fleetIndex: 0 }, at(0));
  cad.addUnit({ callsign: '23', kind: 'ai', officer: 'Officer Park', beat: 'suburbs', fleetIndex: 1 }, at(0));
}

export function addCall(cad: CadState, sim: number, priority: Priority, typeId = 'trafficHazard', text = 'RP reports debris.') {
  return cad.createCall(
    { typeId, priority, location: location(), caller: { kind: 'citizen', name: 'Jane Roe', phone: '555-0100', personId: 77 }, narrative: text },
    at(sim),
  );
}

export interface Fixture {
  cad: CadState;
  records: RecordsDb;
  graph: RoadGraph;
  deps: MdtDeps;
  requests: UnitRequest[];
  completed: string[];
  clock: { sim: number };
  state: { prisoner: number; atStation: boolean; violations: Record<string, number>; speed: { speedMph: number; limitMph: number } | null };
}

export function fixture(): Fixture {
  const cad = new CadState();
  addRoster(cad);
  const records = new RecordsDb(SEED, fakeCtx());
  const graph = smallGraph();
  const requests: UnitRequest[] = [];
  const completed: string[] = [];
  const clock = { sim: 0 };
  const state: Fixture['state'] = { prisoner: -1, atStation: false, violations: {}, speed: null };
  const deps: MdtDeps = {
    cad,
    records,
    graph,
    callsign: '12',
    officer: () => ({ name: 'Officer Doe', badge: '4071' }),
    now: () => at(clock.sim),
    request: (r) => requests.push(r),
    target: () => null,
    observed: (id) => (id >= 0 && id < 60000 ? observedVehicle(SEED, id) : null),
    observedViolations: () => state.violations,
    observedSpeed: () => state.speed,
    prisoner: () => state.prisoner,
    atStation: () => state.atStation,
    completeBooking: (id) => completed.push(id),
  };
  return { cad, records, graph, deps, requests, completed, clock, state };
}

/** Starts a stop on registry car `vehicleId` (its own call, player assigned). */
export function startStop(f: Fixture, vehicleId: number, patch: Partial<TrafficStopInfo> = {}): TrafficStopInfo {
  const call = f.cad.createCall(
    { typeId: 'trafficStop', priority: 4, location: location('400 S Elm Street', 100, 0), caller: { kind: 'officer', name: 'Unit 12', phone: '', personId: -1 }, narrative: 'Traffic stop', selfInitiated: true },
    at(f.clock.sim),
  );
  f.cad.assign(call.id, '12', at(f.clock.sim), 'self');
  const stop: TrafficStopInfo = {
    callId: call.id,
    vehicleId,
    plate: mountedPlate(SEED, vehicleId).plate,
    x: 100,
    z: 0,
    started: at(f.clock.sim),
    driverId: -1,
    trueDriverId: driverOf(SEED, vehicleId),
    plateRun: false,
    vinChecked: false,
    vinResult: '',
    citations: [],
    outcome: 'active',
    ...patch,
  };
  f.cad.setTrafficStop(stop, at(f.clock.sim));
  return stop;
}

export function key(k: string, target: unknown = null): KeyboardEvent {
  return { key: k, target, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, preventDefault() {} } as unknown as KeyboardEvent;
}
