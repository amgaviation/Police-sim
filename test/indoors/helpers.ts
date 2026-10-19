import { createRng } from '../../src/core/rng';
import { EventBus } from '../../src/core/events';
import type { EventMap } from '../../src/core/event-map';
import { InteriorSystem, type InteriorDeps, type OccupantPort, type OccupantSpawn, type OfficerAt } from '../../src/indoors';
import { generateInterior } from '../../src/interior/generate';
import type { InteriorLayout } from '../../src/interior/types';
import { PhysicsWorld, initRapier } from '../../src/physics/physics';
import { BuildingIndex, type BuildingInfo, type BuildingKind } from '../../src/world/buildings';
import { cityFor } from '../world/helpers';
import { cityBuildings } from '../interior/helpers';

export const SEED = 42;

export interface StubOccupants extends OccupantPort {
  readonly spawned: OccupantSpawn[];
  readonly removed: number[];
  readonly busyIds: Set<number>;
  owns: boolean;
}

export function stubOccupants(): StubOccupants {
  let next = 1;
  const stub: StubOccupants = {
    spawned: [],
    removed: [],
    busyIds: new Set<number>(),
    owns: false,
    spawn(spec) {
      stub.spawned.push(spec);
      return next++;
    },
    remove(id) {
      stub.removed.push(id);
    },
    busy(id) {
      return stub.busyIds.has(id);
    },
    sceneOwns() {
      return stub.owns;
    },
  };
  return stub;
}

export interface Rig {
  sys: InteriorSystem;
  physics: PhysicsWorld;
  bus: EventBus<EventMap>;
  buildings: BuildingIndex;
  occupants: StubOccupants;
  rng: ReturnType<typeof createRng>;
  time: { now: number };
  carried: Record<string, number>;
  officer: OfficerAt;
  events: { topic: string; payload: unknown }[];
  /** Runs `n` fixed steps (interiors, then physics). */
  steps(n: number): void;
  dispose(): void;
}

const TOPICS = ['interior:resident', 'interior:moveOfficer', 'interior:transition', 'interior:door', 'interior:switch', 'interior:flash'] as const;

export async function makeRig(seed = SEED, overrides: Partial<InteriorDeps> = {}): Promise<Rig> {
  await initRapier();
  const city = cityFor(seed);
  const physics = PhysicsWorld.createSync();
  const bus = new EventBus<EventMap>();
  const buildings = new BuildingIndex(city);
  const occupants = stubOccupants();
  const rng = createRng(seed).stream('interior');
  const time = { now: 12 * 3600 };
  const carried: Record<string, number> = {};
  const events: Rig['events'] = [];
  for (const t of TOPICS) bus.on(t, (payload) => events.push({ topic: t, payload }));
  const sys = new InteriorSystem({
    seed, city, physics, bus, rng, buildings, occupants,
    now: () => time.now,
    kit: () => ({ carried: (item) => carried[item] ?? 0 }),
    ...overrides,
  });
  const officer: OfficerAt = { x: 0, z: 0, yaw: 0, building: -1, onFoot: true };
  return {
    sys, physics, bus, buildings, occupants, rng, time, carried, officer, events,
    steps(n) {
      for (let i = 0; i < n; i++) {
        officer.building = sys.officerBuilding;
        sys.step(1 / 60, officer);
        physics.step();
      }
    },
    dispose() {
      sys.dispose();
      physics.dispose();
    },
  };
}

/** The first enterable building of `kind` in the test city (ascending block order). */
const found = new Map<string, BuildingInfo>();
const layouts = new Map<string, InteriorLayout>();

export function findBuilding(kind: BuildingKind, seed = SEED, n = 40): BuildingInfo {
  const key = `${seed}:${kind}`;
  let b = found.get(key);
  if (b === undefined) {
    b = cityBuildings(new BuildingIndex(cityFor(seed)), n).find((x) => x.kind === kind);
    if (!b) throw new Error(`no ${kind} in the test city`);
    found.set(key, b);
  }
  return b;
}

/** The pure layout of a building (memoised: layouts are immutable). */
export function layoutOf(info: BuildingInfo, seed = SEED): InteriorLayout {
  const key = `${seed}:${info.id}`;
  let l = layouts.get(key);
  if (l === undefined) {
    const made = generateInterior(seed, info);
    if (!made) throw new Error('no layout');
    l = made;
    layouts.set(key, l);
  }
  return l;
}

declare const process: { memoryUsage(): { heapUsed: number } };
interface NodeModules {
  v8: { setFlagsFromString(flags: string): void };
  vm: { runInNewContext(code: string): unknown };
}

/** A forced-GC function (node:v8 `--expose-gc` through a new vm context), for heap-delta allocation checks. */
export async function loadGc(): Promise<() => void> {
  const names: Record<keyof NodeModules, string> = { v8: 'node:v8', vm: 'node:vm' };
  const v8 = (await import(/* @vite-ignore */ names.v8)) as NodeModules['v8'];
  const vm = (await import(/* @vite-ignore */ names.vm)) as NodeModules['vm'];
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
}

/** Heap bytes allocated by `fn` (call `loadGc()` first and pass its result). */
export function heapDelta(gc: () => void, fn: () => void): number {
  gc();
  const before = process.memoryUsage().heapUsed;
  fn();
  return process.memoryUsage().heapUsed - before;
}
